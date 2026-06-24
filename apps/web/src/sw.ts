import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  matchPrecache,
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
// actually served and fails closed on a mismatch. Source: the Workbox precache FIRST (preserves offline —
// these assets are precached — and still verifies the precached copy, so a chunk poisoned at install time is
// also caught), then the network. It writes nothing to Cache Storage — the SW caches only the precache shell.
registerRoute(
  ({ request, url }) =>
    request.method === 'GET' &&
    url.origin === self.location.origin &&
    expectedHashFor(url.pathname, INTEGRITY_MANIFEST) !== undefined,
  async ({ request, url }) => {
    const expected = expectedHashFor(url.pathname, INTEGRITY_MANIFEST);
    const response = (await matchPrecache(request)) ?? (await fetch(request));
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

// Prompt-mode updates: the update dialog calls wb.messageSkipWaiting() which posts this message.
// injectManifest strategy requires adding this handler manually (generateSW would inject it automatically).
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.origin !== self.location.origin) return;
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

interface StoredNotificationSettings {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

async function readCachedNotificationSettings(): Promise<StoredNotificationSettings> {
  const defaults: StoredNotificationSettings = {
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
  };
  try {
    const cache = await caches.open('argus-settings');
    const response = await cache.match('/notification-settings');
    if (!response) return defaults;
    const data = (await response.json()) as Partial<StoredNotificationSettings>;
    return {
      quietHoursEnabled:
        typeof data.quietHoursEnabled === 'boolean'
          ? data.quietHoursEnabled
          : defaults.quietHoursEnabled,
      quietHoursStart:
        typeof data.quietHoursStart === 'string' ? data.quietHoursStart : defaults.quietHoursStart,
      quietHoursEnd:
        typeof data.quietHoursEnd === 'string' ? data.quietHoursEnd : defaults.quietHoursEnd,
    };
  } catch {
    return defaults;
  }
}

function isInQuietHours(settings: StoredNotificationSettings): boolean {
  if (!settings.quietHoursEnabled) return false;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const { quietHoursStart: start, quietHoursEnd: end } = settings;
  // Handle overnight ranges (e.g. 22:00 → 07:00 crosses midnight).
  if (start <= end) return hhmm >= start && hhmm < end;
  return hhmm >= start || hhmm < end;
}

// Push: content-free wake. The payload is {"type":"new_message"|"friend_request"} — zero plaintext,
// no sender, no conversation id. On push: show a generic notification. The app reconnects via
// WebSocket and fetches ciphertext normally. Tag collapses multiple pushes into one notification entry.
self.addEventListener('push', (event: PushEvent) => {
  let type = 'new_message';
  try {
    const data = event.data?.json() as { type?: unknown } | null;
    if (typeof data?.type === 'string') type = data.type;
  } catch {
    // malformed payload — default to new_message
  }

  let body: string;
  let tag: string;
  if (type === 'friend_request') {
    body = 'New friend request';
    tag = 'argus-friend-request';
  } else {
    body = 'New message';
    tag = 'argus-new-message';
  }

  event.waitUntil(
    readCachedNotificationSettings().then((notifSettings) => {
      if (isInQuietHours(notifSettings)) return; // swallow push silently during quiet hours
      return self.registration.showNotification('argus', {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag,
        renotify: true,
      });
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
