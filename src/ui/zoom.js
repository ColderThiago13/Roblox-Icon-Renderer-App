export const ZOOM_MIN = 0.01;
export const ZOOM_MAX = 4;

// WheelEvent deltaMode: pixels, lines, or pages. Ctrl gives ten times finer zoom.
export function wheelZoom(zoom, event, pageSize = 800) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageSize : 1;
  const delta = Math.max(-1000, Math.min(1000, event.deltaY * unit));
  const next = zoom * Math.exp(-delta * (event.ctrlKey ? 0.0001 : 0.001));
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +next.toFixed(4)));
}
