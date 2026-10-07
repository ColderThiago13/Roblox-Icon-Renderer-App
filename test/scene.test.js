import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeInstance, finalizeTree } from '../src/rbx/instance.js';
import { brickColor } from '../src/rbx/brickcolor.js';
import { defaultSettings, withDefaults, textLayer } from '../src/settings.js';
import { layoutText, frameLayout, hitText } from '../src/render/overlay.js';
import { wheelZoom } from '../src/ui/zoom.js';
import { collectAppearances, clothingGeometry, clothingRect, chamferedLimb } from '../src/scene/appearance.js';
import { buildScene, projectedDecalGeometry } from '../src/scene/build.js';
import { buildRig } from '../src/scene/anim.js';
import { buildTrails, clipTrail, directionalHistory, trailGeometry, behindDirection } from '../src/scene/trails.js';
import { frameTimes, gifDelays, sheetLayout, flatten } from '../src/ui/animexport.js';
import { setPose, updateTrails } from '../src/scene/job.js';

const settings = defaultSettings();
assert.ok(Math.abs(wheelZoom(1, { deltaY: 100, ctrlKey: true }) - 1) < Math.abs(wheelZoom(1, { deltaY: 100 }) - 1) / 9);
assert.equal(wheelZoom(0.0101, { deltaY: 10, ctrlKey: true }), 0.0101);
assert.equal(wheelZoom(0.01, { deltaY: 1000 }), 0.01);
assert.equal(wheelZoom(4, { deltaY: -1000 }), 4);
assert.equal(wheelZoom(1, { deltaY: 3, deltaMode: 1 }), wheelZoom(1, { deltaY: 48, deltaMode: 0 }));
assert.ok(wheelZoom(0.2, { deltaY: 100 }) < 0.2);
assert.equal(withDefaults({ vfx: { enabled: false } }).trails.enabled, true);
assert.deepEqual(brickColor(21), { r: 196/255, g: 40/255, b: 28/255 });
assert.equal(brickColor(99999), null);

function inst(cls, name, parent = null, props = {}) {
  const i = makeInstance(cls, name); i.props = { name, ...props };
  if (parent) { i.parent = parent; parent.children.push(i); }
  return i;
}
const cf = (x = 0, y = 0, z = 0) => ({ p: [x,y,z], r: [1,0,0,0,1,0,0,0,1] });
const rig1 = inst('Model', 'Rig1'), rig2 = inst('Model', 'Rig2');
const body = inst('Part', 'Torso', rig1, { size: { x: 2, y: 2, z: 1 }, cframe: cf() });
const other = inst('Part', 'Torso', rig2, { size: { x: 2, y: 2, z: 1 }, cframe: cf(6) });
inst('BodyColors', 'Colors', rig1, { torsocolor: 21, headcolor3: { r: 0, g: 1, b: 0 } });
const shirt = inst('Shirt', 'Shirt', rig1);
const cm = inst('CharacterMesh', 'Body', rig1, { bodypart: 1 });
const accessory = inst('Accessory', 'Hat', rig1), fakeBody = inst('Part', 'Torso', accessory);
const upper = inst('MeshPart', 'LeftUpperArm', rig1, { size: { x: 1, y: 2, z: 1 } });
const lower = inst('MeshPart', 'LeftLowerArm', rig1, { size: { x: 1, y: 1, z: 1 } });
const hand = inst('MeshPart', 'LeftHand', rig1, { size: { x: 1, y: 1, z: 1 } });
const tree = finalizeTree([rig1, rig2]), appearances = collectAppearances(tree);
assert.deepEqual(appearances.get(body).color, brickColor(21));
assert.equal(appearances.get(body).shirt, shirt);
assert.equal(appearances.get(body).characterMesh, cm);
assert.equal(appearances.get(other).color, null);
assert.equal(appearances.get(other).shirt, undefined);
assert.equal(appearances.has(fakeBody), false);
assert.deepEqual(appearances.get(upper).slice, [0, 0.5]);
assert.deepEqual(appearances.get(lower).slice, [0.5, 0.75]);
assert.deepEqual(appearances.get(hand).slice, [0.75, 1]);
assert.deepEqual(clothingRect('torso', 5), [231,74,128,128]);
assert.notDeepEqual(clothingRect('leftarm', 5), clothingRect('rightarm', 5));
// Left limbs: front under the top square at x=308, strip F L B R.
assert.deepEqual([5, 1, 3, 2, 0].map((f) => clothingRect('leftleg', f).slice(0, 2)), [[308,355], [308,289], [374,355], [440,355], [506,355]]);
assert.deepEqual([5, 0, 2, 3].map((f) => clothingRect('rightarm', f)[0]), [217, 151, 85, 19]);
const box = new THREE.BoxGeometry(1,1,1), clothed = clothingGeometry(box);
assert.equal(box.attributes.clothingUv, undefined);
assert.deepEqual([...clothed.attributes.uv.array], [...box.attributes.uv.array]);
assert.equal(clothed.attributes.clothingUv.count, box.attributes.position.count);
assert.ok([...clothed.attributes.clothingUv.array].every((v) => v >= 0 && v <= 1));

const a0 = inst('Attachment', 'A0', body, { cframe: cf(0,-0.5,0) });
const a1 = inst('Attachment', 'A1', body, { cframe: cf(0,0.5,0) });
const trail = inst('Trail', 'Trail', body, { attachment0: a0, attachment1: a1, lifetime: 1, minlength: 0, maxlength: 2 });
const history = directionalHistory(trail, { ...settings.trails, yaw: 90, length: 4 });
const capped = clipTrail(history, 1.05);
assert.ok(Math.abs(capped.at(-1).distance - 1.05) < 1e-6);
assert.equal(clipTrail(history, 0).length, 0);
const spin = clipTrail([
  { a: new THREE.Vector3(-1,0,0), b: new THREE.Vector3(1,0,0), age: 0 },
  { a: new THREE.Vector3(0,-1,0), b: new THREE.Vector3(0,1,0), age: 1 },
], 0.5);
assert.equal(spin.at(-1).distance, 0.5);
const geometry = trailGeometry(trail, history, settings.trails);
const points = geometry.userData.boundsPoints;
assert.ok(Math.max(...points.filter((_, i) => i % 3 === 0)) <= 2 + 1e-6);
assert.equal(geometry.index.count > 0, true);
assert.equal(trailGeometry(trail, [], settings.trails).index.count, 0);
const disabled = inst('Trail', 'Disabled', body, { enabled: false, attachment0: a0, attachment1: a1 });
const warnings = [], system = await buildTrails([trail, disabled, inst('Trail', 'Missing')], (w) => warnings.push(w));
assert.equal(system.trails.length, 1);
assert.ok(warnings.some((w) => w.includes('missing an attachment')));

// Exercise scene routing, actual Motor6D history, and restore-after-scrubbing behavior.
const motionRig = inst('Model', 'Animated');
const root = inst('Part', 'HumanoidRootPart', motionRig, { size: { x: 1, y: 1, z: 1 }, cframe: cf() });
const arm = inst('Part', 'Right Arm', motionRig, { size: { x: 1, y: 1, z: 1 }, cframe: cf() });
inst('Motor6D', 'Joint', root, { part0: root, part1: arm, c0: cf(), c1: cf() });
const p0 = inst('Attachment', 'A0', arm, { cframe: cf(0,-0.5) }), p1 = inst('Attachment', 'A1', arm, { cframe: cf(0,0.5) });
inst('Trail', 'Motion', arm, { attachment0: p0, attachment1: p1, lifetime: 1, minlength: 0 });
inst('Trail', 'Fast', arm, { attachment0: p0, attachment1: p1, lifetime: 0.01, minlength: 0 });
const motionTree = finalizeTree([motionRig]);
const job = await buildScene(motionTree, (w) => warnings.push(w));
assert.equal(job.vfx.length, 0); assert.equal(job.trails.length, 2);
job.rig = buildRig(motionTree, job.partObjects);
job.trailSystem = await buildTrails(job.trails, (w) => warnings.push(w));
const track = { length: 2, loop: false, curves: new Map([['Right Arm', [
  { t: 0, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), style: 0, dir: 0 },
  { t: 2, pos: new THREE.Vector3(4,0,0), quat: new THREE.Quaternion(), style: 0, dir: 0 },
]]]) };
setPose(job, track, 1); updateTrails(job, settings.trails);
assert.ok(job.trailPoints.length > 0);
assert.ok(job.trailSystem.trails.every(({ mesh }) => mesh.geometry.index.count > 0), 'Both long and short lifetimes retain motion');
assert.ok(Math.abs(arm.anim.elements[12] - 2) < 1e-6);
const first = [...job.trailPoints];
setPose(job, track, 0); updateTrails(job, settings.trails);
assert.equal(job.trailPoints.length, 0);
setPose(job, track, 1); updateTrails(job, settings.trails);
assert.deepEqual([...job.trailPoints], first);
updateTrails(job, { ...settings.trails, enabled: false });
assert.equal(job.trailPoints.length, 0);
updateTrails(job, settings.trails);
assert.deepEqual([...job.trailPoints], first);

// Classic head mesh keeps a round cross-section (2x1x1 head at 1.25 scale = 1.25-stud cylinder, not an oval).
const headRig = inst('Model', 'R6');
const head = inst('Part', 'Head', headRig, { size: { x: 2, y: 1, z: 1 }, cframe: cf() });
inst('SpecialMesh', 'Mesh', head, { meshtype: 0, scale: { x: 1.25, y: 1.25, z: 1.25 } });
const headJob = await buildScene(finalizeTree([headRig]), () => {});
const headMesh = headJob.partObjects.get(head).children[0];
assert.deepEqual(headMesh.scale.toArray(), [1.25, 1.25, 1.25]);
// A face decal is projected onto the front of the mesh, inside the [0,1] texture.
const face = projectedDecalGeometry(headMesh, { axis: 'z', sign: -1, rot: [0, Math.PI, 0] });
assert.ok(face.geometry.attributes.position.count > 0);
assert.ok([...face.geometry.attributes.uv.array].every((v) => v >= -1e-6 && v <= 1 + 1e-6));
assert.ok(Math.max(...face.geometry.attributes.position.array.filter((_, i) => i % 3 === 2)) <= 1e-6, 'front faces only');

// Still trails sweep perpendicular to the attachment edge: off the back of a board, behind a character.
const board = inst('Model', 'Board'), deck = inst('Part', 'Deck', board, { size: { x: 9, y: 1, z: 3 }, cframe: cf() });
const e0 = inst('Attachment', 'E0', deck, { cframe: cf(-3, 0, -1.5) }), e1 = inst('Attachment', 'E1', deck, { cframe: cf(-3, 0, 1.5) });
const boardTrail = inst('Trail', 'T', deck, { attachment0: e0, attachment1: e1 });
assert.deepEqual(behindDirection(boardTrail, new THREE.Vector3()).toArray().map(Math.round), [-1, 0, 0]);
assert.deepEqual(behindDirection(boardTrail).toArray().map((v) => Math.round(v) || 0), [1, 0, 0], 'pivot +Z is parallel to the edge, so fall back to world X');
assert.deepEqual(behindDirection(trail).toArray().map((v) => Math.round(v) || 0), [0, 0, 1]);

// Animated export frame math.
assert.equal(frameTimes(0, 1, 24, true).length, 24);
assert.equal(frameTimes(0, 1, 24, false).length, 25);
assert.equal(frameTimes(0.5, 1, 4, true)[3], 1.25);
assert.equal(gifDelays(24, 24).reduce((a, b) => a + b), 100);
assert.deepEqual([...new Set(gifDelays(24, 24))].sort(), [4, 5]);
const layout = sheetLayout(10, 64, 0, 2);
assert.deepEqual([layout.cols, layout.rows, layout.width, layout.height, layout.frames[9].x, layout.frames[9].y], [4, 3, 262, 196, 66, 132]);
assert.equal(sheetLayout(400, 1024).fits, false);
assert.deepEqual([...flatten(new Uint8Array([255, 0, 0, 128, 9, 9, 9, 0]), [0, 0, 255])], [128, 0, 127, 255, 0, 0, 255, 255]);

// Humanoid R6 limbs use Roblox's chamfered limb meshes; one shared body (atlas) per character.
const r6 = inst('Model', 'Classic');
inst('Humanoid', 'Humanoid', r6);
const r6torso = inst('Part', 'Torso', r6, { size: { x: 2, y: 2, z: 1 } }), r6arm = inst('Part', 'Left Arm', r6, { size: { x: 1, y: 2, z: 1 }, color3uint8: { r: 1, g: 0, b: 0 } });
const r6leg = inst('Part', 'Left Leg', r6, { size: { x: 1, y: 2, z: 1 } });
inst('SpecialMesh', 'Mesh', r6leg, { meshtype: 6 });
const r6look = collectAppearances(finalizeTree([r6]));
assert.ok(r6look.get(r6torso).classic && r6look.get(r6torso).classic === r6look.get(r6arm).classic);
assert.deepEqual(r6look.get(r6torso).classic.colors.leftarm, { r: 1, g: 0, b: 0 }, 'no BodyColors: part color');
assert.equal(r6look.get(r6leg).classic, null, 'a SpecialMesh keeps its own look');
assert.equal(appearances.get(body).classic, null, 'no Humanoid: plain block');
const limb = chamferedLimb('Torso');
limb.computeBoundingBox();
assert.deepEqual(limb.boundingBox.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3)), [2, 2, 1]);
assert.ok(limb.attributes.position.array.some((v) => Math.abs(Math.abs(v) - 0.935) < 1e-6), '0.065 chamfer');

// Text layers: saved settings keep layers and gain new fields; layout, curve and hit testing.
const saved = withDefaults({ texts: [{ id: 'a', text: 'Hi', size: 10 }] });
assert.equal(saved.texts[0].id, 'a'); assert.equal(saved.texts[0].size, 10); assert.equal(saved.texts[0].strokeWidth, 6);
assert.deepEqual(withDefaults({}).texts, []);
const migrated = withDefaults({ texts: [{ id: 'g', gradient: true }] }).texts[0];
assert.equal(migrated.fill, 'gradient'); assert.equal('gradient' in migrated, false);
const measure = (s) => s.length * 10; // 10 px per character
const flat = layoutText(textLayer({ text: 'ABCD', size: 512, strokeWidth: 0 }), 512, measure);
assert.equal(flat.glyphs.length, 1); assert.equal(flat.glyphs[0].x, 0);
assert.ok(Math.abs(flat.box[0] + 20) < 1e-9 && Math.abs(flat.box[2] - 20) < 1e-9, 'centered box');
const lines = layoutText(textLayer({ text: 'AB' + String.fromCharCode(10) + 'ABCD', align: 'left', strokeWidth: 0 }), 512, measure);
assert.equal(lines.glyphs[0].x, -20 + 10); // left edge of the wider line
assert.ok(lines.glyphs[0].y < lines.glyphs[1].y, 'lines stack downward');
const arc = layoutText(textLayer({ text: 'ABCDEF', curve: 90, strokeWidth: 0 }), 512, measure);
assert.equal(arc.glyphs.length, 6);
assert.ok(Math.abs(arc.glyphs[0].rot + arc.glyphs[5].rot) < 1e-9 && arc.glyphs[5].rot > 0, 'symmetric arch, right side tilts clockwise');
assert.ok(arc.glyphs[0].y > arc.glyphs[2].y, 'arched up: ends lower than the middle');
const sag = layoutText(textLayer({ text: 'ABCDEF', curve: -90, strokeWidth: 0 }), 512, measure);
assert.ok(sag.glyphs[0].y < sag.glyphs[2].y && sag.glyphs[5].rot < 0, 'negative curve sags');
const small = textLayer({ id: 'r', text: 'ABCD', x: 0.1, y: 0.2, rotation: 90, size: 10, strokeWidth: 0 }); // 40 x ~12 px box
const L = frameLayout(small, layoutText(small, 512, measure), 512);
assert.equal(hitText([L], 0.6, 0.3 + 0.03), 'r', 'rotated 90°: the long side runs vertically');
assert.equal(hitText([L], 0.6 + 0.03, 0.3), null);
console.log('scene, appearance, classic R6, trails, zoom, head/decal, text layout, animated export ok');
