/* Service worker: caches the app shell for offline + installability.
 * Cross-origin API calls (the Apps Script Web App) are left to the app / offline queue (S10).
 */
var CACHE = 'bp-shell-v59';
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
  // Network-first AND cache-busting. GitHub Pages serves the shell with `cache-control: max-age=600`,
  // and a plain fetch() inside a service worker still honours the browser's HTTP cache — so for ten
  // minutes after an upload the SW dutifully re-served the OLD file it already had. Phil uploaded
  // styles.css, reopened, saw the old behaviour, and reported the same bug a third time; the file was
  // live on the server the whole time. `cache: 'reload'` bypasses the HTTP cache and revalidates.
  // We still write every response into CacheStorage below, so offline is unaffected.
  var req = e.request;
  try { req = new Request(e.request, { cache: 'reload' }); } catch (err) { req = e.request; }
  e.respondWith(
    fetch(req).then(function (resp) {
      var copy = resp.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return resp;
    }).catch(function () {
      return caches.match(e.request).then(function (cached) { return cached || caches.match('./index.html'); });
    })
  );
});
