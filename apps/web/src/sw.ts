import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { pwaNavigateFallback, pwaNavigateFallbackDenylist } from './lib/pwa-cache-policy';
import {
  buildVerifiedResponse,
  checkAssetIntegrity,
  integrityManifestKey,
} from './lib/sw-integrity';

declare let self: ServiceWorkerGlobalScope & typeof globalThis;

// Build-time subresource-integrity manifest (CDI-1): { "assets/<file>": "<sha384-base64>" } for every built
// JS/CSS asset. INLINED into the emitted dist/sw.js by the scripts/inline-sw-integrity.mjs post-build step
// (run from the build script, after vite-plugin-pwa emits sw.js) — it reuses the exact hashes already written
// to bundle-manifest.json (one source of truth, byte-identical to the SRI integrity= attrs). It MUST be
// inlined here, never fetched at runtime: a runtime fetch would let an attacker who swapped a chunk also serve
// a matching manifest (the CDI-3 self-defeat). The placeholder string below is replaced at build with the real
// JSON; if it is ever left unreplaced, JSON.parse throws on SW load (fail-closed) and the build-output guard
// (scripts/check-sw-integrity.mjs) fails CI.
const INTEGRITY_MANIFEST: Record<string, string> = JSON.parse(
  '__SW_INTEGRITY_MANIFEST_JSON__',
) as Record<string, string>;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SRI enforcement for same-origin built assets the browser loads via native dynamic import() (the ts-mls
// crypto chunks), which cannot carry an SRI integrity= attribute. For any GET whose path is a manifest key,
// re-hash the bytes actually received (network OR HTTP cache — so a cache-poisoned immutable asset is still
// caught) and refuse to serve a mismatch. Unknown paths (api/ws/attachments/future-build chunks) are NOT
// intercepted — we `return` so the browser handles them normally. We never write to Cache Storage here:
// the SW caches nothing but the precache shell.
self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const key = integrityManifestKey(url.pathname);
  const expected = key ? INTEGRITY_MANIFEST[key] : undefined;
  if (!expected) return; // unknown path → untouched (mandatory: mid-deploy skew must not brick)

  event.respondWith(
    (async () => {
      const response = await fetch(request);
      const buffer = await response.clone().arrayBuffer();
      const decision = await checkAssetIntegrity(expected, buffer);
      if (!decision.ok) {
        // Fail closed: the dynamic import() rejects and the crypto operation errors out rather than
        // executing a tampered chunk. 502 (not a forged 200) so the failure is unambiguous.
        return new Response(null, { status: 502, statusText: 'Asset integrity check failed' });
      }
      // Re-emit the verified bytes (the original body stream was consumed by clone().arrayBuffer()).
      // buildVerifiedResponse drops the now-stale Content-Encoding/Content-Length (fetch already decoded the
      // body) so the browser doesn't double-decode the chunk. See sw-integrity.ts.
      return buildVerifiedResponse(buffer, response);
    })(),
  );
});

// SPA navigation fallback — serves index.html for all navigation requests not in the denylist.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL(pwaNavigateFallback), {
    denylist: [...pwaNavigateFallbackDenylist],
  }),
);

// Push: content-free wake. The payload is {"type":"new_message"} — zero plaintext, no sender, no
// conversation id. On push: show a generic notification. The app reconnects via WebSocket and
// fetches ciphertext normally. Tag collapses multiple pushes into one notification entry.
self.addEventListener('push', (event: PushEvent) => {
  event.waitUntil(
    self.registration.showNotification('argus', {
      body: 'New message',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'argus-new-message',
      renotify: true,
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
