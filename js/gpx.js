// GPX parsing and writing.
function num(el, sel) { const e = el.querySelector(sel); if (!e) return undefined; const v = parseFloat(e.textContent); return isFinite(v) ? v : undefined; }

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid GPX/XML file');
  const nameEl = doc.querySelector('trk > name') || doc.querySelector('rte > name') || doc.querySelector('metadata > name');
  const name = nameEl ? nameEl.textContent.trim() : '';
  const points = [];
  const grab = sel => doc.querySelectorAll(sel).forEach(el => {
    const lat = parseFloat(el.getAttribute('lat')), lon = parseFloat(el.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return;
    const p = { lat, lon };
    const ele = num(el, 'ele'); if (ele !== undefined) p.ele = ele;
    const t = el.querySelector('time'); if (t) { const ts = Date.parse(t.textContent); if (isFinite(ts)) p.time = ts; }
    const last = points[points.length - 1];
    if (!last || last.lat !== lat || last.lon !== lon) points.push(p);
  });
  grab('trkpt');
  if (!points.length) grab('rtept');
  const waypoints = [...doc.querySelectorAll('wpt')].map(el => ({
    lat: parseFloat(el.getAttribute('lat')), lon: parseFloat(el.getAttribute('lon')),
    name: el.querySelector('name')?.textContent.trim() || '', ele: num(el, 'ele')
  })).filter(w => isFinite(w.lat) && isFinite(w.lon));
  if (!points.length && !waypoints.length) throw new Error('No track, route or waypoints found');
  return { name, points, waypoints };
}

const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function toGPX(route) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="VeloCH" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${esc(route.name)}</name><time>${new Date(route.createdAt || Date.now()).toISOString()}</time></metadata>`];
  for (const w of route.waypoints || []) {
    if (w.lat == null) continue;
    lines.push(`  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">${w.ele != null ? `<ele>${w.ele.toFixed(1)}</ele>` : ''}${w.name ? `<name>${esc(w.name)}</name>` : ''}</wpt>`);
  }
  lines.push(`  <trk><name>${esc(route.name)}</name><trkseg>`);
  for (const p of route.points) {
    lines.push(`    <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${p.ele != null ? `<ele>${Number(p.ele).toFixed(1)}</ele>` : ''}${p.time ? `<time>${new Date(p.time).toISOString()}</time>` : ''}</trkpt>`);
  }
  lines.push('  </trkseg></trk>', '</gpx>');
  return lines.join('\n');
}
