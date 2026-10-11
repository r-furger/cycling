// Geometry helpers: distances, projections, track utilities, formatting.
const R = 6371000;
const toRad = d => d * Math.PI / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearing(a, b) {
  const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// WGS84 -> Swiss LV95 (swisstopo approximate formulas, ~1 m accuracy).
export function wgs84ToLV95(lat, lon) {
  const phi = (lat * 3600 - 169028.66) / 10000;
  const lam = (lon * 3600 - 26782.5) / 10000;
  const E = 2600072.37 + 211455.93 * lam - 10938.51 * lam * phi - 0.36 * lam * phi * phi - 44.54 * lam ** 3;
  const N = 1200147.07 + 308807.95 * phi + 3745.25 * lam * lam + 76.63 * phi * phi - 194.56 * lam * lam * phi + 119.79 * phi ** 3;
  return { E, N };
}

// Sets p.dist (cumulative metres) on every point, returns total length.
export function cumulative(points) {
  let d = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) d += haversine(points[i - 1], points[i]);
    points[i].dist = d;
  }
  return d;
}

// Nearest point on a polyline (points need .dist). Searches a window around fromIndex first.
export function nearestOnTrack(points, p, fromIndex = null, window = 300) {
  if (!points || points.length < 2) return null;
  const cosLat = Math.cos(toRad(p.lat));
  const px = p.lon * cosLat, py = p.lat;
  const seg = i => {
    const a = points[i], b = points[i + 1];
    const ax = a.lon * cosLat, ay = a.lat, bx = b.lon * cosLat, by = b.lat;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy, ex = qx - px, ey = qy - py;
    return { d2: ex * ex + ey * ey, t, qx, qy, i };
  };
  const scan = (lo, hi) => { let best = null; for (let i = lo; i < hi; i++) { const s = seg(i); if (!best || s.d2 < best.d2) best = s; } return best; };
  let best = null;
  if (fromIndex != null) best = scan(Math.max(0, fromIndex - window), Math.min(points.length - 1, fromIndex + window));
  if (!best || Math.sqrt(best.d2) * 111320 > 150) {
    const full = scan(0, points.length - 1);
    if (!best || full.d2 < best.d2) best = full;
  }
  const a = points[best.i], b = points[best.i + 1];
  const snapped = { lat: best.qy, lon: best.qx / cosLat };
  return { index: best.i, along: a.dist + best.t * (b.dist - a.dist), distToTrack: haversine(p, snapped), snapped };
}

export function interpolateAt(points, along) {
  if (!points || !points.length) return null;
  if (along <= 0) return { ...points[0], index: 0 };
  const last = points[points.length - 1];
  if (along >= last.dist) return { ...last, index: points.length - 1 };
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].dist <= along) lo = mid; else hi = mid; }
  const a = points[lo], b = points[hi];
  const t = b.dist - a.dist > 0 ? (along - a.dist) / (b.dist - a.dist) : 0;
  return {
    lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon),
    ele: a.ele != null && b.ele != null ? a.ele + t * (b.ele - a.ele) : undefined, index: lo
  };
}

// Ascent/descent with hysteresis so GPS noise does not inflate totals.
export function elevationStats(samples, thresh = 5) {
  let asc = 0, desc = 0, min = Infinity, max = -Infinity, ref = null;
  for (const s of samples) {
    if (s.ele == null) continue;
    min = Math.min(min, s.ele); max = Math.max(max, s.ele);
    if (ref == null) { ref = s.ele; continue; }
    const d = s.ele - ref;
    if (d >= thresh) { asc += d; ref = s.ele; } else if (d <= -thresh) { desc -= d; ref = s.ele; }
  }
  if (ref == null) return { ascent: 0, descent: 0, min: null, max: null };
  return { ascent: Math.round(asc), descent: Math.round(desc), min: Math.round(min), max: Math.round(max) };
}

function sqSegDist(p, a, b) {
  let x = a.lon, y = a.lat, dx = b.lon - x, dy = b.lat - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p.lon - x) * dx + (p.lat - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b.lon; y = b.lat; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p.lon - x; dy = p.lat - y;
  return dx * dx + dy * dy;
}

// Douglas-Peucker, tolerance in degrees (0.0001 ~ 10 m).
export function simplify(points, tol) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]], sqTol = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) { const d = sqSegDist(points[i], points[s], points[e]); if (d > maxD) { maxD = d; idx = i; } }
    if (maxD > sqTol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

export function inSwitzerland(points) {
  const p = points[Math.floor(points.length / 2)];
  return !!p && p.lat > 45.7 && p.lat < 47.95 && p.lon > 5.8 && p.lon < 10.6;
}

// Rough cycling time estimate: ~17 km/h on the flat plus ~6 s per metre of climbing.
export function estimateTime(dist, ascent) { return dist / (17 / 3.6) + (ascent || 0) * 6; }

export const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(m >= 100000 ? 0 : 1) + ' km' : Math.round(m) + ' m';
export const fmtDuration = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`; };
export const fmtSpeed = ms => (Math.max(0, ms) * 3.6).toFixed(1) + ' km/h';
export const fmtTime = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
