// Nearby public transport, cable cars, bike shops, water: OpenStreetMap via Overpass + Swiss timetable API.
const ENDPOINTS = ['https://overpass.osm.ch/api/interpreter', 'https://overpass-api.de/api/interpreter'];

export const CATEGORIES = [
  { id: 'train', label: 'Train', glyph: '🚆', color: '#c62828', point: bb => `nwr["railway"~"^(station|halt)$"]["station"!="subway"]${bb};nwr["public_transport"="station"]["train"="yes"]${bb};` },
  { id: 'bus', label: 'Bus / Postauto', glyph: '🚌', color: '#f9a825', point: bb => `node["highway"="bus_stop"]${bb};` },
  { id: 'cable', label: 'Cable car / lift', glyph: '🚡', color: '#6a1b9a', line: bb => `way["aerialway"~"^(cable_car|gondola|mixed_lift|chair_lift)$"]${bb};way["railway"="funicular"]${bb};` },
  { id: 'boat', label: 'Boat', glyph: '⛴', color: '#0277bd', default: false, point: bb => `nwr["amenity"="ferry_terminal"]${bb};` },
  { id: 'bike', label: 'Bike shop / repair', glyph: '🔧', color: '#2e7d32', point: bb => `nwr["shop"="bicycle"]${bb};nwr["amenity"="bicycle_repair_station"]${bb};` },
  { id: 'water', label: 'Drinking water', glyph: '💧', color: '#0288d1', default: false, point: bb => `node["amenity"="drinking_water"]${bb};` },
];
const byId = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

function categorize(t) {
  if (t.aerialway || t.railway === 'funicular') return 'cable';
  if (t.railway === 'station' || t.railway === 'halt' || t.public_transport === 'station') return 'train';
  if (t.highway === 'bus_stop') return 'bus';
  if (t.amenity === 'ferry_terminal') return 'boat';
  if (t.shop === 'bicycle' || t.amenity === 'bicycle_repair_station') return 'bike';
  if (t.amenity === 'drinking_water') return 'water';
  return null;
}

const AERIAL_NAMES = { cable_car: 'Cable car', gondola: 'Gondola', mixed_lift: 'Gondola / chairlift', chair_lift: 'Chairlift', funicular: 'Funicular' };

export function typeLabel(it) {
  const t = it.tags;
  if (it.cat === 'cable') return AERIAL_NAMES[t.aerialway] || (t.railway === 'funicular' ? 'Funicular' : 'Lift');
  if (it.cat === 'train') return t.railway === 'halt' ? 'Train halt' : 'Train station';
  if (it.cat === 'bike') return t.shop === 'bicycle' ? 'Bike shop' : 'Repair station';
  return byId[it.cat]?.label || '';
}

export async function searchNearby(b, cats) {
  const bb = `(${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)})`;
  const pointQ = [], lineQ = [];
  for (const c of CATEGORIES) { if (!cats.includes(c.id)) continue; if (c.point) pointQ.push(c.point(bb)); if (c.line) lineQ.push(c.line(bb)); }
  let q = '[out:json][timeout:25];';
  if (pointQ.length) q += `(${pointQ.join('')});out tags center;`;
  if (lineQ.length) q += `(${lineQ.join('')});out geom;`;
  let lastErr;
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(ep, { method: 'POST', body: new URLSearchParams({ data: q }) });
      if (!res.ok) throw new Error('Overpass ' + res.status);
      const data = await res.json();
      return normalize(data.elements || []);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Overpass unavailable');
}

function normalize(elements) {
  const items = [], seen = new Map();
  for (const el of elements) {
    const tags = el.tags || {}; const cat = categorize(tags); if (!cat) continue;
    let lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon, geometry = null;
    if (el.geometry?.length) { geometry = el.geometry.map(g => [g.lat, g.lon]); if (lat == null) { lat = geometry[0][0]; lon = geometry[0][1]; } }
    if (lat == null) continue;
    const name = tags.name || tags['name:de'] || tags['name:fr'] || tags['name:it'] || tags.ref || tags.operator || typeLabel({ cat, tags });
    const key = cat + ':' + name.toLowerCase();
    const prev = seen.get(key);
    if (prev && (cat === 'bus' || cat === 'train') && Math.hypot((prev.lat - lat) * 111000, (prev.lon - lon) * 75000) < 400) { if (el.type === 'node' && prev.type !== 'node') Object.assign(prev, { lat, lon, type: 'node' }); continue; }
    const c = byId[cat];
    const it = { id: el.type + '/' + el.id, type: el.type, cat, name, lat, lon, geometry, tags, glyph: c.glyph, color: c.color };
    seen.set(key, it); items.push(it);
  }
  return items;
}

export function describeOpening(tags) {
  const oh = tags.opening_hours;
  if (!oh) return { state: 'unknown', text: null, note: tags.seasonal ? `Seasonal: ${tags.seasonal}` : tags['opening_hours:signed'] === 'no' ? 'No signed hours' : null };
  try {
    if (typeof opening_hours === 'undefined') throw new Error('lib');
    const o = new opening_hours(oh, { address: { country_code: 'ch', state: 'Bern' } }, { locale: 'en' });
    const now = new Date();
    const unknown = o.getUnknown(now), open = o.getState(now), next = o.getNextChange(now);
    return { state: unknown ? 'unknown' : open ? 'open' : 'closed', text: oh, next, comment: o.getComment(now) || null };
  } catch { return { state: 'unknown', text: oh, note: null }; }
}

// Score how well a timetable stop name matches a POI name (e.g. "Firstbahn" vs "Grindelwald (Firstbahn)").
function nameScore(a, b) {
  const norm = s => s.toLowerCase().replace(/[()\-–,.]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const ta = norm(a), tb = new Set(norm(b));
  return ta.filter(w => tb.has(w) || [...tb].some(x => x.includes(w) || w.includes(x))).length;
}

export async function departures(lat, lon, preferName = null) {
  const r = await fetch(`https://transport.opendata.ch/v1/locations?x=${lat.toFixed(5)}&y=${lon.toFixed(5)}&type=station`);
  if (!r.ok) throw new Error('timetable ' + r.status);
  const cands = ((await r.json()).stations || []).filter(s => s.id && (s.distance == null || s.distance < 1500));
  let st = cands[0];
  if (preferName) { const scored = cands.map(s => ({ s, sc: nameScore(preferName, s.name) })).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc || a.s.distance - b.s.distance); if (scored[0]) st = scored[0].s; }
  if (!st) throw new Error('No timetable stop within 1.5 km');
  const b = await fetch(`https://transport.opendata.ch/v1/stationboard?id=${st.id}&limit=10`);
  if (!b.ok) throw new Error('timetable ' + b.status);
  const data = await b.json();
  return {
    station: { id: st.id, name: st.name, distance: st.distance },
    board: (data.stationboard || []).map(d => ({ time: d.stop.departure ? new Date(d.stop.departure) : null, delay: d.stop.delay, platform: d.stop.platform, cat: d.category, number: d.number, to: d.to, operator: d.operator }))
  };
}
