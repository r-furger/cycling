// Elevation profiles: swisstopo DTM (api3.geo.admin.ch) with fallback to point elevations.
import { wgs84ToLV95, simplify, cumulative, inSwitzerland } from './geo.js';

const PROFILE_URL = 'https://api3.geo.admin.ch/rest/services/profile.json';

export async function swisstopoProfile(points, nbPoints) {
  const total = points[points.length - 1].dist ?? cumulative(points);
  nbPoints = nbPoints || Math.min(1000, Math.max(250, Math.round(total / 60)));
  let pts = points.length > 1500 ? simplify(points, 0.00005) : points;
  if (pts.length > 4000) { const step = Math.ceil(pts.length / 4000); pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1); }
  const coords = pts.map(p => { const { E, N } = wgs84ToLV95(p.lat, p.lon); return [Math.round(E * 10) / 10, Math.round(N * 10) / 10]; });
  const body = new URLSearchParams({ geom: JSON.stringify({ type: 'LineString', coordinates: coords }), sr: '2056', nb_points: String(nbPoints), offset: '0', distinct_points: 'false' });
  // Note: the API rejects a charset suffix on the content type, so set it explicitly (still a CORS 'simple' request).
  const res = await fetch(PROFILE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  if (!res.ok) throw new Error('swisstopo profile ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data) || data.length < 2) throw new Error('empty profile');
  const k = total / (data[data.length - 1].dist || 1);
  const samples = data.map(d => ({ dist: d.dist * k, ele: d.alts?.COMB ?? d.alts?.DTM2 ?? d.alts?.DTM25 })).filter(s => s.ele != null && s.ele > -500);
  if (samples.length < 2) throw new Error('no elevation data');
  return samples;
}

export function profileFromPoints(points, maxSamples = 600) {
  const withEle = points.filter(p => p.ele != null);
  if (withEle.length < Math.max(2, points.length * 0.5)) return null;
  const step = Math.max(1, Math.ceil(withEle.length / maxSamples));
  const out = [];
  for (let i = 0; i < withEle.length; i += step) out.push({ dist: withEle[i].dist, ele: withEle[i].ele });
  const last = withEle[withEle.length - 1];
  if (out[out.length - 1].dist !== last.dist) out.push({ dist: last.dist, ele: last.ele });
  return out;
}

// Returns {samples, source} or null.
export async function buildProfile(points, { preferSwisstopo = true } = {}) {
  if (!points || points.length < 2) return null;
  if (points[points.length - 1].dist == null) cumulative(points);
  if (preferSwisstopo && navigator.onLine && inSwitzerland(points)) {
    try { return { samples: await swisstopoProfile(points), source: 'swisstopo' }; } catch (e) { console.warn('swisstopo profile failed', e); }
  }
  const s = profileFromPoints(points);
  return s ? { samples: s, source: 'points' } : null;
}

export function eleAtDist(samples, d) {
  if (!samples?.length) return null;
  if (d <= samples[0].dist) return samples[0].ele;
  if (d >= samples[samples.length - 1].dist) return samples[samples.length - 1].ele;
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (samples[m].dist <= d) lo = m; else hi = m; }
  const a = samples[lo], b = samples[hi], t = b.dist > a.dist ? (d - a.dist) / (b.dist - a.dist) : 0;
  return a.ele + t * (b.ele - a.ele);
}

export function remainingAscent(samples, from, thresh = 5) {
  if (!samples?.length) return 0;
  let ref = eleAtDist(samples, from), asc = 0;
  for (const s of samples) {
    if (s.dist < from) continue;
    const d = s.ele - ref;
    if (d >= thresh) { asc += d; ref = s.ele; } else if (d <= -thresh) ref = s.ele;
  }
  return Math.round(asc);
}
