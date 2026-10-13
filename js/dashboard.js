// Personal dashboard: totals, weekly chart, rides, goals, export and integration hooks.
import { fmtDist, fmtDuration, fmtSpeed } from './geo.js';
import { weeklyTotals, periods, streakWeeks, bests, sumRides, startOfWeek, DEFAULT_PROFILE } from './fitness.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const METRICS = {
  distance: { label: 'Distance', fmt: v => (v / 1000).toFixed(v >= 100000 ? 0 : 1) + ' km', unit: 'km', scale: v => v / 1000 },
  kcal: { label: 'Calories', fmt: v => Math.round(v) + ' kcal', unit: 'kcal', scale: v => v },
  movingTime: { label: 'Moving time', fmt: v => fmtDuration(v), unit: 'h', scale: v => v / 3600 },
  ascent: { label: 'Climbing', fmt: v => Math.round(v) + ' m', unit: 'm', scale: v => v },
};
const fmtDate = ms => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const rideTitle = r => r.name || r.routeName || 'Ride';

export function renderDashboard(el, { rides, profile, metric = 'distance', onShowRide, onRideMenu, onProfile, onMetric, onExport }) {
  const done = rides.filter(r => r.status === 'done').sort((a, b) => b.startedAt - a.startedAt);
  const goalKm = profile.weeklyGoalKm ?? DEFAULT_PROFILE.weeklyGoalKm;
  const weekTotal = sumRides(done.filter(r => r.startedAt >= startOfWeek(new Date())));
  const pct = goalKm > 0 ? Math.min(100, weekTotal.distance / 1000 / goalKm * 100) : 0;
  const per = periods(done), streak = streakWeeks(done), b = bests(done);
  el.innerHTML = `
    <div class="goal">
      <div class="goal-head"><span>Weekly goal</span><b>${(weekTotal.distance / 1000).toFixed(1)} / ${goalKm} km</b></div>
      <div class="goal-bar"><div style="width:${pct.toFixed(1)}%"></div></div>
      <div class="hint small">${pct >= 100 ? 'Goal reached 🎉' : `${Math.max(0, goalKm - weekTotal.distance / 1000).toFixed(1)} km to go this week`}${streak ? ` · ${streak}-week streak` : ''}</div>
    </div>
    <table class="periods"><thead><tr><th></th><th>Rides</th><th>km</th><th>↑ m</th><th>Time</th><th>kcal</th></tr></thead><tbody>
      ${per.map(([n, t]) => `<tr><td>${n}</td><td>${t.rides}</td><td>${(t.distance / 1000).toFixed(0)}</td><td>${Math.round(t.ascent)}</td><td>${fmtDuration(t.movingTime)}</td><td>${Math.round(t.kcal)}</td></tr>`).join('')}
    </tbody></table>
    <div class="chart-head"><h4>Last 12 weeks</h4><div class="seg" id="metric-seg">${Object.entries(METRICS).map(([k, m]) => `<button data-m="${k}" class="${k === metric ? 'on' : ''}">${m.label}</button>`).join('')}</div></div>
    <div id="week-chart" class="chart"></div>
    ${done.length ? `<h4>Personal bests</h4><div class="stats">
      ${b.longest ? `<div class="stat"><span class="v">${fmtDist(b.longest.distance)}</span><span class="l">Longest ride</span></div>` : ''}
      ${b.climb ? `<div class="stat"><span class="v">↑ ${Math.round(b.climb.ascent)} m</span><span class="l">Most climbing</span></div>` : ''}
      ${b.kcal ? `<div class="stat"><span class="v">${Math.round(b.kcal.kcal)} kcal</span><span class="l">Biggest burn</span></div>` : ''}
      ${b.fastest ? `<div class="stat"><span class="v">${fmtSpeed(b.fastest.avgSpeed)}</span><span class="l">Fastest avg (&gt;5 km)</span></div>` : ''}
    </div>` : ''}
    <h4>Rides (${done.length})</h4>
    <ul class="ride-list">${done.length ? done.map(r => `<li data-id="${r.id}">
      <div class="rl-main"><strong>${esc(rideTitle(r))}</strong><div class="meta">${fmtDate(r.startedAt)} · ${fmtDist(r.distance || 0)} · ↑ ${Math.round(r.ascent || 0)} m · ${fmtDuration(r.movingTime || 0)} · ${Math.round(r.kcal || 0)} kcal · ${fmtSpeed(r.avgSpeed || 0)} avg</div></div>
      <button data-a="menu" title="More">⋯</button></li>`).join('') : '<li class="none">No rides yet. Start a navigation or free ride and finish it with Stop – every ride is saved here automatically.</li>'}
    </ul>
    <h4>Your profile</h4>
    <div class="profile-form">
      <label>Weight (kg)<input type="number" id="pf-weight" min="30" max="200" step="0.5" value="${profile.weight ?? DEFAULT_PROFILE.weight}"></label>
      <label>Bike + gear (kg)<input type="number" id="pf-bike" min="5" max="40" step="0.5" value="${profile.bikeWeight ?? DEFAULT_PROFILE.bikeWeight}"></label>
      <label>Weekly goal (km)<input type="number" id="pf-goal" min="0" max="2000" step="5" value="${goalKm}"></label>
    </div>
    <p class="hint small">Calories use a physics model (rolling resistance, air drag, climbing from the swisstopo terrain model) and your weights – a sound estimate, not a measurement.</p>
    <h4>Export &amp; connect</h4>
    <div class="row wrap"><button data-x="json">Export JSON</button><button data-x="csv">Export CSV</button><button data-x="copy">Copy summary</button></div>
    <label class="field">Webhook URL (POST a JSON summary after every ride)<input type="url" id="pf-webhook" placeholder="https://…" value="${esc(profile.webhook || '')}"></label>
    <label class="field">Authorization header (optional)<input type="text" id="pf-webhook-auth" placeholder="Bearer …" value="${esc(profile.webhookAuth || '')}" autocomplete="off"></label>
    <p class="hint small">Other apps can also read your stats: embed this page in an iframe and post <code>{type:"veloch:getStats"}</code>, or open <code>${location.origin}${location.pathname}#export</code> to download the JSON.</p>`;

  renderWeekChart(el.querySelector('#week-chart'), weeklyTotals(done, 12), metric);
  el.querySelectorAll('#metric-seg button').forEach(bt => bt.onclick = () => onMetric?.(bt.dataset.m));
  el.querySelectorAll('.ride-list li[data-id]').forEach(li => {
    const r = done.find(x => x.id === li.dataset.id);
    li.querySelector('.rl-main').onclick = () => onShowRide?.(r);
    li.querySelector('[data-a=menu]').onclick = e => { e.stopPropagation(); onRideMenu?.(r, li); };
  });
  const prof = () => onProfile?.({
    weight: parseFloat(el.querySelector('#pf-weight').value) || DEFAULT_PROFILE.weight,
    bikeWeight: parseFloat(el.querySelector('#pf-bike').value) || DEFAULT_PROFILE.bikeWeight,
    weeklyGoalKm: parseFloat(el.querySelector('#pf-goal').value) || 0,
    webhook: el.querySelector('#pf-webhook').value.trim(),
    webhookAuth: el.querySelector('#pf-webhook-auth').value.trim(),
  });
  el.querySelectorAll('.profile-form input, #pf-webhook, #pf-webhook-auth').forEach(i => i.onchange = prof);
  el.querySelectorAll('[data-x]').forEach(bt => bt.onclick = () => onExport?.(bt.dataset.x));
}

// Single-series weekly bar chart: thin rounded bars, recessive grid, hover tooltip.
function renderWeekChart(host, weeks, metric) {
  const m = METRICS[metric] || METRICS.distance;
  const W = host.clientWidth || 340, H = 150, padL = 34, padR = 6, padT = 22, padB = 20;
  const w = W - padL - padR, h = H - padT - padB;
  const vals = weeks.map(x => m.scale(x[metric] || 0));
  const max = Math.max(1, ...vals) * 1.1;
  const step = niceStep(max / 3);
  const y = v => padT + h - v / max * h;
  const bw = w / weeks.length, barW = Math.max(6, bw - 4);
  let grid = '';
  for (let g = step; g <= max; g += step) grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(g)}" y2="${y(g)}" class="grid"/><text x="${padL - 4}" y="${y(g) + 3}" class="tick" text-anchor="end">${Number.isInteger(g) ? g : g.toFixed(1)}</text>`;
  const bars = weeks.map((x, i) => {
    const v = vals[i], x0 = padL + i * bw + (bw - barW) / 2, top = y(v), bh = Math.max(0, padT + h - top);
    const r = Math.min(4, barW / 2, bh);
    const d = bh > 0 ? `M${x0},${padT + h}V${top + r}a${r},${r} 0 0 1 ${r},-${r}h${barW - 2 * r}a${r},${r} 0 0 1 ${r},${r}V${padT + h}Z` : '';
    const label = x.start.toLocaleDateString([], { day: 'numeric', month: 'short' });
    const cur = i === weeks.length - 1;
    return `<g class="bar${cur ? ' cur' : ''}" data-i="${i}"><rect x="${padL + i * bw}" y="${padT}" width="${bw}" height="${h}" class="hit"/><path d="${d}"/>${(i % 3 === 0 || cur) ? `<text x="${x0 + barW / 2}" y="${H - 6}" class="tick" text-anchor="middle">${cur ? 'now' : label}</text>` : ''}</g>`;
  }).join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${grid}<line x1="${padL}" x2="${W - padR}" y1="${padT + h}" y2="${padT + h}" class="axis"/>${bars}<g class="tip" visibility="hidden"><rect rx="4" ry="4" height="18"/><text></text></g></svg><div class="hint small">${m.label} per week (${m.unit})</div>`;
  const svg = host.querySelector('svg'), tip = svg.querySelector('.tip'), tipR = tip.querySelector('rect'), tipT = tip.querySelector('text');
  svg.querySelectorAll('.bar').forEach(g => {
    const i = +g.dataset.i, x = weeks[i];
    const show = () => {
      tipT.textContent = `${x.start.toLocaleDateString([], { day: 'numeric', month: 'short' })}–${new Date(x.end - 1).toLocaleDateString([], { day: 'numeric', month: 'short' })}: ${m.fmt(x[metric] || 0)}${x.rides ? ` · ${x.rides} ride${x.rides > 1 ? 's' : ''}` : ''}`;
      const tw = tipT.getComputedTextLength() + 12, cx = padL + i * bw + bw / 2;
      const tx = Math.max(padL, Math.min(W - padR - tw, cx - tw / 2));
      tipR.setAttribute('x', tx); tipR.setAttribute('y', 2); tipR.setAttribute('width', tw); tipT.setAttribute('x', tx + 6); tipT.setAttribute('y', 15);
      tip.setAttribute('visibility', 'visible'); g.classList.add('hover');
    };
    g.addEventListener('pointerenter', show); g.addEventListener('pointerdown', show);
    g.addEventListener('pointerleave', () => { tip.setAttribute('visibility', 'hidden'); g.classList.remove('hover'); });
  });
}
function niceStep(raw) { if (!(raw > 0)) return 1; const p = 10 ** Math.floor(Math.log10(raw)), r = raw / p; return (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * p; }

// ---- export / integration
export function rideSummary(r) {
  return { id: r.id, name: rideTitle(r), startedAt: new Date(r.startedAt).toISOString(), endedAt: r.endedAt ? new Date(r.endedAt).toISOString() : null, mode: r.mode, routeName: r.routeName || null,
    distanceKm: +((r.distance || 0) / 1000).toFixed(2), ascentM: Math.round(r.ascent || 0), descentM: Math.round(r.descent || 0), movingTimeMin: Math.round((r.movingTime || 0) / 60), elapsedMin: r.endedAt ? Math.round((r.endedAt - r.startedAt) / 60000) : null,
    avgSpeedKmh: +((r.avgSpeed || 0) * 3.6).toFixed(1), maxSpeedKmh: +((r.maxSpeed || 0) * 3.6).toFixed(1), kcal: Math.round(r.kcal || 0) };
}
export function buildExport(rides, profile) {
  const done = rides.filter(r => r.status === 'done').sort((a, b) => b.startedAt - a.startedAt);
  return { app: 'VeloCH', exportedAt: new Date().toISOString(), profile: { weight: profile.weight, bikeWeight: profile.bikeWeight, weeklyGoalKm: profile.weeklyGoalKm },
    totals: Object.fromEntries(periods(done).map(([n, t]) => [n.toLowerCase().replace(' ', '_'), { ...t, distanceKm: +(t.distance / 1000).toFixed(1), movingTimeMin: Math.round(t.movingTime / 60), kcal: Math.round(t.kcal) }])),
    weeks: weeklyTotals(done, 26).map(w => ({ weekStart: w.start.toISOString().slice(0, 10), rides: w.rides, distanceKm: +(w.distance / 1000).toFixed(1), ascentM: Math.round(w.ascent), movingTimeMin: Math.round(w.movingTime / 60), kcal: Math.round(w.kcal) })),
    streakWeeks: streakWeeks(done), rides: done.map(rideSummary) };
}
export function ridesCSV(rides) {
  const rows = rides.filter(r => r.status === 'done').sort((a, b) => b.startedAt - a.startedAt).map(rideSummary);
  const cols = ['startedAt', 'name', 'mode', 'distanceKm', 'ascentM', 'descentM', 'movingTimeMin', 'elapsedMin', 'avgSpeedKmh', 'maxSpeedKmh', 'kcal'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n');
}
export async function sendWebhook(profile, payload) {
  if (!profile.webhook) return false;
  const headers = { 'Content-Type': 'application/json' };
  if (profile.webhookAuth) headers.Authorization = profile.webhookAuth;
  const res = await fetch(profile.webhook, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error('webhook ' + res.status);
  return true;
}
