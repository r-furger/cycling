// Turn-by-turn / follow-the-track navigation state machine. Positions are fed in from outside.
import { nearestOnTrack, haversine, bearing } from './geo.js';
import { remainingAscent } from './elevation.js';

export class Navigator {
  constructor({ onUpdate, onEvent }) { this.onUpdate = onUpdate; this.onEvent = onEvent; this.running = false; this.trail = []; }

  start(route) {
    this.route = route && route.points?.length > 1 ? route : null;
    this.running = true; this.finished = false; this.lastIndex = null; this.offSince = null; this.offAnnounced = false;
    this.trail = []; this.startTime = Date.now(); this.ridden = 0; this.movingTime = 0; this.lastPos = null;
    this.announced = new Map(); this.recent = []; this.lastHeading = null;
    this.sortedHints = (this.route?.hints || []).slice().sort((a, b) => a.dist - b.dist);
  }
  stop() { this.running = false; }

  baseState(pos, extra) { return { pos, speed: 0, heading: this.lastHeading, elapsed: (Date.now() - this.startTime) / 1000, ridden: this.ridden, movingTime: this.movingTime, ...extra }; }

  feed(pos) {
    if (!this.running) return;
    const now = pos.t || Date.now();
    if (pos.acc != null && pos.acc > 150) { this.onUpdate(this.baseState(pos, { poor: true })); return; }
    let speed = isFinite(pos.speed) && pos.speed != null ? pos.speed : null;
    if (this.lastPos) {
      const d = haversine(this.lastPos, pos), dt = (now - this.lastPos.t) / 1000;
      if (d >= Math.max(3, (pos.acc || 10) * 0.3)) {
        this.ridden += d;
        if (speed == null) speed = dt > 0 ? d / dt : 0;
        this.lastHeading = isFinite(pos.heading) && pos.heading != null ? pos.heading : bearing(this.lastPos, pos);
        if (speed > 0.8 && dt < 30) this.movingTime += dt;
        this.trail.push({ lat: pos.lat, lon: pos.lon, time: now });
        this.lastPos = { ...pos, t: now };
      } else if (speed == null) speed = 0;
    } else {
      this.trail.push({ lat: pos.lat, lon: pos.lon, time: now });
      this.lastPos = { ...pos, t: now };
      if (isFinite(pos.heading) && pos.heading != null) this.lastHeading = pos.heading;
    }
    const st = this.baseState(pos, { speed: speed || 0 });

    if (this.route) {
      const near = nearestOnTrack(this.route.points, pos, this.lastIndex);
      if (near) {
        this.lastIndex = near.index;
        const total = this.route.points[this.route.points.length - 1].dist;
        st.along = near.along; st.remaining = Math.max(0, total - near.along);
        st.offDist = near.distToTrack; st.offRoute = near.distToTrack > 50 + (pos.acc || 0) * 0.5;
        st.remainingAscent = this.route.samples ? remainingAscent(this.route.samples, near.along) : null;

        this.recent.push({ t: now, along: near.along });
        while (this.recent.length && now - this.recent[0].t > 5 * 60000) this.recent.shift();
        const first = this.recent[0]; let v = null;
        if (first && now - first.t > 60000) v = (near.along - first.along) / ((now - first.t) / 1000);
        if (v == null || v < 1) v = this.movingTime > 60 ? this.ridden / this.movingTime : 4.2;
        if (!(v >= 1)) v = 4.2;
        st.eta = st.remaining / v;

        if (!st.offRoute) {
          const up = this.sortedHints.filter(h => h.dist >= near.along - 15);
          if (up[0]) {
            st.nextHint = { ...up[0], distTo: Math.max(0, up[0].dist - near.along) };
            if (up[1] && up[1].dist - up[0].dist < 150) st.thenHint = up[1];
            this.announce(up[0], st.nextHint.distTo, up[1]);
          }
        }
        if (st.offRoute) {
          if (!this.offSince) this.offSince = now;
          else if (now - this.offSince > 10000 && !this.offAnnounced) { this.offAnnounced = true; this.onEvent({ type: 'offroute', dist: near.distToTrack }); }
        } else {
          if (this.offAnnounced) this.onEvent({ type: 'backontrack' });
          this.offSince = null; this.offAnnounced = false;
        }
        if (!this.finished && st.remaining < 40 && near.index >= this.route.points.length - 3) { this.finished = true; this.onEvent({ type: 'arrived' }); }
      }
    }
    this.onUpdate(st);
  }

  announce(h, distTo, then) {
    const lvl = this.announced.get(h.index) || 0;
    if (distTo <= 350 && distTo > 80 && lvl < 1) {
      this.announced.set(h.index, 1);
      this.onEvent({ type: 'speak', text: `In ${Math.round(distTo / 50) * 50} meters, ${h.text.toLowerCase()}` });
    } else if (distTo <= 40 && lvl < 2) {
      this.announced.set(h.index, 2);
      let t = h.text; if (then && then.dist - h.dist < 150) t += `, then ${then.text.toLowerCase()}`;
      this.onEvent({ type: 'speak', text: t });
    }
  }
}
