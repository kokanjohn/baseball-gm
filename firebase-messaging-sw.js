// firebase-messaging-sw.js
// Place this file at the ROOT of your GitHub Pages repo

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// Note: Firebase web config is intentionally public — it is not a secret.
// See: https://firebase.google.com/docs/projects/api-keys
const _cfg = {
  aK:  "AIzaSyAaUqnuCWzRO6FrEbUaX7EupI9FYuaJYjo",
  aD:  "baseball-gm-push.firebaseapp.com",
  pI:  "baseball-gm-push",
  sB:  "baseball-gm-push.firebasestorage.app",
  mSI: "157200420537",
  aI:  "1:157200420537:web:b411f9d199f081c0db9568"
};

firebase.initializeApp({
  apiKey:            _cfg.aK,
  authDomain:        _cfg.aD,
  projectId:         _cfg.pI,
  storageBucket:     _cfg.sB,
  messagingSenderId: _cfg.mSI,
  appId:             _cfg.aI,
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const n = payload.notification || payload.data || {};
  return self.registration.showNotification(n.title || 'The Front Office', {
    body:     n.body  || '',
    icon:     '/baseball-gm/icon-192.png',
    badge:    '/baseball-gm/icon-192.png',
    tag:      n.tag   || 'bgm',
    renotify: true,
    data:     payload.data || {},
  });
});
