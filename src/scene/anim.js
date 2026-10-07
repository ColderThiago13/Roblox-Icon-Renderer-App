// Rig posing from KeyframeSequences.
// Joints: Motor6D (Part1 = Part0 * C0 * Transform * C1^-1), AnimationConstraint (same with the attachments' CFrames as
// C0/C1), plus Weld/WeldConstraint so accessories and welded parts follow. Pose names match each joint's Part1 name.
// Bones (skinned meshes): Bone world = parent * Bone.CFrame * Transform; pose names match Bone names, and skinned
// MeshParts are deformed on the CPU with linear blend skinning against the bones' rest pose.
import * as THREE from 'three';
import { cframeMatrix, isPart, worldMatrix } from './build.js';
import { parseModel } from '../rbx/model.js';
import { getAssetBytes } from './assets.js';
import { nameOf } from '../rbx/instance.js';

// ---------------- easing (Enum.PoseEasingStyle / PoseEasingDirection) ----------------
const bounceOut = (t) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
const elasticOut = (t) => (t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);
const IN = { 2: (t) => 1 - elasticOut(1 - t), 3: (t) => t * t * t, 4: (t) => 1 - bounceOut(1 - t), 5: (t) => t * t * t };

export function ease(style, dir, t) {
  if (style === 1) return 0; // Constant: hold until the next keyframe
  const f = IN[style];
  if (!f) return t; // Linear
  // ponytail: legacy Elastic/Cubic/Bounce have In/Out swapped in Roblox (CubicV2 fixed it); verify against Studio if a curve looks mirrored.
  let d = dir ?? 0;
  if (style !== 5 && d !== 2) d = 1 - d;
  if (d === 0) return f(t);
  if (d === 1) return 1 - f(1 - t);
  return t < 0.5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2;
}

// ---------------- tracks ----------------
export function trackFromKeyframeSequence(ks, name) {
  const curves = new Map();
  let length = 0;
  for (const kf of ks.children) {
    if (kf.className !== 'Keyframe') continue;
    const t = kf.props.time ?? 0;
    length = Math.max(length, t);
    const visit = (node) => {
      for (const pose of node.children) {
        if (pose.className !== 'Pose') continue;
        // Weight 0 = placeholder that only keeps the hierarchy (unkeyed joint); Roblox ignores it.
        if (pose.props.weight === 0) { visit(pose); continue; }
        const key = nameOf(pose);
        const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
        cframeMatrix(pose.props.cframe).decompose(pos, quat, new THREE.Vector3());
        if (!curves.has(key)) curves.set(key, []);
        curves.get(key).push({ t, pos, quat, style: pose.props.easingstyle ?? 0, dir: pose.props.easingdirection ?? 0 });
        visit(pose);
      }
    };
    visit(kf);
  }
  for (const keys of curves.values()) keys.sort((a, b) => a.t - b.t);
  return { name: name ?? nameOf(ks), length, loop: ks.props.loop !== false, curves };
}

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), ONE = new THREE.Vector3(1, 1, 1);

// Joint transform for a pose name at time t (null when the animation doesn't key that joint).
export function sampleTrack(track, poseName, time) {
  const keys = track.curves.get(poseName);
  if (!keys?.length) return null;
  let t = time;
  if (track.length > 0) t = track.loop ? ((time % track.length) + track.length) % track.length : Math.min(Math.max(time, 0), track.length);
  let i = keys.length - 1;
  while (i > 0 && keys[i].t > t) i--;
  const a = keys[i], b = keys[i + 1];
  if (!b || t <= a.t) {
    const k = t < a.t ? keys[0] : a;
    return new THREE.Matrix4().compose(k.pos, k.quat, ONE);
  }
  const w = ease(a.style, a.dir, (t - a.t) / (b.t - a.t || 1));
  _p.lerpVectors(a.pos, b.pos, w);
  _q.slerpQuaternions(a.quat, b.quat, w);
  return new THREE.Matrix4().compose(_p, _q, ONE);
}

// Animation asset -> track. Supports KeyframeSequence; CurveAnimation (curve editor) is reported as unsupported.
export async function loadAnimationId(id) {
  const tree = parseModel(await getAssetBytes(`rbxassetid://${id}`));
  const ks = tree.all.find((i) => i.className === 'KeyframeSequence');
  if (ks) return trackFromKeyframeSequence(ks, `${nameOf(ks)} (${id})`);
  if (tree.all.some((i) => i.className === 'CurveAnimation')) throw new Error(`Animation ${id} uses the curve editor format (CurveAnimation), which isn't supported yet`);
  throw new Error(`Asset ${id} is not an animation`);
}

// Animations available inside a file: KeyframeSequences, plus Animation instances (loaded by id on demand).
export function fileAnimations(tree) {
  const out = [];
  for (const inst of tree.all) {
    if (inst.className === 'KeyframeSequence') out.push({ key: `ks:${out.length}:${nameOf(inst)}`, name: nameOf(inst), track: trackFromKeyframeSequence(inst) });
    else if (inst.className === 'Animation') {
      const id = String(inst.props.animationid ?? '').match(/(\d{3,})/)?.[1];
      if (id) out.push({ key: `id:${id}`, name: `${nameOf(inst)} (${id})`, id, track: null });
    }
  }
  return out;
}

// ---------------- rig ----------------
export function buildRig(tree, partObjects, skinned = []) {
  const saved = (p) => cframeMatrix(p.props.cframe);
  const edges = [];
  for (const inst of tree.all) {
    const p = inst.props, cls = inst.className;
    if (cls === 'Motor6D' || cls === 'Motor' || cls === 'Weld' || cls === 'ManualWeld' || cls === 'Snap' || cls === 'Glue') {
      if (!isPart(p.part0 ?? {}) || !isPart(p.part1 ?? {})) continue;
      edges.push({ a: p.part0, b: p.part1, c0: cframeMatrix(p.c0), c1inv: cframeMatrix(p.c1).invert(), animated: cls === 'Motor6D' || cls === 'Motor' });
    } else if (cls === 'AnimationConstraint') {
      const a0 = p.attachment0, a1 = p.attachment1;
      if (!a0 || !a1 || !isPart(a0.parent ?? {}) || !isPart(a1.parent ?? {})) continue;
      edges.push({ a: a0.parent, b: a1.parent, c0: cframeMatrix(a0.props.cframe), c1inv: cframeMatrix(a1.props.cframe).invert(), animated: true });
    } else if (cls === 'WeldConstraint' && p.enabled !== false) {
      if (!isPart(p.part0 ?? {}) || !isPart(p.part1 ?? {})) continue;
      edges.push({ a: p.part0, b: p.part1, c0: saved(p.part0).invert().multiply(saved(p.part1)), c1inv: new THREE.Matrix4(), animated: false });
    }
  }
  const bones = tree.all.filter((i) => i.className === 'Bone');
  if (!edges.some((e) => e.animated) && !bones.length) return null;
  const skins = prepareSkins(bones, skinned);

  const adj = new Map();
  for (const e of edges) for (const [from, to, fwd] of [[e.a, e.b, true], [e.b, e.a, false]]) {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, e, fwd });
  }
  // One root per connected group: HumanoidRootPart, else a part that is never driven by an animated joint.
  const driven = new Set(edges.filter((e) => e.animated).map((e) => e.b));
  const parts = [...adj.keys()];
  const order = []; // [part, parentLink|null] in BFS order
  const seen = new Set();
  const roots = [...parts.filter((p) => nameOf(p) === 'HumanoidRootPart'), ...parts.filter((p) => !driven.has(p)), ...parts];
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    const queue = [root];
    order.push([root, null]);
    while (queue.length) {
      const cur = queue.shift();
      for (const link of adj.get(cur)) {
        if (seen.has(link.to)) continue;
        seen.add(link.to);
        order.push([link.to, { from: cur, ...link }]);
        queue.push(link.to);
      }
    }
  }

  return {
    // track = null restores the pose saved in the file.
    apply(track, time, transformsOnly = false) {
      const world = new Map();
      for (const [part, link] of order) {
        let m;
        if (!track || !link) m = saved(part);
        else {
          const { e } = link;
          const T = (e.animated && sampleTrack(track, nameOf(e.b), time)) || new THREE.Matrix4();
          const rel = e.c0.clone().multiply(T).multiply(e.c1inv);
          m = world.get(link.from).clone().multiply(link.fwd ? rel : rel.invert());
        }
        world.set(part, m);
        part.anim = track ? m : null;
        const g = partObjects.get(part);
        if (g) g.matrix.copy(m);
      }
      for (const b of bones) b.boneT = track ? sampleTrack(track, nameOf(b), time) : null;
      if (!transformsOnly) for (const sk of skins) deform(sk, !!track);
    },
  };
}

// ---------------- skinning ----------------
function prepareSkins(bones, skinned) {
  const byName = new Map();
  for (const b of bones) if (!byName.has(nameOf(b))) byName.set(nameOf(b), b);
  const restInv = new Map(bones.map((b) => [b, worldMatrix(b).invert()]));
  const out = [];
  for (const { part, mesh } of skinned) {
    const geo = mesh.geometry, skin = geo.userData.skin;
    const meshBones = skin.names.map((n) => byName.get(n) || null);
    if (!meshBones.some(Boolean)) continue;
    const local = new THREE.Matrix4().compose(mesh.position, mesh.quaternion, mesh.scale);
    const restA = cframeMatrix(part.props.cframe).multiply(local); // geometry space -> world, rest pose
    const nm = new THREE.Matrix3().getNormalMatrix(restA);
    const pos = geo.attributes.position, nor = geo.attributes.normal, n = pos.count;
    const restW = new Float32Array(n * 3), restN = new Float32Array(n * 3), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(restA); restW.set([v.x, v.y, v.z], i * 3);
      if (nor) { v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); restN.set([v.x, v.y, v.z], i * 3); }
    }
    mesh.frustumCulled = false;
    out.push({ part, mesh, skin, local, restGeo: geo, work: null, restW, restN, hasNormals: !!nor, meshBones, restInv: meshBones.map((b) => b && restInv.get(b)) });
  }
  return out;
}

function deform(sk, posed) {
  if (!posed) { sk.mesh.geometry = sk.restGeo; return; }
  if (!sk.work) sk.work = sk.restGeo.clone();
  sk.mesh.geometry = sk.work;
  const M = sk.meshBones.map((b, i) => (b ? worldMatrix(b).multiply(sk.restInv[i]).elements : null));
  const A = (sk.part.anim ? sk.part.anim.clone() : cframeMatrix(sk.part.props.cframe)).multiply(sk.local);
  const Ainv = A.clone().invert().elements, Ae = A.elements;
  const { joints, weights } = sk.skin, pos = sk.work.attributes.position.array, nor = sk.work.attributes.normal?.array;
  const E = new Float64Array(16), n = pos.length / 3;
  for (let v = 0; v < n; v++) {
    E.fill(0);
    let wsum = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k], m = w > 0 && M[joints[v * 4 + k]];
      if (!m) continue;
      wsum += w;
      for (let j = 0; j < 16; j++) E[j] += m[j] * w;
    }
    const rest = 1 - wsum; // weight not covered by a bone stays at rest
    if (rest > 1e-6) { E[0] += rest; E[5] += rest; E[10] += rest; E[15] += rest; }
    const x = sk.restW[v * 3], y = sk.restW[v * 3 + 1], z = sk.restW[v * 3 + 2];
    const wx = E[0] * x + E[4] * y + E[8] * z + E[12], wy = E[1] * x + E[5] * y + E[9] * z + E[13], wz = E[2] * x + E[6] * y + E[10] * z + E[14];
    pos[v * 3] = Ainv[0] * wx + Ainv[4] * wy + Ainv[8] * wz + Ainv[12];
    pos[v * 3 + 1] = Ainv[1] * wx + Ainv[5] * wy + Ainv[9] * wz + Ainv[13];
    pos[v * 3 + 2] = Ainv[2] * wx + Ainv[6] * wy + Ainv[10] * wz + Ainv[14];
    if (nor && sk.hasNormals) {
      const a = sk.restN[v * 3], b = sk.restN[v * 3 + 1], c = sk.restN[v * 3 + 2];
      const nx = E[0] * a + E[4] * b + E[8] * c, ny = E[1] * a + E[5] * b + E[9] * c, nz = E[2] * a + E[6] * b + E[10] * c;
      // world normal -> geometry space: multiply by A^T (inverse of the normal matrix)
      const gx = Ae[0] * nx + Ae[1] * ny + Ae[2] * nz, gy = Ae[4] * nx + Ae[5] * ny + Ae[6] * nz, gz = Ae[8] * nx + Ae[9] * ny + Ae[10] * nz;
      const l = Math.hypot(gx, gy, gz) || 1;
      nor[v * 3] = gx / l; nor[v * 3 + 1] = gy / l; nor[v * 3 + 2] = gz / l;
    }
  }
  sk.work.attributes.position.needsUpdate = true;
  if (nor) sk.work.attributes.normal.needsUpdate = true;
  sk.work.computeBoundingSphere();
}
