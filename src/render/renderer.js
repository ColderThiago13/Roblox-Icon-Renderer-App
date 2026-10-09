// One WebGL context shared by preview, thumbnails and export.
// Pipeline: model pass -> silhouette copy -> ground+VFX pass -> highlight fills -> bloom -> grade (tone map, color,
// overlay, stylize) -> JFA distance field -> outline/glow/drop shadow -> highlight outlines -> background/output.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as S from './shaders.js';
import { hexToVec3 } from '../settings.js';
import { drawBackground, drawTexts, imageFor } from './overlay.js';

export const LAYER = { MODEL: 0, GROUND: 2, VFX: 3, HL_FILL: 4, HL_MASK: 5, TRAIL: 6 };
const deg = THREE.MathUtils.degToRad;
const TONE = { none: 0, aces: 1, agx: 2, neutral: 3 };
const angles = (yaw, pitch) => new THREE.Vector3(Math.sin(deg(yaw)) * Math.cos(deg(pitch)), Math.sin(deg(pitch)), -Math.cos(deg(yaw)) * Math.cos(deg(pitch)));

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
    this.attach(canvas);
    this.mats = {};
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this.black.needsUpdate = true;

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
    this.rig = [this.hemi, this.key, this.key.target, this.fill, this.fill.target, this.rim, this.rim.target, this.ground];
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

  rt(name, w, h, { type = THREE.HalfFloatType, samples = 0, depth = false, filter = THREE.LinearFilter } = {}) {
    let t = this.targets[name];
    if (t && (t.width !== w || t.height !== h)) { t.dispose(); t = null; }
    if (!t) {
      t = new THREE.WebGLRenderTarget(w, h, { type, samples, depthBuffer: depth, minFilter: filter, magFilter: filter });
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

  // Points the camera frames: the model, plus VFX/trails when the user asked to fit them.
  framingPoints(job, s) {
    let points = s.camera.fitVfx && s.vfx.enabled && job.vfxPoints?.length ? concat(job.points, job.vfxPoints) : job.points;
    if (s.trails.enabled && s.trails.fit && job.trailPoints?.length) points = concat(points, job.trailPoints);
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
    const sc = this.scene;
    for (const child of [...sc.children]) if (!this.rig.includes(child)) sc.remove(child);
    sc.add(job.root);
    if (job.vfxGroup && s.vfx.enabled) {
      sc.add(job.vfxGroup);
      job.vfxGroup.traverse((o) => o.userData.sortFor?.(frame.cam));
    }
    if (job.trailGroup && s.trails.enabled && s.trails.length > 0) sc.add(job.trailGroup);
    if (job.hlGroup) sc.add(job.hlGroup);
    sc.environment = s.lighting.robloxSky && this.skyEnv ? this.skyEnv : this.env;
    sc.environmentIntensity = s.lighting.env;

    const L = s.lighting, { center, radius } = frame;
    for (const light of job.lights) {
      if (!L.modelLights) continue;
      light.intensity = light.userData.base * L.modelLightStrength;
      light.castShadow = light.userData.shadows && s.shadows.selfShadows;
      light.layers.enableAll();
      sc.add(light);
    }
    job.root.traverse((o) => {
      if (!o.isMesh) return;
      o.receiveShadow = s.shadows.selfShadows;
      if (o.material.userData?.neon) o.material.emissiveIntensity = L.neon;
      // ponytail: sqrt keeps EmissiveStrength 1..100 near Neon brightness; recalibrate against Studio if glow looks off.
      if (o.material.userData?.emissiveStrength) o.material.emissiveIntensity = L.neon * Math.sqrt(o.material.userData.emissiveStrength) / 4;
    });

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

    this.ground.visible = s.shadows.ground;
    this.ground.position.set(center.x, frame.minY - radius * 0.002, center.z);
    this.ground.scale.setScalar(radius * 16);
    this.ground.material.opacity = s.shadows.groundOpacity;
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

  distanceField(maskTex, W, R) {
    const res = new THREE.Vector2(W, W);
    const opts = { type: THREE.FloatType, filter: THREE.NearestFilter };
    let a = this.rt('jfaA', W, W, opts), b = this.rt('jfaB', W, W, opts);
    this.pass(this.mat('jfaInit', S.jfaInitFS, { tMask: maskTex, res }), a);
    const steps = [];
    for (let st = 2 ** Math.ceil(Math.log2(Math.max(1, R))); st >= 1; st /= 2) steps.push(st);
    steps.push(1);
    for (const st of steps) {
      this.pass(this.mat('jfaStep', S.jfaStepFS, { tSrc: a.texture, res, stepPx: st }), b);
      [a, b] = [b, a];
    }
    const d = this.rt('dist', W, W);
    this.pass(this.mat('jfaDist', S.jfaDistFS, { tSrc: a.texture, res }), d);
    return d;
  }

  // size: output px (the long side). out: 'screen' or 'pixels'. Returns ImageData for 'pixels', cropped to aspect.
  render(job, s, size, { out = 'screen', supersample = 1, fit = null, aspect = 1 } = {}) {
    const gl = this.gl;
    this.checkContext();
    const W = Math.round(size * supersample), px = W / 512;
    const frame = this.setupCamera(job, s, fit, aspect);
    const cam = frame.cam;
    this.setupScene(job, s, frame);

    // 1) model, 2) silhouette, 3) ground + VFX, 4) highlight fills
    const sceneRT = this.rt('scene', W, W, { samples: 4, depth: true });
    gl.setClearColor(0x000000, 0);
    gl.setRenderTarget(sceneRT);
    gl.clear();
    cam.layers.set(LAYER.MODEL);
    if (s.trails.outline) cam.layers.enable(LAYER.TRAIL);
    if (s.vfx.outlineVfx) cam.layers.enable(LAYER.VFX);
    gl.render(this.scene, cam);
    const maskRT = this.rt('mask', W, W, { type: THREE.UnsignedByteType });
    this.pass(this.mat('copyAlpha', S.copyAlphaFS, { tSrc: sceneRT.texture }), maskRT);
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

    // bloom
    let bloomTex = this.black;
    if (s.bloom.enabled && s.bloom.strength > 0) {
      const mips = [];
      for (let i = 0, w = W >> 1; i < 6 && w >= 4; i++, w >>= 1) mips.push(this.rt('bloom' + i, w, w));
      this.pass(this.mat('bloomPre', S.bloomPrefilterFS, { tSrc: sceneRT.texture, threshold: s.bloom.threshold, texel: new THREE.Vector2(1 / W, 1 / W) }), mips[0]);
      for (let i = 1; i < mips.length; i++) this.pass(this.mat('down', S.downFS, { tSrc: mips[i - 1].texture, texel: new THREE.Vector2(1 / mips[i - 1].width, 1 / mips[i - 1].width) }), mips[i]);
      gl.autoClear = false;
      for (let i = mips.length - 1; i > 0; i--)
        this.pass(this.mat('up', S.upFS, { tSrc: mips[i].texture, texel: new THREE.Vector2(0.5 / mips[i].width, 0.5 / mips[i].width), weight: 0.3 + s.bloom.radius }, { blending: THREE.AdditiveBlending }), mips[i - 1]);
      gl.autoClear = true;
      bloomTex = mips[0].texture;
    }

    const C = s.color, O = s.overlay, Z = s.stylize;
    const a = this.rt('A', W, W), b = this.rt('B', W, W);
    this.pass(this.mat('grade', S.gradeFS, {
      tScene: sceneRT.texture, tBloom: bloomTex, texel: new THREE.Vector2(1 / W, 1 / W),
      bloomStrength: s.bloom.enabled ? s.bloom.strength : 0, toneMode: TONE[s.lighting.toneMapping] ?? 3, exposure: s.lighting.exposure, toneMappingExposure: 1,
      brightness: C.brightness, contrast: C.contrast, saturation: C.saturation, hue: deg(C.hue), gamma: C.gamma, temperature: C.temperature,
      overlayMode: ['none', 'solid', 'gradient', 'rainbow'].indexOf(O.mode), overlayBlend: ['normal', 'multiply', 'screen', 'overlay', 'tint'].indexOf(O.blend),
      ov1: new THREE.Vector3(...hexToVec3(O.color1)), ov2: new THREE.Vector3(...hexToVec3(O.color2)), ovAngle: deg(O.angle), ovStrength: O.strength,
      chroma: Z.chroma * px, sharpen: Z.sharpen, posterize: Z.posterize, grain: Z.grain, vignette: Z.vignette, seed: s.vfx.seed,
    }), a);
    let cur = a, other = b;

    const ol = s.outline, gw = s.glow, ds = s.dropShadow;
    const outlineW = ol.enabled ? ol.thickness * px : 0, glowSize = gw.enabled ? gw.size * px : 0, blur = ds.enabled ? ds.blur * px : 0;
    if (outlineW > 0 || glowSize > 0 || ds.enabled) {
      const R = Math.min(256, Math.ceil(Math.max(outlineW, glowSize * 2.5, blur) + 2));
      const dist = this.distanceField(maskRT.texture, W, R);
      this.pass(this.mat('sil', S.silhouetteFS, {
        tColor: cur.texture, tDist: dist.texture, texel: new THREE.Vector2(1 / W, 1 / W),
        outlineW, outlineColor: new THREE.Vector3(...hexToVec3(ol.color)), outlineOpacity: ol.opacity,
        glowSize, glowColor: new THREE.Vector3(...hexToVec3(gw.color)), glowIntensity: gw.enabled ? gw.intensity : 0,
        shadowBlur: blur, shadowOffset: new THREE.Vector2(ds.offsetX * px, ds.offsetY * px), shadowColor: new THREE.Vector3(...hexToVec3(ds.color)), shadowOpacity: ds.enabled ? ds.opacity : 0,
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

    const B = s.background, outSize = out === 'screen' ? gl.domElement.width : size;
    const bgImage = B.mode === 'image' ? imageFor(B.image) : null;
    const bgTex = this.layerTexture('bgLayer', outSize, bgImage && ((g) => drawBackground(g, bgImage, B, outSize)));
    let layouts = [];
    const textTex = this.layerTexture('textLayer', outSize, s.texts?.length && ((g) => { layouts = drawTexts(g, s.texts, outSize); }));
    this.layouts = layouts; // normalized text boxes of the last render, for hit testing in the preview
    const finalU = (straight) => ({ tColor: cur.texture, bgMode: ['transparent', 'solid', 'linear', 'radial', 'image'].indexOf(B.mode), tBgImage: bgTex, tText: textTex, bg1: new THREE.Vector3(...hexToVec3(B.color1)), bg2: new THREE.Vector3(...hexToVec3(B.color2)), bgAngle: deg(B.angle), straight,
      // level N = (N + 1)-px blocks at 512, scaled with the output size; as a fraction of the frame
      pixelBlock: Z.pixelate > 0 ? (Z.pixelate + 1) / 512 : 0 });
    if (out === 'screen') {
      this.pass(this.mat('final', S.finalFS, finalU(false)), null);
      return null;
    }
    const outRT = this.rt('out', size, size, { type: THREE.UnsignedByteType });
    this.pass(this.mat('final', S.finalFS, finalU(true)), outRT);
    const [cw, ch] = cropOf(aspect), w = Math.round(size * cw), h = Math.round(size * ch), x0 = (size - w) >> 1, y0 = (size - h) >> 1;
    const buf = new Uint8Array(w * h * 4);
    gl.readRenderTargetPixels(outRT, x0, y0, w, h, buf);
    this.checkContext(); // lost mid-render: the pixels read back are all zero
    const img = new ImageData(w, h), row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return img;
  }

  // Roblox's default sky (six DDS faces in the local install) as the reflection/lighting environment.
  // faces: canvases in three's cube order (+x, -x, +y, -y, +z, -z).
  checkContext() {
    if (this.gl.getContext()?.isContextLost?.() !== false) throw new Error('The GPU was reset (out of video memory or a driver crash). Waiting for it to come back; restart the app if renders stay blank.');
  }

  setSky(faces) {
    this.skyFaces = faces;
    const cube = new THREE.CubeTexture(faces);
    cube.colorSpace = THREE.SRGBColorSpace;
    cube.needsUpdate = true;
    this.skyEnv = new THREE.PMREMGenerator(this.gl).fromCubemap(cube).texture;
    cube.dispose();
  }
}

// Width and height of the visible crop as fractions of the square render.
export const cropOf = (aspect = 1) => (aspect >= 1 ? [1, 1 / aspect] : [aspect, 1]);

function srgbVec(color) { const t = {}; color.getRGB(t, THREE.SRGBColorSpace); return new THREE.Vector3(t.r, t.g, t.b); }
function concat(a, b) { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
