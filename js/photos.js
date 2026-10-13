// Ride photos: downscale for storage, read EXIF position/time, place on the track.

export async function processImage(file, maxDim = 1600, thumbDim = 200) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { src = await loadViaImg(file); }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const s1 = Math.min(1, maxDim / Math.max(w, h)), s2 = Math.min(1, thumbDim / Math.max(w, h));
  const full = await draw(src, Math.round(w * s1), Math.round(h * s1), 0.82);
  const thumb = await draw(src, Math.round(w * s2), Math.round(h * s2), 0.7);
  src.close?.();
  return { blob: full.blob, width: full.w, height: full.h, thumb: thumb.blob };
}
function draw(src, w, h, q) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  return new Promise((res, rej) => c.toBlob(b => b ? res({ blob: b, w, h }) : rej(new Error('Could not encode image')), 'image/jpeg', q));
}
function loadViaImg(file) {
  return new Promise((res, rej) => { const url = URL.createObjectURL(file); const img = new Image(); img.onload = () => { URL.revokeObjectURL(url); res(img); }; img.onerror = () => rej(new Error('Unsupported image')); img.src = url; });
}

// Minimal EXIF reader: GPS position and DateTimeOriginal from a JPEG.
export async function readExif(file) {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xFFD8) return {};
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off), len = v.getUint16(off + 2);
      if (marker === 0xFFE1 && off + 10 < v.byteLength && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
      off += 2 + len;
    }
  } catch { }
  return {};
}
function parseTiff(v, start) {
  const le = v.getUint16(start) === 0x4949, u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
  const readIfd = o => { const n = u16(o), tags = {}; for (let i = 0; i < n; i++) { const e = o + 2 + i * 12; tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 }; } return tags; };
  const val = t => {
    const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 }[t.type] || 1, o = size * t.count <= 4 ? t.at : start + u32(t.at);
    if (t.type === 2) { let s = ''; for (let i = 0; i < t.count - 1; i++) s += String.fromCharCode(v.getUint8(o + i)); return s; }
    const out = [];
    for (let i = 0; i < t.count; i++) { const p = o + i * size; out.push(t.type === 3 ? u16(p) : t.type === 4 ? u32(p) : t.type === 5 ? u32(p) / (u32(p + 4) || 1) : t.type === 10 ? v.getInt32(p, le) / (v.getInt32(p + 4, le) || 1) : v.getUint8(p)); }
    return out;
  };
  const ifd0 = readIfd(start + u32(start + 4)), out = {};
  if (ifd0[0x8769]) {
    const exif = readIfd(start + val(ifd0[0x8769])[0]), dt = exif[0x9003] && val(exif[0x9003]);
    const m = dt && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(dt);
    if (m) out.time = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  if (ifd0[0x8825]) {
    const g = readIfd(start + val(ifd0[0x8825])[0]), dms = t => { const a = val(t); return a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600; };
    if (g[2] && g[4]) {
      let lat = dms(g[2]), lon = dms(g[4]);
      if (g[1] && val(g[1]) === 'S') lat = -lat; if (g[3] && val(g[3]) === 'W') lon = -lon;
      if (isFinite(lat) && isFinite(lon) && (lat || lon)) { out.lat = lat; out.lon = lon; }
    }
  }
  return out;
}

// Where does a photo belong on a ride? EXIF GPS > time match on the track > current GPS > middle of the ride.
export function placePhoto(points, exif, currentPos) {
  if (exif?.lat != null) return { lat: exif.lat, lon: exif.lon, how: 'photo location' };
  if (exif?.time && points?.length) {
    let best = null;
    for (const a of points) { const d = Math.abs(a[3] - exif.time); if (!best || d < best.d) best = { d, a }; }
    if (best && best.d < 15 * 60000) return { lat: best.a[0], lon: best.a[1], how: 'matched by time' };
  }
  if (currentPos) return { lat: currentPos.lat, lon: currentPos.lon, how: 'GPS position' };
  if (points?.length) { const a = points[Math.floor(points.length / 2)]; return { lat: a[0], lon: a[1], how: 'middle of ride (no location in photo)' }; }
  return null;
}
