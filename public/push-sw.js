/* global self, clients */
// Custom Web Push Service Worker extension imported into Workbox SW

self.addEventListener('push', (event) => {
  let payload = {
    title: 'Intervento Completato · SITE',
    body: 'Un intervento è stato contrassegnato come Completato.',
    url: '/',
    taskId: '',
    tag: 'site-task-completed',
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        payload = {
          title: parsed.title || payload.title,
          body: parsed.body || payload.body,
          url: parsed.url || payload.url,
          taskId: parsed.taskId || '',
          tag: parsed.tag || (parsed.taskId ? `site-task-completed-${parsed.taskId}` : payload.tag),
        };
      }
    } catch {
      const rawText = event.data.text();
      if (rawText) {
        payload.body = rawText;
      }
    }
  }

  const notificationOptions = {
    body: payload.body,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: payload.tag,
    renotify: true,
    vibrate: [180, 80, 220],
    data: {
      url: payload.url || '/',
      taskId: payload.taskId || '',
    },
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, notificationOptions)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const taskId = typeof data.taskId === 'string' ? data.taskId : '';
  const targetUrl =
    typeof data.url === 'string' && data.url.startsWith('/')
      ? data.url
      : taskId
      ? `/?taskId=${encodeURIComponent(taskId)}`
      : '/';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url && 'focus' in client) {
            if (taskId) {
              client.postMessage({
                type: 'SITE_OPEN_TASK',
                taskId,
              });
            }
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
        return undefined;
      })
  );
});
