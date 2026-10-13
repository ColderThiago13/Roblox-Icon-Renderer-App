// Things placed around the model at render time: procedural idle motion and a pedestal under it.
import * as THREE from 'three';

const TAU = Math.PI * 2;
const about = (p, m) => new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(m).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));

// World transform of the motion (settings.motion) at t seconds, around the unmoved model (center, bottom, radius).
export function motionMatrix(m, t, center, minY, radius) {
  const w = TAU * m.speed * t, A = m.amount, base = new THREE.Vector3(center.x, minY, center.z);
  switch (m.mode) {
    case 'float':
      return new THREE.Matrix4().makeTranslation(0, Math.sin(w) * 0.08 * A * radius, 0).multiply(about(center, new THREE.Matrix4().makeRotationZ(Math.sin(w + 1) * 0.05 * A)));
    case 'bounce': { // a hop per cycle, squashing on landing
      const u = ((t * m.speed) % 1 + 1) % 1, air = 4 * u * (1 - u), squash = 1 - 0.15 * A * (1 - air) ** 8;
      return new THREE.Matrix4().makeTranslation(0, air * 0.22 * A * radius, 0).multiply(about(base, new THREE.Matrix4().makeScale(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash))));
    }
    case 'wobble': return about(base, new THREE.Matrix4().makeRotationZ(Math.sin(w) * 0.2 * A).multiply(new THREE.Matrix4().makeRotationX(Math.sin(w * 0.5) * 0.06 * A)));
    case 'spin': return about(center, new THREE.Matrix4().makeRotationY(w));
    case 'pulse': return about(center, new THREE.Matrix4().makeScale(...Array(3).fill(1 + 0.08 * A * Math.sin(w))));
    default: return new THREE.Matrix4();
  }
}

// Framing points covering a whole motion cycle, so the camera holds still while the model moves inside the frame.
export function motionFramePoints(points, m, center, minY, radius) {
  if (!m || m.mode === 'none' || !points.length) return points;
  const stride = Math.max(1, Math.ceil(points.length / 3 / 2000)) * 3, phases = m.mode === 'spin' ? 24 : 16, out = [...points], v = new THREE.Vector3();
  for (let k = 0; k < phases; k++) {
    const M = motionMatrix(m, k / phases / m.speed, center, minY, radius);
    for (let i = 0; i < points.length; i += stride) { v.set(points[i], points[i + 1], points[i + 2]).applyMatrix4(M); out.push(v.x, v.y, v.z); }
  }
  return new Float32Array(out);
}

// ---------- pedestal ----------
// Built at unit size (radius 1, height 1, top at y = 0), then scaled and placed under the model.
const GRASS = ['#7a5230', '#5aa832'];
function part(geo, color, y) {
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 }));
  m.position.y = y;
  m.castShadow = m.receiveShadow = true;
  return m;
}
export function pedestalGroup(p) {
  const g = new THREE.Group(), [c1, c2] = p.shape === 'grass' ? GRASS : [p.color, p.color2];
  // Trims are open bands just outside the body, and slabs sit on a shorter body, so no two faces share a plane.
  const cyl = (r0, r1, h, seg = 64, open = false) => new THREE.CylinderGeometry(r0, r1, h, seg, 1, open);
  const box = (w, h) => new THREE.BoxGeometry(w, h, w);
  switch (p.shape) {
    case 'disc': g.add(part(cyl(1, 1.02, 1), c1, -0.5), part(cyl(1.035, 1.035, 0.16, 64, true), c2, -0.09)); break;
    case 'podium': g.add(part(cyl(1.25, 1.3, 0.5), c1, -0.75), part(cyl(1, 1.04, 0.5), c1, -0.25),
      part(cyl(1.275, 1.275, 0.1, 64, true), c2, -0.56), part(cyl(1.025, 1.025, 0.1, 64, true), c2, -0.06)); break;
    case 'platform': g.add(part(box(2, 0.85), c1, -0.575), part(box(2.06, 0.15), c2, -0.075)); break;
    case 'grass': g.add(part(box(2, 0.78), c1, -0.61), part(box(2.04, 0.22), c2, -0.11)); break;
    case 'hexagon': g.add(part(cyl(1, 1, 1, 6), c1, -0.5), part(cyl(1.035, 1.035, 0.16, 6, true), c2, -0.09)); break;
  }
  return g;
}

// Where the pedestal goes for this model: { x, y (top), z, r, h }. Sizes are relative to the model radius.
export const pedestalPlace = (p, center, minY, radius) => ({ x: center.x, y: minY - p.gap * radius, z: center.z, r: radius * p.size, h: radius * p.height });

// Points on the pedestal's outer rim, top and bottom, for framing.
export function pedestalPoints(p, center, minY, radius) {
  if (p.shape === 'none') return new Float32Array();
  const { x, y, z, r, h } = pedestalPlace(p, center, minY, radius), out = [], R = r * (p.shape === 'podium' ? 1.3 : p.shape === 'platform' || p.shape === 'grass' ? 1.45 : 1.04);
  for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU; for (const yy of [y, y - h]) out.push(x + Math.cos(a) * R, yy, z + Math.sin(a) * R); }
  return new Float32Array(out);
}
