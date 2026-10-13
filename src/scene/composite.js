// Several files' models in one scene (a bundle showcase). Each member's world-space parts move together into a row,
// an arc (center in front) or a grid, standing on the same floor. A scene file is JSON that carries its members' bytes.
import { finalizeTree, walk } from '../rbx/instance.js';
import { isPart } from './build.js';

export const SCENE_LAYOUTS = ['row', 'arc', 'grid'];

export const toB64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// members: [{ name, bytes, path, disabled }]; layout: { mode, gap } (gap as a fraction of the average model width).
export function sceneFile(members, layout = { mode: 'row', gap: 0.25 }) {
  return new TextEncoder().encode(JSON.stringify({ type: 'scene', layout, members: members.map((m) => ({ name: m.name, path: m.path ?? null, disabled: m.disabled ?? [], data: toB64(m.bytes) })) }));
}

// Axis-aligned bounds of the parts under roots: { lo: [x, y, z], hi: [x, y, z] }.
export function treeBounds(roots) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const inst of walk(roots)) {
    const { cframe: c, size: s } = inst.props;
    if (!isPart(inst) || !c || !s) continue;
    const h = [s.x / 2, s.y / 2, s.z / 2], r = c.r;
    for (let k = 0; k < 3; k++) {
      const e = Math.abs(r[k * 3]) * h[0] + Math.abs(r[k * 3 + 1]) * h[1] + Math.abs(r[k * 3 + 2]) * h[2];
      lo[k] = Math.min(lo[k], c.p[k] - e); hi[k] = Math.max(hi[k], c.p[k] + e);
    }
  }
  return lo[0] <= hi[0] ? { lo, hi } : { lo: [0, 0, 0], hi: [0, 0, 0] };
}

// Translation for each member's bounds so they sit side by side (camera yaw 0 looks from -Z, so "back" is +Z).
export function layoutOffsets(boxes, mode = 'row', gap = 0.25) {
  const n = boxes.length, w = boxes.map((b) => b.hi[0] - b.lo[0]), d = boxes.map((b) => b.hi[2] - b.lo[2]);
  const avg = w.reduce((a, b) => a + b, 0) / Math.max(1, n), g = gap * avg;
  const place = (b, x, z) => [x - (b.lo[0] + b.hi[0]) / 2, -b.lo[1], z - (b.lo[2] + b.hi[2]) / 2];
  if (mode === 'grid') {
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), cell = Math.max(...w, ...d) + g;
    return boxes.map((b, i) => place(b, ((i % cols) - (cols - 1) / 2) * cell, (Math.floor(i / cols) - (rows - 1) / 2) * cell));
  }
  const total = w.reduce((a, b) => a + b, 0) + g * (n - 1);
  let x = -total / 2;
  return boxes.map((b, i) => {
    const cx = x + w[i] / 2;
    x += w[i] + g;
    if (mode !== 'arc') return place(b, cx, 0);
    const R = Math.max(total / 1.8, 1e-3), th = cx / R; // members on an arc, the middle one closest to the camera
    return place(b, R * Math.sin(th), R * (1 - Math.cos(th)));
  });
}

// memberRoots: one array of root instances per member (already cut to its path / disabled parts).
export function compositeTree(memberRoots, layout) {
  const offsets = layoutOffsets(memberRoots.map(treeBounds), layout?.mode, layout?.gap ?? 0.25);
  memberRoots.forEach((roots, i) => {
    const o = offsets[i], move = (c) => ({ ...c, p: c.p.map((v, k) => v + o[k]) });
    for (const inst of walk(roots)) {
      if (isPart(inst) && inst.props.cframe) inst.props.cframe = move(inst.props.cframe);
      else if ((inst.className === 'Model' || inst.className === 'Actor') && inst.props.worldpivotdata) inst.props.worldpivotdata = move(inst.props.worldpivotdata);
    }
  });
  return finalizeTree(memberRoots.flat());
}
