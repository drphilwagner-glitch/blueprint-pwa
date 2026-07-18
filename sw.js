/* Service worker: caches the app shell for offline + installability.
 * Cross-origin API calls (the Apps Script Web App) are left to the app / offline queue (S10).
 */
var CACHE = 'bp-shell-v50';
var SHELL = ['./', './index.html', './app.js', './config.js', './tokens.css', './styles.css',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', function (e) {
  // Cache each shell asset independently so one missing file can't fail the whole install.
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
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
  // Network-first: always load the latest shell when online, fall back to cache offline.
  e.respondWith(
    fetch(e.request).then(function (resp) {
      var copy = resp.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return resp;
    }).catch(function () {
      return caches.match(e.request).then(function (cached) { return cached || caches.match('./index.html'); });
    })
  );
});
