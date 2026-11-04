// Minimal service worker: cache the app shell for installability and fast
// reloads. API calls always go to the network.
const CACHE = 'thalamuse-v8';
const SHELL = ['/', '/index.html', '/css/app.css', '/manifest.json', '/js/app.js', '/js/config.js', '/js/sensors.js', '/js/classifier.js', '/js/graph.js', '/js/transform.js', '/js/viz.js', '/js/quiz.js', '/js/own.js', '/mirror.html', '/js/mirror.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  // Network first so code changes show up during development; cache as fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
