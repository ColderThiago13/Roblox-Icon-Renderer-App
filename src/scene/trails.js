// Trail properties: https://create.roblox.com/docs/reference/engine/classes/Trail
import * as THREE from 'three';
import { worldMatrix, color3, isPart } from './build.js';
import { loadTexture } from './assets.js';
import { nameOf } from '../rbx/instance.js';
import { evalNumSeq, evalColorSeq, numSeq, colSeq, vfxMaterial, beamVS, beamFS, inPart } from './vfx.js';

const clamp = THREE.MathUtils.clamp;
const center = (s) => s.a.clone().add(s.b).multiplyScalar(0.5);
export function attachmentSample(inst, age = 0) {
  return { a: new THREE.Vector3().setFromMatrixPosition(worldMatrix(inst.props.attachment0)),
    b: new THREE.Vector3().setFromMatrixPosition(worldMatrix(inst.props.attachment1)), age };
}

// History is newest first. Clip the last segment exactly at the user's distance cap.
export function clipTrail(history, maxLength, minLength = 0) {
  if (!history.length || maxLength <= 0) return [];
  const out = [{ ...history[0], distance: 0 }];
  let distance = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = out[out.length - 1], next = history[i];
    const moved = Math.max(prev.a.distanceTo(next.a), prev.b.distanceTo(next.b));
    if (moved < Math.max(minLength, 1e-6)) continue;
    // Endpoint travel also counts when a rotating ribbon's center stays still.
    const d = (prev.a.distanceTo(next.a) + prev.b.distanceTo(next.b)) / 2;
    if (distance + d > maxLength) {
      const t = (maxLength - distance) / d;
      out.push({ a: prev.a.clone().lerp(next.a, t), b: prev.b.clone().lerp(next.b, t),
        age: THREE.MathUtils.lerp(prev.age, next.age, t), distance: maxLength });
      break;
    }
    distance += d;
    out.push({ ...next, distance });
  }
  return out;
}

// Where a still trail should sweep: away from the object's front, perpendicular to the attachment edge
// (motion along the edge would collapse the ribbon to a line). center = model bounds center, if known.
export function behindDirection(inst, center = null) {
  const { a, b } = attachmentSample(inst), edge = b.clone().sub(a).normalize(), mid = a.clone().add(b).multiplyScalar(0.5);
  let model = null, hrp = null;
  for (let p = inst.parent; p; p = p.parent) if (p.className === 'Model' || p.className === 'Actor') {
    model = p;
    hrp ??= p.children.find((c) => isPart(c) && nameOf(c) === 'HumanoidRootPart') ?? null;
  }
  const back = (m) => new THREE.Vector3().setFromMatrixColumn(m, 2); // opposite of LookVector
  const candidates = [
    hrp && back(worldMatrix(hrp)),
    center && mid.clone().sub(center).setY(0),
    model && back(worldMatrix(model)),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
  ];
  for (const c of candidates) {
    const len = c?.length();
    if (!(len > 0.05)) continue;
    const perp = c.clone().addScaledVector(edge, -c.dot(edge));
    if (perp.length() > 0.3 * len) return perp.normalize();
  }
  return new THREE.Vector3(0, 0, 1);
}

export function directionalHistory(inst, settings, dir = null) {
  const head = attachmentSample(inst), yaw = THREE.MathUtils.degToRad(settings.yaw), pitch = THREE.MathUtils.degToRad(settings.pitch);
  dir ??= new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  const length = Math.max(0, settings.length), lifetime = inst.props.lifetime ?? 2;
  return Array.from({ length: 65 }, (_, i) => {
    const f = i / 64, offset = dir.clone().multiplyScalar(length * f);
    return { a: head.a.clone().add(offset), b: head.b.clone().add(offset), age: lifetime * f };
  });
}

export function trailGeometry(inst, history, settings) {
  const p = inst.props, lifetime = Math.max(0.01, p.lifetime ?? 2);
  const limit = p.maxlength > 0 ? Math.min(settings.length, p.maxlength) : settings.length;
  const samples = clipTrail(history.filter((s) => s.age <= lifetime), limit, p.minlength ?? 0.1);
  const arrays = { position: [], tangent3: [], side: [], width: [], fixedDir: [], color4: [], uv: [], along: [] };
  const bounds = [], indices = [], colors = colSeq(p.color ?? { r: 1, g: 1, b: 1 });
  const alpha = numSeq(p.transparency ?? 0), widths = numSeq(p.widthscale ?? 1);
  const total = samples.at(-1)?.distance || 1, texLength = Math.max(0.001, p.texturelength ?? 1);
  if (samples.length < 2) samples.length = 0;
  samples.forEach((s, i) => {
    const age = clamp(s.age / lifetime, 0, 1), c = color3(evalColorSeq(colors, age));
    const a = (1 - clamp(evalNumSeq(alpha, age, 0), 0, 1)) * (1 - clamp(p.localtransparencymodifier ?? 0, 0, 1));
    const mid = center(s), edge = s.b.clone().sub(s.a), w = edge.length() * Math.max(0, evalNumSeq(widths, age, 0));
    const fixed = edge.lengthSq() ? edge.normalize() : new THREE.Vector3(0, 1, 0);
    const prev = center(samples[Math.max(0, i - 1)]), next = center(samples[Math.min(samples.length - 1, i + 1)]);
    const tangent = next.sub(prev).normalize();
    const along = (p.texturemode ?? 0) === 0 ? s.distance / total * texLength : s.distance / texLength;
    for (const side of [-1, 1]) {
      arrays.position.push(...mid); arrays.tangent3.push(...tangent); arrays.side.push(side); arrays.width.push(w);
      arrays.fixedDir.push(...fixed); arrays.color4.push(c.r, c.g, c.b, a); arrays.uv.push(side < 0 ? 0 : 1, 0); arrays.along.push(along);
      bounds.push(...mid.clone().addScaledVector(fixed, side * w / 2));
      // FaceCamera can rotate the width in any direction, so include its full radius when fitting.
      if (p.facecamera) for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) bounds.push(...mid.clone().addScaledVector(axis, side * w / 2));
    }
    if (i < samples.length - 1) { const b = i * 2; indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  });
  const geometry = new THREE.BufferGeometry();
  const sizes = { position: 3, tangent3: 3, side: 1, width: 1, fixedDir: 3, color4: 4, uv: 2, along: 1 };
  for (const [key, values] of Object.entries(arrays)) geometry.setAttribute(key, new THREE.Float32BufferAttribute(values, sizes[key]));
  geometry.setIndex(indices);
  geometry.userData.boundsPoints = bounds;
  return geometry;
}

export async function buildTrails(instances, warn) {
  const group = new THREE.Group(), trails = [];
  group.name = 'Trails';
  for (const inst of instances) {
    const p = inst.props;
    if (p.enabled === false) continue;
    if (!p.attachment0 || !p.attachment1) { warn(`${nameOf(inst)}: trail is missing an attachment`); continue; }
    if (![p.attachment0, p.attachment1].every((a) => ['Attachment', 'Bone'].includes(a.className) && inPart(a))) {
      warn(`${nameOf(inst)}: trail attachments must be inside a part or model`); continue;
    }
    let map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    const url = p.texture || p.texturecontent;
    if (url) {
      try { const texture = await loadTexture(url); map.dispose(); map = texture; }
      catch (e) { warn(`${nameOf(inst)}: ${e.message}`); }
    }
    map.wrapT = THREE.RepeatWrapping;
    const cfg = { lightEmission: p.lightemission ?? 0, brightness: p.brightness ?? 1,
      lightInfluence: clamp(p.lightinfluence ?? 1, 0, 1), zOffset: 0 };
    const material = vfxMaterial(beamVS, beamFS, map, cfg, { faceCamera: { value: !!p.facecamera }, scroll: { value: 0 } });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.frustumCulled = false;
    group.add(mesh); trails.push({ inst, mesh });
  }
  return {
    group, trails,
    update(settings, histories, center = null) {
      for (const { inst, mesh } of trails) {
        const history = histories?.get(inst) ?? directionalHistory(inst, settings, settings.mode === 'direction' ? null : behindDirection(inst, center));
        mesh.geometry.dispose(); mesh.geometry = trailGeometry(inst, history, settings);
        mesh.material.uniforms.litLight.value = settings.litLight;
      }
    },
  };
}
