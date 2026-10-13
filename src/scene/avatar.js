// A Roblox user's avatar as an R6 or R15 character: body colors, classic clothing, face, head mesh, accessories
// (placed on matching body attachments and welded so they follow animations) and body package meshes.
// The recipe is the avatar API reply (see main.js 'avatar:get') plus rig ('R6' | 'R15'); asset files come from the
// asset cache/API. R15 starts from Roblox's own default rig in the local install.
import { makeInstance, finalizeTree, walk, nameOf } from '../rbx/instance.js';
import { parseModel } from '../rbx/model.js';
import { brickColor } from '../rbx/brickcolor.js';
import { cframeMatrix } from './build.js';

const cf = (x, y, z, r = [1, 0, 0, 0, 1, 0, 0, 0, 1]) => ({ p: [x, y, z], r });
const toCf = (m) => { const e = m.elements; return { p: [e[12], e[13], e[14]], r: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]] }; };
const R_NECK = [-1, 0, 0, 0, 0, 1, 0, 1, 0], R_RIGHT = [0, 0, 1, 0, 1, 0, -1, 0, 0], R_LEFT = [0, 0, -1, 0, 1, 0, 1, 0, 0];

// Standard R6 rig: parts, Motor6D joints and the attachments accessories look for.
const PARTS = {
  HumanoidRootPart: { size: [2, 2, 1], at: [0, 3, 0], transparency: 1 },
  Torso: { size: [2, 2, 1], at: [0, 3, 0], attachments: { NeckAttachment: [0, 1, 0], BodyFrontAttachment: [0, 0, -0.5], BodyBackAttachment: [0, 0, 0.5],
    LeftCollarAttachment: [-1, 1, 0], RightCollarAttachment: [1, 1, 0], WaistFrontAttachment: [0, -1, -0.5], WaistCenterAttachment: [0, -1, 0], WaistBackAttachment: [0, -1, 0.5] } },
  Head: { size: [2, 1, 1], at: [0, 4.5, 0], attachments: { HatAttachment: [0, 0.6, 0], HairAttachment: [0, 0.6, 0], FaceFrontAttachment: [0, 0, -0.6], FaceCenterAttachment: [0, 0, 0] } },
  'Left Arm': { size: [1, 2, 1], at: [-1.5, 3, 0], attachments: { LeftShoulderAttachment: [0, 1, 0], LeftGripAttachment: [0, -1, 0] } },
  'Right Arm': { size: [1, 2, 1], at: [1.5, 3, 0], attachments: { RightShoulderAttachment: [0, 1, 0], RightGripAttachment: [0, -1, 0] } },
  'Left Leg': { size: [1, 2, 1], at: [-0.5, 1, 0], attachments: { LeftFootAttachment: [0, -1, 0] } },
  'Right Leg': { size: [1, 2, 1], at: [0.5, 1, 0], attachments: { RightFootAttachment: [0, -1, 0] } },
};
const JOINTS = [ // name, parent part, part0, part1, C0, C1
  ['RootJoint', 'HumanoidRootPart', 'HumanoidRootPart', 'Torso', cf(0, 0, 0, R_NECK), cf(0, 0, 0, R_NECK)],
  ['Neck', 'Torso', 'Torso', 'Head', cf(0, 1, 0, R_NECK), cf(0, -0.5, 0, R_NECK)],
  ['Right Shoulder', 'Torso', 'Torso', 'Right Arm', cf(1, 0.5, 0, R_RIGHT), cf(-0.5, 0.5, 0, R_RIGHT)],
  ['Left Shoulder', 'Torso', 'Torso', 'Left Arm', cf(-1, 0.5, 0, R_LEFT), cf(0.5, 0.5, 0, R_LEFT)],
  ['Right Hip', 'Torso', 'Torso', 'Right Leg', cf(1, -1, 0, R_RIGHT), cf(0.5, 1, 0, R_RIGHT)],
  ['Left Hip', 'Torso', 'Torso', 'Left Leg', cf(-1, -1, 0, R_LEFT), cf(-0.5, 1, 0, R_LEFT)],
];
// bodyColor3s keys (v2 API) / bodyColors ids (v1) -> BodyColors regions
const REGIONS = { head: 'head', torso: 'torso', leftArm: 'leftarm', rightArm: 'rightarm', leftLeg: 'leftleg', rightLeg: 'rightleg' };
const ACCESSORY_TYPES = new Set([8, 41, 42, 43, 44, 45, 46, 47, 57, 58]); // hats, hair, face, neck, shoulder, front, back, waist, ears, eyes
const BODY_PART_TYPES = new Set([27, 28, 29, 30, 31]);
const LAYERED_TYPES = new Set([64, 65, 66, 67, 68, 69, 70, 71, 72]);
const R15_RIG = 'rbxasset://avatar/characterR15.rbxm';
// Animation packs: climb, fall, idle, jump, run, swim, walk. Each is an R15Anim folder of slot StringValues, like
// the Animate script's defaults (avatar/animations/humanoid{R6,R15}AnimateChildren.rbxm in the Roblox install).
const ANIM_TYPES = new Set([48, 50, 51, 52, 53, 54, 55]);
const ANIM_LABELS = { swimidle: 'Swim idle', toolnone: 'Tool hold', toollunge: 'Tool lunge', toolslash: 'Tool slash', dance: 'Dance 1', dance2: 'Dance 2', dance3: 'Dance 3' };
const ANIM_ORDER = ['idle', 'walk', 'run', 'jump', 'fall', 'climb', 'swim', 'swimidle', 'sit', 'toolnone', 'toollunge', 'toolslash', 'wave', 'point', 'cheer', 'laugh', 'dance', 'dance2', 'dance3'];
const R6_ANIMS = { idle: ['180435571', '180435792'], walk: ['180426354'], run: ['180426354'], jump: ['125750702'], fall: ['180436148'], climb: ['180436334'], sit: ['178130996'], toolnone: ['182393478'] }; // without a Roblox install

function add(cls, name, parent, props = {}) {
  const i = makeInstance(cls, null);
  i.props = { name, ...props };
  if (parent) { i.parent = parent; parent.children.push(i); }
  return i;
}
function adopt(inst, parent) {
  const list = inst.parent ? inst.parent.children : null;
  if (list) list.splice(list.indexOf(inst), 1);
  inst.parent = parent;
  parent.children.push(inst);
}
const hexColor = (h) => { const n = parseInt(String(h).replace('#', ''), 16); return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }; };

function r6Model() {
  const model = add('Model', 'Avatar', null), parts = {};
  add('Humanoid', 'Humanoid', model);
  for (const [name, d] of Object.entries(PARTS)) {
    const p = parts[name] = add('Part', name, model, { size: { x: d.size[0], y: d.size[1], z: d.size[2] }, cframe: cf(...d.at), transparency: d.transparency ?? 0 });
    for (const [an, pos] of Object.entries(d.attachments ?? {})) add('Attachment', an, p, { cframe: cf(...pos) });
  }
  model.props.primarypart = parts.HumanoidRootPart;
  add('SpecialMesh', 'Mesh', parts.Head, { meshtype: 0, scale: { x: 1.25, y: 1.25, z: 1.25 } });
  add('Decal', 'face', parts.Head, { texture: 'rbxasset://textures/face.png', face: 5 });
  for (const [name, parent, a, b, c0, c1] of JOINTS) add('Motor6D', name, parts[parent], { part0: parts[a], part1: parts[b], c0, c1 });
  return model;
}
function r15Model(bytes) {
  const model = parseModel(bytes).roots.find((r) => r.className === 'Model');
  if (!model) throw new Error('no character in characterR15.rbxm');
  model.parent = null;
  return model;
}

// recipe: { username, rig, avatar: { bodyColor3s | bodyColors, scales, assets: [{ id, name, assetType: { id } }] } }.
// fetch(id or rbxasset:// url) -> Uint8Array of the asset file. Problems go to warn; the character still builds.
export async function buildAvatarTree(recipe, warn, fetch) {
  const av = recipe.avatar ?? {};
  let model = null;
  if (recipe.rig === 'R15') {
    try { model = r15Model(await fetch(R15_RIG)); } catch (e) { warn(`R15 rig: ${e.message}; built as R6 instead`); }
  }
  const r15 = !!model;
  model ??= r6Model();
  model.props.name = recipe.username || 'Avatar';
  const parts = Object.fromEntries(model.children.filter((c) => c.className === 'Part' || c.className === 'MeshPart').map((c) => [nameOf(c), c]));
  const headMesh = () => parts.Head.children.find((c) => c.className === 'SpecialMesh');
  let face = parts.Head.children.find((c) => c.className === 'Decal' && nameOf(c) === 'face');

  const colors = add('BodyColors', 'Body Colors', model);
  for (const [k, region] of Object.entries(REGIONS)) {
    const c = av.bodyColor3s?.[`${k}Color3`], id = av.bodyColors?.[`${k}ColorId`];
    const color = c ? hexColor(c) : id != null ? brickColor(id) : null;
    if (color) colors.props[region + 'color3'] = color;
  }

  const skipped = [];
  const loaded = await Promise.all((av.assets ?? []).map(async (a) => {
    const type = a.assetType?.id;
    if (LAYERED_TYPES.has(type)) { skipped.push(`${a.name} (layered clothing)`); return null; }
    if (ANIM_TYPES.has(type) && !r15) return null; // R6 always plays the default animations
    if (![2, 11, 12, 17, 18, 79].includes(type) && !ACCESSORY_TYPES.has(type) && !BODY_PART_TYPES.has(type) && !ANIM_TYPES.has(type)) return null; // gear, emotes, moods…
    try { return { type, all: [...walk(parseModel(await fetch(String(a.id))).roots)] }; } catch (e) { warn(`${a.name}: ${e.message}`); return null; }
  }));
  // Body parts first, then the joints are rebuilt from them, then accessories go on the moved attachments.
  const items = loaded.filter(Boolean).sort((x, y) => isBody(y.type) - isBody(x.type));
  for (const { type, all } of items.filter((i) => isBody(i.type))) {
    // Heads come as a SpecialMesh (classic heads, and some head items like Headless: a near-empty mesh the face
    // projects onto, so it vanishes too) or as MeshParts (dynamic heads, R15 packages). R6 uses MeshParts only for
    // a dynamic head with no SpecialMesh.
    const special = (type === 17 || type === 79) && all.find((i) => i.className === 'SpecialMesh');
    const meshParts = packageParts(all).filter((p) => parts[nameOf(p)] && (r15 || (type === 79 && !special && nameOf(p) === 'Head')));
    if (meshParts.length) {
      for (const p of meshParts) swapPart(parts[nameOf(p)], p, type !== 79); // a dynamic head has its face in its texture
      if (type === 79) face = null;
      if (!r15 && type === 79) seatR6Head(parts);
    } else if (special) {
      const old = headMesh();
      if (old) parts.Head.children.splice(parts.Head.children.indexOf(old), 1);
      adopt(special, parts.Head);
      if (type === 79 && face) { parts.Head.children.splice(parts.Head.children.indexOf(face), 1); face = null; } // its face is in its texture
    } else if (!r15) for (const cm of all.filter((i) => i.className === 'CharacterMesh')) adopt(cm, model); // the package's R6 meshes
  }
  // R15 only: R6 bodies don't scale. ponytail: proportion / body type scaling (Rthro blends) not reproduced.
  const scaleOf = r15 ? scaleBody(parts, av.scales ?? {}) : new Map();
  if (r15) rigFromAttachments(model, parts.HumanoidRootPart);
  // The animations the avatar plays: the rig's defaults, with the player's packs (R15) in their slots.
  let slots = {};
  try { slots = animSlots([...walk(parseModel(await fetch(`rbxasset://avatar/animations/humanoid${r15 ? 'R15' : 'R6'}AnimateChildren.rbxm`)).roots)]); }
  catch { if (!r15) slots = { ...R6_ANIMS }; }
  for (const { type, all } of items.filter((i) => !isBody(i.type))) {
    if (ANIM_TYPES.has(type)) Object.assign(slots, animSlots(all));
    else if (type === 11 || type === 12 || type === 2) {
      const cls = { 11: 'Shirt', 12: 'Pants', 2: 'ShirtGraphic' }[type], item = all.find((i) => i.className === cls);
      if (item) adopt(item, model);
    } else if (type === 18) {
      const decal = all.find((i) => i.className === 'Decal');
      if (decal && face) { parts.Head.children.splice(parts.Head.children.indexOf(face), 1); decal.props.face = 5; adopt(decal, parts.Head); face = decal; }
    } else {
      const acc = all.find((i) => i.className === 'Accessory' || i.className === 'Hat');
      if (acc) { adopt(acc, model); placeAccessory(acc, parts, warn, scaleOf); }
    }
  }
  addAnimations(model, slots);
  if (skipped.length) warn(`Not reproduced on the ${r15 ? 'R15' : 'R6'} body: ${skipped.join(', ')}`);
  return finalizeTree([model]);
}

// slot -> animation ids, from Animate-style StringValues holding Animation instances.
function animSlots(list) {
  const out = {};
  for (const sv of list) {
    if (sv.className !== 'StringValue') continue;
    const ids = sv.children.filter((c) => c.className === 'Animation').map((c) => String(c.props.animationid ?? '').match(/(\d{3,})/)?.[1]).filter(Boolean);
    if (ids.length) out[nameOf(sv)] = ids;
  }
  return out;
}
// An Animations folder of Animation instances named by slot ("Idle A", "Walk"…), which the app lists for the rig.
function addAnimations(model, slots) {
  const names = [...ANIM_ORDER.filter((s) => slots[s]), ...Object.keys(slots).filter((s) => !ANIM_ORDER.includes(s))];
  if (!names.length) return;
  const folder = add('Folder', 'Animations', model), seen = new Set();
  for (const slot of names) slots[slot].forEach((id, i) => {
    if (seen.has(id)) return; // R6 walks and runs with one animation
    seen.add(id);
    add('Animation', (ANIM_LABELS[slot] ?? slot[0].toUpperCase() + slot.slice(1)) + (slots[slot].length > 1 ? ` ${'ABCDEFGH'[i] ?? i + 1}` : ''), folder, { animationid: `rbxassetid://${id}` });
  });
}
const isBody = (type) => BODY_PART_TYPES.has(type) || type === 17 || type === 79;

// The R15 MeshParts in a body package. Roblox wears the R15ArtistIntent version (the artist's own joints and
// hidden parts: a Korblox leg is one peg with the shin and foot invisible); R15Fixed / R15 are older fallbacks.
function packageParts(all) {
  for (const f of ['R15ArtistIntent', 'R15Fixed', 'R15']) {
    const dir = all.find((i) => i.className === 'Folder' && nameOf(i) === f);
    if (dir) return dir.children.filter((c) => c.className === 'MeshPart');
  }
  return all.filter((i) => i.className === 'MeshPart' && !(i.parent && nameOf(i.parent) === 'R6'));
}

// The rig part takes the package part's class, mesh, size, textures and attachments; its joints (and face) stay.
function swapPart(part, pkg, keepFace) {
  const theirs = new Set(pkg.children.filter((c) => c.className === 'Attachment').map(nameOf));
  part.children = part.children.filter((c) => c.className === 'Motor6D' || (c.className === 'Attachment' && !theirs.has(nameOf(c))) || (keepFace && c.className === 'Decal'));
  part.className = pkg.className;
  part.props = { ...pkg.props, name: nameOf(part), cframe: part.props.cframe };
  for (const c of [...pkg.children]) if (c.className !== 'Motor6D' && !/Weld/.test(c.className)) adopt(c, part);
}

// A dynamic (MeshPart) head on R6 sits on the neck by its own height.
function seatR6Head(parts) {
  const neck = parts.Torso.children.find((c) => nameOf(c) === 'Neck'), h = parts.Head;
  neck.props.c1 = cf(0, -(h.props.size?.y ?? 1) / 2, 0, R_NECK);
  h.props.cframe = toCf(cframeMatrix(parts.Torso.props.cframe).multiply(cframeMatrix(neck.props.c0)).multiply(cframeMatrix(neck.props.c1).invert()));
}

// Avatar scales on R15 classic bodies: width / height / depth per axis on the body, head scale on the head. Sizes,
// attachments (so the joints rebuilt from them) and file-mesh scales grow together. Returns part -> [sx, sy, sz].
const mul3 = (v, s) => ({ x: (v?.x ?? 1) * s[0], y: (v?.y ?? 1) * s[1], z: (v?.z ?? 1) * s[2] });
function scaleInstance(inst, s) {
  inst.props.size = mul3(inst.props.size, s);
  for (const c of inst.children) {
    if (c.className === 'Attachment' && c.props.cframe) c.props.cframe = { ...c.props.cframe, p: c.props.cframe.p.map((v, i) => v * s[i]) };
    if (c.className === 'SpecialMesh' && c.props.meshtype === 5) c.props.scale = mul3(c.props.scale, s);
  }
}
function scaleBody(parts, sc) {
  const out = new Map(), n = (v) => (Number.isFinite(+v) && +v > 0 ? +v : 1);
  for (const [name, part] of Object.entries(parts)) {
    const s = name === 'Head' ? Array(3).fill(n(sc.head)) : [n(sc.width), n(sc.height), n(sc.depth)];
    if (s.some((v) => v !== 1)) { scaleInstance(part, s); out.set(part, s); }
  }
  return out;
}

// Like Humanoid:BuildRigFromAttachments: each joint's C0/C1 are the RigAttachment its two parts share, then every
// part is placed outward from the root.
function rigFromAttachments(model, root) {
  const motors = [...walk([model])].filter((i) => i.className === 'Motor6D' && i.props.part0 && i.props.part1);
  const att = (p, n) => p.children.find((c) => c.className === 'Attachment' && nameOf(c) === n);
  const at = (a) => a.props.cframe ?? cf(0, 0, 0);
  for (const m of motors) {
    const { part0, part1 } = m.props, shared = part1.children.find((c) => c.className === 'Attachment' && /RigAttachment$/.test(nameOf(c)) && att(part0, nameOf(c)));
    if (shared) { m.props.c0 = at(att(part0, nameOf(shared))); m.props.c1 = at(shared); }
  }
  const placed = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { props: { part0, part1, c0, c1 } } of motors) {
      if (!placed.has(part0) || placed.has(part1)) continue;
      part1.props.cframe = toCf(cframeMatrix(part0.props.cframe).multiply(cframeMatrix(c0)).multiply(cframeMatrix(c1).invert()));
      placed.add(part1); grew = true;
    }
  }
}

// Handle.CFrame = part.CFrame * bodyAttachment.CFrame * handleAttachment.CFrame⁻¹, welded to that part.
// Accessories without a matching attachment fall back to the legacy hat AttachmentPoint on top of the head.
// They scale with the body part they sit on (scaleOf: part -> [sx, sy, sz]).
function placeAccessory(acc, parts, warn, scaleOf = new Map()) {
  const handle = acc.children.find((c) => nameOf(c) === 'Handle');
  if (!handle?.props) return warn(`${nameOf(acc)}: no Handle`);
  for (const c of [...handle.children]) if (/Weld/.test(c.className)) handle.children.splice(handle.children.indexOf(c), 1);
  const own = handle.children.filter((c) => c.className === 'Attachment');
  for (const att of own) for (const part of Object.values(parts)) {
    const body = part.children.find((c) => c.className === 'Attachment' && nameOf(c) === nameOf(att));
    if (!body) continue;
    if (scaleOf.has(part)) scaleInstance(handle, scaleOf.get(part));
    handle.props.cframe = toCf(cframeMatrix(part.props.cframe).multiply(cframeMatrix(body.props.cframe)).multiply(cframeMatrix(att.props.cframe).invert()));
    add('Weld', 'AccessoryWeld', handle, { part0: part, part1: handle, c0: body.props.cframe, c1: att.props.cframe });
    return;
  }
  if (scaleOf.has(parts.Head)) scaleInstance(handle, scaleOf.get(parts.Head));
  const point = cframeMatrix(acc.props.attachmentpoint), top = cframeMatrix(cf(0, parts.Head.props.size.y / 2, 0));
  handle.props.cframe = toCf(cframeMatrix(parts.Head.props.cframe).multiply(top).multiply(point.clone().invert()));
  add('Weld', 'AccessoryWeld', handle, { part0: parts.Head, part1: handle, c0: toCf(top.multiply(point.invert())), c1: cf(0, 0, 0) });
}
