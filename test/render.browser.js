import { buildScene } from '../src/scene/build.js';
import { buildTrails } from '../src/scene/trails.js';
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
  const job = await scene({ trail: true });
  const trailSettings = { ...settings.trails, mode: 'direction', yaw: 90, length: 2 };
  job.trailSystem.update(trailSettings);
  job.trailPoints = new Float32Array(job.trailSystem.trails.flatMap(({ mesh }) => mesh.geometry.userData.boundsPoints));
  settings.vfx.enabled = false;
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
  window.renderTest.done({ ok: true, message: 'WebGL appearance layering, asset fallback, trails and outline tests ok' });
} catch (e) { window.renderTest.done({ ok: false, message: e.stack || e.message }); }
