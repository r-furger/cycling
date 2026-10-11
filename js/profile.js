// Interactive SVG elevation profile coloured by gradient.
const UP = [[3, '#8bc34a'], [6, '#fdd835'], [9, '#fb8c00'], [13, '#e53935'], [Infinity, '#8e24aa']];
const DOWN = [[3, '#b0bec5'], [6, '#90a4ae'], [9, '#78909c'], [13, '#546e7a'], [Infinity, '#37474f']];
function gradeColor(g) { const t = g >= 0 ? UP : DOWN, a = Math.abs(g); for (const [lim, c] of t) if (a < lim) return c; return t[t.length - 1][1]; }
function niceStep(raw) { if (!(raw > 0)) return 1; const p = 10 ** Math.floor(Math.log10(raw)), r = raw / p; return (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * p; }
const NS = 'http://www.w3.org/2000/svg';
// Average into at most `max` buckets so the chart stays light on phones.
function downsample(samples, max) {
  if (samples.length <= max) return samples;
  const total = samples[samples.length - 1].dist, step = total / max, out = [];
  let bucket = [], edge = step;
  for (const p of samples) {
    if (p.dist > edge && bucket.length) { out.push({ dist: bucket.reduce((a, b) => a + b.dist, 0) / bucket.length, ele: bucket.reduce((a, b) => a + b.ele, 0) / bucket.length }); bucket = []; while (p.dist > edge) edge += step; }
    bucket.push(p);
  }
  if (bucket.length) out.push({ dist: bucket.reduce((a, b) => a + b.dist, 0) / bucket.length, ele: bucket.reduce((a, b) => a + b.ele, 0) / bucket.length });
  out[0] = { dist: samples[0].dist, ele: samples[0].ele }; out[out.length - 1] = { dist: total, ele: samples[samples.length - 1].ele };
  return out;
}

export class ElevationChart {
  constructor(svg, { onHover, onLeave } = {}) {
    this.svg = svg; this.onHover = onHover; this.onLeave = onLeave; this.samples = null; this.progress = null;
    new ResizeObserver(() => this.render()).observe(svg);
    svg.addEventListener('pointermove', e => this.hover(e));
    svg.addEventListener('pointerdown', e => this.hover(e));
    svg.addEventListener('pointerleave', () => { this.showCursor(null); this.onLeave?.(); });
  }
  el(tag, attrs = {}) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
  setData(samples) { this.samples = samples && samples.length > 1 ? downsample(samples, 450) : null; this.progress = null; this.render(); }
  setProgress(d) { this.progress = d; this.updateProgress(); }

  gradeAt(i) {
    // Gradient over a ~250 m window so the colouring is readable rather than noisy.
    const s = this.samples; let j = i + 1, k = i;
    while (j < s.length - 1 && s[j].dist - s[i].dist < 120) j++;
    while (k > 0 && s[j].dist - s[k].dist < 250) k--;
    const dd = s[j].dist - s[k].dist;
    return dd > 0 ? (s[j].ele - s[k].ele) / dd * 100 : 0;
  }

  render() {
    const svg = this.svg; svg.innerHTML = '';
    if (!this.samples) return;
    const W = svg.clientWidth || 300, H = svg.clientHeight || 120;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const padL = 40, padR = 10, padT = 10, padB = 16, w = W - padL - padR, h = H - padT - padB;
    const s = this.samples, total = s[s.length - 1].dist || 1;
    let min = Infinity, max = -Infinity;
    for (const p of s) { min = Math.min(min, p.ele); max = Math.max(max, p.ele); }
    const range = Math.max(60, max - min);
    const eMin = Math.floor((min - range * 0.08) / 10) * 10, eMax = eMin + range * 1.2;
    this.x = d => padL + d / total * w; this.y = e => padT + (1 - (e - eMin) / (eMax - eMin)) * h;
    Object.assign(this, { padL, padT, w, h, W, H, total, base: padT + h });

    const g = this.el('g');
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i], b = s[i + 1], c = gradeColor(this.gradeAt(i));
      g.appendChild(this.el('path', { d: `M${this.x(a.dist)},${this.y(a.ele)}L${this.x(b.dist)},${this.y(b.ele)}L${this.x(b.dist)},${this.base}L${this.x(a.dist)},${this.base}Z`, fill: c, stroke: c, 'stroke-width': 0.6 }));
    }
    svg.appendChild(g);
    svg.appendChild(this.el('path', { d: s.map((p, i) => (i ? 'L' : 'M') + this.x(p.dist).toFixed(1) + ',' + this.y(p.ele).toFixed(1)).join(''), fill: 'none', stroke: '#263238', 'stroke-width': 1.3 }));

    const ys = niceStep((eMax - eMin) / 3);
    for (let e = Math.ceil(eMin / ys) * ys; e <= eMax; e += ys) {
      const y = this.y(e);
      svg.appendChild(this.el('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: 'rgba(0,0,0,.12)' }));
      const t = this.el('text', { x: padL - 4, y: y + 3, 'text-anchor': 'end', class: 'tick' }); t.textContent = Math.round(e); svg.appendChild(t);
    }
    const xs = niceStep(total / 1000 / 5);
    for (let k = 0; k * 1000 <= total + 1; k += xs) {
      const t = this.el('text', { x: this.x(k * 1000), y: H - 3, 'text-anchor': 'middle', class: 'tick' });
      t.textContent = (Number.isInteger(k) ? k : k.toFixed(1)) + (k === 0 ? ' km' : ''); svg.appendChild(t);
    }
    this.progressEl = this.el('rect', { x: padL, y: padT, width: 0, height: h, fill: 'rgba(21,101,192,.22)' }); svg.appendChild(this.progressEl);
    this.progressDot = this.el('circle', { r: 5, fill: '#1976d2', stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }); svg.appendChild(this.progressDot);
    this.cursor = this.el('g', { visibility: 'hidden' });
    this.cLine = this.el('line', { y1: padT, y2: this.base, stroke: '#1565c0', 'stroke-width': 1.2 });
    this.cDot = this.el('circle', { r: 4, fill: '#1565c0', stroke: '#fff', 'stroke-width': 1.5 });
    this.cBg = this.el('rect', { rx: 4, ry: 4, height: 16, fill: 'rgba(255,255,255,.92)', stroke: '#cfd8dc' });
    this.cLabel = this.el('text', { class: 'label' });
    this.cursor.append(this.cLine, this.cDot, this.cBg, this.cLabel); svg.appendChild(this.cursor);
    this.updateProgress();
  }

  updateProgress() {
    if (!this.progressEl || !this.samples) return;
    if (this.progress == null) { this.progressEl.setAttribute('width', 0); this.progressDot.setAttribute('visibility', 'hidden'); return; }
    const d = Math.max(0, Math.min(this.total, this.progress));
    this.progressEl.setAttribute('width', Math.max(0, this.x(d) - this.padL));
    this.progressDot.setAttribute('cx', this.x(d)); this.progressDot.setAttribute('cy', this.y(this.eleAt(d))); this.progressDot.setAttribute('visibility', 'visible');
  }

  eleAt(d) {
    const s = this.samples; let lo = 0, hi = s.length - 1;
    if (d <= s[0].dist) return s[0].ele; if (d >= s[hi].dist) return s[hi].ele;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].dist <= d) lo = m; else hi = m; }
    const a = s[lo], b = s[hi], t = b.dist > a.dist ? (d - a.dist) / (b.dist - a.dist) : 0;
    return a.ele + t * (b.ele - a.ele);
  }
  indexAt(d) { const s = this.samples; let lo = 0, hi = s.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].dist <= d) lo = m; else hi = m; } return lo; }

  hover(e) {
    if (!this.samples || !this.x) return;
    const rect = this.svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (this.W / rect.width);
    const d = Math.max(0, Math.min(this.total, (px - this.padL) / this.w * this.total));
    this.showCursor(d);
    this.onHover?.({ dist: d, ele: this.eleAt(d) });
  }
  showCursor(d) {
    if (!this.cursor) return;
    if (d == null) { this.cursor.setAttribute('visibility', 'hidden'); return; }
    const x = this.x(d), ele = this.eleAt(d), grade = this.gradeAt(this.indexAt(d));
    this.cursor.setAttribute('visibility', 'visible');
    this.cLine.setAttribute('x1', x); this.cLine.setAttribute('x2', x);
    this.cDot.setAttribute('cx', x); this.cDot.setAttribute('cy', this.y(ele));
    this.cLabel.textContent = `${(d / 1000).toFixed(1)} km · ${Math.round(ele)} m · ${grade > 0 ? '+' : ''}${grade.toFixed(0)}%`;
    const tw = this.cLabel.getComputedTextLength() + 10;
    const lx = x + 8 + tw > this.W - 4 ? x - 8 - tw : x + 8;
    this.cBg.setAttribute('x', lx); this.cBg.setAttribute('y', this.padT); this.cBg.setAttribute('width', tw);
    this.cLabel.setAttribute('x', lx + 5); this.cLabel.setAttribute('y', this.padT + 12);
  }
}
