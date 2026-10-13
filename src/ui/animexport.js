// Pure helpers for animated export (PNG sequence, sprite sheet, GIF). See docs/animated-export.md.
export const MAX_FRAMES = 1200;
export const MAX_SHEET = 16384; // px per side (the browser's canvas limit); larger sheets fall back to numbered PNGs
export const MAX_GIF_SIZE = 1024;

// Frame times start + i / fps. A looping clip omits the endpoint (it equals the first frame).
export function frameTimes(start, duration, fps, loop) {
  const span = Math.max(0, duration) * fps;
  const n = Math.min(MAX_FRAMES, Math.max(1, loop ? Math.round(span) : Math.floor(span + 1e-6) + 1));
  return Array.from({ length: n }, (_, i) => start + i / fps);
}

// GIF delays are in 1/100 s; accumulate rounding so e.g. 24 fps alternates 4 and 5 and never drifts.
export function gifDelays(n, fps) {
  return Array.from({ length: n }, (_, i) => Math.max(1, Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps)));
}

const gridCols = (n, columns) => Math.max(1, Math.min(n, columns > 0 ? columns : Math.ceil(Math.sqrt(n))));

export function sheetLayout(n, size, columns = 0, padding = 0, maxDim = MAX_SHEET) {
  const cols = gridCols(n, columns);
  const rows = Math.ceil(n / cols), step = size + padding;
  const width = cols * step - padding, height = rows * step - padding;
  const frames = Array.from({ length: n }, (_, i) => ({ x: (i % cols) * step, y: Math.floor(i / cols) * step, w: size, h: size }));
  return { cols, rows, width, height, frames, fits: width <= maxDim && height <= maxDim };
}

// "Size by sheet": the largest square frame that fits n frames (same grid as sheetLayout) in a sheet × sheet image,
// so the sheet keeps its size whatever the FPS or duration; more frames just means smaller ones.
export function frameSizeForSheet(n, sheet, columns = 0, padding = 0) {
  const cols = gridCols(n, columns), rows = Math.ceil(n / cols);
  return Math.max(1, Math.floor(Math.min((sheet - padding * (cols - 1)) / cols, (sheet - padding * (rows - 1)) / rows)));
}

// Straight-alpha RGBA over a solid color, in place (GIF has only 1-bit transparency).
export function flatten(data, [r, g, b]) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    data[i] = data[i] * a + r * (1 - a); data[i + 1] = data[i + 1] * a + g * (1 - a); data[i + 2] = data[i + 2] * a + b * (1 - a); data[i + 3] = 255;
  }
  return data;
}

// Appends up to `max` pixels with alpha >= 128 to `out` (palette samples for GIF quantization).
export function opaqueSamples(data, max, out = []) {
  const stride = Math.max(1, Math.floor(data.length / 4 / max));
  for (let i = 0; i < data.length; i += 4 * stride) if (data[i + 3] >= 128) out.push(data[i], data[i + 1], data[i + 2], 255);
  return out;
}

// Turntable framing: copies of the clip's framing points turned about the vertical axis through their center,
// so every camera yaw fits the same way and the model doesn't breathe in and out as it spins.
export function spinFit(fit, steps = 24) {
  const p = fit.points, stride = Math.max(1, Math.ceil(p.length / 3 / 20000)) * 3;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]); }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, out = [];
  for (let k = 0; k < steps; k++) {
    const c = Math.cos((2 * Math.PI * k) / steps), sn = Math.sin((2 * Math.PI * k) / steps);
    for (let i = 0; i < p.length; i += stride) { const dx = p[i] - cx, dz = p[i + 2] - cz; out.push(cx + dx * c - dz * sn, p[i + 1], cz + dx * sn + dz * c); }
  }
  return { ...fit, points: new Float32Array(out) };
}

// ---------- motion blur ----------
// Averages sub-frames premultiplied (so transparent edges don't darken), then back to straight alpha.
export function accumulate(acc, data) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    acc[i] += data[i] * a; acc[i + 1] += data[i + 1] * a; acc[i + 2] += data[i + 2] * a; acc[i + 3] += data[i + 3];
  }
  return acc;
}
export function resolveAccumulated(acc, n, out) {
  for (let i = 0; i < acc.length; i += 4) {
    const a = acc[i + 3] / n, k = a > 0 ? 255 / a / n : 0;
    out[i] = acc[i] * k; out[i + 1] = acc[i + 1] * k; out[i + 2] = acc[i + 2] * k; out[i + 3] = a;
  }
  return out;
}

// ---------- APNG / animated WebP ----------
// Both are assembled from per-frame PNG / WebP files the browser already encoded: the image data chunks are reused.
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(bytes, crc = 0xffffffff) { for (const b of bytes) crc = CRC[(crc ^ b) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const le = (v, n) => Array.from({ length: n }, (_, i) => (v >>> (8 * i)) & 255);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const join = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

export function pngChunks(png) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength), out = [];
  for (let p = 8; p + 8 <= png.length;) {
    const len = dv.getUint32(p), type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    out.push({ type, data: png.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
}
function pngChunk(type, data) {
  const body = join([new Uint8Array(ascii(type)), data]);
  return join([new Uint8Array(be32(data.length)), body, new Uint8Array(be32(crc32(body)))]);
}
// pngs: one PNG file per frame (same size). Frame delay is exactly 1/fps; loop false plays once.
export function assembleApng(pngs, fps, loop = true) {
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  const ihdr = pngChunks(pngs[0]).find((c) => c.type === 'IHDR').data, w = new DataView(ihdr.buffer, ihdr.byteOffset).getUint32(0), h = new DataView(ihdr.buffer, ihdr.byteOffset).getUint32(4);
  parts.push(pngChunk('IHDR', ihdr), pngChunk('acTL', new Uint8Array([...be32(pngs.length), ...be32(loop ? 0 : 1)])));
  let seq = 0;
  pngs.forEach((png, i) => {
    // fcTL: sequence, size, offset 0,0, delay 1/fps, dispose none, blend source (each frame replaces the canvas).
    parts.push(pngChunk('fcTL', new Uint8Array([...be32(seq++), ...be32(w), ...be32(h), ...be32(0), ...be32(0), 0, 1, (fps >> 8) & 255, fps & 255, 0, 0])));
    for (const c of pngChunks(png)) {
      if (c.type !== 'IDAT') continue;
      parts.push(i === 0 ? pngChunk('IDAT', c.data) : pngChunk('fdAT', join([new Uint8Array(be32(seq++)), c.data])));
    }
  });
  parts.push(pngChunk('IEND', new Uint8Array()));
  return join(parts);
}

export function riffChunks(webp) {
  const dv = new DataView(webp.buffer, webp.byteOffset, webp.byteLength), out = [];
  for (let p = 12; p + 8 <= webp.length;) {
    const type = String.fromCharCode(...webp.subarray(p, p + 4)), len = dv.getUint32(p + 4, true);
    out.push({ type, raw: webp.subarray(p, p + 8 + len + (len & 1)) });
    p += 8 + len + (len & 1);
  }
  return out;
}
const riffChunk = (type, data) => join([new Uint8Array([...ascii(type), ...le(data.length, 4)]), data, new Uint8Array(data.length & 1)]);
// Frame durations in whole ms, rounding accumulated so the clip doesn't drift (like gifDelays).
export const webpDurations = (n, fps) => Array.from({ length: n }, (_, i) => Math.max(1, Math.round(((i + 1) * 1000) / fps) - Math.round((i * 1000) / fps)));
// webps: one WebP file per frame (same size w × h). Frames replace each other (no blending), so transparency stays exact.
export function assembleWebp(webps, fps, loop, w, h) {
  const durations = webpDurations(webps.length, fps);
  let alpha = false;
  const frames = webps.map((f, i) => {
    const keep = riffChunks(f).filter((c) => c.type === 'ALPH' || c.type === 'VP8 ' || c.type === 'VP8L');
    if (keep.some((c) => c.type !== 'VP8 ')) alpha = true;
    return riffChunk('ANMF', join([new Uint8Array([...le(0, 3), ...le(0, 3), ...le(w - 1, 3), ...le(h - 1, 3), ...le(durations[i], 3), 0b10]), ...keep.map((c) => c.raw)]));
  });
  const body = [riffChunk('VP8X', new Uint8Array([0x02 | (alpha ? 0x10 : 0), 0, 0, 0, ...le(w - 1, 3), ...le(h - 1, 3)])),
    riffChunk('ANIM', new Uint8Array([0, 0, 0, 0, ...le(loop ? 0 : 1, 2)])), ...frames];
  const size = 4 + body.reduce((n, p) => n + p.length, 0);
  return join([new Uint8Array([...ascii('RIFF'), ...le(size, 4), ...ascii('WEBP')]), ...body]);
}

// ---------- still export helpers ----------
// Crops transparent padding: bounds of pixels with any alpha, plus `margin` px of transparency on every side.
// img: { data, width, height } (ImageData). Returns the same shape; fully transparent images come back unchanged.
export function trimImage(img, margin = 0) {
  const { data, width: w, height: h } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return img;
  const m = Math.max(0, Math.round(margin)), W = x1 - x0 + 1 + 2 * m, H = y1 - y0 + 1 + 2 * m, out = new Uint8ClampedArray(W * H * 4);
  for (let y = y0; y <= y1; y++) out.set(data.subarray((y * w + x0) * 4, (y * w + x1 + 1) * 4), ((y - y0 + m) * W + m) * 4);
  return { data: out, width: W, height: H };
}

// Batch file names: {name} {size} {w} {h} {format} {profile} {preset} {index} {date}; unknown tokens stay as typed.
export function fileNameFrom(template, vars) {
  const name = String(template || '{name}').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : k in vars ? '' : m));
  return name.replace(/[\/:*?"<>|\x00-\x1f]/g, '_').replace(/[_ -]{2,}/g, (s) => s[0]).replace(/^[_ .-]+|[_ .-]+$/g, '') || 'icon';
}

// Toolbar export presets for Roblox targets; mask is the safe area the preview outlines.
export const EXPORT_PRESETS = {
  'Game icon (512)': { size: 512, aspect: 1, format: 'png', mask: 'rounded' },
  'Game thumbnail (1920×1080)': { size: 1920, aspect: 1.7778, format: 'png', mask: 'none' },
  'Badge (512, circle)': { size: 512, aspect: 1, format: 'png', mask: 'circle' },
  'Game pass (512, circle)': { size: 512, aspect: 1, format: 'png', mask: 'circle' },
  'Developer product (512)': { size: 512, aspect: 1, format: 'png', mask: 'rounded' },
  'Group icon (512)': { size: 512, aspect: 1, format: 'png', mask: 'circle' },
  'Discord emoji (128)': { size: 128, aspect: 1, format: 'png', mask: 'none' },
};
