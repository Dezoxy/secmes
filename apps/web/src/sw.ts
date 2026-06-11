import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { pwaNavigateFallback, pwaNavigateFallbackDenylist } from './lib/pwa-cache-policy';

declare let self: ServiceWorkerGlobalScope & typeof globalThis;

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
