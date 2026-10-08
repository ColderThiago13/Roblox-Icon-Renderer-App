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
