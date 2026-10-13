// VeloCH – app glue: UI, routes, planning, navigation, nearby search.
import { createMap, BASE_LAYERS, OVERLAYS } from './map.js';
import { parseGPX, toGPX } from './gpx.js';
import { cumulative, elevationStats, interpolateAt, estimateTime, fmtDist, fmtDuration, fmtSpeed, fmtTime, haversine } from './geo.js';
import { buildProfile, swisstopoProfile } from './elevation.js';
import { ElevationChart } from './profile.js';
import { PROFILES, routeBRouter } from './router.js';
import { Navigator } from './nav.js';
import { CATEGORIES, searchNearby, describeOpening, departures, typeLabel } from './nearby.js';
import { routesDB, ridesDB, photosDB, settings } from './storage.js';
import { processImage, readExif, placePhoto } from './photos.js';
import { DEFAULT_PROFILE, rideStats, estimateRouteKcal } from './fitness.js';
import { renderDashboard, buildExport, ridesCSV } from './dashboard.js';
import { tilesForRoute, cacheTiles, tileCacheInfo, clearTileCache, tileUrl } from './offline.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isMobile = () => matchMedia('(max-width: 899px), (max-height: 499px)').matches;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const state = {
  routes: [], route: null, tab: 'routes',
  plan: { waypoints: [], profile: settings.get('profile', 'trekking'), abort: null, id: null },
  navigating: false, follow: true, pos: null, headingPos: null, heading: null, watchId: null, flyOnFix: false,
  nearby: [], deferredInstall: null, wakeLock: null, lastRide: null, rides: [], metric: settings.get('metric', 'distance'),
  photos: [], photoRide: null, lbIndex: -1,
};
const profileSettings = () => ({ ...DEFAULT_PROFILE, ...settings.get('profile', {}) });

const mapApi = createMap($('#map'));
const { map } = mapApi;
const chart = new ElevationChart($('#profile'), {
  onHover: ({ dist }) => { const p = state.route && interpolateAt(state.route.points, dist); if (p) mapApi.setHover(p); },
  onLeave: () => mapApi.setHover(null),
});
const nav = new Navigator({ onUpdate: onNavUpdate, onEvent: onNavEvent });

let toastTimer;
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms); }

// ---------- bottom sheet / tabs
function sheetLevel() { const p = $('#panel'); return p.classList.contains('full') ? 'full' : p.classList.contains('half') ? 'half' : 'collapsed'; }
function setSheet(level) { const p = $('#panel'); p.classList.remove('collapsed', 'half', 'full'); p.classList.add(level); }
$('#panel-handle').addEventListener('click', () => { const l = sheetLevel(); setSheet(l === 'collapsed' ? 'half' : l === 'half' ? 'full' : 'collapsed'); });
(() => {
  const p = $('#panel'), h = $('#panel-handle'); let startY = null, startH = 0, moved = false;
  h.addEventListener('touchstart', e => { startY = e.touches[0].clientY; startH = p.getBoundingClientRect().height; moved = false; p.style.transition = 'none'; }, { passive: true });
  h.addEventListener('touchmove', e => { if (startY == null) return; const dy = startY - e.touches[0].clientY; if (Math.abs(dy) > 6) moved = true; p.style.height = Math.max(60, Math.min(innerHeight * 0.92, startH + dy)) + 'px'; }, { passive: true });
  h.addEventListener('touchend', () => {
    if (startY == null) return; const hh = p.getBoundingClientRect().height; p.style.height = ''; p.style.transition = ''; startY = null;
    if (moved) setSheet(hh < innerHeight * 0.28 ? 'collapsed' : hh < innerHeight * 0.68 ? 'half' : 'full');
  });
})();
function setTab(name) {
  state.tab = name;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  document.body.classList.toggle('planning', name === 'plan' && !state.navigating);
  if (isMobile() && sheetLevel() === 'collapsed') setSheet('half');
  if (name === 'nav') renderNavIdle();
  if (name === 'stats') renderStats();
}
$$('#tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#goto-plan').onclick = () => setTab('plan');

// ---------- routes
async function makeRoute({ name, points, source, waypoints = [], hints = [], profile = null, quick = false, id = null }) {
  const pts = [];
  for (const p of points) { const l = pts[pts.length - 1]; if (!l || l.lat !== p.lat || l.lon !== p.lon) pts.push({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.time }); }
  const distance = cumulative(pts);
  let samples = null, eleSource = null;
  try { const r = await buildProfile(pts, { preferSwisstopo: !quick }); if (r) { samples = r.samples; eleSource = r.source; } } catch (e) { console.warn(e); }
  const es = samples ? elevationStats(samples) : { ascent: 0, descent: 0, min: null, max: null };
  return { id: id || uuid(), name: name || 'Route', source, createdAt: Date.now(), points: pts, samples, eleSource, stats: { distance, ...es, time: estimateTime(distance, es.ascent), kcal: samples ? estimateRouteKcal(samples, profileSettings()) : null }, hints, waypoints, profile };
}
const serialize = r => { const { _tmp, ...rest } = r; return { ...rest, points: r.points.map(p => [p.lat, p.lon, p.ele ?? null, p.time ?? null]) }; };
function deserialize(rec) { const points = rec.points.map(a => ({ lat: a[0], lon: a[1], ele: a[2] ?? undefined, time: a[3] ?? undefined })); cumulative(points); return { ...rec, points }; }
const isSaved = r => !!r && state.routes.some(x => x.id === r.id);

function statsHtml(st) {
  const tiles = [[fmtDist(st.distance), 'Distance'], ['↑ ' + (st.ascent ?? 0) + ' m', 'Ascent'], ['↓ ' + (st.descent ?? 0) + ' m', 'Descent'], [fmtDuration(st.time || 0), 'Est. time']];
  if (st.max != null) tiles.push([st.max + ' m', 'Highest point']);
  if (st.kcal != null) tiles.push(['~' + st.kcal + ' kcal', 'Est. energy']);
  return tiles.map(([v, l]) => `<div class="stat"><span class="v">${v}</span><span class="l">${l}</span></div>`).join('');
}
function setActiveRoute(route, { fit = true } = {}) {
  state.route = route;
  chart.setData(route.samples);
  $('#profile-box').hidden = !route.samples; document.body.classList.toggle('has-profile', !!route.samples);
  mapApi.showRoute(route.points, { fit, color: route.source === 'plan' ? '#1565c0' : '#d81b60' });
  $('#btn-fit').hidden = false;
  renderRouteCard(); renderNavIdle();
}
function clearActiveRoute() {
  state.route = null; mapApi.clearRoute(); chart.setData(null); clearPhotos();
  $('#profile-box').hidden = true; document.body.classList.remove('has-profile'); $('#btn-fit').hidden = true;
  renderRouteCard(); renderNavIdle(); renderPlanStats();
}
function sourceLabel(r) { return { plan: 'Planned route (unsaved)', planned: 'Planned route', gpx: 'Imported GPX', ride: 'Recorded ride', saved: 'Saved route' }[r.source] || 'Route'; }
function renderRouteCard() {
  const card = $('#route-card'), r = state.route;
  if (!r) { card.hidden = true; return; }
  card.hidden = false;
  $('#rc-name').textContent = r.name;
  $('#rc-meta').textContent = sourceLabel(r) + (r.eleSource ? ' · elevation from ' + (r.eleSource === 'swisstopo' ? 'swisstopo terrain model' : 'file') : ' · no elevation data');
  $('#rc-stats').innerHTML = statsHtml(r.stats);
  $('#rc-save').hidden = isSaved(r);
}
$('#rc-close').onclick = clearActiveRoute;
$('#rc-nav').onclick = () => startNavigation(state.route);
$('#rc-gpx').onclick = () => exportGPX(state.route);
$('#rc-save').onclick = () => saveRoute(state.route);
$('#rc-offline').onclick = () => cacheRouteTiles(state.route);
$('#btn-fit').onclick = () => mapApi.fitRoute();

async function loadRoutes() {
  try { const recs = await routesDB.all(); state.routes = recs.map(deserialize).sort((a, b) => b.createdAt - a.createdAt); }
  catch (e) { console.warn(e); toast('Could not open local storage'); }
  renderRouteList(); renderRouteCard();
}
function renderRouteList() {
  const ul = $('#route-list'); ul.innerHTML = ''; $('#routes-empty').hidden = state.routes.length > 0;
  for (const r of state.routes) {
    const li = document.createElement('li'); li.className = 'route-item';
    li.innerHTML = `<div class="ri-main"><strong>${esc(r.name)}</strong><div class="meta">${fmtDist(r.stats.distance)} · ↑ ${r.stats.ascent} m · ${sourceLabel(r)} · ${new Date(r.createdAt).toLocaleDateString()}</div></div>
      <div class="ri-actions"><button data-a="show">Show</button><button data-a="nav" class="primary" title="Navigate">▶</button><button data-a="menu" title="More">⋯</button></div>`;
    $('[data-a=show]', li).onclick = () => { setActiveRoute(r); if (isMobile()) setSheet('collapsed'); };
    $('[data-a=nav]', li).onclick = () => { setActiveRoute(r); startNavigation(r); };
    $('[data-a=menu]', li).onclick = () => routeMenu(r, li);
    ul.appendChild(li);
  }
}
function routeMenu(r, li) {
  let m = $('.ri-menu', li); if (m) { m.remove(); return; }
  m = document.createElement('div'); m.className = 'ri-menu row wrap';
  m.innerHTML = `<button data-a="gpx">Export GPX</button><button data-a="offline">Offline maps</button><button data-a="rename">Rename</button><button data-a="rev">Reverse</button><button data-a="del" class="danger">Delete</button>`;
  $('[data-a=gpx]', m).onclick = () => exportGPX(r);
  $('[data-a=offline]', m).onclick = () => { setActiveRoute(r); cacheRouteTiles(r); };
  $('[data-a=rename]', m).onclick = async () => { const n = prompt('Route name', r.name); if (n && n.trim()) { r.name = n.trim(); await routesDB.put(serialize(r)); renderRouteList(); if (state.route?.id === r.id) renderRouteCard(); } };
  $('[data-a=rev]', m).onclick = async () => { toast('Reversing…'); const nr = await makeRoute({ name: r.name + ' (reversed)', points: [...r.points].reverse(), source: 'saved' }); await routesDB.put(serialize(nr)); await loadRoutes(); setActiveRoute(nr); };
  $('[data-a=del]', m).onclick = async () => { if (!confirm(`Delete "${r.name}"?`)) return; await routesDB.del(r.id); if (state.route?.id === r.id) clearActiveRoute(); await loadRoutes(); };
  li.appendChild(m);
}
async function saveRoute(r) {
  if (!r) return;
  const name = prompt('Save route as', r.name); if (name == null) return;
  r.name = name.trim() || r.name;
  if (r.source === 'plan') { r.source = 'planned'; state.plan.id = null; }
  if (r.eleSource !== 'swisstopo' && navigator.onLine) {
    try { r.samples = await swisstopoProfile(r.points); r.eleSource = 'swisstopo'; const es = elevationStats(r.samples); r.stats = { ...r.stats, ...es, time: estimateTime(r.stats.distance, es.ascent) }; chart.setData(r.samples); } catch (e) { console.warn(e); }
  }
  r.createdAt = r.createdAt || Date.now();
  await routesDB.put(serialize(r)); await loadRoutes(); renderRouteCard(); renderPlanStats(); toast('Route saved');
}

// ---------- GPX import / export
$('#gpx-file').addEventListener('change', async e => { const files = [...e.target.files]; e.target.value = ''; await importFiles(files); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); const files = [...e.dataTransfer.files].filter(f => /\.gpx$/i.test(f.name) || f.type.includes('xml')); if (files.length) importFiles(files); });
async function importFiles(files) {
  let last = null;
  for (const f of files) {
    try {
      toast(`Importing ${f.name}…`, 15000);
      const g = parseGPX(await f.text());
      if (g.points.length < 2) throw new Error('No track points in file');
      const r = await makeRoute({ name: g.name || f.name.replace(/\.gpx$/i, ''), points: g.points, source: 'gpx', waypoints: g.waypoints });
      await routesDB.put(serialize(r)); last = r;
    } catch (err) { toast(`${f.name}: ${err.message}`, 6000); }
  }
  await loadRoutes();
  if (last) { setTab('routes'); setActiveRoute(last); toast(`Imported "${last.name}"`); if (isMobile()) setSheet('collapsed'); }
}
async function exportGPX(r) {
  if (!r) return;
  const xml = toGPX(r), fname = (r.name || 'route').replace(/[^\w\-]+/g, '_') + '.gpx';
  const file = new File([xml], fname, { type: 'application/gpx+xml' });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && isMobile()) { try { await navigator.share({ files: [file], title: r.name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = fname; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// ---------- planning
const planProfile = $('#plan-profile');
PROFILES.forEach(p => planProfile.add(new Option(p.label, p.id)));
planProfile.value = state.plan.profile;
planProfile.onchange = () => { state.plan.profile = planProfile.value; settings.set('profile', planProfile.value); recalcPlan(); };
map.on('click', e => {
  $('#layer-panel').hidden = true; $('#search-results').hidden = true;
  if (state.tab === 'plan' && !state.navigating) addWaypoint({ lat: e.latlng.lat, lon: e.latlng.lng });
});
function addWaypoint(p, at = null) {
  if (at == null) state.plan.waypoints.push(p); else state.plan.waypoints.splice(at, 0, p);
  refreshWaypoints(); recalcPlan();
}
function refreshWaypoints() {
  mapApi.setWaypoints(state.plan.waypoints, {
    onDrag: (i, p) => { state.plan.waypoints[i] = p; recalcPlan(); },
    onClick: i => { state.plan.waypoints.splice(i, 1); refreshWaypoints(); recalcPlan(); },
  });
  const none = !state.plan.waypoints.length;
  $('#plan-undo').disabled = $('#plan-clear').disabled = none; $('#plan-reverse').disabled = state.plan.waypoints.length < 2;
}
let planTimer;
function recalcPlan() { clearTimeout(planTimer); planTimer = setTimeout(doRecalc, 250); }
async function doRecalc() {
  const wps = state.plan.waypoints; state.plan.abort?.abort();
  if (wps.length < 2) { if (state.route?.source === 'plan') clearActiveRoute(); $('#plan-status').textContent = wps.length === 1 ? 'Add a destination.' : ''; renderPlanStats(); return; }
  const ctrl = new AbortController(); state.plan.abort = ctrl;
  $('#plan-status').textContent = 'Calculating route…';
  try {
    const res = await routeBRouter(wps, state.plan.profile, { signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    state.plan.id ||= uuid();
    const r = await makeRoute({ name: 'Planned route', points: res.points, source: 'plan', hints: res.hints, waypoints: wps.slice(), profile: state.plan.profile, quick: true, id: state.plan.id });
    if (ctrl.signal.aborted) return;
    r.routerTime = res.time;
    setActiveRoute(r, { fit: false });
    $('#plan-status').textContent = '';
  } catch (e) { if (e.name === 'AbortError') return; $('#plan-status').textContent = 'Routing failed: ' + e.message; }
  renderPlanStats();
}
function renderPlanStats() {
  const r = state.route?.source === 'plan' || state.route?.source === 'planned' ? state.route : null;
  $('#plan-stats').innerHTML = r ? statsHtml(r.stats) : '';
  $('#plan-save').disabled = !r || isSaved(r); $('#plan-export').disabled = $('#plan-nav').disabled = !r;
}
$('#plan-undo').onclick = () => { state.plan.waypoints.pop(); refreshWaypoints(); recalcPlan(); };
$('#plan-clear').onclick = () => { state.plan.waypoints = []; state.plan.id = null; refreshWaypoints(); recalcPlan(); };
$('#plan-reverse').onclick = () => { state.plan.waypoints.reverse(); state.plan.id = null; refreshWaypoints(); recalcPlan(); };
$('#plan-save').onclick = () => saveRoute(state.route);
$('#plan-export').onclick = () => exportGPX(state.route);
$('#plan-nav').onclick = () => startNavigation(state.route);

// ---------- GPS
function startGPS() {
  if (state.watchId != null) return;
  if (!('geolocation' in navigator)) return toast('This browser has no GPS/geolocation support');
  if (!isSecureContext) return toast('GPS only works over HTTPS (or localhost)');
  state.watchId = navigator.geolocation.watchPosition(onGeo, e => toast('GPS: ' + e.message, 5000), { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  $('#btn-locate').classList.add('active');
}
function stopGPS() { if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId); state.watchId = null; $('#btn-locate').classList.remove('active'); }
function onGeo(p) {
  const pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, heading: p.coords.heading, speed: p.coords.speed, t: p.timestamp };
  state.pos = pos;
  if (pos.heading != null && isFinite(pos.heading)) state.heading = pos.heading;
  else if (state.headingPos && haversine(state.headingPos, pos) > 5) { state.heading = bearingDeg(state.headingPos, pos); state.headingPos = pos; }
  else if (!state.headingPos) state.headingPos = pos;
  mapApi.setPosition(pos, state.heading);
  if (state.flyOnFix) { state.flyOnFix = false; map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 15)); }
  if (state.navigating) { nav.feed(pos); if (state.follow) map.panTo([pos.lat, pos.lon], { animate: true, duration: 0.4 }); }
}
function bearingDeg(a, b) { const y = Math.sin((b.lon - a.lon) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180); const x = Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180) - Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((b.lon - a.lon) * Math.PI / 180); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; }
$('#btn-locate').onclick = () => {
  if (state.watchId != null && !state.navigating && state.pos && map.getBounds().contains([state.pos.lat, state.pos.lon]) && map.getZoom() >= 14) { stopGPS(); return; }
  if (state.pos) map.setView([state.pos.lat, state.pos.lon], Math.max(map.getZoom(), 15)); else { toast('Locating…'); state.flyOnFix = true; }
  startGPS();
};
map.on('dragstart', () => { if (state.navigating) { state.follow = false; $('#btn-recenter').hidden = false; } });
function recenter() { state.follow = true; $('#btn-recenter').hidden = true; if (state.pos) map.panTo([state.pos.lat, state.pos.lon]); }
$('#btn-recenter').onclick = recenter; $('#nav-recenter').onclick = recenter;

// ---------- navigation & rides
$('#nav-voice').checked = settings.get('voice', true); $('#nav-voice').onchange = e => settings.set('voice', e.target.checked);
$('#nav-keep').checked = settings.get('keepawake', true); $('#nav-keep').onchange = e => settings.set('keepawake', e.target.checked);
function speak(text) {
  if (!settings.get('voice', true) || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; speechSynthesis.speak(u); } catch { }
}
async function requestWakeLock() {
  if (!settings.get('keepawake', true) || !navigator.wakeLock) return;
  try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch { }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.navigating) { requestWakeLock(); startGPS(); } });
function renderNavIdle() {
  const r = state.route;
  $('#nav-route-info').textContent = r ? `Ready: "${r.name}" · ${fmtDist(r.stats.distance)} · ↑ ${r.stats.ascent} m${r.hints?.length ? ' · turn-by-turn' : ' · follow-the-track'}` : 'Select a saved route or plan one, then start. "Free ride" just records your track.';
  $('#nav-start').disabled = !r;
}

let ride = null, persistTimer = null;
async function loadRides() { try { state.rides = (await ridesDB.all()).sort((a, b) => b.startedAt - a.startedAt); } catch (e) { console.warn(e); } }

async function startNavigation(route, resumeRide = null) {
  if (route && route.points.length < 2) return toast('Route has no track');
  if (!('geolocation' in navigator)) return toast('No GPS available in this browser');
  if (!isSecureContext) return toast('GPS needs HTTPS – open the site via https:// or localhost');
  if (state.navigating) return;
  ride = resumeRide || { id: uuid(), startedAt: Date.now(), status: 'active', mode: route ? 'nav' : 'free', routeId: route?.id || null, routeName: route?.name || null, points: [], distance: 0, movingTime: 0, maxSpeed: 0 };
  ride.status = 'active'; settings.set('activeRide', ride.id);
  try { await ridesDB.put(ride); } catch (e) { console.warn(e); }
  state.navigating = true; state.follow = true; $('#btn-recenter').hidden = true;
  document.body.classList.add('navigating'); document.body.classList.remove('planning');
  nav.start(route, resumeRide); startGPS(); requestWakeLock();
  mapApi.setTrail(nav.trail);
  if (resumeRide) showPhotos(ride.id); else clearPhotos();
  if (route) { setActiveRoute(route, { fit: false }); }
  if (state.pos) map.setView([state.pos.lat, state.pos.lon], Math.max(map.getZoom(), 15)); else state.flyOnFix = true;
  $('#nav-idle').hidden = true; $('#nav-active').hidden = false; $('#ride-done').hidden = true; $('#nav-hud').hidden = false; $('#nav-hud').classList.remove('off');
  $('#hud-icon').textContent = route ? '⤳' : '●'; $('#hud-instr').textContent = 'Waiting for GPS…'; $('#hud-then').textContent = ''; $('#hud-stats').innerHTML = '';
  setTab('nav'); if (isMobile()) setSheet('collapsed');
  speak(resumeRide ? 'Ride resumed' : route ? 'Navigation started' : 'Recording started');
}
// Save the ride so far every few seconds so nothing is lost on reload or crash.
function persistRide() {
  if (!ride || !nav.running || persistTimer) return;
  persistTimer = setTimeout(async () => { persistTimer = null; if (!ride || !nav.running) return; Object.assign(ride, nav.snapshot()); try { await ridesDB.put(ride); } catch (e) { console.warn(e); } }, 4000);
}
async function finalizeRide(r, pointsArr) {
  const pts = pointsArr.map(a => ({ lat: a[0], lon: a[1], ele: a[2] ?? undefined, time: a[3] }));
  cumulative(pts);
  r.endedAt = Math.max(Date.now(), pts[pts.length - 1]?.time || 0); r.status = 'done'; r.points = pointsArr;
  if (pts.length < 5 || pts[pts.length - 1].dist < 100) { try { await ridesDB.del(r.id); } catch { } settings.del('activeRide'); return null; }
  let samples = null;
  try { const prof = await buildProfile(pts); samples = prof?.samples || null; } catch (e) { console.warn(e); }
  Object.assign(r, rideStats(pts, samples, profileSettings()));
  r.name ||= r.routeName || `Ride ${new Date(r.startedAt).toLocaleDateString()}`;
  try { await ridesDB.put(r); } catch (e) { console.warn(e); toast('Could not save ride'); }
  settings.del('activeRide'); await loadRides();
  return r;
}
async function stopNavigation() {
  nav.stop(); clearTimeout(persistTimer); persistTimer = null;
  state.navigating = false; document.body.classList.remove('navigating');
  $('#nav-idle').hidden = false; $('#nav-active').hidden = true; $('#nav-hud').hidden = true; $('#nav-hud').classList.remove('big'); $('#btn-recenter').hidden = true;
  chart.setProgress(null); try { state.wakeLock?.release(); } catch { } state.wakeLock = null;
  const r = ride; ride = null;
  setTab('nav'); if (isMobile()) setSheet('half');
  if (r) {
    Object.assign(r, nav.snapshot());
    toast('Saving ride…', 8000);
    const done = await finalizeRide(r, r.points);
    if (done) showRideDone(done); else { toast('Ride too short – not saved'); mapApi.setTrail([]); }
  }
}
function showRideDone(r) {
  state.lastRide = r; $('#ride-done').hidden = false; showPhotos(r.id);
  $('#ride-done-stats').innerHTML = [[fmtDist(r.distance), 'Distance'], ['↑ ' + Math.round(r.ascent || 0) + ' m', 'Ascent'], [fmtDuration(r.movingTime), 'Moving'], [fmtSpeed(r.avgSpeed), 'Avg speed'], [Math.round(r.kcal) + ' kcal', 'Energy']].map(([v, l]) => `<div class="stat"><span class="v">${v}</span><span class="l">${l}</span></div>`).join('');
  toast(`Ride saved: ${fmtDist(r.distance)}, ${Math.round(r.kcal)} kcal`, 5000);
}
async function rideToRoute(r) {
  toast('Building route…', 8000);
  const pts = r.points.map(a => ({ lat: a[0], lon: a[1], ele: a[2] ?? undefined, time: a[3] }));
  const route = await makeRoute({ name: r.name || 'Ride', points: pts, source: 'ride' });
  return route;
}
$('#nav-start').onclick = () => startNavigation(state.route);
$('#nav-free').onclick = () => startNavigation(null);
$('#nav-stop').onclick = stopNavigation; $('#hud-stop').onclick = e => { e.stopPropagation(); stopNavigation(); };
$('#nav-hud').onclick = () => $('#nav-hud').classList.toggle('big');
$('#ride-ok').onclick = () => { $('#ride-done').hidden = true; mapApi.setTrail([]); };
$('#ride-stats-btn').onclick = () => setTab('stats');
$('#ride-route').onclick = async () => { if (!state.lastRide) return; const route = await rideToRoute(state.lastRide); await routesDB.put(serialize(route)); await loadRoutes(); setTab('routes'); setActiveRoute(route); toast('Saved as route'); };

// Resume an interrupted ride after a reload / crash.
async function checkResume() {
  const id = settings.get('activeRide'); if (!id) return;
  let r = null; try { r = await ridesDB.get(id); } catch { }
  if (!r || r.status !== 'active') { settings.del('activeRide'); return; }
  if (!r.points?.length) { try { await ridesDB.del(id); } catch { } settings.del('activeRide'); return; }
  const banner = $('#resume-banner'); banner.hidden = false;
  $('#resume-info').textContent = `since ${fmtTime(new Date(r.startedAt))} · ${fmtDist(r.distance || 0)}${r.routeName ? ' · ' + r.routeName : ''}`;
  mapApi.setTrail(r.points.map(a => ({ lat: a[0], lon: a[1] }))); showPhotos(r.id);
  $('#resume-yes').onclick = () => { banner.hidden = true; const route = r.routeId ? state.routes.find(x => x.id === r.routeId) || null : null; startNavigation(route, r); };
  $('#resume-finish').onclick = async () => { banner.hidden = true; toast('Saving ride…', 8000); const done = await finalizeRide(r, r.points); setTab('nav'); if (done) showRideDone(done); else { toast('Ride too short – discarded'); mapApi.setTrail([]); } };
  $('#resume-discard').onclick = async () => { if (!confirm('Discard the unfinished ride?')) return; banner.hidden = true; try { await ridesDB.del(id); } catch { } settings.del('activeRide'); mapApi.setTrail([]); };
}

const roundDist = m => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.max(10, Math.round(m / 10) * 10) + ' m';
function onNavUpdate(st) {
  const hasRoute = !!nav.route;
  persistRide();
  if (st.poor) { $('#hud-instr').textContent = 'Poor GPS signal…'; return; }
  if (hasRoute && st.nextHint) {
    $('#hud-icon').textContent = st.nextHint.icon;
    $('#hud-instr').textContent = (st.nextHint.distTo > 25 ? `In ${roundDist(st.nextHint.distTo)}: ` : 'Now: ') + st.nextHint.text;
    $('#hud-then').textContent = st.thenHint ? 'then ' + st.thenHint.text.toLowerCase() : '';
  } else if (hasRoute) {
    $('#hud-icon').textContent = st.offRoute ? '⚠' : '⤳';
    $('#hud-instr').textContent = st.offRoute ? `Off route – ${fmtDist(st.offDist)} from track` : st.remaining < 40 ? 'You have arrived' : 'Follow the track';
    $('#hud-then').textContent = '';
  } else { $('#hud-icon').textContent = '●'; $('#hud-instr').textContent = 'Recording ride'; $('#hud-then').textContent = ''; }
  $('#nav-hud').classList.toggle('off', !!st.offRoute);
  const stats = [[fmtSpeed(st.speed || 0), 'Speed'], [fmtDist(st.ridden), 'Ridden']];
  if (hasRoute && st.remaining != null) stats.push([fmtDist(st.remaining), 'To go'], ['↑ ' + Math.round(st.remainingAscent ?? 0) + ' m', 'Climb left'], [st.eta ? fmtTime(new Date(Date.now() + st.eta * 1000)) : '–', 'ETA']);
  stats.push([fmtDuration(st.elapsed), 'Time']);
  $('#hud-stats').innerHTML = stats.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
  $('#nav-stats').innerHTML = stats.map(([v, l]) => `<div class="stat"><span class="v">${v}</span><span class="l">${l}</span></div>`).join('');
  if (hasRoute && st.along != null) chart.setProgress(st.along);
  if (nav.trail.length % 3 === 0) mapApi.setTrail(nav.trail);
}
function onNavEvent(ev) {
  if (ev.type === 'speak') { speak(ev.text); if (!/^In /.test(ev.text)) navigator.vibrate?.(120); }
  else if (ev.type === 'offroute') { speak('You are off route'); navigator.vibrate?.([200, 100, 200]); toast('Off route – head back to the track'); }
  else if (ev.type === 'backontrack') speak('Back on track');
  else if (ev.type === 'arrived') { speak('You have reached your destination'); navigator.vibrate?.([100, 50, 100, 50, 300]); toast('Arrived 🎉'); }
}

// ---------- photos
let photoTarget = null;
async function showPhotos(rideId) {
  try { state.photos = (await photosDB.byRide(rideId)).sort((a, b) => a.time - b.time); } catch { state.photos = []; }
  state.photoRide = rideId; mapApi.setPhotos(state.photos, openLightbox);
}
function clearPhotos() { state.photos = []; state.photoRide = null; mapApi.setPhotos([], () => { }); }
// live=true: taken right now during the ride, pinned at the current GPS position.
async function addPhotos(files, rideRec, live) {
  if (!rideRec) return toast('Start a ride first – photos are attached to rides');
  let added = 0, how = '';
  for (const f of files) {
    try {
      toast(`Adding photo ${added + 1}/${files.length}…`, 15000);
      const [exif, img] = await Promise.all([readExif(f), processImage(f)]);
      const pos = live && state.pos ? { lat: state.pos.lat, lon: state.pos.lon, how: 'GPS position' } : placePhoto(rideRec.points, exif, live ? state.pos : null);
      if (!pos) throw new Error('No position for this photo yet');
      const ph = { id: uuid(), rideId: rideRec.id, time: live ? Date.now() : (exif.time || f.lastModified || Date.now()), lat: pos.lat, lon: pos.lon, how: pos.how, blob: img.blob, thumb: img.thumb, width: img.width, height: img.height };
      await photosDB.put(ph); added++; how = pos.how;
    } catch (e) { toast(`Photo failed: ${e.message}`, 5000); }
  }
  if (!added) return;
  rideRec.photoCount = (rideRec.photoCount || 0) + added;
  try { await ridesDB.put(rideRec); } catch { }
  await loadRides();
  if (state.photoRide === rideRec.id || live) await showPhotos(rideRec.id);
  if (state.tab === 'stats') renderStats();
  toast(added === 1 ? `Photo pinned (${how})` : `${added} photos added`, 4000);
}
function pickPhotosFor(r) { photoTarget = r; $('#photo-input').click(); }
$('#photo-input').addEventListener('change', async e => { const files = [...e.target.files]; e.target.value = ''; if (files.length && photoTarget) await addPhotos(files, photoTarget, false); });
$('#cam-input').addEventListener('change', async e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) await addPhotos(files, ride, true); });
const takePhoto = () => { if (!ride) return toast('Start a ride first'); $('#cam-input').click(); };
$('#hud-cam').onclick = e => { e.stopPropagation(); takePhoto(); };
$('#nav-cam').onclick = takePhoto;
$('#ride-photos').onclick = () => state.lastRide && pickPhotosFor(state.lastRide);
async function photoStrip(el, r) {
  const photos = (await photosDB.byRide(r.id).catch(() => [])).sort((a, b) => a.time - b.time);
  el.innerHTML = '';
  for (const ph of photos) { const img = document.createElement('img'); img.src = URL.createObjectURL(ph.thumb || ph.blob); img.onclick = async () => { if (state.photoRide !== r.id) await showPhotos(r.id); openLightbox(ph); }; el.appendChild(img); }
}
async function exportRideGPX(r) {
  const photos = (await photosDB.byRide(r.id).catch(() => [])).sort((a, b) => a.time - b.time);
  exportGPX({ name: r.name || 'Ride', createdAt: r.startedAt, points: r.points.map(a => ({ lat: a[0], lon: a[1], ele: a[2] ?? undefined, time: a[3] })), waypoints: photos.map((ph, i) => ({ lat: ph.lat, lon: ph.lon, name: `Photo ${i + 1} · ${fmtTime(new Date(ph.time))}` })) });
}
// Lightbox
let lbUrl = null;
function openLightbox(ph) {
  const i = state.photos.findIndex(x => x.id === ph.id); state.lbIndex = i >= 0 ? i : 0;
  renderLightbox(); $('#lightbox').hidden = false;
}
function renderLightbox() {
  const ph = state.photos[state.lbIndex]; if (!ph) { closeLightbox(); return; }
  if (lbUrl) URL.revokeObjectURL(lbUrl); lbUrl = URL.createObjectURL(ph.blob); $('#lb-img').src = lbUrl;
  $('#lb-cap').textContent = `${state.lbIndex + 1}/${state.photos.length} · ${new Date(ph.time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${ph.how}`;
  $('#lb-prev').disabled = state.lbIndex <= 0; $('#lb-next').disabled = state.lbIndex >= state.photos.length - 1;
  map.panTo([ph.lat, ph.lon]);
}
function closeLightbox() { $('#lightbox').hidden = true; if (lbUrl) { URL.revokeObjectURL(lbUrl); lbUrl = null; } }
$('#lb-close').onclick = closeLightbox;
$('#lb-prev').onclick = () => { state.lbIndex--; renderLightbox(); };
$('#lb-next').onclick = () => { state.lbIndex++; renderLightbox(); };
$('#lb-img').onclick = () => { if (state.lbIndex < state.photos.length - 1) { state.lbIndex++; renderLightbox(); } };
$('#lb-share').onclick = async () => {
  const ph = state.photos[state.lbIndex]; if (!ph) return;
  const file = new File([ph.blob], `veloch-${new Date(ph.time).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.jpg`, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
};
$('#lb-del').onclick = async () => {
  const ph = state.photos[state.lbIndex]; if (!ph || !confirm('Delete this photo?')) return;
  await photosDB.del(ph.id);
  const r = state.rides.find(x => x.id === ph.rideId) || (ride?.id === ph.rideId ? ride : null);
  if (r) { r.photoCount = Math.max(0, (r.photoCount || 1) - 1); try { await ridesDB.put(r); } catch { } }
  await loadRides(); await showPhotos(ph.rideId);
  if (state.photos.length) { state.lbIndex = Math.min(state.lbIndex, state.photos.length - 1); renderLightbox(); } else closeLightbox();
  if (state.tab === 'stats') renderStats();
};
document.addEventListener('keydown', e => { if ($('#lightbox').hidden) return; if (e.key === 'Escape') closeLightbox(); if (e.key === 'ArrowRight') $('#lb-next').click(); if (e.key === 'ArrowLeft') $('#lb-prev').click(); });

// ---------- stats dashboard
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function renderStats() {
  renderDashboard($('#dashboard'), {
    rides: state.rides, profile: profileSettings(), metric: state.metric,
    onMetric: m => { state.metric = m; settings.set('metric', m); renderStats(); },
    onProfile: p => { settings.set('profile', p); renderStats(); },
    onShowRide: async r => { const route = await rideToRoute(r); route.id = 'ride:' + r.id; setActiveRoute(route); showPhotos(r.id); setTab('routes'); if (isMobile()) setSheet('collapsed'); },
    onRideMenu: (r, li) => {
      let m = $('.rl-menu', li); if (m) { m.remove(); return; }
      m = document.createElement('div'); m.className = 'rl-menu row wrap';
      m.innerHTML = '<button data-a="photos">📷 Add photos</button><button data-a="gpx">Export GPX</button><button data-a="route">Save as route</button><button data-a="rename">Rename</button><button data-a="del" class="danger">Delete</button><div class="photo-strip"></div>';
      $('[data-a=photos]', m).onclick = () => pickPhotosFor(r);
      photoStrip($('.photo-strip', m), r);
      $('[data-a=gpx]', m).onclick = () => exportRideGPX(r);
      $('[data-a=route]', m).onclick = async () => { const route = await rideToRoute(r); await routesDB.put(serialize(route)); await loadRoutes(); setTab('routes'); setActiveRoute(route); toast('Saved as route'); };
      $('[data-a=rename]', m).onclick = async () => { const n = prompt('Ride name', r.name || ''); if (n != null && n.trim()) { r.name = n.trim(); await ridesDB.put(r); await loadRides(); renderStats(); } };
      $('[data-a=del]', m).onclick = async () => { if (!confirm('Delete this ride and its photos?')) return; for (const ph of await photosDB.byRide(r.id).catch(() => [])) await photosDB.del(ph.id); await ridesDB.del(r.id); if (state.photoRide === r.id) clearPhotos(); await loadRides(); renderStats(); };
      li.appendChild(m);
    },
    onExport: async kind => {
      const data = buildExport(state.rides, profileSettings()), day = new Date().toISOString().slice(0, 10);
      if (kind === 'json') download(`veloch-rides-${day}.json`, JSON.stringify(data, null, 2), 'application/json');
      else if (kind === 'csv') download(`veloch-rides-${day}.csv`, ridesCSV(state.rides), 'text/csv');
      else if (kind === 'copy') { const t = data.totals; const txt = `VeloCH · week ${t.this_week.distanceKm} km / ${t.this_week.kcal} kcal · month ${t.this_month.distanceKm} km / ${t.this_month.kcal} kcal · year ${t.this_year.distanceKm} km, ${t.this_year.rides} rides, ${t.this_year.kcal} kcal`; try { await navigator.clipboard.writeText(txt); toast('Summary copied'); } catch { prompt('Copy:', txt); } }
    },
  });
}

// ---------- nearby
const chips = $('#nearby-cats');
CATEGORIES.forEach(c => {
  const l = document.createElement('label'); l.className = 'chip';
  l.innerHTML = `<input type="checkbox" value="${c.id}" ${settings.get('cat:' + c.id, c.default !== false) ? 'checked' : ''}> ${c.glyph} ${c.label}`;
  $('input', l).onchange = e => settings.set('cat:' + c.id, e.target.checked);
  chips.appendChild(l);
});
const selectedCats = () => $$('#nearby-cats input:checked').map(i => i.value);
const centerPos = () => { const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; };
$('#nearby-area').onclick = () => { const b = map.getBounds(); runNearby(b, state.pos && b.contains([state.pos.lat, state.pos.lon]) ? state.pos : centerPos()); };
$('#nearby-me').onclick = () => {
  if (!state.pos) { startGPS(); state.flyOnFix = true; return toast('Waiting for a GPS fix – tap again in a moment'); }
  const b = L.latLng(state.pos.lat, state.pos.lon).toBounds(8000); map.fitBounds(b); runNearby(b, state.pos);
};
async function runNearby(bounds, ref) {
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  if (haversine({ lat: sw.lat, lon: sw.lng }, { lat: ne.lat, lon: ne.lng }) > 90000) return toast('Zoom in further – the area is too large');
  const cats = selectedCats(); if (!cats.length) return toast('Select at least one category');
  $('#nearby-status').textContent = 'Searching OpenStreetMap…'; $('#nearby-list').innerHTML = '';
  try {
    const items = await searchNearby({ south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng }, cats);
    for (const it of items) it.distance = haversine(ref, it);
    items.sort((a, b) => a.distance - b.distance);
    state.nearby = items; mapApi.setNearby(items, popupFor); renderNearby(items);
    $('#nearby-status').textContent = items.length ? `${items.length} places (sorted by distance)` : 'Nothing found in this area';
  } catch (e) { $('#nearby-status').textContent = 'Search failed: ' + e.message; }
}
function openingBadge(tags) { const o = describeOpening(tags); return o.state === 'unknown' && !o.text ? '' : `<span class="badge ${o.state}">${o.state === 'open' ? 'open' : o.state === 'closed' ? 'closed' : 'hours?'}</span>`; }
function renderNearby(items) {
  const ul = $('#nearby-list'); ul.innerHTML = '';
  for (const it of items.slice(0, 150)) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="poi-glyph" style="background:${it.color}22">${it.glyph}</div><div class="nb-main"><strong>${esc(it.name)}</strong><div class="sub">${esc(typeLabel(it))}${it.tags.operator ? ' · ' + esc(it.tags.operator) : ''} ${openingBadge(it.tags)}</div></div><div class="nb-dist">${fmtDist(it.distance)}</div>`;
    li.onclick = () => { map.setView([it.lat, it.lon], Math.max(map.getZoom(), 15)); it._marker?.openPopup(); if (isMobile()) setSheet('collapsed'); };
    ul.appendChild(li);
  }
}
function fmtNext(d) { if (!d) return ''; const now = new Date(); const sameDay = d.toDateString() === now.toDateString(); const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); return sameDay ? fmtTime(d) : d.toDateString() === tomorrow.toDateString() ? 'tomorrow ' + fmtTime(d) : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + fmtTime(d); }
function popupFor(it) { return (it._popupEl ||= buildPopup(it)); }
function buildPopup(it) {
  const t = it.tags, oh = describeOpening(t);
  const el = document.createElement('div'); el.className = 'poi-popup';
  const rows = [];
  if (t.operator) rows.push(['Operator', t.operator]);
  if (it.cat === 'cable') {
    if (t['aerialway:duration']) rows.push(['Ride time', t['aerialway:duration'] + ' min']);
    if (t.bicycle) rows.push(['Bikes', t.bicycle === 'yes' ? 'allowed' : t.bicycle]);
    if (t['aerialway:capacity']) rows.push(['Capacity', t['aerialway:capacity'] + ' /h']);
    if (t['aerialway:occupancy']) rows.push(['Cabin', t['aerialway:occupancy'] + ' persons']);
    if (t.seasonal && t.seasonal !== 'no') rows.push(['Season', t.seasonal]);
  }
  if (it.cat === 'bike' && t.service) rows.push(['Service', t.service.replace(/_/g, ' ')]);
  if (t.ele) rows.push(['Elevation', t.ele + ' m']);
  if (t.phone || t['contact:phone']) rows.push(['Phone', t.phone || t['contact:phone']]);
  const web = t.website || t['contact:website'] || t.url;
  const wantsHours = it.cat === 'cable' || it.cat === 'bike' || !!oh.text;
  const stateText = oh.state === 'open' ? 'Open now' : oh.state === 'closed' ? 'Closed now' : oh.text ? 'Hours (could not evaluate)' : it.cat === 'cable' ? 'No opening hours in OpenStreetMap – check departures / website' : 'No opening hours in OpenStreetMap';
  el.innerHTML = `<h4>${esc(it.name)}</h4><div class="poi-type">${esc(typeLabel(it))}${t.network ? ' · ' + esc(t.network) : ''} · ${fmtDist(it.distance || 0)} away</div>
    ${wantsHours ? `<div class="oh ${oh.state}">${stateText}${oh.next ? ' · ' + (oh.state === 'open' ? 'closes ' : 'opens ') + fmtNext(oh.next) : ''}</div>` : ''}
    ${oh.text ? `<div class="oh-raw">${esc(oh.text)}</div>` : ''}${oh.note ? `<div class="oh-raw">${esc(oh.note)}</div>` : ''}${oh.comment ? `<div class="oh-raw">${esc(oh.comment)}</div>` : ''}
    ${rows.length ? '<table>' + rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') + '</table>' : ''}
    <div class="row wrap">
      ${['train', 'bus', 'boat', 'cable'].includes(it.cat) ? `<button data-a="deps">${it.cat === 'cable' ? 'Timetable' : 'Departures'}</button>` : ''}
      ${web ? `<a class="btn" target="_blank" rel="noopener" href="${esc(/^https?:/.test(web) ? web : 'https://' + web)}">Website</a>` : it.cat === 'cable' ? `<a class="btn" target="_blank" rel="noopener" href="https://duckduckgo.com/?q=${encodeURIComponent(it.name + ' ' + (t.operator || '') + ' Betriebszeiten')}">Find hours</a>` : ''}
      <button data-a="to">Route here</button>
    </div><div class="deps"></div>`;
  $('[data-a=to]', el).onclick = () => { map.closePopup(); if (!state.plan.waypoints.length && state.pos) state.plan.waypoints.push({ lat: state.pos.lat, lon: state.pos.lon }); setTab('plan'); addWaypoint({ lat: it.lat, lon: it.lon }); };
  const depBtn = $('[data-a=deps]', el);
  if (depBtn) depBtn.onclick = async () => {
    const box = $('.deps', el); box.textContent = 'Loading timetable…'; depBtn.disabled = true;
    try {
      const d = await departures(it.lat, it.lon, it.cat === 'cable' ? it.name : null);
      box.innerHTML = `<b>${esc(d.station.name)}</b><ul>${d.board.map(x => `<li><b>${esc((x.cat || '') + (x.number && !/^\d+$/.test(x.cat || '') && x.cat !== x.number ? ' ' + x.number : ''))}</b><span class="to">→ ${esc(x.to)}</span><span>${x.time ? fmtTime(x.time) : ''}${x.delay ? `<span class="delay"> +${x.delay}</span>` : ''}${x.platform ? ` · Pl. ${esc(x.platform)}` : ''}</span></li>`).join('') || '<li>No departures listed</li>'}</ul>
        <a target="_blank" rel="noopener" href="https://www.sbb.ch/en?nach=${encodeURIComponent(d.station.name)}">Open in SBB timetable</a>`;
      if (it.cat === 'cable') box.insertAdjacentHTML('afterbegin', '<div class="hint small">Swiss lifts run on the official timetable – the first and last departures are the operating hours.</div>');
    } catch (e) { box.textContent = e.message; }
    depBtn.disabled = false;
    it._marker?.getPopup()?.update();
  };
  return el;
}

// ---------- search
const sInput = $('#search'), sRes = $('#search-results'); let sTimer, searchMarker;
sInput.addEventListener('input', () => { clearTimeout(sTimer); const q = sInput.value.trim(); if (q.length < 2) { sRes.hidden = true; return; } sTimer = setTimeout(() => doSearch(q), 300); });
sInput.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(sTimer); doSearch(sInput.value.trim(), true); } });
async function doSearch(q, pickFirst = false) {
  if (!q) return;
  try {
    const res = await fetch(`https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=${encodeURIComponent(q)}&type=locations&sr=4326&limit=8&lang=en`);
    const data = await res.json();
    const results = (data.results || []).map(r => ({ label: r.attrs.label.replace(/<[^>]+>/g, ''), lat: r.attrs.lat, lon: r.attrs.lon, origin: r.attrs.origin }));
    if (pickFirst && results[0]) return pickSearch(results[0]);
    sRes.innerHTML = results.map((r, i) => `<li data-i="${i}">${esc(r.label)}</li>`).join('') || '<li class="none">No results</li>';
    sRes.hidden = false;
    $$('li[data-i]', sRes).forEach(li => li.onclick = () => pickSearch(results[li.dataset.i]));
  } catch { sRes.innerHTML = '<li class="none">Search unavailable (offline?)</li>'; sRes.hidden = false; }
}
function pickSearch(r) {
  sRes.hidden = true; sInput.value = r.label; sInput.blur();
  const zoom = /gg25|district|kantone/.test(r.origin || '') ? 12 : 15;
  map.setView([r.lat, r.lon], zoom);
  if (searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.marker([r.lat, r.lon]).addTo(map);
  const el = document.createElement('div');
  el.innerHTML = `<b>${esc(r.label)}</b><div class="row"><button data-a="from">Route from here</button><button data-a="to">Route to here</button></div>`;
  $('[data-a=from]', el).onclick = () => { map.closePopup(); setTab('plan'); addWaypoint({ lat: r.lat, lon: r.lon }, 0); };
  $('[data-a=to]', el).onclick = () => { map.closePopup(); setTab('plan'); addWaypoint({ lat: r.lat, lon: r.lon }); };
  searchMarker.bindPopup(el).openPopup();
}
document.addEventListener('click', e => { if (!e.target.closest('.search')) sRes.hidden = true; if (!e.target.closest('#layer-panel') && !e.target.closest('#btn-layers')) $('#layer-panel').hidden = true; });

// ---------- layers & offline
function buildLayerPanel() {
  const base = settings.get('base', 'swisstopo-color'), ovs = settings.get('overlays', ['veloland']);
  const p = $('#layer-panel');
  p.innerHTML = '<h4>Base map</h4>' + Object.entries(BASE_LAYERS).map(([id, d]) => `<label><input type="radio" name="base" value="${id}" ${id === base ? 'checked' : ''}>${d.label}</label>`).join('')
    + '<h4>Overlays</h4>' + Object.entries(OVERLAYS).map(([id, d]) => `<label><input type="checkbox" name="ov" value="${id}" ${ovs.includes(id) ? 'checked' : ''}>${d.label}</label>`).join('')
    + '<h4>Offline maps</h4><div id="offline-info">…</div><button id="clear-tiles" class="small">Clear cached tiles</button><p class="hint small">swisstopo tiles you look at are cached automatically. Use “Offline maps” on a route to download its whole corridor beforehand.</p>';
  mapApi.setBase(base); ovs.forEach(id => mapApi.setOverlay(id, true));
  $$('input[name=base]', p).forEach(i => i.onchange = () => { mapApi.setBase(i.value); settings.set('base', i.value); });
  $$('input[name=ov]', p).forEach(i => i.onchange = () => { mapApi.setOverlay(i.value, i.checked); settings.set('overlays', $$('input[name=ov]:checked', p).map(x => x.value)); });
  $('#clear-tiles').onclick = async () => { if (!confirm('Delete all cached map tiles?')) return; await clearTileCache(); updateOfflineInfo(); toast('Cached tiles cleared'); };
}
$('#btn-layers').onclick = () => { const p = $('#layer-panel'); p.hidden = !p.hidden; if (!p.hidden) updateOfflineInfo(); };
async function updateOfflineInfo() { const i = await tileCacheInfo(); $('#offline-info').textContent = `${i.count.toLocaleString()} tiles cached · ${(i.usage / 1048576).toFixed(0)} MB used${i.quota ? ` of ${(i.quota / 1073741824).toFixed(1)} GB available` : ''}`; }
async function cacheRouteTiles(r) {
  if (!r) return;
  const baseId = settings.get('base', 'swisstopo-color'), def = BASE_LAYERS[baseId];
  if (!def.swiss) return toast('Offline download works with swisstopo base maps – switch the base map first', 5000);
  if (!navigator.onLine) return toast('You are offline');
  const tiles = tilesForRoute(r.points, [9, 10, 11, 12, 13, 14, 15, 16], 1);
  const urls = tiles.map(t => tileUrl(def.url, t));
  for (const id of settings.get('overlays', []).filter(id => OVERLAYS[id])) for (const t of tiles) if (t.z >= 12) urls.push(tileUrl(OVERLAYS[id].url, t));
  if (urls.length > 15000) return toast(`Route too long for one download (${urls.length} tiles). Split it into stages.`, 6000);
  if (!confirm(`Download ~${urls.length} map tiles (about ${Math.max(1, Math.round(urls.length * 22 / 1024))} MB) for offline use along this route?`)) return;
  setTab('routes'); if (isMobile()) setSheet('half');
  const prog = $('#rc-progress'); prog.hidden = false; const bar = $('div', prog), lbl = $('span', prog);
  const ctrl = new AbortController(); prog.onclick = () => ctrl.abort();
  lbl.textContent = 'Starting…';
  const res = await cacheTiles(urls, (done, total, failed) => { bar.style.width = (done / total * 100) + '%'; lbl.textContent = `${done} / ${total}${failed ? ` (${failed} failed)` : ''} · tap to cancel`; }, ctrl.signal);
  prog.hidden = true;
  toast(res.aborted ? 'Download cancelled' : `Offline maps ready: ${res.done - res.failed} tiles${res.failed ? `, ${res.failed} failed` : ''}`, 5000);
}

// ---------- install / service worker / misc
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); state.deferredInstall = e; $('#btn-install').hidden = false; });
$('#btn-install').onclick = async () => { state.deferredInstall?.prompt(); state.deferredInstall = null; $('#btn-install').hidden = true; };
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone) $('#ios-hint').hidden = false;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => { const nw = reg.installing; nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Update installed – reload to use the new version', 6000); }); });
  }).catch(e => console.warn('SW', e));
}
window.addEventListener('offline', () => toast('You are offline – cached maps and saved routes still work'));
window.addEventListener('online', () => toast('Back online'));
map.on('moveend', () => { const c = map.getCenter(); settings.set('view', { lat: c.lat, lon: c.lng, z: map.getZoom() }); });

// ---------- init
buildLayerPanel();
const v = settings.get('view'); if (v) map.setView([v.lat, v.lon], v.z);
refreshWaypoints();
loadRoutes().then(async () => { renderNavIdle(); await loadRides(); await checkResume(); });
if (!isMobile()) setSheet('full');
// Debug / automation hook (e.g. simulate GPS: __veloch.onGeo({coords:{latitude,longitude,accuracy,heading:null,speed:null},timestamp:Date.now()}))
window.__veloch = { state, nav, mapApi, onGeo, importFiles, setTab, startNavigation, stopNavigation, loadRides, renderStats };
