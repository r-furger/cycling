// Service worker: offline app shell + tile caching for swisstopo layers.
const VERSION = 'v2';
const SHELL = 'veloch-shell-' + VERSION;
const TILES = 'veloch-tiles-v1';
const RUNTIME = 'veloch-runtime-v1';
const SHELL_URLS = [
  './', './index.html', './css/style.css', './manifest.webmanifest',
  './js/main.js', './js/map.js', './js/geo.js', './js/gpx.js', './js/elevation.js', './js/profile.js',
  './js/router.js', './js/nav.js', './js/nearby.js', './js/storage.js', './js/offline.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
  'https://cdnjs.cloudflare.com/ajax/libs/i18next/23.16.8/i18next.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/suncalc/1.9.0/suncalc.min.js',
  'https://cdn.jsdelivr.net/npm/opening_hours@3.8.0/build/opening_hours.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_URLS.map(u => c.add(u).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('veloch-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

const isSwissTile = u => u.hostname === 'wmts.geo.admin.ch';
const isOtherTile = u => /tile\.openstreetmap\.org|tile-cyclosm|opentopomap/.test(u.hostname);
const isApi = u => /api3\.geo\.admin\.ch|brouter\.de|overpass|transport\.opendata\.ch/.test(u.hostname);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (isApi(url)) return;

  if (isSwissTile(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req.url, res.clone());
        return res;
      } catch { return new Response('', { status: 504 }); }
    })());
    return;
  }

  if (isOtherTile(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req.url, res.clone());
        return res;
      } catch { return (await cache.match(req.url)) || new Response('', { status: 504 }); }
    })());
    return;
  }

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        const c = await caches.open(SHELL); c.put('./index.html', res.clone());
        return res;
      } catch { return (await caches.match('./index.html')) || (await caches.match('./')); }
    })());
    return;
  }

  // Own files: network first (always fresh when online), cache when offline.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch { return (await cache.match(req)) || new Response('', { status: 504 }); }
    })());
    return;
  }

  // Versioned CDN libraries: cache first.
  if (/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/.test(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok) cache.put(req, res.clone()); return res; }
      catch { return new Response('', { status: 504 }); }
    })());
  }
});
