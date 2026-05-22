/* Service Worker: офлайн-кэш PWA «Калькулятор раскроя труб». */
'use strict';

const CACHE_VERSION = 'v1.0.0';
const CACHE_NAME = 'pipe-cutter-' + CACHE_VERSION;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.svg',
  './icon-512.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('pipe-cutter-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Cache-first для собственных ассетов.
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(response => {
        // Кэшируем только успешные GET того же origin.
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const url = new URL(req.url);
        if (url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      }).catch(() => {
        // Фоллбэк на главную при офлайн-навигации.
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('Офлайн', { status: 503, statusText: 'Offline' });
      });
    })
  );
});
