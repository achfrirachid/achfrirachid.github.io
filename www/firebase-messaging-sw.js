// firebase-messaging-sw.js
// ⭐ هاد الملف خاصو يكون فـ جذر الموقع (نفس مستوى index.html)، لأن
// index.html كيسجلو بـ: navigator.serviceWorker.register('./firebase-messaging-sw.js')
// هو المسؤول على استقبال وعرض إشعارات الدفع حتى والتطبيق مسكر بالكامل.

importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

// ⚠️ خاصك تحط هنا نفس firebaseConfig اللي كاين فـ index.html (apiKey,
// authDomain, databaseURL, projectId, storageBucket, messagingSenderId, appId)
firebase.initializeApp({
  apiKey: "AIzaSyCFsFJyz0JJWtULDWHXPHo2fyXzW2GJ0ns",
  authDomain: "student-4f473-205b5-21ca0.firebaseapp.com",
  databaseURL: "https://student-4f473-205b5-21ca0-default-rtdb.firebaseio.com",
  projectId: "student-4f473-205b5-21ca0",
  storageBucket: "student-4f473-205b5-21ca0.firebasestorage.app",
  messagingSenderId: "293049187782",
  appId: "1:293049187782:web:a6bd8cbec429595d1886c7"
});

const messaging = firebase.messaging();

// الرسائل جايين data-only من الـ Worker (/fcm-send) — كيوصلو هنا حتى
// والتطبيق مسكر بالكامل، وهنا كنبنيو الإشعار يدويا باش يكون تحت تحكمنا
// (شكل، اهتزاز، وشنو غيوقع كي كيتضغط عليه).
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  const title = d.title || '💰 تلاميذ دفعوا الواجب الشهري';
  const body = d.body || 'وصلاتك رسالة دفع جديدة';
  const url = d.url || './';

  self.registration.showNotification(title, {
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'payment-alert',           // إشعار وحد ما كيتكدسش، كيبدل لي قبلو
    renotify: true,                  // كيرن/كيهز حتى ولو تاغ نفسو
    requireInteraction: true,        // كيبقى باين حتى يتقرا (ما كيختفيش وحدو)
    vibrate: [300, 150, 300, 150, 300],
    data: { url, type: d.type || 'ownerPayment', id: d.id || '' }
  });
});

// ⭐ الضغطة على الإشعار: كتحل التطبيق (أو كتفوكوسي عليه إلا كان حالّ من
// قبل) وكتوجهو مباشرة لخانة الدفع.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'OPEN_PAYMENT_INBOX', data: event.notification.data });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl + '#openPaymentInbox=1');
      }
    })
  );
});
