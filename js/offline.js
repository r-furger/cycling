// Offline tile pre-caching for swisstopo layers (shared Cache Storage with the service worker).
import { haversine } from './geo.js';
export const TILE_CACHE = 'veloch-tiles-v1';

export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const r = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  return { x, y };
}

export function tileUrl(template, t) {
  return template.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y).replace('{s}', 'a');
}

// All tiles touched by the route (densified so long segments are covered) plus `pad` neighbours.
export function tilesForRoute(points, zooms, pad = 1) {
  const dense = [];
  for (let i = 0; i < points.length; i++) {
    dense.push(points[i]);
    if (i + 1 < points.length) {
      const a = points[i], b = points[i + 1], d = haversine(a, b);
      const n = Math.floor(d / 150);
      for (let k = 1; k <= n; k++) { const t = k / (n + 1); dense.push({ lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) }); }
    }
  }
  const seen = new Set(), out = [];
  for (const z of zooms) {
    const p = z >= 15 ? pad : Math.max(0, pad - 1);
    for (const pt of dense) {
      const { x, y } = lonLatToTile(pt.lon, pt.lat, z);
      for (let dx = -p; dx <= p; dx++) for (let dy = -p; dy <= p; dy++) {
        const key = `${z}/${x + dx}/${y + dy}`;
        if (!seen.has(key)) { seen.add(key); out.push({ z, x: x + dx, y: y + dy }); }
      }
    }
  }
  return out;
}

export async function cacheTiles(urls, onProgress, signal) {
  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0, i = 0, aborted = false;
  const worker = async () => {
    while (i < urls.length) {
      if (signal?.aborted) { aborted = true; return; }
      const url = urls[i++];
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) await cache.put(url, res); else failed++;
        }
      } catch { failed++; }
      done++;
      if (done % 10 === 0 || done === urls.length) onProgress?.(done, urls.length, failed);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { done, failed, aborted };
}

export async function tileCacheInfo() {
  let count = 0, usage = 0, quota = 0;
  try { const c = await caches.open(TILE_CACHE); count = (await c.keys()).length; } catch { }
  try { const e = await navigator.storage?.estimate(); usage = e?.usage || 0; quota = e?.quota || 0; } catch { }
  return { count, usage, quota };
}

export async function clearTileCache() { try { await caches.delete(TILE_CACHE); } catch { } }
