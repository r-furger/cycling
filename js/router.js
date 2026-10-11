// Route planning via the public BRouter server (OpenStreetMap data, bike profiles).
import { cumulative } from './geo.js';

export const PROFILES = [
  { id: 'trekking', label: 'Touring / trekking bike' },
  { id: 'fastbike', label: 'Road bike' },
  { id: 'fastbike-lowtraffic', label: 'Road bike, low traffic' },
  { id: 'gravel', label: 'Gravel' },
  { id: 'mtb', label: 'Mountain bike' },
  { id: 'safety', label: 'Safest (avoid traffic)' },
  { id: 'shortest', label: 'Shortest' },
];

const CMD = { 1: 'Continue straight', 2: 'Turn left', 3: 'Turn slightly left', 4: 'Turn sharp left', 5: 'Turn right', 6: 'Turn slightly right', 7: 'Turn sharp right', 8: 'Keep left', 9: 'Keep right', 10: 'Make a U-turn', 11: 'Make a U-turn', 12: 'Make a U-turn', 13: 'Leave the road', 14: 'Take the roundabout', 15: 'Take the roundabout', 16: 'Continue off-road', 17: 'Back on the road' };
const ICON = { 1: '↑', 2: '←', 3: '↖', 4: '↙', 5: '→', 6: '↗', 7: '↘', 8: '↰', 9: '↱', 10: '↩', 11: '↩', 12: '↪', 13: '⤴', 14: '↻', 15: '↺', 16: '⤳', 17: '⤳' };

export function hintText(cmd, exit) {
  let t = CMD[cmd] || 'Continue';
  if ((cmd === 14 || cmd === 15) && exit) t += `, exit ${exit}`;
  return t;
}

export async function routeBRouter(waypoints, profile = 'trekking', { signal } = {}) {
  const lonlats = waypoints.map(w => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join('|');
  const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson&timode=2`;
  const res = await fetch(url, { signal });
  const text = await res.text();
  if (!res.ok || !text.trim().startsWith('{')) throw new Error((text || `BRouter ${res.status}`).slice(0, 160));
  const f = JSON.parse(text).features?.[0];
  if (!f?.geometry?.coordinates?.length) throw new Error('No route found');
  const points = f.geometry.coordinates.map(c => ({ lon: c[0], lat: c[1], ele: isFinite(c[2]) ? c[2] : undefined }));
  const total = cumulative(points);
  const hints = (f.properties.voicehints || []).map(h => {
    const idx = Math.min(h[0], points.length - 1);
    return { index: idx, cmd: h[1], exit: h[2], text: hintText(h[1], h[2]), icon: ICON[h[1]] || '•', dist: points[idx].dist };
  });
  const p = f.properties;
  return { points, hints, length: Number(p['track-length']) || total, ascent: Number(p['filtered ascend']) || 0, time: Number(p['total-time']) || 0 };
}
