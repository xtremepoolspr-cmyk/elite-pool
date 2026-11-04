// Service worker: guarda la app para que abra sin internet.
// Sube CACHE a v2, v3… cuando publiques cambios para que los teléfonos se actualicen.
const CACHE = 'elite-pool-v21';
const TILES = 'epspr-tiles-v1'; // mosaicos del mapa vistos antes (se ven sin internet)
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/lib.js', './js/data.js', './js/app.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'GET' && url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(
      caches.open(TILES).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }))),
    );
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // sirve de la caché y refresca en segundo plano
        fetch(req).then((res) => res.ok && caches.open(CACHE).then((c) => c.put(req, res))).catch(() => {});
        return hit;
      }
      return fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
    }),
  );
});
