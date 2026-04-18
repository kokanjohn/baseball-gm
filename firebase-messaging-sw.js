// firebase-messaging-sw.js
// Place this file at the ROOT of your GitHub Pages repo
// (same level as Baseball_GM.html, sw.js, manifest.json)

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyAaUqnuCWzRO6FrEbUaX7EupI9FYuaJYjo",
  authDomain:        "baseball-gm-push.firebaseapp.com",
  projectId:         "baseball-gm-push",
  storageBucket:     "baseball-gm-push.firebasestorage.app",
  messagingSenderId: "157200420537",
  appId:             "1:157200420537:web:b411f9d199f081c0db9568"
});

const messaging = firebase.messaging();

// Handle background push messages sent by the Cloudflare worker
// (foreground messages are handled by the app itself)
messaging.onBackgroundMessage(payload => {
  const { title = 'The Front Office', body = '', tag = 'bgm', data = {} } = payload.notification || payload.data || {};
  return self.registration.showNotification(title, {
    body,
    icon:     '/baseball-gm/icon-192.png',
    badge:    '/baseball-gm/icon-192.png',
    tag,
    renotify: true,
    data,
  });
});
