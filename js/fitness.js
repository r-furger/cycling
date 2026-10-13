// Ride statistics, calorie model and period aggregation.
import { haversine, cumulative, elevationStats } from './geo.js';
import { eleAtDist } from './elevation.js';

export const DEFAULT_PROFILE = { weight: 75, bikeWeight: 12, weeklyGoalKm: 100 };
const G = 9.81, CRR = 0.006, CDA = 0.45, RHO = 1.1; // rolling resistance, drag area (upright touring), air density ~1000 m

// Mechanical power at speed v (m/s) on slope (rise/run). Negative = coasting, clamped to 0.
function power(mass, v, slope) {
  const p = mass * G * v * (CRR + slope) + 0.5 * RHO * CDA * v ** 3;
  return Math.max(0, p);
}

// Riders convert food to pedal work at ~24 %, so 1 kJ of work ≈ 1 kcal burned.
// points: [{lat, lon, time, dist}], eleAt: dist -> elevation (may be null).
export function rideKcal(points, eleAt, profile = {}) {
  const mass = (profile.weight || DEFAULT_PROFILE.weight) + (profile.bikeWeight || DEFAULT_PROFILE.bikeWeight);
  let joules = 0, moving = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dt = (b.time - a.time) / 1000, d = b.dist - a.dist;
    if (!(dt > 0) || dt > 120 || d < 1) continue;      // skip GPS gaps and standstill
    const v = Math.min(d / dt, 25);
    const slope = eleAt ? Math.max(-0.3, Math.min(0.3, ((eleAt(b.dist) ?? 0) - (eleAt(a.dist) ?? 0)) / d)) : 0;
    joules += power(mass, v, slope) * dt;
    if (v > 0.8) moving += dt;
  }
  const kcal = joules / 1000;
  const floor = 3 * (profile.weight || DEFAULT_PROFILE.weight) * moving / 3600; // 3 METs floor while moving
  return Math.round(Math.max(kcal, floor));
}

// Rough estimate for a planned route: ~17 km/h on the flat, climbing at ~500 m/h vertical, coasting down.
export function estimateRouteKcal(samples, profile = {}) {
  if (!samples || samples.length < 2) return null;
  const mass = (profile.weight || DEFAULT_PROFILE.weight) + (profile.bikeWeight || DEFAULT_PROFILE.bikeWeight);
  let joules = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].dist - samples[i - 1].dist; if (d <= 0) continue;
    const slope = (samples[i].ele - samples[i - 1].ele) / d;
    const v = slope > 0.01 ? Math.min(4.7, (500 / 3600) / slope) : slope < -0.02 ? 9 : 4.7;
    joules += power(mass, v, slope) * (d / v);
  }
  return Math.round(joules / 1000);
}

// Full statistics for a recorded ride. samples: swisstopo profile along the trail (optional).
export function rideStats(points, samples, profile) {
  cumulative(points);
  const distance = points.length ? points[points.length - 1].dist : 0;
  let moving = 0, maxSpeed = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].time - points[i - 1].time) / 1000, d = points[i].dist - points[i - 1].dist;
    if (!(dt > 0) || dt > 30) continue;
    const v = d / dt;
    if (v > 0.8) moving += dt;
    if (v < 25 && v > maxSpeed) maxSpeed = v;
  }
  const es = samples ? elevationStats(samples) : { ascent: 0, descent: 0, min: null, max: null };
  const eleAt = samples ? d => eleAtDist(samples, d) : null;
  return { distance, movingTime: moving, maxSpeed, avgSpeed: moving > 0 ? distance / moving : 0, ...es, kcal: rideKcal(points, eleAt, profile) };
}

// ---- aggregation
export function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
export function sumRides(rides) {
  const t = { rides: rides.length, distance: 0, ascent: 0, movingTime: 0, kcal: 0 };
  for (const r of rides) { t.distance += r.distance || 0; t.ascent += r.ascent || 0; t.movingTime += r.movingTime || 0; t.kcal += r.kcal || 0; }
  return t;
}
export function weeklyTotals(rides, weeks = 12, now = new Date()) {
  const out = [];
  let ws = startOfWeek(now); ws.setDate(ws.getDate() - 7 * (weeks - 1));
  for (let i = 0; i < weeks; i++) {
    const start = new Date(ws), end = new Date(ws); end.setDate(end.getDate() + 7);
    out.push({ start, end, ...sumRides(rides.filter(r => r.startedAt >= start && r.startedAt < end)) });
    ws = end;
  }
  return out;
}
export function periods(rides, now = new Date()) {
  const week = startOfWeek(now), month = new Date(now.getFullYear(), now.getMonth(), 1), year = new Date(now.getFullYear(), 0, 1);
  return [
    ['This week', sumRides(rides.filter(r => r.startedAt >= week))],
    ['This month', sumRides(rides.filter(r => r.startedAt >= month))],
    ['This year', sumRides(rides.filter(r => r.startedAt >= year))],
    ['All time', sumRides(rides)],
  ];
}
export function streakWeeks(rides, now = new Date()) {
  let n = 0, ws = startOfWeek(now);
  for (; ;) { const end = new Date(ws); end.setDate(end.getDate() + 7); if (!rides.some(r => r.startedAt >= ws && r.startedAt < end)) { if (n === 0 && ws.getTime() === startOfWeek(now).getTime()) { ws.setDate(ws.getDate() - 7); continue; } break; } n++; ws.setDate(ws.getDate() - 7); if (n > 520) break; }
  return n;
}
export function bests(rides) {
  const pick = (k) => rides.reduce((b, r) => (r[k] || 0) > (b?.[k] || 0) ? r : b, null);
  return { longest: pick('distance'), climb: pick('ascent'), kcal: pick('kcal'), fastest: rides.filter(r => r.distance > 5000).reduce((b, r) => (r.avgSpeed || 0) > (b?.avgSpeed || 0) ? r : b, null) };
}
