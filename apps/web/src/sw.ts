import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { pwaNavigateFallback, pwaNavigateFallbackDenylist } from './lib/pwa-cache-policy';
import { buildVerifiedResponse, checkAssetIntegrity, expectedHashFor } from './lib/sw-integrity';

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

// SRI enforcement for same-origin built assets the browser loads via native dynamic import() (the ts-mls
// crypto chunks), which cannot carry an SRI integrity= attribute. Registered through Workbox's router and
// BEFORE precacheAndRoute, so for a guarded /assets/* path this route wins over the precache route (Workbox
// evaluates routes in registration order, first match handles it) — otherwise the precache would serve the
// crypto chunks from Cache Storage WITHOUT the integrity check, defeating CDI-1. Only matches paths in the
// inlined manifest; unknown paths (api/ws/attachments/future-build chunks) don't match → fall through to the
// precache/network untouched, so a mid-deploy version skew never bricks the app. It re-hashes the bytes
// actually received (network OR HTTP cache, so a cache-poisoned immutable asset is still caught) and fails
// closed on a mismatch. It writes nothing to Cache Storage — the SW caches only the precache shell.
registerRoute(
  ({ request, url }) =>
    request.method === 'GET' &&
    url.origin === self.location.origin &&
    expectedHashFor(url.pathname, INTEGRITY_MANIFEST) !== undefined,
  async ({ request, url }) => {
    const expected = expectedHashFor(url.pathname, INTEGRITY_MANIFEST);
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
  },
);

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

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
