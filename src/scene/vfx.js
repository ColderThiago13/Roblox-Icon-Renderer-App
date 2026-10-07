// VFX: ParticleEmitters (analytic, deterministic simulation at any time T), Beams, and legacy Fire/Smoke/Sparkles.
// Everything renders premultiplied so LightEmission blends between alpha (0) and additive (1) like Roblox.
// Built once per file; update(time) re-simulates cheaply so the timeline can scrub and play.
import * as THREE from 'three';
import { loadTexture, textureFrom } from './assets.js';
import { worldMatrix, isPart, color3 } from './build.js';
import { nameOf } from '../rbx/instance.js';

const NORMALS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];

// Roblox only renders effects whose source is a BasePart or an Attachment/Bone inside one.
// Attachments directly under a Model are placed relative to the Model's pivot and do render.
function inPart(inst) {
  for (let p = inst; p; p = p.parent) {
    if (isPart(p)) return true;
    if (p !== inst && (p.className === 'Model' || p.className === 'Actor')) return true;
    if (p.className !== 'Attachment' && p.className !== 'Bone') return false;
  }
  return false;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const lerp = (a, b, t) => a + (b - a) * t;
const range = (r, rand) => lerp(r.min, r.max, rand());

function evalNumSeq(seq, t, offset) {
  if (!seq?.length) return 0;
  for (let i = 1; i < seq.length; i++) {
    if (t <= seq[i].t) {
      const a = seq[i - 1], b = seq[i], k = (t - a.t) / ((b.t - a.t) || 1);
      return lerp(a.v + a.e * offset, b.v + b.e * offset, k);
    }
  }
  const l = seq[seq.length - 1];
  return l.v + l.e * offset;
}
function evalColorSeq(seq, t) {
  if (!seq?.length) return { r: 1, g: 1, b: 1 };
  for (let i = 1; i < seq.length; i++) {
    if (t <= seq[i].t) {
      const a = seq[i - 1], b = seq[i], k = (t - a.t) / ((b.t - a.t) || 1);
      return { r: lerp(a.c.r, b.c.r, k), g: lerp(a.c.g, b.c.g, k), b: lerp(a.c.b, b.c.b, k) };
    }
  }
  return seq[seq.length - 1].c;
}
const numSeq = (v) => (typeof v === 'number' ? [{ t: 0, v, e: 0 }, { t: 1, v, e: 0 }] : v);
const colSeq = (c) => (Array.isArray(c) ? c : [{ t: 0, c }, { t: 1, c }]);

// Shared ribbon shading and sequence sampling for Trails.
export { evalNumSeq, evalColorSeq, numSeq, colSeq, vfxMaterial, beamVS, beamFS, inPart };

// ---------- procedural stand-ins for built-in rbxasset:// textures ----------
const procCache = new Map();
function procTexture(kind) {
  if (procCache.has(kind)) return procCache.get(kind);
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const radial = (stops) => { const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2); stops.forEach(([o, col]) => gr.addColorStop(o, col)); g.fillStyle = gr; g.fillRect(0, 0, S, S); };
  if (kind === 'sparkle') {
    radial([[0, 'rgba(255,255,255,0.9)'], [0.25, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']]);
    g.fillStyle = '#fff';
    for (const [w, h] of [[S * 0.06, S * 0.48], [S * 0.48, S * 0.06]]) { g.beginPath(); g.ellipse(S / 2, S / 2, w, h, 0, 0, Math.PI * 2); g.fill(); }
  } else if (kind === 'smoke') {
    const r = rng(7);
    for (let i = 0; i < 14; i++) {
      const x = S / 2 + (r() - 0.5) * S * 0.35, y = S / 2 + (r() - 0.5) * S * 0.35, rad = S * (0.18 + r() * 0.2);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }
  } else if (kind === 'beam') {
    g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
  } else if (kind === 'fire') {
    radial([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]);
  } else {
    radial([[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
  }
  const t = textureFrom(c);
  procCache.set(kind, t);
  return t;
}

async function textureFor(url, fallbackKind, warn, label) {
  if (url && /rbxassetid:|[?&]id=\d/i.test(url)) {
    try { return await loadTexture(url); } catch (e) { warn(`${label}: ${e.message}`); }
  }
  if (url && /sparkle/i.test(url)) return procTexture('sparkle');
  if (url && /smoke/i.test(url)) return procTexture('smoke');
  if (url && /fire|flame/i.test(url)) return procTexture('fire');
  return procTexture(fallbackKind);
}

// ---------- emitter configs ----------
// Roblox: Brightness only scales emitted light when LightInfluence is 0; lit effects take the scene light instead.
// The shader blends mix(Brightness, litLight, LightInfluence); litLight is a setting (Studio daylight ≈ 2).
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function emitterConfig(inst) {
  const p = inst.props, a = inst.attributes;
  if (inst.className === 'ParticleEmitter') {
    return {
      texture: p.texture, fallback: 'circle',
      enabled: p.enabled !== false, rate: p.rate ?? 5, emitCount: +(a.EmitCount ?? a.emitcount ?? 0), emitDelay: +(a.EmitDelay ?? 0),
      lifetime: p.lifetime ?? { min: 5, max: 10 }, speed: p.speed ?? { min: 5, max: 5 }, spread: p.spreadangle ?? { x: 0, y: 0 },
      accel: p.acceleration ?? { x: 0, y: 0, z: 0 }, drag: p.drag ?? 0,
      size: numSeq(p.size ?? 1), squash: numSeq(p.squash ?? 0), transparency: numSeq(p.transparency ?? 0), color: colSeq(p.color ?? { r: 1, g: 1, b: 1 }),
      rotation: p.rotation ?? { min: 0, max: 0 }, rotSpeed: p.rotspeed ?? { min: 0, max: 0 },
      lightEmission: p.lightemission ?? 0, brightness: p.brightness ?? 1, lightInfluence: clamp01(p.lightinfluence ?? 0), zOffset: p.zoffset ?? 0,
      orientation: p.orientation ?? 0, emissionDir: p.emissiondirection ?? 1,
      shape: p.shape ?? 0, shapeStyle: p.shapestyle ?? 0, shapeInOut: p.shapeinout ?? 0,
      flipLayout: p.flipbooklayout ?? 0, flipSize: { x: p.flipbooksizex ?? 1, y: p.flipbooksizey ?? 1 }, flipMode: p.flipbookmode ?? 0,
      flipRate: p.flipbookframerate ?? { min: 1, max: 1 }, flipRandom: !!p.flipbookstartrandom, flipBlend: p.flipbookblendframes ?? true,
      timeScale: p.timescale ?? 1,
    };
  }
  const base = { enabled: p.enabled !== false, emitCount: 0, emitDelay: 0, spread: { x: 15, y: 15 }, drag: 0, rotation: { min: 0, max: 360 }, rotSpeed: { min: -30, max: 30 }, brightness: 1, zOffset: 0, orientation: 0, emissionDir: 1, shape: 0, shapeStyle: 0, shapeInOut: 0, flipLayout: 0, timeScale: 1, squash: numSeq(0) };
  if (inst.className === 'Fire') {
    const size = p.size_xml ?? p.size ?? 5, heat = p.heat_xml ?? p.heat ?? 9;
    return { ...base, texture: null, fallback: 'fire', rate: 65, lifetime: { min: 0.5, max: 1 }, speed: { min: heat * 0.4, max: heat * 0.6 }, accel: { x: 0, y: heat * 0.3, z: 0 },
      size: [{ t: 0, v: size * 0.6, e: 0.1 }, { t: 1, v: size * 0.15, e: 0 }], transparency: [{ t: 0, v: 0.2, e: 0 }, { t: 1, v: 1, e: 0 }],
      color: [{ t: 0, c: p.color ?? { r: 0.93, g: 0.5, b: 0.2 } }, { t: 1, c: p.secondarycolor ?? { r: 0.55, g: 0.31, b: 0.18 } }], lightEmission: 0.85 };
  }
  if (inst.className === 'Smoke') {
    const size = p.size_xml ?? p.size ?? 1, rise = p.risevelocity_xml ?? p.risevelocity ?? 1, op = p.opacity_xml ?? p.opacity ?? 0.5;
    return { ...base, texture: null, fallback: 'smoke', rate: 20, lifetime: { min: 3, max: 5 }, speed: { min: rise, max: rise * 1.2 }, accel: { x: 0, y: 0, z: 0 },
      size: [{ t: 0, v: size, e: 0.2 }, { t: 1, v: size * 3, e: 0.2 }], transparency: [{ t: 0, v: 1 - op, e: 0 }, { t: 1, v: 1, e: 0 }],
      color: colSeq(p.color ?? { r: 1, g: 1, b: 1 }), lightEmission: 0, spread: { x: 20, y: 20 } };
  }
  // Sparkles
  return { ...base, texture: 'sparkle', fallback: 'sparkle', rate: 40, lifetime: { min: 0.8, max: 1.4 }, speed: { min: 2, max: 4 }, accel: { x: 0, y: 0, z: 0 },
    size: [{ t: 0, v: 0.6, e: 0.2 }, { t: 1, v: 0.1, e: 0 }], transparency: [{ t: 0, v: 0, e: 0 }, { t: 1, v: 1, e: 0 }],
    color: colSeq(p.sparklecolor ?? { r: 0.56, g: 0.34, b: 1 }), lightEmission: 1, spread: { x: 180, y: 180 } };
}

// Flipbook grid, or null when Roblox would ignore it (needs a square power-of-two texture, 8..1024 px).
function flipGrid(cfg, map) {
  const g = [null, { x: 2, y: 2 }, { x: 4, y: 4 }, { x: 8, y: 8 }, cfg.flipSize][cfg.flipLayout];
  if (!g || g.x * g.y <= 1) return null;
  const img = map.image, w = img?.naturalWidth || img?.width, h = img?.naturalHeight || img?.height;
  const pot = (n) => n >= 8 && n <= 1024 && (n & (n - 1)) === 0;
  return w === h && pot(w) ? g : null;
}

// ---------- spawn ----------
function spawnPoint(cfg, src, rand) {
  const dirLocal = new THREE.Vector3(...NORMALS[cfg.emissionDir] || NORMALS[1]);
  const pos = new THREE.Vector3(), dir = dirLocal.clone();
  if (src.size) {
    const s = src.size, r3 = () => new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5);
    if (cfg.shape === 1) { // sphere
      const d = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
      const rad = cfg.shapeStyle === 1 ? 1 : Math.cbrt(rand());
      pos.copy(d).multiplyScalar(rad * 0.5).multiply(s);
      dir.copy(d);
    } else if (cfg.shape === 2 || cfg.shape === 3) { // cylinder / disc around emission axis
      const ang = rand() * Math.PI * 2, rad = cfg.shapeStyle === 1 ? 0.5 : Math.sqrt(rand()) * 0.5;
      const t1 = new THREE.Vector3(dirLocal.y, dirLocal.z, dirLocal.x), t2 = new THREE.Vector3().crossVectors(dirLocal, t1);
      const radial = t1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(t2, Math.sin(ang));
      pos.copy(radial).multiplyScalar(rad).addScaledVector(dirLocal, cfg.shape === 2 ? rand() - 0.5 : 0).multiply(s);
      if (cfg.shape === 2) dir.copy(radial);
    } else if (cfg.shapeStyle === 1) { // box surface: the face toward EmissionDirection
      pos.copy(r3()).multiply(s);
      const axis = ['x', 'y', 'z'][Math.abs(dirLocal.x) > 0.5 ? 0 : Math.abs(dirLocal.y) > 0.5 ? 1 : 2];
      pos[axis] = dirLocal[axis] * s[axis] * 0.5;
    } else pos.copy(r3()).multiply(s);
    if (cfg.shapeInOut === 1) dir.negate();
    else if (cfg.shapeInOut === 2 && rand() < 0.5) dir.negate();
  }
  // SpreadAngle: random rotation in [-x, x] / [-y, y] degrees around the two axes perpendicular to the direction
  if (cfg.spread.x || cfg.spread.y) {
    const up = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const ax1 = new THREE.Vector3().crossVectors(dir, up).normalize(), ax2 = new THREE.Vector3().crossVectors(dir, ax1).normalize();
    dir.applyAxisAngle(ax1, THREE.MathUtils.degToRad((rand() * 2 - 1) * cfg.spread.x));
    dir.applyAxisAngle(ax2, THREE.MathUtils.degToRad((rand() * 2 - 1) * cfg.spread.y));
  }
  return { pos: pos.applyMatrix4(src.matrix), dir: dir.transformDirection(src.matrix) };
}

const hash = (a, b) => Math.imul(a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b), 0xc2b2ae35) >>> 0;

// Each particle's random values depend only on (seed, index), so scrubbing time moves particles continuously.
function simulate(cfg, src, grid, T, opts) {
  const spawns = []; // [index, spawnTime]
  const T0 = T * cfg.timeScale;
  if (cfg.enabled && cfg.rate > 0) {
    const n = Math.floor(cfg.rate * T0) + 1;
    // Prewarm: the emitter has been running before t=0 (as in Studio), so it starts fully populated.
    const first = Math.ceil((T0 - cfg.lifetime.max) * cfg.rate);
    for (let i = Math.max(opts.prewarm ? first : Math.max(0, first), n - 20000); i < n; i++) spawns.push([i, i / cfg.rate]);
  }
  if (opts.includeBursts && cfg.emitCount > 0 && cfg.emitDelay <= T0) {
    for (let j = 0; j < cfg.emitCount; j++) spawns.push([1e7 + j, cfg.emitDelay]);
  }
  const grav = new THREE.Vector3(cfg.accel.x, cfg.accel.y, cfg.accel.z);
  const k = cfg.drag * Math.LN2; // Drag = seconds to lose half the speed
  const frames = grid ? grid.x * grid.y : 1;
  const cell = (i) => [(i % grid.x) / grid.x, 1 - (Math.floor(i / grid.x) + 1) / grid.y];
  const out = [];
  for (let s = spawns.length - 1; s >= 0 && out.length < opts.maxParticles; s--) {
    const [index, t0] = spawns[s];
    const rand = rng(hash(opts.seed, index));
    const life = range(cfg.lifetime, rand), age = T0 - t0;
    if (age < 0 || age >= life) continue;
    const sp = spawnPoint(cfg, src, rand);
    const speed = range(cfg.speed, rand), rot0 = range(cfg.rotation, rand), rotSpeed = range(cfg.rotSpeed, rand);
    const env = rand() * 2 - 1, envT = rand() * 2 - 1;
    const flipStart = cfg.flipRandom ? Math.floor(rand() * frames) : 0, flipRate = range(cfg.flipRate || { min: 1, max: 1 }, rand);
    const v0 = sp.dir.multiplyScalar(speed);
    let pos, vel;
    if (k > 0) {
      const term = grav.clone().divideScalar(k), e = Math.exp(-k * age);
      vel = v0.clone().sub(term).multiplyScalar(e).add(term);
      pos = sp.pos.clone().addScaledVector(term, age).addScaledVector(v0.clone().sub(term), (1 - e) / k);
    } else {
      vel = v0.clone().addScaledVector(grav, age);
      pos = sp.pos.clone().addScaledVector(v0, age).addScaledVector(grav, 0.5 * age * age);
    }
    const lt = age / life;

    // flipbook: two frames + blend weight (FlipbookBlendFrames crossfades)
    let f0 = 0, f1 = 0, blend = 0;
    if (frames > 1) {
      const f = flipStart + age * flipRate;
      if (cfg.flipMode === 1) { const x = Math.min(lt * frames, frames - 1); f0 = Math.floor(x); f1 = Math.min(f0 + 1, frames - 1); blend = x - f0; } // OneShot: once over the lifetime
      else if (cfg.flipMode === 2) { const period = 2 * frames - 2, p = f % period, tri = p < frames - 1 ? p : period - p; f0 = Math.floor(tri); f1 = Math.min(f0 + 1, frames - 1); blend = tri - f0; }
      else if (cfg.flipMode === 3) { f0 = f1 = Math.floor(rng(hash(index, Math.floor(f)))() * frames); }
      else { f0 = Math.floor(f) % frames; f1 = (f0 + 1) % frames; blend = f - Math.floor(f); }
      if (!cfg.flipBlend) blend = 0;
    }

    const size = Math.max(0, evalNumSeq(cfg.size, lt, env));
    // Squash > 0: taller and narrower; < 0: wider and shorter.
    // ponytail: Roblox's exact squash curve is undocumented; area-preserving scale matches its description.
    const sq = evalNumSeq(cfg.squash, lt, 0), ks = sq >= 0 ? 1 + sq : 1 / (1 - sq);
    out.push({
      pos, vel, sx: size / ks, sy: size * ks,
      alpha: 1 - Math.min(1, Math.max(0, evalNumSeq(cfg.transparency, lt, envT))),
      color: color3(evalColorSeq(cfg.color, lt)), rot: THREE.MathUtils.degToRad(rot0 + rotSpeed * age),
      frame: frames > 1 ? [...cell(f0), ...cell(f1)] : [0, 0, 0, 0], blend,
    });
  }
  return out;
}

// ---------- rendering ----------
const quad = new THREE.PlaneGeometry(1, 1);

// ZOffset moves toward the camera while keeping the on-screen size (scale by (d - z) / d).
const particleVS = /* glsl */`
attribute vec3 iPos; attribute vec3 iVel; attribute vec4 iColor; attribute vec2 iSize; attribute float iRot; attribute vec4 iFrame; attribute float iBlend;
uniform int orientation; uniform float zOffset; uniform vec2 cell;
varying vec2 vUv0; varying vec2 vUv1; varying float vBlend; varying vec4 vColor;
void main() {
  vUv0 = iFrame.xy + uv * cell; vUv1 = iFrame.zw + uv * cell; vBlend = iBlend;
  vColor = iColor;
  vec2 c = position.xy * iSize;
  float cs = cos(iRot), sn = sin(iRot);
  vec2 r = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
  vec3 center = (viewMatrix * vec4(iPos, 1.0)).xyz;
  vec3 off;
  if (orientation == 1) {
    vec3 up = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec3 right = normalize(cross(up, normalize(-center)));
    off = right * r.x + up * r.y;
  } else if (orientation == 2) {
    vec3 v = (viewMatrix * vec4(iVel, 0.0)).xyz;
    vec2 ax = length(v.xy) > 1e-6 ? normalize(v.xy) : vec2(0.0, 1.0);
    off = vec3(ax * c.y + vec2(ax.y, -ax.x) * c.x, 0.0);
  } else if (orientation == 3) {
    vec3 n = length(iVel) > 1e-6 ? normalize(iVel) : vec3(0.0, 1.0, 0.0);
    vec3 up = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, -1.0);
    vec3 t2 = normalize(up - n * dot(up, n)); // texture up stays as close to world up as possible
    vec3 t1 = cross(t2, n);
    off = (viewMatrix * vec4(t1 * r.x + t2 * r.y, 0.0)).xyz;
  } else {
    off = vec3(r, 0.0);
  }
  float d = length(center);
  float k = d > 1e-4 ? max(0.0, (d - zOffset) / d) : 1.0;
  gl_Position = projectionMatrix * vec4((center + off) * k, 1.0);
}`;

const particleFS = /* glsl */`
uniform sampler2D map; uniform float lightEmission; uniform float brightness; uniform float lightInfluence; uniform float litLight;
varying vec2 vUv0; varying vec2 vUv1; varying float vBlend; varying vec4 vColor;
void main() {
  vec4 t = mix(texture2D(map, vUv0), texture2D(map, vUv1), vBlend);
  float a = t.a * vColor.a;
  gl_FragColor = vec4(t.rgb * vColor.rgb * mix(brightness, litLight, lightInfluence) * a, a * (1.0 - lightEmission));
}`;

function vfxMaterial(vs, fs, map, cfg, extraUniforms = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: vs, fragmentShader: fs,
    uniforms: { map: { value: map }, lightEmission: { value: clamp01(cfg.lightEmission) }, brightness: { value: cfg.brightness }, lightInfluence: { value: cfg.lightInfluence ?? 0 }, litLight: { value: 2 }, zOffset: { value: cfg.zOffset }, ...extraUniforms },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

const ATTRS = [['iPos', 3], ['iVel', 3], ['iColor', 4], ['iSize', 2], ['iRot', 1], ['iFrame', 4], ['iBlend', 1]];

function particleMesh(map, cfg, grid) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index; g.setAttribute('position', quad.attributes.position); g.setAttribute('uv', quad.attributes.uv);
  for (const [name, size] of ATTRS) g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(16 * size), size));
  g.instanceCount = 0;
  const cell = grid ? new THREE.Vector2(1 / grid.x, 1 / grid.y) : new THREE.Vector2(1, 1);
  const mesh = new THREE.Mesh(g, vfxMaterial(particleVS, particleFS, map, cfg, { orientation: { value: cfg.orientation }, cell: { value: cell } }));
  mesh.frustumCulled = false;
  mesh.userData.particles = [];
  // Called outside rendering: grow buffers (new attribute objects get fresh GPU buffers).
  mesh.userData.setParticles = (list) => {
    if (g.attributes.iPos.count < list.length) {
      const cap = 2 ** Math.ceil(Math.log2(list.length));
      for (const [name, size] of ATTRS) g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size));
    }
    mesh.userData.particles = list;
  };
  // Back-to-front ordering per camera for correct alpha blending.
  mesh.onBeforeRender = (_r, _s, camera) => {
    const particles = mesh.userData.particles;
    g.instanceCount = particles.length;
    const cp = camera.position, A = g.attributes;
    const sorted = particles.slice().sort((a, b) => b.pos.distanceToSquared(cp) - a.pos.distanceToSquared(cp));
    sorted.forEach((p, i) => {
      A.iPos.setXYZ(i, p.pos.x, p.pos.y, p.pos.z); A.iVel.setXYZ(i, p.vel.x, p.vel.y, p.vel.z);
      A.iColor.setXYZW(i, p.color.r, p.color.g, p.color.b, p.alpha); A.iSize.setXY(i, p.sx, p.sy); A.iRot.setX(i, p.rot);
      A.iFrame.setXYZW(i, ...p.frame); A.iBlend.setX(i, p.blend);
    });
    for (const [name] of ATTRS) A[name].needsUpdate = true;
  };
  return mesh;
}

// ---------- beams ----------
// Roblox maps the texture's top edge to Attachment0 and bottom to Attachment1 (V runs along the beam, U across).
// With FaceCamera off, the width follows the attachments' Y axes (blended along the curve).
const beamVS = /* glsl */`
attribute vec3 tangent3; attribute float side; attribute float width; attribute vec3 fixedDir; attribute vec4 color4; attribute float along;
uniform bool faceCamera; uniform float zOffset; uniform float scroll;
varying vec2 vUv; varying vec4 vColor;
void main() {
  vUv = vec2(uv.x, 1.0 - (along - scroll)); vColor = color4;
  vec3 dir = fixedDir;
  if (faceCamera) {
    vec3 facing = cross(tangent3, cameraPosition - position);
    if (dot(facing, facing) > 1e-8) dir = normalize(facing);
  }
  vec3 center = (viewMatrix * vec4(position, 1.0)).xyz;
  vec3 off = (viewMatrix * vec4(dir * side * width * 0.5, 0.0)).xyz;
  float d = length(center);
  float k = d > 1e-4 ? max(0.0, (d - zOffset) / d) : 1.0;
  gl_Position = projectionMatrix * vec4((center + off) * k, 1.0);
}`;
const beamFS = /* glsl */`
uniform sampler2D map; uniform float lightEmission; uniform float brightness; uniform float lightInfluence; uniform float litLight;
varying vec2 vUv; varying vec4 vColor;
void main() {
  vec4 t = texture2D(map, vUv);
  float a = t.a * vColor.a;
  gl_FragColor = vec4(t.rgb * vColor.rgb * mix(brightness, litLight, lightInfluence) * a, a * (1.0 - lightEmission));
}`;

// Beam ribbon from the attachments' current world transforms (re-run when an animation moves them).
function beamGeometry(inst) {
  const p = inst.props;
  const m0 = worldMatrix(p.attachment0), m1 = worldMatrix(p.attachment1);
  const P0 = new THREE.Vector3().setFromMatrixPosition(m0), P3 = new THREE.Vector3().setFromMatrixPosition(m1);
  const axis = (m, i) => new THREE.Vector3().setFromMatrixColumn(m, i).normalize();
  const curve = new THREE.CubicBezierCurve3(P0, P0.clone().addScaledVector(axis(m0, 0), p.curvesize0 ?? 0), P3.clone().addScaledVector(axis(m1, 0), -(p.curvesize1 ?? 0)), P3);
  const y0 = axis(m0, 1), y1 = axis(m1, 1);
  const segs = Math.max(1, Math.min(1000, p.segments ?? 10));
  const total = curve.getLength();
  const colorS = colSeq(p.color ?? { r: 1, g: 1, b: 1 }), transS = numSeq(p.transparency ?? 0.5);
  const w0 = p.width0 ?? 1, w1 = p.width1 ?? 1, texLen = p.texturelength ?? 1, mode = p.texturemode ?? 0;
  const pos = [], tan = [], side = [], width = [], fixed = [], col = [], uv = [], along = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, pt = curve.getPoint(t), tg = curve.getTangent(t);
    const fd = y0.clone().lerp(y1, t);
    fd.addScaledVector(tg, -fd.dot(tg));
    if (fd.lengthSq() < 1e-8) fd.crossVectors(tg, Math.abs(tg.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
    fd.normalize();
    const c = color3(evalColorSeq(colorS, t)), a = 1 - evalNumSeq(transS, t, 0);
    // Stretch: TextureLength repeats over the beam; Wrap/Static: one repeat per TextureLength studs
    const v = mode === 0 ? t * texLen : (t * total) / (texLen || 1);
    for (const s of [-1, 1]) {
      pos.push(pt.x, pt.y, pt.z); tan.push(tg.x, tg.y, tg.z); side.push(s); width.push(lerp(w0, w1, t));
      fixed.push(fd.x, fd.y, fd.z); col.push(c.r, c.g, c.b, a); uv.push(s < 0 ? 0 : 1, 0); along.push(v);
    }
    if (i < segs) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  const g = new THREE.BufferGeometry();
  const f = (arr, n) => new THREE.Float32BufferAttribute(arr, n);
  g.setAttribute('position', f(pos, 3)); g.setAttribute('tangent3', f(tan, 3)); g.setAttribute('side', f(side, 1)); g.setAttribute('width', f(width, 1));
  g.setAttribute('fixedDir', f(fixed, 3)); g.setAttribute('color4', f(col, 4)); g.setAttribute('uv', f(uv, 2)); g.setAttribute('along', f(along, 1));
  g.setIndex(idx);
  return g;
}

async function buildBeam(inst, warn) {
  const p = inst.props;
  const a0 = p.attachment0, a1 = p.attachment1;
  if (!a0 || !a1) { warn(`${nameOf(inst)}: beam is missing an attachment`); return null; }
  if (!inPart(a0) || !inPart(a1)) { warn(`${nameOf(inst)}: beam attachment is not inside a part (Roblox doesn't render it)`); return null; }
  let map = procTexture('beam');
  if (p.texture) {
    map = await textureFor(p.texture, 'beam', warn, nameOf(inst));
    if (map !== procTexture('beam')) { map.wrapT = THREE.RepeatWrapping; map.needsUpdate = true; }
  }
  const cfg = { lightEmission: p.lightemission ?? 0, brightness: p.brightness ?? 1, lightInfluence: clamp01(p.lightinfluence ?? 1), zOffset: p.zoffset ?? 0 };
  const mesh = new THREE.Mesh(beamGeometry(inst), vfxMaterial(beamVS, beamFS, map, cfg, { faceCamera: { value: !!p.facecamera }, scroll: { value: 0 } }));
  mesh.frustumCulled = false;
  // TextureSpeed: texture lengths per second, moving from Attachment0 toward Attachment1
  const texLen = p.texturelength ?? 1;
  mesh.userData.speed = (p.texturemode ?? 0) === 0 ? (p.texturespeed ?? 1) * texLen : (p.texturespeed ?? 1);
  mesh.userData.inst = inst;
  return mesh;
}

// ---------- entry ----------
// Loads textures/geometry once. update(time, { seed, includeBursts, maxParticles }, poseChanged) re-simulates;
// poseChanged re-reads source transforms after an animation moved the parts.
export async function buildVfx(insts, warn) {
  const group = new THREE.Group();
  group.name = 'VFX';
  const beams = [], emitters = [];
  let i = 0;
  for (const inst of insts) {
    i++;
    if (inst.className === 'Beam') {
      if (inst.props.enabled === false) continue;
      const b = await buildBeam(inst, warn);
      if (b) { group.add(b); beams.push(b); }
      continue;
    }
    const cfg = emitterConfig(inst);
    if (!cfg.enabled && !cfg.emitCount) continue;
    const parent = inst.parent;
    if (!parent || !inPart(parent)) { warn(`${nameOf(inst)}: not inside a part or attachment-in-part (Roblox doesn't render it)`); continue; }
    const ps = parent && isPart(parent) ? parent.props.size ?? { x: 1, y: 1, z: 1 } : null;
    const src = { parent, matrix: worldMatrix(parent), size: ps && new THREE.Vector3(ps.x, ps.y, ps.z) }; // attachments emit from a point
    const map = await textureFor(cfg.texture, cfg.fallback, warn, nameOf(inst));
    const grid = flipGrid(cfg, map);
    if (cfg.flipLayout && !grid) warn(`${nameOf(inst)}: flipbook ignored (texture must be square power-of-two, 8-1024 px), same as Roblox`);
    const mesh = particleMesh(map, cfg, grid);
    group.add(mesh);
    emitters.push({ cfg, src, grid, mesh, index: i });
  }
  return {
    group,
    update(time, s, poseChanged) {
      if (poseChanged) {
        for (const b of beams) { b.geometry.dispose(); b.geometry = beamGeometry(b.userData.inst); }
        for (const e of emitters) e.src.matrix = worldMatrix(e.src.parent);
      }
      group.traverse((o) => { if (o.material?.uniforms?.litLight) o.material.uniforms.litLight.value = s.litLight ?? 2; });
      for (const b of beams) b.material.uniforms.scroll.value = time * b.userData.speed;
      for (const e of emitters) e.mesh.userData.setParticles(simulate(e.cfg, e.src, e.grid, time, { ...s, seed: hash(s.seed, e.index) }));
    },
  };
}
