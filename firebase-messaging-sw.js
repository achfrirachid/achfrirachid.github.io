/* Firebase Cloud Messaging — إشعارات رسائل الدفع */
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

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

messaging.onBackgroundMessage(payload => {
  const n = payload.notification || {};
  const title = n.title || '💰 عملية دفع لم تدون';
  const body = n.body || 'وصلاتك رسالة دفع جديدة';
  self.registration.showNotification(title, {
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'owner-payment',
    renotify: true,
    data: payload.data || {}
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url
    ? event.notification.data.url : './';
  event.waitUntil(clients.matchAll({type:'window', includeUncontrolled:true}).then(list=>{
    for(const c of list){
      if('focus' in c) return c.focus();
    }
    if(clients.openWindow) return clients.openWindow(target);
  }));
});
