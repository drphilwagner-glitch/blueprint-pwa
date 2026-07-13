/* Service worker: caches the app shell for offline + installability.
 * Cross-origin API calls (the Apps Script Web App) are left to the app / offline queue (S10).
 */
var CACHE = 'bp-shell-v1';
var SHELL = ['./', './index.html', './app.js', './config.js', './styles.css',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;                    // POSTs (logs) handled by the app/queue
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;                // API is cross-origin; don't intercept
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return cached || fetch(e.request).then(function (resp) {
        var copy = resp.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return resp;
      }).catch(function () { return caches.match('./index.html'); });
    })
  );
});
