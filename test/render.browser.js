import { buildScene } from '../src/scene/build.js';
import { buildTrails } from '../src/scene/trails.js';
import { buildVfx } from '../src/scene/vfx.js';
import { buildRig } from '../src/scene/anim.js';
import { setPose, updateVfx } from '../src/scene/job.js';
import { IconRenderer, samplePoints, LAYER } from '../src/render/renderer.js';
import { makeInstance, finalizeTree } from '../src/rbx/instance.js';
import { defaultSettings, textLayer } from '../src/settings.js';
import { overlayReady } from '../src/render/overlay.js';
import * as THREE from 'three';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const cf = (x = 0, y = 0, z = 0) => ({ p: [x,y,z], r: [1,0,0,0,1,0,0,0,1] });
const images = new Map();
const image = (id, color, draw = null) => {
  const c = document.createElement('canvas'); c.width = 585; c.height = 559;
  const ctx = c.getContext('2d');
  if (color !== 'none') { ctx.fillStyle = color; ctx.fillRect(0,0,585,559); }
  draw?.(ctx);
  images.set(id, new Promise((resolve) => c.toBlob(async (blob) => resolve(new Uint8Array(await blob.arrayBuffer())))));
};
image('1', '#0000ff'); image('2', '#ff0000'); image('3', '#00ff00'); image('4', '#ffffff');
// Transparent front center should show BodyColors through the shirt.
image('5', 'none', (ctx) => { ctx.fillStyle = '#0000ff'; ctx.fillRect(231,74,128,128); ctx.clearRect(263,106,64,64); });
// A real FileMesh exercises CharacterMesh/MeshPart asset loading, not a fallback box.
const box = new THREE.BoxGeometry(1,1,1).toNonIndexed();
let meshText = `version 1.01\n${box.attributes.position.count / 3}\n`;
for (let i = 0; i < box.attributes.position.count; i++) {
  const p = box.attributes.position, n = box.attributes.normal, uv = box.attributes.uv;
  meshText += `[${p.getX(i)},${p.getY(i)},${p.getZ(i)}][${n.getX(i)},${n.getY(i)},${n.getZ(i)}][${uv.getX(i)},${uv.getY(i)},0]`;
}
images.set('6', new TextEncoder().encode(meshText));
image('7', 'none'); // fully transparent
{ // binary v2 cube whose unused last vertex is NaN (like asset 4681227436)
  const n = box.attributes.position.count, head = new TextEncoder().encode('version 2.00\n');
  const body = new DataView(new ArrayBuffer(12 + (n + 1) * 36 + n / 3 * 12));
  body.setUint16(0, 12, true); body.setUint8(2, 36); body.setUint8(3, 12); body.setUint32(4, n + 1, true); body.setUint32(8, n / 3, true);
  for (let i = 0; i <= n; i++) for (let k = 0; k < 3; k++) {
    body.setFloat32(12 + i * 36 + k * 4, i < n ? box.attributes.position.array[i * 3 + k] : NaN, true);
    body.setFloat32(12 + i * 36 + 12 + k * 4, i < n ? box.attributes.normal.array[i * 3 + k] : NaN, true);
  }
  for (let i = 0; i < n; i++) body.setUint32(12 + (n + 1) * 36 + i * 4, i, true);
  const buf = new Uint8Array(head.length + body.byteLength); buf.set(head); buf.set(new Uint8Array(body.buffer), head.length);
  images.set('8', Promise.resolve(buf));
}
window.native = { getAsset: async (id) => { if (!images.has(id)) throw new Error('Missing test asset ' + id); return images.get(id); } };

function inst(cls, name, parent = null, props = {}) {
  const i = makeInstance(cls, name); i.props = { name, ...props };
  if (parent) { i.parent = parent; parent.children.push(i); }
  return i;
}
async function scene({ shirt, pants, graphic, bodyColor = { r: 1, g: 0, b: 0 }, trail = false, cm = false, mesh = false, meshPart = false } = {}) {
  const root = inst('Model', 'Rig');
  const torso = inst(meshPart ? 'MeshPart' : 'Part', 'Torso', root, { size: { x: 2, y: 2, z: 1 }, cframe: cf(), ...(meshPart ? { meshcontent: '6', texturecontent: '4' } : {}) });
  inst('BodyColors', 'Colors', root, { torsocolor3: bodyColor });
  if (shirt) inst('Shirt', 'Shirt', root, { shirttemplate: shirt });
  if (pants) inst('Pants', 'Pants', root, { pantstemplate: pants });
  if (graphic) inst('ShirtGraphic', 'Graphic', root, { graphic });
  if (cm) inst('CharacterMesh', 'Body', root, { bodypart: 1, ...(cm === true ? { overlaytextureid: 3 } : cm) });
  // VertexColor is a Vector3; reading it as a Color3 gave NaN (black, smeared by bloom).
  if (mesh) inst('SpecialMesh', 'Mesh', torso, { meshtype: 6, textureid: '4', vertexcolor: { x: 1, y: 1, z: 1 } });
  if (trail) {
    const a = inst('Attachment', 'A', torso, { cframe: cf(0,-0.5) });
    const b = inst('Attachment', 'B', torso, { cframe: cf(0,0.5) });
    inst('Trail', 'Trail', torso, { attachment0: a, attachment1: b, lifetime: 2, facecamera: true,
      color: { r: 0, g: 1, b: 0 }, transparency: 0, minlength: 0 });
  }
  const warnings = [], job = await buildScene(finalizeTree([root]), (w) => warnings.push(w));
  check(!warnings.length, warnings.join('; '));
  job.points = samplePoints(job.root);
  if (trail) {
    job.trailSystem = await buildTrails(job.trails, (w) => warnings.push(w));
    job.trailGroup = job.trailSystem.group;
    job.trailGroup.traverse((o) => o.layers.set(LAYER.TRAIL));
  }
  return job;
}

try {
  const renderer = new IconRenderer(document.getElementById('view')), settings = defaultSettings();
  Object.assign(settings.camera, { yaw: 0, pitch: 0, zoom: 0.6 });
  Object.assign(settings.lighting, { toneMapping: 'none', env: 0, ambient: 2, key: 0, fill: 0, rim: 0 });
  settings.bloom.enabled = settings.outline.enabled = settings.shadows.selfShadows = false;
  const render = (job) => renderer.render(job, settings, 128, { out: 'pixels' });
  const pixel = (img, x = 64, y = 64) => [...img.data.slice((y * 128 + x) * 4, (y * 128 + x) * 4 + 4)];
  const dominant = (img, channel, label) => { const p = pixel(img); check(p[3] > 200 && p[channel] > Math.max(...p.slice(0,3).filter((_, i) => i !== channel)) + 30, `${label}: ${p}`); };
  dominant(render(await scene()), 0, 'BodyColors');
  dominant(render(await scene({ shirt: '1' })), 2, 'Shirt over body color');
  dominant(render(await scene({ pants: '2', shirt: '1' })), 2, 'Shirt over pants');
  dominant(render(await scene({ pants: '1' })), 2, 'Pants on torso');
  dominant(render(await scene({ shirt: '1', graphic: '3' })), 1, 'T-shirt over shirt');
  dominant(render(await scene({ shirt: '1', cm: true })), 1, 'CharacterMesh overlay over clothing');
  dominant(render(await scene({ shirt: '1', mesh: true })), 2, 'Clothing preserves existing texture UVs');
  dominant(render(await scene({ cm: { meshcontent: '6', basetexturecontent: '1' } })), 2, 'CharacterMesh replacement and base Content texture');
  dominant(render(await scene({ shirt: '1', cm: { meshid: 6, basetextureid: 2, overlaytexturecontent: '3' } })), 1, 'CharacterMesh legacy mesh and overlay Content texture');
  dominant(render(await scene({ shirt: '1', meshPart: true })), 2, 'Classic clothing on loaded MeshPart');
  const transparentShirt = render(await scene({ shirt: '5' }));
  dominant(transparentShirt, 0, 'Transparent clothing reveals BodyColors');
  const border = pixel(transparentShirt, 44, 64);
  check(border[2] > border[0] + 30 && border[3] > 200, 'Classic front template mapping: ' + border);
  // A failed texture should warn and fall back to the colored body.
  const bad = inst('Model', 'Missing');
  inst('Part', 'Torso', bad, { size: { x: 2, y: 2, z: 1 }, color: { r: 1, g: 0, b: 0 } });
  inst('Shirt', 'Shirt', bad, { shirttemplate: '999' });
  const errors = [], fallback = await buildScene(finalizeTree([bad]), (w) => errors.push(w));
  fallback.points = samplePoints(fallback.root);
  check(errors.length === 1, 'Missing clothing asset must warn'); dominant(render(fallback), 0, 'Missing clothing fallback');
  // Humanoid R6 torso without a Roblox install: chamfered stand-in with the template still mapped.
  const classic = inst('Model', 'Classic');
  inst('Humanoid', 'Humanoid', classic);
  inst('Part', 'Torso', classic, { size: { x: 2, y: 2, z: 1 }, color: { r: 1, g: 0, b: 0 } });
  inst('Shirt', 'Shirt', classic, { shirttemplate: '1' });
  const classicWarnings = [], classicJob = await buildScene(finalizeTree([classic]), (w) => classicWarnings.push(w));
  classicJob.points = samplePoints(classicJob.root);
  check(classicWarnings.some((w) => w.includes('approximation')), 'Classic fallback must say so');
  dominant(render(classicJob), 2, 'Classic R6 fallback clothing');
  // SurfaceAppearance glow is albedo x EmissiveTint: gold Color x magenta tint glows orange, not magenta.
  const glow = inst('Model', 'Glow');
  const glowPart = inst('MeshPart', 'Plane', glow, { size: { x: 2, y: 2, z: 1 }, cframe: cf(), meshcontent: '6' });
  inst('SurfaceAppearance', 'SA', glowPart, { colormap: 'rbxassetid://4', emissivemaskcontent: 'rbxassetid://4', alphamode: 0,
    color: { r: 200/255, g: 161/255, b: 22/255 }, emissivetint: { r: 1, g: 73/255, b: 1 }, emissivestrength: 40 });
  const glowJob = await buildScene(finalizeTree([glow]), () => {});
  glowJob.points = samplePoints(glowJob.root);
  settings.lighting.ambient = 0;
  const glowPx = pixel(render(glowJob));
  settings.lighting.ambient = 2;
  check(glowPx[0] > 150 && glowPx[2] < glowPx[0] / 2, 'Emissive keeps the SurfaceAppearance Color: ' + glowPx);
  // ParticleEmitter Size 1 is 2 studs across in Roblox: as wide as the 2-stud part behind it.
  const fx = inst('Model', 'Fx');
  const fxPart = inst('Part', 'Base', fx, { size: { x: 2, y: 2, z: 1 }, cframe: cf(), color: { r: 0, g: 0, b: 1 } });
  const fxAtt = inst('Attachment', 'A', fxPart, { cframe: cf() });
  inst('ParticleEmitter', 'P', fxAtt, { texture: 'rbxassetid://4', size: 1, speed: { min: 0, max: 0 }, lifetime: { min: 10, max: 10 },
    color: { r: 1, g: 0, b: 0 }, transparency: 0, lightemission: 0 });
  const fxJob = await buildScene(finalizeTree([fx]), () => {});
  fxJob.points = samplePoints(fxJob.root);
  const partOnly = render(fxJob);
  fxJob.vfxSystem = await buildVfx(fxJob.vfx, (w) => { throw new Error(w); });
  fxJob.vfxGroup = fxJob.vfxSystem.group;
  fxJob.vfxGroup.traverse((o) => o.layers.set(LAYER.VFX));
  fxJob.vfxSystem.update(1, { seed: 1, includeBursts: true, maxParticles: 100, prewarm: true, litLight: 2 });
  fxJob.root.visible = false; // particle alone, same framing
  const withFx = render(fxJob); // the first render after building must already show the particles
  const span = (img, red) => { let n = 0; for (let x = 0; x < 128; x++) { const p = pixel(img, x, 64); if (p[3] > 200 && (!red || p[0] > p[2] + 100)) n++; } return n; };
  const ratio = span(withFx, true) / span(partOnly, false);
  check(ratio > 0.85 && ratio < 1.15, 'Particle Size is the half-width (particle/part width ratio ' + ratio.toFixed(2) + ')');
  // Parts sharing one image share one GPU texture (a map with 587 decals of 6 images used to upload 587 copies).
  const many = inst('Model', 'Many');
  for (let i = 0; i < 6; i++) { const p = inst('Part', 'P' + i, many, { size: { x: 1, y: 1, z: 1 }, cframe: cf(i * 1.5) }); inst('Decal', 'D', p, { texture: '2', face: 5 }); }
  const manyJob = await buildScene(finalizeTree([many]), () => {});
  const sources = new Set(); manyJob.root.traverse((o) => o.material?.map && sources.add(o.material.map.source));
  check(sources.size === 1, 'Decals of one image share a texture source: ' + sources.size);
  // A mesh with a NaN vertex still frames and renders.
  const nanModel = inst('Model', 'Nan');
  inst('MeshPart', 'Start', nanModel, { size: { x: 2, y: 2, z: 2 }, cframe: cf(), meshcontent: '8', color: { r: 1, g: 0, b: 0 } });
  const nanJob = await buildScene(finalizeTree([nanModel]), () => {});
  nanJob.points = samplePoints(nanJob.root);
  dominant(render(nanJob), 0, 'Mesh with a NaN vertex');
  // Overlay SurfaceAppearance: Color tints the ColorMap only; the part color under clear texels stays untinted.
  const ov = inst('Model', 'Ov');
  const ovPart = inst('Part', 'P', ov, { size: { x: 2, y: 2, z: 1 }, cframe: cf(), color: { r: 0, g: 0, b: 1 } });
  inst('SurfaceAppearance', 'SA', ovPart, { colormap: 'rbxassetid://7', alphamode: 0, color: { r: 1, g: 0, b: 0 } });
  const ovJob = await buildScene(finalizeTree([ov]), () => {}); ovJob.points = samplePoints(ovJob.root);
  dominant(render(ovJob), 2, 'Overlay SurfaceAppearance part color is not tinted');
  // Emitter shapes: ShapePartial 0.5 on a sphere surface = dome toward EmissionDirection (Top); on a disc = outer half.
  const shapes = async (props) => {
    const m = inst('Model', 'S'), p = inst('Part', 'Src', m, { size: { x: 2, y: 2, z: 2 }, cframe: cf(), transparency: 1 });
    inst('ParticleEmitter', 'E', p, { texture: 'rbxassetid://4', size: 0.1, speed: { min: 0, max: 0 }, lifetime: { min: 10, max: 10 }, rate: 50, ...props });
    const j = await buildScene(finalizeTree([m]), () => {});
    const sys = await buildVfx(j.vfx, () => {});
    sys.update(10, { seed: 1, includeBursts: true, maxParticles: 1000, prewarm: true, litLight: 2 });
    return sys.group.children[0].userData.particles.map((q) => q.pos);
  };
  const dome = await shapes({ shape: 1, shapestyle: 1, shapepartial: 0.5, emissiondirection: 1 });
  check(dome.length > 100 && dome.every((q) => q.y > -1e-6), 'ShapePartial 0.5 sphere is a dome: min y ' + Math.min(...dome.map((q) => q.y)));
  check((await shapes({ shape: 1, shapestyle: 1 })).some((q) => q.y < -0.5), 'ShapePartial 1 is the whole sphere');
  const ring = await shapes({ shape: 3, shapepartial: 0.5 });
  check(ring.every((q) => Math.hypot(q.x, q.z) > 0.5 - 1e-6), 'ShapePartial 0.5 disc leaves the inner half empty');
  // LockedToPart off: particles stay where the moving arm emitted them; on: they ride along. VelocityInheritance: they
  // keep the arm's speed, so with Speed 0 they move along with it.
  const moving = async (props) => {
    const rigModel = inst('Model', 'Rig');
    const rootPart = inst('Part', 'HumanoidRootPart', rigModel, { size: { x: 1, y: 1, z: 1 }, cframe: cf() });
    const arm = inst('Part', 'Right Arm', rigModel, { size: { x: 1, y: 1, z: 1 }, cframe: cf() });
    inst('Motor6D', 'Joint', rootPart, { part0: rootPart, part1: arm, c0: cf(), c1: cf() });
    inst('ParticleEmitter', 'E', inst('Attachment', 'A', arm, { cframe: cf() }), { texture: 'rbxassetid://4', size: 0.1, speed: { min: 0, max: 0 }, lifetime: { min: 1, max: 1 }, rate: 20, ...props });
    const t = finalizeTree([rigModel]), j = await buildScene(t, () => {});
    j.rig = buildRig(t, j.partObjects);
    j.vfxSystem = await buildVfx(j.vfx, () => {}); j.vfxGroup = j.vfxSystem.group;
    const track = { length: 4, loop: false, curves: new Map([['Right Arm', [
      { t: 0, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), style: 0, dir: 0 },
      { t: 4, pos: new THREE.Vector3(8, 0, 0), quat: new THREE.Quaternion(), style: 0, dir: 0 }]]]) }; // 2 studs/s along X
    const poseChanged = setPose(j, track, 3);
    updateVfx(j, { ...settings.vfx, time: 5 }, poseChanged);
    return j.vfxGroup.children[0].userData.particles.map((q) => q.pos.x);
  };
  const spread = (xs) => Math.max(...xs) - Math.min(...xs);
  const unlocked = await moving({}), locked = await moving({ lockedtopart: true }), inherit = await moving({ velocityinheritance: 1 });
  check(unlocked.length > 10 && spread(unlocked) > 1.5 && Math.max(...unlocked) <= 6 + 1e-3, 'Unlocked particles stay behind: x ' + Math.min(...unlocked).toFixed(2) + '..' + Math.max(...unlocked).toFixed(2));
  check(spread(locked) < 1e-3 && Math.abs(locked[0] - 6) < 1e-3, 'LockedToPart particles ride with the arm: spread ' + spread(locked));
  check(inherit.every((x) => Math.abs(x - 6) < 0.15), 'VelocityInheritance 1 keeps pace with the arm: ' + Math.min(...inherit).toFixed(2) + '..' + Math.max(...inherit).toFixed(2));
  const job = await scene({ trail: true });
  const trailSettings = { ...settings.trails, mode: 'direction', yaw: 90, length: 2 };
  job.trailSystem.update(trailSettings);
  job.trailPoints = new Float32Array(job.trailSystem.trails.flatMap(({ mesh }) => mesh.geometry.userData.boundsPoints));
  settings.vfx.enabled = false; settings.trails.enabled = true;
  const on = render(job);
  settings.trails.enabled = false; const off = render(job);
  check(on.data.some((v, i) => v !== off.data[i]), 'Trails must render while Show VFX is off');
  settings.trails.enabled = true; settings.trails.outline = true; settings.outline.enabled = true;
  const outlined = render(job);
  settings.trails.outline = false; const modelOutline = render(job);
  check(outlined.data.some((v, i) => v !== modelOutline.data[i]), 'Independent trail outline mask');
  // Background image under the model, text layer over everything.
  const green = Object.assign(document.createElement('canvas'), { width: 8, height: 8 }), gg = green.getContext('2d');
  gg.fillStyle = '#00ff00'; gg.fillRect(0, 0, 8, 8);
  const layered = await scene();
  Object.assign(settings.background, { mode: 'image', image: green.toDataURL(), imageFit: 'cover' });
  settings.texts = [textLayer({ text: '■', font: 'Arial', size: 200, y: 0, color: '#0000ff', strokeWidth: 0 })];
  await overlayReady(settings);
  const layeredImg = render(layered);
  dominant(layeredImg, 2, 'Text over the model');
  const corner = pixel(layeredImg, 3, 3);
  check(corner[1] > 200 && corner[0] < 60 && corner[3] === 255, 'Background image behind: ' + corner);
  check(renderer.layouts.length === 1, 'Text layout reported for hit testing');
  settings.texts[0].fill = 'rainbow'; settings.texts[0].fillAngle = 0; // left red -> center cyan -> right red
  const rainbow = pixel(render(layered));
  check(rainbow[0] < 90 && rainbow[1] > 150 && rainbow[2] > 150, 'Rainbow text fill: ' + rainbow);
  // Curved text: the gradient spans the whole layer, not each glyph (the first glyph is red, not the center hue).
  settings.texts = [textLayer({ text: '■■■■■', font: 'Arial', size: 90, y: 0, curve: 20, fill: 'rainbow', fillAngle: 0, strokeWidth: 0 })];
  const curved = render(layered), [Lc] = renderer.layouts, first = pixel(curved, Math.round((Lc.cx + Lc.box[0] * 0.85) * 128), Math.round(Lc.cy * 128));
  check(first[0] > 200 && first[2] < 80, 'Curved rainbow starts red/orange: ' + first);
  settings.texts = []; settings.background.mode = 'transparent';
  check(renderer.gl.info.programs.every((p) => p.diagnostics?.runnable !== false), 'All shaders must compile');
  // GPU reset: renders throw instead of returning blank images, and the renderer rebuilds on a fresh canvas.
  const oldCanvas = renderer.canvas;
  const restored = new Promise((r) => { renderer.onRestore = r; });
  renderer.gl.getContext().getExtension('WEBGL_lose_context').loseContext();
  let lostError = '';
  try { render(await scene()); } catch (e) { lostError = e.message; }
  check(/GPU was reset/.test(lostError), 'Lost GPU context must throw: ' + lostError);
  const fresh = await restored;
  check(fresh !== oldCanvas && fresh.isConnected && !oldCanvas.isConnected && fresh.id === 'view', 'Fresh canvas swapped into the page');
  dominant(render(await scene()), 0, 'Renders again after the GPU comes back');
  window.renderTest.done({ ok: true, message: 'WebGL appearance layering, asset fallback, trails and outline tests ok' });
} catch (e) { window.renderTest.done({ ok: false, message: e.stack || e.message }); }
