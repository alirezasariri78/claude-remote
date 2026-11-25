// Service worker for the Claude Remote web app.
// It makes the app installable and shows notifications. It does not cache the
// app: without a connection to the computer there is nothing useful to show.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Pass every request straight to the network.
self.addEventListener('fetch', () => {});

// Tapping a notification brings the app to the front, or opens it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) if ('focus' in w) return w.focus();
      return self.clients.openWindow('/');
    }),
  );
});
