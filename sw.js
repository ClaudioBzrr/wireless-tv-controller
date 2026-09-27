/* Controle TV — service worker.
 * Guarda o "app shell" em cache para abrir rápido e funcionar offline.
 * Não faz cache de nenhuma chamada externa (as TVs são acessadas via WebSocket,
 * que não passa pelo service worker). */

var CACHE = 'controle-tv-v1';
var ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/proxy.js',
  './js/ssap.js',
  './js/webos.js',
  './js/apps-data.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== location.origin) return;

  // network-first: sempre pega a versão nova quando online e usa o cache
  // apenas quando estiver offline.
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (cached) {
        return cached || caches.match('./index.html');
      });
    })
  );
});
