// One WebGL context shared by preview, thumbnails and export.
// Pipeline: model pass (+ pedestal) -> silhouette copy -> reflection floor -> ground+VFX pass -> highlight fills ->
// normal/depth pass (AO, edges, rim, depth of field) -> bloom + lens flare -> grade (AO, tone map, color, rim, LUT,
// overlay, stylize, halftone, edges) -> depth of field / tilt-shift -> JFA distance fields -> strokes, light rays ->
// outline/glow/drop shadow/inner shadow/bevel -> highlight outlines -> background, dither, frame, text -> CRT/VHS.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as S from './shaders.js';
import { hexToVec3, RARITIES } from '../settings.js';
import { drawBackground, drawTexts, imageFor } from './overlay.js';
import { motionMatrix, motionFramePoints, pedestalGroup, pedestalPlace, pedestalPoints } from './stage.js';

export const LAYER = { MODEL: 0, GROUND: 2, VFX: 3, HL_FILL: 4, HL_MASK: 5, TRAIL: 6 };
const deg = THREE.MathUtils.degToRad;
const TONE = { none: 0, aces: 1, agx: 2, neutral: 3 };
const angles = (yaw, pitch) => new THREE.Vector3(Math.sin(deg(yaw)) * Math.cos(deg(pitch)), Math.sin(deg(pitch)), -Math.cos(deg(yaw)) * Math.cos(deg(pitch)));
const vec3 = (hex) => new THREE.Vector3(...hexToVec3(hex)); // display (sRGB) values, for passes after grading
const linear = (hex) => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); }; // for HDR passes

// Toon shading: material.defines.TOON_BANDS quantizes direct light (and the shadows in it) into bands.
const TOON_FROM = 'vec3 irradiance = dotNL * directLight.color;';
THREE.ShaderChunk.lights_physical_pars_fragment = THREE.ShaderChunk.lights_physical_pars_fragment.replace(TOON_FROM, `#ifdef TOON_BANDS
	float toonX = dotNL * float( TOON_BANDS );
	dotNL = ( floor( toonX ) + smoothstep( 0.4, 0.6, fract( toonX ) ) ) / float( TOON_BANDS );
	#endif
	${TOON_FROM}`);
export const TOON_READY = THREE.ShaderChunk.lights_physical_pars_fragment.includes('TOON_BANDS');

const PALETTES = {
  '1-bit': ['#000000', '#ffffff'], gameboy: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'], cga: ['#000000', '#55ffff', '#ff55ff', '#ffffff'],
  sepia: ['#2b1d0e', '#5e4024', '#8f6a3e', '#c4a173', '#f2e3c6'],
  'pico-8': ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'],
};

// World-space sample points used for framing (subsampled for huge meshes).
export function samplePoints(object, max = 40000) {
  const meshes = [];
  let total = 0;
  object.updateMatrixWorld(true);
  object.traverse((o) => {
    if (!o.visible) return;
    if (o.userData.particles) { meshes.push(o); total += o.userData.particles.length; }
    else if (o.isMesh && o.geometry.attributes.position) { meshes.push(o); total += o.geometry.attributes.position.count; }
  });
  const stride = Math.max(1, Math.ceil(total / max)), out = [], v = new THREE.Vector3();
  for (const m of meshes) {
    if (m.userData.particles) { for (const p of m.userData.particles) out.push(p.pos.x, p.pos.y, p.pos.z); continue; }
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += stride) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); out.push(v.x, v.y, v.z); }
  }
  return new Float32Array(out);
}

export function boundsOf(points) {
  if (!points.length) return { center: new THREE.Vector3(), radius: 1, minY: 0 };
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < points.length; i += 3) box.expandByPoint(v.set(points[i], points[i + 1], points[i + 2]));
  const center = box.getCenter(new THREE.Vector3());
  let r2 = 0;
  for (let i = 0; i < points.length; i += 3) r2 = Math.max(r2, center.distanceToSquared(v.set(points[i], points[i + 1], points[i + 2])));
  return { center, radius: Math.max(Math.sqrt(r2), 1e-3), minY: box.min.y };
}

export class IconRenderer {
  constructor(canvas) {
    this.hdriSources = new Map(); // name -> equirect texture, kept to rebuild after a GPU reset
    this.attach(canvas);
    this.mats = {};
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this.black.needsUpdate = true;
    this.far = new THREE.DataTexture(new Float32Array([1e4, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType); // "no edge in range"
    this.far.needsUpdate = true;
    this.luts = new Map();
    this.normalMats = new Map();

    this.fsScene = new THREE.Scene();
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fsMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);

    this.scene = new THREE.Scene();
    this.scene.environment = this.env;
    this.pcam = new THREE.PerspectiveCamera();
    this.ocam = new THREE.OrthographicCamera();
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x50505a, 1);
    this.key = new THREE.DirectionalLight();
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.fill = new THREE.DirectionalLight();
    this.rim = new THREE.DirectionalLight();
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ transparent: true }));
    this.ground.receiveShadow = true;
    this.ground.layers.set(LAYER.GROUND);
    // Everything that moves with the motion settings (model, VFX, trails, highlights, model lights) goes in here.
    this.motion = new THREE.Group();
    this.motion.matrixAutoUpdate = false;
    this.mirror = new THREE.Group();
    this.mirror.matrixAutoUpdate = false;
    this.rig = [this.hemi, this.key, this.key.target, this.fill, this.fill.target, this.rim, this.rim.target, this.ground, this.motion];
    for (const o of this.rig) { if (o.isLight) o.layers.enableAll(); this.scene.add(o); }
  }

  // Everything tied to one WebGL context: the renderer, its PMREM environments and render targets. Scenes, materials and
  // the files' textures/meshes are context-free and upload again on their own.
  attach(canvas) {
    this.canvas = canvas;
    const gl = (this.gl = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true }));
    gl.setPixelRatio(1);
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFShadowMap;
    gl.toneMapping = THREE.NoToneMapping;
    gl.setClearColor(0x000000, 0);
    this.env = new THREE.PMREMGenerator(gl).fromScene(new RoomEnvironment(), 0.04).texture;
    this.skyEnv = null;
    if (this.skyFaces) this.setSky(this.skyFaces);
    this.hdris = new Map();
    for (const [name, tex] of this.hdriSources) this.setHdri(name, tex);
    this.targets = {};
    canvas.addEventListener('webglcontextlost', () => { this.onLost?.(); this.recover(); });
  }

  // GPU reset (out of video memory, driver crash): Chromium rarely restores the old context, so build a fresh one on a
  // clone of the canvas swapped into the page, retrying while the GPU process restarts. onRestore(canvas) lets the app
  // re-attach input handlers. Until then render() throws instead of returning blank images.
  recover(delay = 1000) {
    clearTimeout(this.recoverTimer);
    this.recoverTimer = setTimeout(() => {
      const old = this.canvas, fresh = old.cloneNode(false);
      try { this.gl.dispose(); } catch { /* already gone */ }
      old.replaceWith(fresh);
      try { this.attach(fresh); } catch { this.canvas = fresh; this.recover(Math.min(delay * 2, 16000)); return; }
      this.onRestore?.(fresh);
    }, delay);
  }

  rt(name, w, h, { type = THREE.HalfFloatType, samples = 0, depth = false, filter = THREE.LinearFilter, depthTexture = false } = {}) {
    let t = this.targets[name];
    if (t && (t.width !== w || t.height !== h)) { t.dispose(); t = null; }
    if (!t) {
      t = new THREE.WebGLRenderTarget(w, h, { type, samples, depthBuffer: depth || depthTexture, minFilter: filter, magFilter: filter });
      if (depthTexture) t.depthTexture = new THREE.DepthTexture(w, h);
      this.targets[name] = t;
    }
    return t;
  }

  // All uniforms a shader uses must be passed on every call.
  mat(name, fs, uniforms, extra = {}) {
    let m = this.mats[name];
    if (!m) m = this.mats[name] = new THREE.ShaderMaterial({ vertexShader: S.fsVS, fragmentShader: fs, uniforms: {}, depthTest: false, depthWrite: false, ...extra });
    for (const [k, v] of Object.entries(uniforms)) { if (m.uniforms[k]) m.uniforms[k].value = v; else m.uniforms[k] = { value: v }; }
    return m;
  }

  pass(material, target) {
    this.fsMesh.material = material;
    this.gl.setRenderTarget(target);
    this.gl.render(this.fsScene, this.fsCam);
  }

  // Points the camera frames: the model, plus VFX/trails when the user asked to fit them, the pedestal, and every
  // position the motion settings move the model through.
  framingPoints(job, s) {
    let points = s.camera.fitVfx && s.vfx.enabled && job.vfxPoints?.length ? concat(job.points, job.vfxPoints) : job.points;
    if (s.trails.enabled && s.trails.fit && job.trailPoints?.length) points = concat(points, job.trailPoints);
    if (s.motion?.mode !== 'none' || s.pedestal?.shape !== 'none') {
      const { center, radius, minY } = boundsOf(job.points);
      points = motionFramePoints(points, s.motion, center, minY, radius);
      if (s.pedestal.shape !== 'none') points = concat(points, pedestalPoints(s.pedestal, center, minY, radius));
    }
    return points;
  }

  // Framing that holds a whole clip. A subsample of every frame places the camera; then each frame's exact
  // screen-space extremes are added, so thin limbs, particles or trail tips skipped by the subsample never clip.
  // poseAt(t) poses the job at clip time t.
  clipFit(job, s, times, poseAt, aspect = 1) {
    const sub = [], extremes = [], v = new THREE.Vector3(), step = Math.max(1, Math.ceil(times.length / 240));
    let minY = Infinity;
    times.forEach((t, i) => {
      if (i % step && i !== times.length - 1) return;
      poseAt(t);
      const pts = this.framingPoints(job, s), stride = Math.max(1, Math.ceil(pts.length / 9000)) * 3;
      for (let k = 0; k < pts.length; k += stride) sub.push(pts[k], pts[k + 1], pts[k + 2]);
      for (let k = 1; k < job.points.length; k += 3) minY = Math.min(minY, job.points[k]);
    });
    const fit = { points: new Float32Array(sub), minY: Number.isFinite(minY) ? minY : 0 };
    const { cam } = this.setupCamera(job, s, fit, aspect);
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    times.forEach((t) => {
      poseAt(t);
      const pts = this.framingPoints(job, s), lo = [Infinity, Infinity], hi = [-Infinity, -Infinity], at = [0, 0, 0, 0];
      for (let k = 0; k < pts.length; k += 3) {
        v.set(pts[k], pts[k + 1], pts[k + 2]).applyMatrix4(vp);
        if (v.x < lo[0]) { lo[0] = v.x; at[0] = k; }
        if (v.x > hi[0]) { hi[0] = v.x; at[1] = k; }
        if (v.y < lo[1]) { lo[1] = v.y; at[2] = k; }
        if (v.y > hi[1]) { hi[1] = v.y; at[3] = k; }
      }
      if (pts.length) for (const k of at) extremes.push(pts[k], pts[k + 1], pts[k + 2]);
    });
    fit.points = concat(fit.points, new Float32Array(extremes));
    return fit;
  }

  // fit = { points, minY } locks the framing (animated export); otherwise frame the current pose.
  // aspect (width / height): the frame is still rendered square, then cropped to the centered aspect rectangle,
  // so the model is fitted into that rectangle.
  setupCamera(job, s, fit = null, aspect = 1) {
    const c = s.camera, points = fit?.points ?? this.framingPoints(job, s);
    const { center, radius } = boundsOf(points);
    const persp = c.projection !== 'orthographic';
    const cam = persp ? this.pcam : this.ocam;
    const dist = persp ? (radius / Math.sin(deg(c.fov) / 2)) * 1.1 : radius * 4;
    cam.position.copy(center).addScaledVector(angles(c.yaw, c.pitch), dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(center);
    cam.rotateZ(deg(c.roll));
    cam.near = Math.max(dist - radius * 3, dist * 0.005);
    cam.far = dist + radius * 3;
    if (persp) { cam.fov = c.fov; cam.aspect = 1; } else Object.assign(cam, { left: -radius, right: radius, top: radius, bottom: -radius });
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    // Tight 2D fit: scale/shift clip space so the projected points fill the frame.
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const v = new THREE.Vector3();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < points.length; i += 3) {
      v.set(points[i], points[i + 1], points[i + 2]).applyMatrix4(vp);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    if (!(x1 > x0)) { x0 = y0 = -1; x1 = y1 = 1; }
    const [cw, ch] = cropOf(aspect);
    const k = ((1 - c.padding) / Math.max((x1 - x0) / 2 / cw, (y1 - y0) / 2 / ch, 1e-6)) * c.zoom;
    const M = new THREE.Matrix4().set(k, 0, 0, -k * (x0 + x1) / 2 + c.offsetX * 2 * cw, 0, k, 0, -k * (y0 + y1) / 2 + c.offsetY * 2 * ch, 0, 0, 1, 0, 0, 0, 0, 1);
    cam.projectionMatrix.premultiply(M);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    return { cam, center, radius, minY: fit?.minY ?? boundsOf(job.points).minY };
  }

  setupScene(job, s, frame) {
    const sc = this.scene, M = this.motion;
    for (const child of [...sc.children]) if (!this.rig.includes(child)) sc.remove(child);
    M.clear();
    M.add(job.root);
    if (job.vfxGroup && s.vfx.enabled) {
      M.add(job.vfxGroup);
      job.vfxGroup.traverse((o) => o.userData.sortFor?.(frame.cam));
    }
    if (job.trailGroup && s.trails.enabled && s.trails.length > 0) M.add(job.trailGroup);
    if (job.hlGroup) M.add(job.hlGroup);
    const hdri = s.lighting.hdri && this.hdris.get(s.lighting.hdri);
    sc.environment = hdri || (s.lighting.robloxSky && this.skyEnv) || this.env;
    sc.environmentIntensity = s.lighting.env;
    sc.environmentRotation.set(0, hdri ? deg(s.lighting.hdriRotation) : 0, 0);

    const L = s.lighting, { center, radius } = frame, model = boundsOf(job.points);
    M.matrix.copy(motionMatrix(s.motion, s.vfx.time, model.center, model.minY, model.radius));
    for (const light of job.lights) {
      if (!L.modelLights) continue;
      light.intensity = light.userData.base * L.modelLightStrength;
      light.castShadow = light.userData.shadows && s.shadows.selfShadows;
      light.layers.enableAll();
      M.add(light);
    }
    const bands = s.toon.enabled ? s.toon.bands : 0;
    const toon = (o) => {
      for (const m of [o.material].flat()) {
        if (!m?.isMeshStandardMaterial || (m.defines?.TOON_BANDS ?? 0) === bands) continue;
        m.defines = { ...m.defines };
        if (bands) m.defines.TOON_BANDS = bands; else delete m.defines.TOON_BANDS;
        m.needsUpdate = true;
      }
    };
    job.root.traverse((o) => {
      if (!o.isMesh) return;
      o.receiveShadow = s.shadows.selfShadows;
      if (o.material.userData?.neon) o.material.emissiveIntensity = L.neon;
      // ponytail: sqrt keeps EmissiveStrength 1..100 near Neon brightness; recalibrate against Studio if glow looks off.
      if (o.material.userData?.emissiveStrength) o.material.emissiveIntensity = L.neon * Math.sqrt(o.material.userData.emissiveStrength) / 4;
      toon(o);
    });

    this.pedestal = null;
    const P = s.pedestal;
    if (P.shape !== 'none') {
      const key = `${P.shape}|${P.color}|${P.color2}`;
      if (this.pedestalKey !== key) { this.pedestalMesh = pedestalGroup(P); this.pedestalKey = key; }
      const g = (this.pedestal = this.pedestalMesh), at = pedestalPlace(P, model.center, model.minY, model.radius);
      g.position.set(at.x, at.y, at.z);
      g.scale.set(at.r, at.h, at.r);
      g.traverse((o) => o.isMesh && toon(o));
      sc.add(g);
    }
    sc.updateMatrixWorld(true);

    const baseYaw = L.followCamera ? s.camera.yaw : 0;
    const place = (light, yaw, pitch, intensity, color) => {
      light.position.copy(center).addScaledVector(angles(yaw, pitch), radius * 4);
      light.target.position.copy(center);
      light.intensity = intensity;
      light.color.set(color);
    };
    place(this.key, baseYaw + L.keyYaw, L.keyPitch, L.key, L.keyColor);
    place(this.fill, baseYaw - L.keyYaw * 1.5, 10, L.fill, '#ffffff');
    place(this.rim, baseYaw + 180, 35, L.rim, L.rimColor);
    this.hemi.intensity = L.ambient;

    const sh = this.key.shadow;
    this.key.castShadow = s.shadows.selfShadows || s.shadows.ground;
    Object.assign(sh.camera, { left: -radius * 1.3, right: radius * 1.3, top: radius * 1.3, bottom: -radius * 1.3, near: radius * 0.5, far: radius * 8 });
    sh.camera.updateProjectionMatrix();
    sh.radius = s.shadows.softness;
    sh.blurSamples = 16;
    sh.bias = -0.0005;
    sh.normalBias = radius * 0.004;

    const floor = this.pedestal ? this.pedestal.position.y - this.pedestal.scale.y : frame.minY;
    this.ground.visible = s.shadows.ground;
    this.ground.position.set(center.x, (this.pedestal ? floor : frame.minY) - radius * 0.002, center.z);
    this.ground.scale.setScalar(radius * 16);
    this.ground.material.opacity = s.shadows.groundOpacity;
    return { model, floor };
  }

  // A 2D-canvas layer at the output size as a premultiplied texture; transparent black when there is nothing to draw.
  layerTexture(name, size, draw) {
    if (!draw) return this.black;
    let L = this[name];
    if (!L) {
      const canvas = document.createElement('canvas');
      L = this[name] = { canvas, tex: new THREE.CanvasTexture(canvas) };
      L.tex.premultiplyAlpha = true;
      L.tex.colorSpace = THREE.NoColorSpace; // final pass works in display (sRGB) values
      L.tex.generateMipmaps = false; L.tex.minFilter = THREE.LinearFilter;
    }
    if (L.canvas.width !== size) { L.canvas.width = L.canvas.height = size; L.tex.dispose(); }
    const g = L.canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, size, size);
    draw(g);
    L.tex.needsUpdate = true;
    return L.tex;
  }

  // invert: distance from inside the shape to its edge instead (inner shadow, bevel).
  distanceField(maskTex, W, R, invert = false) {
    const res = new THREE.Vector2(W, W);
    const opts = { type: THREE.FloatType, filter: THREE.NearestFilter };
    let a = this.rt('jfaA', W, W, opts), b = this.rt('jfaB', W, W, opts);
    this.pass(this.mat('jfaInit', S.jfaInitFS, { tMask: maskTex, res, invert }), a);
    const steps = [];
    for (let st = 2 ** Math.ceil(Math.log2(Math.max(1, R))); st >= 1; st /= 2) steps.push(st);
    steps.push(1);
    for (const st of steps) {
      this.pass(this.mat('jfaStep', S.jfaStepFS, { tSrc: a.texture, res, stepPx: st }), b);
      [a, b] = [b, a];
    }
    const d = this.rt(invert ? 'distIn' : 'dist', W, W);
    this.pass(this.mat('jfaDist', S.jfaDistFS, { tSrc: a.texture, res }), d);
    return d;
  }

  // Mirror image of the model (and pedestal) under the floor, slid under the scene so far with a fade.
  reflect(s, frame, floor, W, target, cam) {
    const gl = this.gl, movers = [this.motion, this.pedestal].filter(Boolean);
    this.mirror.matrix.makeTranslation(0, 2 * floor, 0).multiply(new THREE.Matrix4().makeScale(1, -1, 1));
    this.scene.add(this.mirror);
    for (const m of movers) this.mirror.add(m);
    this.scene.updateMatrixWorld(true);
    const rRT = this.rt('refl', W, W, { samples: 4, depth: true });
    gl.shadowMap.autoUpdate = false;
    try {
      gl.setRenderTarget(rRT); gl.clear();
      cam.layers.set(LAYER.MODEL);
      gl.render(this.scene, cam);
    } finally {
      for (const m of movers) this.scene.add(m);
      this.scene.remove(this.mirror);
      this.scene.updateMatrixWorld(true);
      gl.shadowMap.autoUpdate = true;
    }
    const uvY = (p) => p.project(cam).y * 0.5 + 0.5, c = frame.model.center, r = frame.model.radius;
    const floorY = uvY(new THREE.Vector3(c.x, floor, c.z)), h = Math.abs(uvY(c.clone().setY(c.y + r)) - uvY(c.clone().setY(c.y - r)));
    gl.autoClear = false;
    this.pass(this.mat('reflect', S.reflectFS, { tSrc: rRT.texture, opacity: s.reflection.opacity, floorY, fadeLen: Math.max(1e-3, s.reflection.fade * h) }, {
      transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.OneMinusDstAlphaFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneMinusDstAlphaFactor, blendDstAlpha: THREE.OneFactor }), target);
    gl.autoClear = true;
  }

  // View-space normals (alpha = coverage) and depth of the model, for AO, edge lines, rim glow and depth of field.
  normalMaterial(m) {
    if (!m.depthWrite) return null; // decals, see-through glass: left out
    const cut = !!m.map && (m.alphaTest > 0 || m.transparent), key = cut ? m.map : `side${m.side}`;
    let n = this.normalMats.get(key);
    if (!n) {
      n = new THREE.MeshNormalMaterial({ side: m.side });
      if (cut) { // leaves, cards: keep the texture's cutout
        n.defines = { USE_UV: '' };
        n.onBeforeCompile = (sh) => {
          sh.uniforms.clipMap = { value: m.map };
          sh.fragmentShader = 'uniform sampler2D clipMap;\n' + sh.fragmentShader.replace('void main() {', 'void main() {\n\tif ( texture2D( clipMap, vUv ).a < 0.5 ) discard;');
        };
        n.customProgramCacheKey = () => 'normalClip';
      }
      this.normalMats.set(key, n);
    }
    return n;
  }
  geometryPass(W, cam) {
    const gl = this.gl, geo = this.rt('geo', W, W, { type: THREE.UnsignedByteType, depthTexture: true }), swaps = [];
    for (const g of [this.motion, this.pedestal]) g?.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.layers.isEnabled(LAYER.MODEL)) return;
      const mats = [o.material].flat().map((m) => this.normalMaterial(m));
      swaps.push([o, o.material, o.visible]);
      if (mats.every((m) => !m)) o.visible = false;
      else o.material = Array.isArray(o.material) ? mats.map((m) => m ?? this.normalMaterial({ depthWrite: true, side: THREE.FrontSide })) : mats[0];
    });
    gl.shadowMap.autoUpdate = false;
    try {
      cam.layers.set(LAYER.MODEL);
      gl.setRenderTarget(geo); gl.clear();
      gl.render(this.scene, cam);
    } finally {
      for (const [o, m, v] of swaps) { o.material = m; o.visible = v; }
      gl.shadowMap.autoUpdate = true;
    }
    return geo;
  }

  // Outline mask without the pedestal: the model alone where it shows (the pedestal still hides what's behind it).
  modelMask(W, cam, sceneRT, maskRT) {
    const gl = this.gl, rt = this.rt('modelOnly', W, W, { samples: 4, depth: true }), swaps = [];
    this.depthOnly ??= new THREE.MeshBasicMaterial({ colorWrite: false });
    this.pedestal.traverse((o) => { if (o.isMesh) { swaps.push([o, o.material]); o.material = this.depthOnly; } });
    gl.shadowMap.autoUpdate = false;
    try {
      gl.setRenderTarget(rt); gl.clear();
      gl.render(this.scene, cam);
    } finally {
      for (const [o, m] of swaps) o.material = m;
      gl.shadowMap.autoUpdate = true;
    }
    this.pass(this.mat('pedMask', S.pedMaskFS, { tFull: sceneRT.texture, tModel: rt.texture }), maskRT);
  }

  // Gaussian blur of target t in place (tmp: scratch target of the same size). radius in px.
  gaussian(t, tmp, radius) {
    const k = 1 / t.width;
    this.pass(this.mat('blur', S.blurFS, { tSrc: t.texture, dir: new THREE.Vector2(k, 0), radius }), tmp);
    this.pass(this.mat('blur', S.blurFS, { tSrc: tmp.texture, dir: new THREE.Vector2(0, k), radius }), t);
  }

  lutTexture(url) {
    const img = url && imageFor(url);
    if (!img) return null;
    let t = this.luts.get(url);
    if (!t) {
      const tex = new THREE.Texture(img);
      Object.assign(tex, { flipY: false, colorSpace: THREE.NoColorSpace, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, needsUpdate: true });
      if (this.luts.size > 8) this.luts.clear(); // ponytail: tiny cache; LUT textures are small and rebuild on demand
      this.luts.set(url, (t = { tex, size: img.naturalHeight }));
    }
    return t;
  }

  // size: output px (the long side). out: 'screen' or 'pixels'. Returns ImageData for 'pixels', cropped to aspect.
  // The motion transform only lives during a render: posing and framing always see the unmoved model.
  render(job, s, size, opts) {
    try { return this.draw(job, s, size, opts); } finally { this.motion.matrix.identity(); this.motion.updateMatrixWorld(true); }
  }
  draw(job, s, size, { out = 'screen', supersample = 1, fit = null, aspect = 1 } = {}) {
    const gl = this.gl;
    this.checkContext();
    const W = Math.round(size * supersample), px = W / 512, texel = new THREE.Vector2(1 / W, 1 / W);
    const frame = this.setupCamera(job, s, fit, aspect);
    const cam = frame.cam;
    const placed = this.setupScene(job, s, frame);
    frame.model = placed.model;

    // 1) model (+ pedestal), 2) silhouette, 3) reflection, 4) ground + VFX, 5) highlight fills
    const sceneRT = this.rt('scene', W, W, { samples: 4, depth: true });
    gl.setClearColor(0x000000, 0);
    gl.setRenderTarget(sceneRT);
    gl.clear();
    cam.layers.set(LAYER.MODEL);
    if (s.trails.outline) cam.layers.enable(LAYER.TRAIL);
    if (s.vfx.outlineVfx) cam.layers.enable(LAYER.VFX);
    gl.render(this.scene, cam);
    const maskRT = this.rt('mask', W, W, { type: THREE.UnsignedByteType });
    if (this.pedestal && !s.pedestal.outline) this.modelMask(W, cam, sceneRT, maskRT);
    else this.pass(this.mat('copyAlpha', S.copyAlphaFS, { tSrc: sceneRT.texture }), maskRT);
    if (s.reflection.enabled && s.reflection.opacity > 0) this.reflect(s, frame, placed.floor, W, sceneRT, cam);
    // three picks shadow casters by the main camera's layers, so keep pass 1's shadow map (model as caster).
    gl.autoClear = false;
    gl.shadowMap.autoUpdate = false;
    cam.layers.set(LAYER.GROUND); cam.layers.enable(LAYER.HL_FILL);
    if (!s.vfx.outlineVfx) cam.layers.enable(LAYER.VFX);
    if (!s.trails.outline) cam.layers.enable(LAYER.TRAIL);
    gl.setRenderTarget(sceneRT);
    gl.render(this.scene, cam);
    gl.shadowMap.autoUpdate = true;
    gl.autoClear = true;

    const aoOn = s.ao.enabled && s.ao.intensity > 0, dofOn = s.dof.enabled && s.dof.blur > 0, tiltOn = s.tiltShift.enabled && s.tiltShift.blur > 0;
    const geo = aoOn || s.edges.enabled || s.rim.enabled || dofOn ? this.geometryPass(W, cam) : null;
    const tNormal = geo?.texture ?? this.black, tDepth = geo?.depthTexture ?? this.black;
    let aoTex = this.black;
    if (aoOn) {
      const h = Math.max(4, W >> 1), aoA = this.rt('aoA', h, h, { type: THREE.UnsignedByteType }), aoB = this.rt('aoB', h, h, { type: THREE.UnsignedByteType });
      this.pass(this.mat('ao', S.aoFS, { tNormal, tDepth, proj: cam.projectionMatrix, projInv: cam.projectionMatrixInverse, radius: s.ao.radius * frame.model.radius * 2, res: new THREE.Vector2(h, h) }), aoA);
      this.pass(this.mat('aoBlur', S.aoBlurFS, { tAO: aoA.texture, tDepth, texel: new THREE.Vector2(1 / h, 1 / h) }), aoB);
      aoTex = aoB.texture;
    }

    // bloom
    let bloomTex = this.black;
    if (s.bloom.enabled && s.bloom.strength > 0) {
      const mips = [];
      for (let i = 0, w = W >> 1; i < 6 && w >= 4; i++, w >>= 1) mips.push(this.rt('bloom' + i, w, w));
      this.pass(this.mat('bloomPre', S.bloomPrefilterFS, { tSrc: sceneRT.texture, threshold: s.bloom.threshold, texel }), mips[0]);
      for (let i = 1; i < mips.length; i++) this.pass(this.mat('down', S.downFS, { tSrc: mips[i - 1].texture, texel: new THREE.Vector2(1 / mips[i - 1].width, 1 / mips[i - 1].width) }), mips[i]);
      gl.autoClear = false;
      for (let i = mips.length - 1; i > 0; i--)
        this.pass(this.mat('up', S.upFS, { tSrc: mips[i].texture, texel: new THREE.Vector2(0.5 / mips[i].width, 0.5 / mips[i].width), weight: 0.3 + s.bloom.radius }, { blending: THREE.AdditiveBlending }), mips[i - 1]);
      gl.autoClear = true;
      bloomTex = mips[0].texture;
    }

    // lens flare: streaks + ghosts + halo from their own bright pass
    let flareTex = this.black;
    const LF = s.lensFlare;
    if (LF.enabled && (LF.streaks > 0 || LF.ghosts > 0 || LF.halo > 0)) {
      const h = Math.max(4, W >> 1), bright = this.rt('flBright', h, h);
      this.pass(this.mat('bloomPre', S.bloomPrefilterFS, { tSrc: sceneRT.texture, threshold: LF.threshold, texel }), bright);
      let src = bright, a = this.rt('flS1', h, Math.max(4, h >> 2)), b = this.rt('flS2', h, Math.max(4, h >> 2));
      for (const k of [1, 3, 9, 27]) {
        this.pass(this.mat('streak', S.streakFS, { tSrc: src.texture, texel: new THREE.Vector2(1 / h, 1 / a.height), stepPx: k * (0.25 + LF.streakLength * 1.5) * (h / 256) }), a);
        src = a; [a, b] = [b, a];
      }
      const flare = this.rt('flare', h, h);
      this.pass(this.mat('flare', S.flareFS, { tBright: bright.texture, tStreak: src.texture, streakColor: linear(LF.streakColor), streaks: LF.streaks, ghosts: LF.ghosts, halo: LF.halo }), flare);
      flareTex = flare.texture;
    }

    const C = s.color, O = s.overlay, Z = s.stylize, E = s.edges, H = s.halftone, lut = s.lut.image && s.lut.strength > 0 ? this.lutTexture(s.lut.image) : null;
    const a = this.rt('A', W, W), b = this.rt('B', W, W);
    this.pass(this.mat('grade', S.gradeFS, {
      tScene: sceneRT.texture, tBloom: bloomTex, texel,
      bloomStrength: s.bloom.enabled ? s.bloom.strength : 0, toneMode: TONE[s.lighting.toneMapping] ?? 3, exposure: s.lighting.exposure, toneMappingExposure: 1,
      brightness: C.brightness, contrast: C.contrast, saturation: C.saturation, hue: deg(C.hue), gamma: C.gamma, temperature: C.temperature,
      overlayMode: ['none', 'solid', 'gradient', 'rainbow'].indexOf(O.mode), overlayBlend: ['normal', 'multiply', 'screen', 'overlay', 'tint'].indexOf(O.blend),
      ov1: vec3(O.color1), ov2: vec3(O.color2), ovAngle: deg(O.angle), ovStrength: O.strength,
      chroma: Z.chroma * px, sharpen: Z.sharpen, posterize: Z.posterize, grain: Z.grain, vignette: Z.vignette, seed: s.vfx.seed,
      tFlare: flareTex, tAO: aoTex, aoAmount: aoOn ? s.ao.intensity : 0, tNormal, tDepth, projInv: cam.projectionMatrixInverse,
      tLut: lut?.tex ?? this.black, lutSize: lut?.size ?? 2, lutStrength: lut ? s.lut.strength : 0,
      rimOn: s.rim.enabled ? s.rim.intensity : 0, rimPower: s.rim.power, rimColor: vec3(s.rim.color),
      edgeW: E.thickness * px, edgeOpacity: E.enabled ? E.opacity : 0, edgeDepth: E.depth, edgeNormal: E.normal, edgeColor: vec3(E.color),
      htMode: H.enabled ? ['color', 'mono', 'cmyk'].indexOf(H.mode) + 1 : 0, htSize: H.size * px, htAngle: H.angle, htStrength: H.strength, htInk: vec3(H.ink),
    }), a);
    let cur = a, other = b;

    if (dofOn || tiltOn) {
      const D = s.dof, T = s.tiltShift, m = frame.model, ta = deg(T.angle);
      this.pass(this.mat('lensBlur', S.lensBlurFS, {
        tSrc: cur.texture, tDepth, texel, projInv: cam.projectionMatrixInverse,
        dofBlur: dofOn ? D.blur * px : 0, focusZ: cam.position.distanceTo(m.center) - m.radius + D.focus * 2 * m.radius, dofRange: m.radius,
        tiltBlur: tiltOn ? T.blur * px : 0, tiltCenter: T.center, tiltWidth: T.width, tiltNormal: new THREE.Vector2(-Math.sin(ta), Math.cos(ta)),
      }), other);
      [cur, other] = [other, cur];
    }

    const ol = s.outline, gw = s.glow, ds = s.dropShadow, is = s.innerShadow, bv = s.bevel, gr = s.godRays;
    const outlineW = ol.enabled ? ol.thickness * px : 0, glowSize = gw.enabled ? gw.size * px : 0, blur = ds.enabled ? ds.blur * px : 0;
    const strokes = (s.strokes ?? []).filter((st) => st.width > 0), strokeR = outlineW + strokes.reduce((sum, st) => sum + st.width * px, 0);
    const inner = (is.enabled && is.opacity > 0) || (bv.enabled && bv.strength > 0), rays = gr.enabled && gr.intensity > 0;
    if (outlineW > 0 || glowSize > 0 || ds.enabled || strokes.length || inner || rays) {
      const R = Math.min(512, Math.ceil(Math.max(outlineW, glowSize * 2.5, blur, strokeR) + 2));
      const dist = outlineW > 0 || glowSize > 0 || ds.enabled || strokes.length ? this.distanceField(maskRT.texture, W, R) : null;
      const distIn = inner ? this.distanceField(maskRT.texture, W, Math.ceil(Math.max(is.blur + Math.hypot(is.offsetX, is.offsetY), bv.size) * px + 2), true) : null;
      let strokeTex = this.black;
      for (let i = 0, r = outlineW, flip = false; i < strokes.length; i += 8, flip = !flip) { // 8 strokes per pass, any number of passes
        const chunk = strokes.slice(i, i + 8), r0 = r, target = this.rt(flip ? 'stB' : 'stA', W, W);
        const rad = chunk.map((st) => (r += st.width * px));
        this.pass(this.mat('strokes', S.strokesFS, {
          tPrev: strokeTex, tDist: dist.texture, r0, count: chunk.length,
          col: Array.from({ length: 8 }, (_, k) => (chunk[k] ? new THREE.Vector4(...hexToVec3(chunk[k].color), chunk[k].opacity) : new THREE.Vector4())),
          rad: Array.from({ length: 8 }, (_, k) => rad[k] ?? 0),
        }), target);
        strokeTex = target.texture;
      }
      let raysTex = this.black;
      if (rays) {
        const h = Math.max(4, W >> 1), rr = this.rt('rays', h, h);
        this.pass(this.mat('rays', S.raysFS, { tMask: maskRT.texture, light: new THREE.Vector2(0.5 + gr.x, 0.5 + gr.y), color: vec3(gr.color), intensity: gr.intensity, len: gr.length, size: gr.size }), rr);
        raysTex = rr.texture;
      }
      const la = deg(bv.angle);
      this.pass(this.mat('sil', S.silhouetteFS, {
        tColor: cur.texture, tMask: maskRT.texture, tDist: dist?.texture ?? this.far, tDistIn: distIn?.texture ?? this.far, tStrokes: strokeTex, tRays: raysTex, texel,
        outlineW, outlineColor: vec3(ol.color), outlineOpacity: ol.opacity,
        glowSize, glowColor: vec3(gw.color), glowIntensity: gw.enabled ? gw.intensity : 0,
        shadowBlur: blur, shadowOffset: new THREE.Vector2(ds.offsetX * px, ds.offsetY * px), shadowColor: vec3(ds.color), shadowOpacity: ds.enabled ? ds.opacity : 0,
        innerBlur: is.blur * px, innerOpacity: is.enabled ? is.opacity : 0, innerOffset: new THREE.Vector2(is.offsetX * px, is.offsetY * px), innerColor: vec3(is.color),
        bevelSize: bv.size * px, bevelStrength: bv.enabled ? bv.strength : 0, bevelLight: new THREE.Vector2(Math.cos(la), Math.sin(la)), bevelHi: vec3(bv.highlight), bevelLo: vec3(bv.shadow),
      }), other);
      [cur, other] = [other, cur];
    }

    // Highlight outlines (one mask + distance field per Highlight)
    for (const hl of job.highlights || []) {
      if (hl.outlineOpacity <= 0) continue;
      for (const h of job.highlights) h.maskGroup.visible = h === hl;
      const hm = this.rt('hlMask', W, W, { type: THREE.UnsignedByteType, depth: true });
      cam.layers.set(LAYER.HL_MASK);
      gl.setRenderTarget(hm); gl.clear(); gl.render(this.scene, cam);
      const width = 2.5 * px;
      const dist = this.distanceField(hm.texture, W, Math.ceil(width + 2));
      this.pass(this.mat('hlOutline', S.hlOutlineFS, { tColor: cur.texture, tDist: dist.texture, width, color: srgbVec(hl.outlineColor), opacity: hl.outlineOpacity }), other);
      [cur, other] = [other, cur];
    }

    const BL = s.blur, blurPx = BL.enabled ? BL.size : 0;
    if (blurPx > 0 && BL.target !== 'background') this.gaussian(cur, other, blurPx * px);

    const B = s.background, outSize = out === 'screen' ? gl.domElement.width : size;
    const bgImage = B.mode === 'image' ? imageFor(B.image) : null;
    const bgTex = this.layerTexture('bgLayer', outSize, bgImage && ((g) => drawBackground(g, bgImage, B, outSize)));
    let layouts = [];
    const textTex = this.layerTexture('textLayer', outSize, s.texts?.length && ((g) => { layouts = drawTexts(g, s.texts, outSize); }));
    this.layouts = layouts; // normalized text boxes of the last render, for hit testing in the preview
    const Dt = s.dither, F = s.frame, pal = Dt.palette === 'levels' ? [] : PALETTES[Dt.palette] ?? [], fc = RARITIES[F.style] ?? [F.color1, F.color2];
    const R = s.retro, retro = R.scanlines > 0 || R.curvature > 0 || R.mask > 0 || R.vhs > 0 || R.noise > 0;
    let bgBlur = null; // the background drawn alone and blurred, then used as a background image
    const finalU = (straight) => ({ tColor: cur.texture, bgMode: bgBlur ? 4 : ['transparent', 'solid', 'linear', 'radial', 'image', 'sunburst', 'stripes', 'dots', 'stars'].indexOf(B.mode), tBgImage: bgBlur ?? bgTex, tText: textTex,
      bg1: vec3(B.color1), bg2: vec3(B.color2), bgAngle: deg(B.angle), straight,
      // level N = (N + 1)-px blocks at 512, scaled with the output size; as a fraction of the frame
      pixelBlock: Z.pixelate > 0 ? (Z.pixelate + 1) / 512 : 0,
      patCount: B.patternCount, patScale: B.patternScale, patSpin: deg(B.patternSpin * s.vfx.time),
      ditherMode: Dt.enabled ? 1 : 0, ditherLevels: Dt.levels, ditherSpread: Dt.spread, bayer8: Dt.pattern === 'bayer8x8',
      pal: Array.from({ length: 16 }, (_, i) => (pal[i] ? vec3(pal[i]) : new THREE.Vector3())), palN: pal.length,
      frameShape: F.style === 'none' ? 0 : ['rounded', 'circle', 'square'].indexOf(F.shape) + 1, crop: new THREE.Vector2(...cropOf(aspect)),
      frameTh: F.thickness / 512, frameRadius: F.radius, frameInset: F.inset, frameGlow: F.glow, fr1: vec3(fc[0]), fr2: vec3(fc[1]) });
    if (blurPx > 0 && BL.target !== 'model' && B.mode !== 'transparent' && B.mode !== 'solid') {
      const ba = this.rt('bgBlurA', outSize, outSize), bb = this.rt('bgBlurB', outSize, outSize);
      this.pass(this.mat('final', S.finalFS, { ...finalU(false), tColor: this.black, tText: this.black, frameShape: 0 }), ba);
      this.gaussian(ba, bb, blurPx * outSize / 512);
      bgBlur = ba.texture;
    }
    const retroU = (src, straight) => ({ tSrc: src, straight, scan: R.scanlines, scanSize: R.scanlineSize, curv: R.curvature, mask: R.mask, vhs: R.vhs, noise: R.noise, time: s.vfx.time });
    const finish = (target, straight) => {
      if (!retro) return this.pass(this.mat('final', S.finalFS, finalU(straight)), target);
      const fin = this.rt('fin', outSize, outSize, { type: THREE.UnsignedByteType });
      this.pass(this.mat('final', S.finalFS, finalU(false)), fin);
      this.pass(this.mat('retro', S.retroFS, retroU(fin.texture, straight)), target);
    };
    if (out === 'screen') { finish(null, false); return null; }
    const outRT = this.rt('out', size, size, { type: THREE.UnsignedByteType });
    finish(outRT, true);
    const [cw, ch] = cropOf(aspect), w = Math.round(size * cw), h = Math.round(size * ch), x0 = (size - w) >> 1, y0 = (size - h) >> 1;
    const buf = new Uint8Array(w * h * 4);
    gl.readRenderTargetPixels(outRT, x0, y0, w, h, buf);
    this.checkContext(); // lost mid-render: the pixels read back are all zero
    const img = new ImageData(w, h), row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return img;
  }

  checkContext() {
    if (this.gl.getContext()?.isContextLost?.() !== false) throw new Error('The GPU was reset (out of video memory or a driver crash). Waiting for it to come back; restart the app if renders stay blank.');
  }

  // Roblox's default sky (six DDS faces in the local install) as the reflection/lighting environment.
  // faces: canvases in three's cube order (+x, -x, +y, -y, +z, -z).
  setSky(faces) {
    this.skyFaces = faces;
    const cube = new THREE.CubeTexture(faces);
    cube.colorSpace = THREE.SRGBColorSpace;
    cube.needsUpdate = true;
    this.skyEnv = new THREE.PMREMGenerator(this.gl).fromCubemap(cube).texture;
    cube.dispose();
  }

  // An equirectangular HDRI (see equirectTexture) as the lighting/reflection environment, by library name.
  setHdri(name, tex) {
    this.hdriSources.set(name, tex);
    this.hdris.set(name, new THREE.PMREMGenerator(this.gl).fromEquirectangular(tex).texture);
  }
}

// .hdr / .exr / ordinary image bytes -> equirectangular texture.
export async function equirectTexture(bytes, name) {
  const ext = String(name).split('.').pop().toLowerCase();
  let tex;
  if (ext === 'hdr' || ext === 'exr') {
    const Loader = ext === 'hdr' ? (await import('three/addons/loaders/HDRLoader.js')).HDRLoader : (await import('three/addons/loaders/EXRLoader.js')).EXRLoader;
    const d = new Loader().setDataType(THREE.HalfFloatType).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    tex = new THREE.DataTexture(d.data, d.width, d.height, d.format ?? THREE.RGBAFormat, d.type);
    Object.assign(tex, { colorSpace: THREE.LinearSRGBColorSpace, flipY: !!d.flipY, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  } else {
    tex = new THREE.Texture(await createImageBitmap(new Blob([bytes]), { imageOrientation: 'flipY' }));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
  }
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  return tex;
}

// Width and height of the visible crop as fractions of the square render.
export const cropOf = (aspect = 1) => (aspect >= 1 ? [1, 1 / aspect] : [aspect, 1]);

function srgbVec(color) { const t = {}; color.getRGB(t, THREE.SRGBColorSpace); return new THREE.Vector3(t.r, t.g, t.b); }
function concat(a, b) { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
