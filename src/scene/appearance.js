// Classic clothing templates: https://create.roblox.com/docs/avatar/classic-clothing
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { loadImage, loadTexture, loadMesh, textureFrom } from './assets.js';
import { walk, nameOf } from '../rbx/instance.js';
import { brickColor } from '../rbx/brickcolor.js';

const BODY = {
  Head: 'head', Torso: 'torso', UpperTorso: 'torso', LowerTorso: 'torso',
  'Left Arm': 'leftarm', LeftUpperArm: 'leftarm', LeftLowerArm: 'leftarm', LeftHand: 'leftarm',
  'Right Arm': 'rightarm', RightUpperArm: 'rightarm', RightLowerArm: 'rightarm', RightHand: 'rightarm',
  'Left Leg': 'leftleg', LeftUpperLeg: 'leftleg', LeftLowerLeg: 'leftleg', LeftFoot: 'leftleg',
  'Right Leg': 'rightleg', RightUpperLeg: 'rightleg', RightLowerLeg: 'rightleg', RightFoot: 'rightleg',
};
const R6 = ['Head', 'Torso', 'Left Arm', 'Right Arm', 'Left Leg', 'Right Leg'];
// Humanoid R6 bodies: Roblox swaps these blocks for its chamfered limb meshes (textured from one composited atlas).
const CLASSIC = { Torso: 'torso', 'Left Arm': 'leftarm', 'Right Arm': 'rightarm', 'Left Leg': 'leftleg', 'Right Leg': 'rightleg' };
const ORDER = { torso: ['UpperTorso', 'LowerTorso'], leftarm: ['LeftUpperArm', 'LeftLowerArm', 'LeftHand'],
  rightarm: ['RightUpperArm', 'RightLowerArm', 'RightHand'], leftleg: ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot'], rightleg: ['RightUpperLeg', 'RightLowerLeg', 'RightFoot'] };

// Scope to direct body parts in each character, never accessories or a neighboring rig.
export function collectAppearances(tree) {
  const result = new Map();
  for (const model of walk(tree.roots)) {
    if (model.className !== 'Model' && model.className !== 'Actor') continue;
    const kids = model.children, colors = kids.find((c) => c.className === 'BodyColors');
    const shirt = kids.find((c) => c.className === 'Shirt'), pants = kids.find((c) => c.className === 'Pants');
    const graphic = kids.find((c) => c.className === 'ShirtGraphic');
    const humanoid = kids.some((c) => c.className === 'Humanoid');
    let body = null; // shared by the character's classic parts, so its atlas is composited once
    for (const part of kids) {
      const name = nameOf(part), region = BODY[name];
      if (!region || !['Part', 'MeshPart'].includes(part.className)) continue;
      const color = colors?.props[region + 'color3'] ?? brickColor(colors?.props[region + 'color']);
      const characterMesh = R6.includes(name) ? kids.find((c) => c.className === 'CharacterMesh' && R6[c.props.bodypart] === name) : null;
      const segments = (ORDER[region] ?? []).map((n) => kids.find((c) => nameOf(c) === n)).filter(Boolean);
      const total = segments.reduce((sum, p) => sum + (p.props.size?.y ?? 1), 0);
      let offset = 0, slice = [0, 1];
      for (const segment of segments) {
        const end = offset + (segment.props.size?.y ?? 1);
        if (segment === part) slice = [offset / total, end / total];
        offset = end;
      }
      // A SpecialMesh/CharacterMesh or non-block shape keeps its own look.
      const classic = humanoid && part.className === 'Part' && CLASSIC[name] && !characterMesh && (part.props.shape ?? 1) === 1
        && !part.children.some((c) => /^(SpecialMesh|BlockMesh|CylinderMesh)$/.test(c.className));
      if (classic) body ??= { shirt, pants, graphic, colors: Object.fromEntries(Object.entries(CLASSIC).map(([n, r]) => {
        const p = kids.find((c) => nameOf(c) === n)?.props ?? {};
        return [r, colors?.props[r + 'color3'] ?? brickColor(colors?.props[r + 'color']) ?? p.color3uint8 ?? p.color ?? brickColor(p.brickcolor)];
      })) };
      result.set(part, { region, color, characterMesh, shirt, pants, graphic, slice, classic: classic ? body : null });
    }
  }
  return result;
}

// NormalId face order: Right, Top, Back, Left, Bottom, Front. Pixels in the 585x559 template.
// Strips read like the character seen from the front: torso R F L B, right limb L B R F, left limb F L B R.
export function clothingRect(region, face) {
  if (region === 'torso') return [[165,74,64,128], [231,8,128,64], [427,74,128,128], [361,74,64,128], [231,204,128,64], [231,74,128,128]][face];
  if (region.startsWith('right')) return [[151,355,64,128], [217,289,64,64], [85,355,64,128], [19,355,64,128], [217,485,64,64], [217,355,64,128]][face];
  return [[506,355,64,128], [308,289,64,64], [440,355,64,128], [374,355,64,128], [308,485,64,64], [308,355,64,128]][face];
}

// An independent UV set keeps existing mesh texture/SurfaceAppearance UVs intact.
// Block bodies map exactly; rounded/custom bodies use a box projection.
export function clothingGeometry(geometry) {
  const g = geometry.clone();
  g.computeBoundingBox();
  if (!g.attributes.normal) g.computeVertexNormals();
  const min = g.boundingBox.min, size = g.boundingBox.getSize(new THREE.Vector3());
  const pos = g.attributes.position, normal = g.attributes.normal, uv = [];
  const clamp = (n) => THREE.MathUtils.clamp(n, 0, 1);
  for (let i = 0; i < pos.count; i++) {
    const x = clamp((pos.getX(i) - min.x) / (size.x || 1)), y = clamp((pos.getY(i) - min.y) / (size.y || 1)), z = clamp((pos.getZ(i) - min.z) / (size.z || 1));
    const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
    let face, u, v;
    if (Math.abs(nx) >= Math.max(Math.abs(ny), Math.abs(nz))) { face = nx > 0 ? 0 : 3; u = nx > 0 ? 1-z : z; v = y; }
    else if (Math.abs(ny) >= Math.abs(nz)) { face = ny > 0 ? 1 : 4; u = 1-x; v = ny > 0 ? z : 1-z; } // edge shared with Front
    else { face = nz > 0 ? 2 : 5; u = nz > 0 ? x : 1-x; v = y; }
    // Inset half a texel to prevent neighboring faces bleeding under filtering.
    uv.push((face * 128 + 0.5 + u * 127) / 768, (0.5 + v * 127) / 128);
  }
  g.setAttribute('clothingUv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

function tintImage(image, color) {
  if (!color) return image;
  const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight;
  const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = new THREE.Color().setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace).getStyle(THREE.SRGBColorSpace);
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(image, 0, 0);
  return c;
}

async function clothingAtlas(a, warn) {
  if (a.region === 'head') return null;
  const layers = [];
  const add = async (inst, url, graphic = false) => {
    if (!url) return;
    try { layers.push({ image: tintImage(await loadImage(url), inst.props.color3 || inst.props.color), graphic }); }
    catch (e) { warn(`${nameOf(inst)}: ${e.message}`); }
  };
  if (a.region === 'torso' || a.region.endsWith('leg')) await add(a.pants, a.pants?.props.pantstemplate);
  if (a.region === 'torso' || a.region.endsWith('arm')) await add(a.shirt, a.shirt?.props.shirttemplate);
  if (a.region === 'torso') await add(a.graphic, a.graphic?.props.graphic, true);
  if (!layers.length) return null;
  const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  for (let face = 0; face < 6; face++) {
    const tile = document.createElement('canvas'); tile.width = tile.height = 128;
    const g = tile.getContext('2d');
    for (const { image, graphic } of layers) {
      if (graphic) { if (face === 5) g.drawImage(image, 0, 0, 128, 128); }
      else {
        const [x,y,w,h] = clothingRect(a.region, face);
        const sx = image.width / 585, sy = image.height / 559;
        g.drawImage(image, x*sx, y*sy, w*sx, h*sy, 0, 0, 128, 128);
      }
    }
    const side = face !== 1 && face !== 4, [start, end] = side ? a.slice : [0, 1];
    ctx.drawImage(tile, 0, start*128, 128, (end-start)*128, face*128, 0, 128, 128);
  }
  return textureFrom(canvas);
}

// ---------- classic R6 body ----------
// Limb mesh from the local Roblox install; without one, the same 0.065-stud chamfered box (no Roblox UVs).
export const classicLimbUrl = (name) => `rbxasset://avatar/meshes/${CLASSIC[name]}.mesh`;
const chamfered = new Map();
export function chamferedLimb(name) {
  const [w, h, d] = name === 'Torso' ? [2, 2, 1] : [1, 2, 1], b = 0.065, pts = [];
  if (!chamfered.has(w)) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      pts.push(new THREE.Vector3(sx * w / 2, sy * (h / 2 - b), sz * (d / 2 - b)), new THREE.Vector3(sx * (w / 2 - b), sy * h / 2, sz * (d / 2 - b)), new THREE.Vector3(sx * (w / 2 - b), sy * (h / 2 - b), sz * d / 2));
    }
    const g = new ConvexGeometry(pts);
    g.userData.approx = true;
    chamfered.set(w, g);
  }
  return chamfered.get(w);
}

// Roblox composites body colors, then pants, shirt and t-shirt (by the meshes' z order) into a 1024x512 atlas with
// the Composit*.mesh layouts: positions are atlas pixels (y down), UVs point into the 585x559 template / graphic.
// The limb meshes' UVs read that atlas directly. Composited in sRGB like the 2D templates (no color conversion).
let compositor = null;
const COMPOSITE = [['TorsoBase', 'torso'], ['LeftArmBase', 'leftarm'], ['RightArmBase', 'rightarm'], ['LeftLegBase', 'leftleg'], ['RightLegBase', 'rightleg']];
async function buildClassicAtlas(body, warn) {
  const mesh = (n) => loadMesh(`rbxasset://avatar/compositing/Composit${n}.mesh`);
  const raw = (c, d = 0xa3a2a5) => (c ? new THREE.Color().setRGB(c.r, c.g, c.b, THREE.LinearSRGBColorSpace) : new THREE.Color(d));
  const layers = [];
  for (const [n, region] of COMPOSITE) layers.push({ geometry: await mesh(n), color: raw(body.colors[region]) });
  for (const [inst, url, n] of [[body.pants, body.pants?.props.pantstemplate, 'PantsTemplate'], [body.shirt, body.shirt?.props.shirttemplate, 'ShirtTemplate'], [body.graphic, body.graphic?.props.graphic, 'TShirt']]) {
    if (!url) continue;
    try {
      const map = await loadTexture(url, false);
      layers.push({ geometry: await mesh(n), map, color: raw(inst.props.color3 ?? inst.props.color, 0xffffff) });
    } catch (e) { warn(`${nameOf(inst)}: ${e.message}`); }
  }
  compositor ??= new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  compositor.outputColorSpace = THREE.LinearSRGBColorSpace;
  compositor.setSize(1024, 512, false);
  compositor.setClearColor(0xffffff, 1);
  const scene = new THREE.Scene();
  layers.forEach(({ geometry, map, color }, i) => {
    const m = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: map ?? null, color, transparent: !!map, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
    m.renderOrder = i;
    scene.add(m);
  });
  compositor.render(scene, new THREE.OrthographicCamera(0, 1024, 0, 512, -1000, 1000));
  const canvas = Object.assign(document.createElement('canvas'), { width: 1024, height: 512 });
  canvas.getContext('2d').drawImage(compositor.domElement, 0, 0);
  for (const m of scene.children) { m.material.map?.dispose(); m.material.dispose(); } // geometries are the shared mesh cache
  const atlas = textureFrom(canvas);
  atlas.flipY = false; // atlas row 0 = UV v 0
  return atlas;
}

export async function applyAppearance(mesh, a, warn) {
  if (!a) return;
  if (a.classic && mesh.userData.classicUv) {
    a.classic.atlas ??= buildClassicAtlas(a.classic, warn).catch((e) => { warn(`Classic R6 clothing: ${e.message}`); return null; });
    const atlas = await a.classic.atlas;
    if (atlas) { mesh.material.map = atlas; mesh.material.color.set(0xffffff); mesh.material.needsUpdate = true; return; }
  }
  const clothing = await clothingAtlas(a, warn);
  let overlay = null;
  const cm = a.characterMesh?.props, url = cm?.overlaytexturecontent || (cm?.overlaytextureid ? String(cm.overlaytextureid) : null);
  if (url) {
    try { overlay = await loadTexture(url); } catch (e) { warn(`${nameOf(a.characterMesh)}: ${e.message}`); }
  }
  if (!clothing && !overlay) return;
  if (clothing) mesh.geometry = clothingGeometry(mesh.geometry);
  const material = mesh.material;
  material.onBeforeCompile = (shader) => {
    const vertexDecl = (clothing ? 'attribute vec2 clothingUv; varying vec2 vClothingUv;\n' : '') + (overlay ? 'varying vec2 vBodyOverlayUv;\n' : '');
    const vertexSet = (clothing ? 'vClothingUv = clothingUv;\n' : '') + (overlay ? 'vBodyOverlayUv = uv;\n' : '');
    shader.vertexShader = vertexDecl + shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n' + vertexSet);
    let fragmentDecl = '', fragment = '';
    // Three uploads these sRGB textures as SRGB8_ALPHA8; sampling already returns linear RGB.
    if (clothing) {
      shader.uniforms.clothingMap = { value: clothing };
      fragmentDecl += 'uniform sampler2D clothingMap; varying vec2 vClothingUv;\n';
      fragment += 'vec4 clothes = texture2D(clothingMap, vClothingUv); diffuseColor.rgb = mix(diffuseColor.rgb, clothes.rgb, clothes.a);\n';
    }
    if (overlay) {
      shader.uniforms.bodyOverlayMap = { value: overlay };
      fragmentDecl += 'uniform sampler2D bodyOverlayMap; varying vec2 vBodyOverlayUv;\n';
      fragment += 'vec4 bodyOverlay = texture2D(bodyOverlayMap, vBodyOverlayUv); diffuseColor.rgb = mix(diffuseColor.rgb, bodyOverlay.rgb, bodyOverlay.a);\n';
    }
    shader.fragmentShader = fragmentDecl + shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + fragment);
  };
  material.customProgramCacheKey = () => `appearance:${!!clothing}:${!!overlay}`;
  material.userData.appearanceTextures = [clothing, overlay].filter(Boolean);
  material.needsUpdate = true;
}
