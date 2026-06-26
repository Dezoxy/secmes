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

// Build-time VAPID public key (base64url). Vite replaces import.meta.env at build time, so this
// is inlined into the emitted sw.js the same way client-side env vars are. Used as a fallback in
// handlePushSubscriptionChange when event.oldSubscription is null (iOS drops it before the event
// fires), which is what prevented silent re-subscription on every SW update on iOS.
const SW_VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

/** Convert a base64url string to a Uint8Array. Mirrors fromBase64Url in lib/push.ts. */
function swFromBase64Url(b64url: string): Uint8Array {
  const normalized = b64url.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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

// pushsubscriptionchange: the browser fires this when it invalidates/rotates the push subscription on its
// own (most relevant on iOS, where the subscription is dropped when the SW is replaced on an app update).
// Re-subscribe with the same applicationServerKey so delivery keeps working even with no tab open, then ping
// open clients so an authenticated context re-registers the new endpoint with the server (PUT
// /push/subscription is JWT-guarded — the SW has no token, so the actual save happens client-side via
// reconcilePushSubscription). Best-effort: if no client is open, the next authenticated startup reconciles.
interface PushSubscriptionChangeEvent extends ExtendableEvent {
  readonly oldSubscription: PushSubscription | null;
  readonly newSubscription: PushSubscription | null;
}

async function handlePushSubscriptionChange(event: PushSubscriptionChangeEvent): Promise<void> {
  // Prefer the browser-provided replacement (Firefox / newer Chrome populate newSubscription); only
  // re-subscribe manually when it's absent, so we don't create a redundant second endpoint.
  if (!event.newSubscription) {
    // On iOS, event.oldSubscription is null when the SW is replaced via skipWaiting — the browser
    // has already dropped the subscription before this event fires, so there is no oldSubscription
    // to read the applicationServerKey from. Fall back to the build-time VAPID key so we can
    // re-subscribe from service-worker context (no user gesture required per the Push API spec).
    const applicationServerKey: ArrayBuffer | Uint8Array | null =
      event.oldSubscription?.options.applicationServerKey ??
      (SW_VAPID_PUBLIC_KEY ? swFromBase64Url(SW_VAPID_PUBLIC_KEY) : null);
    if (applicationServerKey) {
      try {
        await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      } catch {
        // best-effort — an open client's reconcile / banner will recreate the subscription
      }
    }
  }
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) {
    client.postMessage({ type: 'push-subscription-changed' });
  }
}

self.addEventListener('pushsubscriptionchange', ((event: ExtendableEvent) => {
  event.waitUntil(handlePushSubscriptionChange(event as PushSubscriptionChangeEvent));
}) as EventListener);

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
// Per-conversation mute cannot be enforced here: push payloads carry no conversation ID (intentional
// — metadata privacy), so the SW cannot determine which conversation triggered the push. Mute is an
// in-app display feature only (sidebar badges, visual state); quiet hours are the only push-level filter.
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
      // userVisibleOnly: true (set at subscription time) means every push MUST produce a visible
      // notification — silently returning causes browsers to show their own fallback or penalise
      // the subscription. During quiet hours we still show the notification but silence it
      // (no sound, no vibration, no re-alert) so it lands in the tray without waking the user.
      const silent = isInQuietHours(notifSettings);
      return self.registration.showNotification('argus', {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag,
        renotify: !silent,
        silent,
      });
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
