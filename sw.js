/**
 * 禁猎区 · Service Worker
 * 只负责后台推送：网页关闭/锁屏时，push 事件也能唤醒浏览器弹出系统通知。
 */
self.addEventListener('install', function (e) {
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(clients.claim());
});
self.addEventListener('push', function (e) {
  let title = '禁猎区';
  let body = '';
  let url = './index.html';
  try {
    const data = e.data.json();
    if (data && data.title) title = data.title;
    if (data && data.body) body = data.body;
    if (data && data.url) url = data.url;
  } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: './icon.png',
      badge: './icon.png',
      tag: 'nh-push-' + Date.now(),
      renotify: true,
      data: { url: url },
      vibrate: [120, 60, 120],
    })
  );
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cl) {
      for (let i = 0; i < cl.length; i++) {
        if ('focus' in cl[i]) return cl[i].focus();
      }
      return clients.openWindow(target);
    })
  );
});
