// Instance tree -> three.js scene graph plus VFX/light/highlight descriptors.
import * as THREE from 'three';
import { getAssetBytes, loadMesh, loadTexture, loadOverlayTexture, loadEmissiveTexture } from './assets.js';
import { walk, nameOf } from '../rbx/instance.js';
import { brickColor } from '../rbx/brickcolor.js';
import { collectAppearances, applyAppearance, classicLimbUrl, chamferedLimb } from './appearance.js';
import { parseModel } from '../rbx/model.js';
import { decodeCsgMesh } from '../rbx/csg.js';

const PART_CLASSES = new Set(['Part', 'MeshPart', 'WedgePart', 'CornerWedgePart', 'TrussPart', 'SpawnLocation', 'Seat', 'VehicleSeat', 'SkateboardPlatform', 'PartOperation', 'UnionOperation', 'NegateOperation', 'IntersectOperation', 'FlagStand']);
export const isPart = (inst) => PART_CLASSES.has(inst.className);

const MAT = { NEON: 288, GLASS: 1568, FORCEFIELD: 1584, SMOOTH: 272, PLASTIC: 256, ICE: 1536, GLACIER: 1552, FOIL: 1072 };
const METALS = new Set([1040, 1056, 1072, 1088]);

// Roblox base material textures, streamed by Roblox as ordinary image assets (create.roblox.com/docs/parts/materials,
// "Current Base"): Material enum -> [color, normal, metalness, roughness] asset ids, 0 = none. Plastic, SmoothPlastic,
// Neon and ForceField are built into the Roblox client and Glass is see-through, so those keep the flat look.
const BASE_MATERIALS = {
  1376: [9930003046, 9429449876, 0, 9429450346], // Asphalt
  788: [9920482056, 9438412214, 0, 9438412457], // Basalt
  848: [9920482813, 9438453152, 0, 9438453413], // Brick
  2304: [14108651729, 14108654002, 0, 14108654299], // Cardboard
  2305: [14108662587, 14108663154, 0, 14108663726], // Carpet
  2306: [17429425079, 17429425915, 17429426100, 17429426861], // CeramicTiles
  2307: [18147681935, 18147683410, 0, 18147684855], // ClayRoofTiles
  880: [9919718991, 9438457162, 0, 9438457470], // Cobblestone
  816: [9920484153, 9466554006, 0, 9466554186], // Concrete
  1040: [9920589327, 9439548484, 9439548749, 9439556441], // CorrodedMetal
  804: [9920484943, 9438508790, 0, 9438509046], // CrackedLava
  1056: [10237720195, 9438583222, 9438583347, 9438583558], // DiamondPlate
  1312: [9920517696, 9873280412, 0, 9873282563], // Fabric
  1072: [9466552117, 9424786192, 9424786272, 9424786620], // Foil
  1552: [9920518732, 9438812958, 0, 9438851286], // Glacier
  832: [9920550238, 9438882935, 0, 9438883109], // Granite
  1280: [9920551868, 9438955773, 0, 9438955997], // Grass
  1360: [9920554482, 9439043558, 0, 9439043765], // Ground
  1536: [9920555943, 9467301039, 0, 9467301203], // Ice
  1284: [9920557906, 9439080781, 0, 9439080950], // LeafyGrass
  2309: [14108670073, 14108670486, 0, 14108670748], // Leather
  820: [9920561437, 9439415191, 0, 9439415495], // Limestone
  784: [9439430596, 9439431240, 0, 9439431383], // Marble
  1088: [9920574687, 9873295432, 9873318201, 9873318890], // Metal
  1344: [9920578473, 9439509827, 0, 9439510012], // Mud
  836: [9920579943, 9439519281, 0, 9439519532], // Pavement
  864: [9920581082, 9439528644, 0, 9439537267], // Pebble
  2310: [14108671255, 14108671870, 0, 14108672378], // Plaster
  896: [9920587470, 9439538417, 0, 9439545859], // Rock
  2308: [119722544879522, 77534750680073, 0, 129397260312247], // RoofShingles
  2311: [14108673018, 14108674698, 14108674894, 14108675142], // Rubber
  1392: [9920590225, 9439565809, 0, 9439566688], // Salt
  1296: [9920591683, 9439577084, 0, 9439577327], // Sand
  912: [9920596120, 9439596530, 0, 9439596711], // Sandstone
  800: [9920599782, 9439612514, 0, 9439612733], // Slate
  1328: [9920620284, 9439632006, 0, 9439632145], // Snow
  512: [9920625290, 9439641376, 0, 9439648605], // Wood
  528: [9920626778, 9439650689, 0, 9439658127], // WoodPlanks
};
// ponytail: one tile size for every material (Roblox doesn't publish them); tune here if textures look too big/small.
const STUDS_PER_TILE = 8;

// Main axis (0 x, 1 y, 2 z) of vertex i's normal once the mesh is scaled.
const mainAxis = (n, i, scale) => {
  const a = [Math.abs(n.getX(i) / scale.x), Math.abs(n.getY(i) / scale.y), Math.abs(n.getZ(i) / scale.z)];
  return a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
};

// Base materials and surface studs tile in studs over every face whatever the mesh UVs: box-project each vertex
// along its normal's main axis. corner: count from the face's corner (unit shapes), so studs line up with the edges.
export function studUvGeometry(geo, scale, studsPerTile = STUDS_PER_TILE, corner = false) {
  const g = geo.clone(), p = g.attributes.position, n = g.attributes.normal, uv = new Float32Array(p.count * 2), o = corner ? 0.5 : 0;
  for (let i = 0; i < p.count; i++) {
    const x = (p.getX(i) + o) * scale.x, y = (p.getY(i) + o) * scale.y, z = (p.getZ(i) + o) * scale.z;
    const [u, v] = [[z, y], [x, z], [x, y]][mainAxis(n, i, scale)];
    uv[i * 2] = u / studsPerTile; uv[i * 2 + 1] = v / studsPerTile;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// urls: [color, normal, metalness, roughness] (asset ids or content URLs, falsy = none).
async function applyBaseMaterial(mesh, urls, warn, studsPerTile = STUDS_PER_TILE) {
  const material = mesh.material;
  const load = async (id, srgb) => {
    if (!id) return null;
    const tex = await loadTexture(String(id), srgb);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  };
  try {
    const [map, normalMap, metalnessMap, roughnessMap] = await Promise.all(urls.map((id, i) => load(id, i === 0)));
    mesh.geometry = studUvGeometry(mesh.geometry, mesh.scale, studsPerTile);
    Object.assign(material, { map, normalMap, roughnessMap, roughness: 1 }); // map is tinted by the part Color, as in Roblox
    if (metalnessMap) material.metalnessMap = metalnessMap; // scales makeMaterial's metalness: full metal reads near-black under the studio env
    material.needsUpdate = true;
  } catch (e) { warn(`Material texture: ${e.message}`); }
}

// Legacy surface types, drawn from Roblox's studs atlas (rbxasset://textures/studs.dds: 16 stacked tiles of 2×2
// studs). SurfaceType Glue 1, Weld 2, Studs 3, Inlet 4, Universal 5 -> atlas tile.
const STUD_TILE = { 1: 4, 2: 4, 3: 0, 4: 8, 5: 12 };
const FACE_SURFACES = [['rightsurface', 'leftsurface'], ['topsurface', 'bottomsurface'], ['backsurface', 'frontsurface']]; // [+axis, -axis]

export function studTiles(geo, scale, props) {
  const tiles = FACE_SURFACES.map((pair) => pair.map((k) => STUD_TILE[props[k]] ?? -1));
  if (tiles.flat().every((t) => t < 0)) return null;
  const g = studUvGeometry(geo, scale, 2, true), n = g.attributes.normal, tile = new Float32Array(n.count);
  for (let i = 0; i < n.count; i++) { const axis = mainAxis(n, i, scale); tile[i] = tiles[axis][n.getComponent(i, axis) >= 0 ? 0 : 1]; }
  g.setAttribute('studTile', new THREE.BufferAttribute(tile, 1));
  return g;
}

// The atlas is a detail map around mid-gray (0.5 = unchanged), multiplied into the part color.
async function applyStuds(mesh, props) {
  const g = studTiles(mesh.geometry, mesh.scale, props);
  if (!g) return;
  let atlas;
  try { atlas = await loadTexture('rbxasset://textures/studs.dds', false); } catch { return; } // needs a local Roblox install
  atlas.flipY = false;
  mesh.geometry = g;
  const m = mesh.material;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.studMap = { value: atlas };
    sh.vertexShader = 'attribute float studTile;\nvarying float vStudTile;\nvarying vec2 vStudUv;\n'
      + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvStudTile = studTile; vStudUv = uv;');
    sh.fragmentShader = 'uniform sampler2D studMap;\nvarying float vStudTile;\nvarying vec2 vStudUv;\n'
      + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  if (vStudTile >= 0.0) { // textureGrad: fract() would break mip selection at tile seams
    vec2 k = vec2(1.0, 1.0 / 16.0);
    diffuseColor.rgb *= 2.0 * textureGrad(studMap, vec2(fract(vStudUv.x), (vStudTile + fract(vStudUv.y)) / 16.0), dFdx(vStudUv) * k, dFdy(vStudUv) * k).rgb;
  }`);
  };
  m.customProgramCacheKey = () => 'studs';
  m.needsUpdate = true;
}

// Union shape: Roblox's baked mesh, inline or in the PartOperationAsset its AssetId names (shared per asset).
const unionCache = new Map();
const blobOf = (p) => [p?.meshdata2, p?.meshdata].find((b) => b instanceof Uint8Array && b.length);
function unionGeometry(inst) {
  const inline = blobOf(inst.props), key = inline ? null : inst.props.assetid;
  if (!inline && !key) return Promise.reject(new Error('no baked shape saved'));
  if (key && unionCache.has(key)) return unionCache.get(key);
  const p = (async () => {
    const blob = inline ?? blobOf(parseModel(await getAssetBytes(key)).roots[0]?.props);
    if (!blob) throw new Error('no baked shape saved');
    const m = decodeCsgMesh(blob), col = new THREE.Color(), rgb = new Float32Array((m.colors.length / 4) * 3);
    for (let i = 0; i < rgb.length / 3; i++) {
      col.setRGB(m.colors[i * 4] / 255, m.colors[i * 4 + 1] / 255, m.colors[i * 4 + 2] / 255, THREE.SRGBColorSpace);
      rgb.set([col.r, col.g, col.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.computeBoundingBox();
    return g;
  })();
  if (key) { unionCache.set(key, p); p.catch(() => unionCache.delete(key)); }
  return p;
}

export function cframeMatrix(cf) {
  const m = new THREE.Matrix4();
  if (!cf) return m;
  const [x, y, z] = cf.p, r = cf.r;
  return m.set(r[0], r[1], r[2], x, r[3], r[4], r[5], y, r[6], r[7], r[8], z, 0, 0, 0, 1);
}

const v3 = (v, d = 1) => (v ? new THREE.Vector3(v.x, v.y, v.z) : new THREE.Vector3(d, d, d));
export const color3 = (c, fallback = 0xa3a2a5) =>
  c ? new THREE.Color().setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace) : new THREE.Color(fallback);

export function partColor(inst) {
  return color3(inst.props.color3uint8 || inst.props.color || brickColor(inst.props.brickcolor));
}

// World matrix of a part or attachment/bone (attachments are relative to their parent part, or to the
// pivot of a parent Model). inst.anim holds an animated part CFrame (Matrix4) when an animation is posed.
export function worldMatrix(inst) {
  if (!inst) return new THREE.Matrix4();
  if (isPart(inst)) return inst.anim ? inst.anim.clone() : cframeMatrix(inst.props.cframe);
  if (inst.className === 'Attachment' || inst.className === 'Bone') {
    const local = cframeMatrix(inst.props.cframe);
    if (inst.boneT) local.multiply(inst.boneT); // animated Bone.Transform
    return inst.parent ? worldMatrix(inst.parent).multiply(local) : local;
  }
  if (inst.className === 'Model' || inst.className === 'Actor') {
    const pp = inst.props.primarypart;
    if (pp && isPart(pp)) return worldMatrix(pp).multiply(cframeMatrix(pp.props.pivotoffset));
    if (inst.props.worldpivotdata) return cframeMatrix(inst.props.worldpivotdata);
  }
  return inst.parent ? worldMatrix(inst.parent) : new THREE.Matrix4();
}

// ---------- unit geometries ----------
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitSphere = new THREE.SphereGeometry(0.5, 48, 24);
const unitCylinderY = new THREE.CylinderGeometry(0.5, 0.5, 1, 48);
const unitCylinderX = unitCylinderY.clone().rotateZ(Math.PI / 2);
// Classic head (SpecialMesh MeshType.Head): upright cylinder with rounded rims.
const unitHead = (() => {
  const rc = 0.2, pts = [new THREE.Vector2(0, -0.5)];
  for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + (i / 8) * Math.PI / 2; pts.push(new THREE.Vector2(0.5 - rc + Math.cos(a) * rc, -0.5 + rc + Math.sin(a) * rc)); }
  for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI / 2; pts.push(new THREE.Vector2(0.5 - rc + Math.cos(a) * rc, 0.5 - rc + Math.sin(a) * rc)); }
  pts.push(new THREE.Vector2(0, 0.5));
  return new THREE.LatheGeometry(pts, 48);
})();

function polyGeometry(verts, faces) {
  const pos = [];
  for (const f of faces) for (let i = 1; i + 1 < f.length; i++) pos.push(...verts[f[0]], ...verts[f[i]], ...verts[f[i + 1]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
// Wedge: full bottom and back (+Z), slope from top-back down to bottom-front.
const unitWedge = polyGeometry(
  [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]],
  [[0, 1, 2, 3], [3, 2, 5, 4], [0, 4, 5, 1], [0, 3, 4], [1, 5, 2]]);
// CornerWedge: square bottom, apex above the (+X, -Z) corner.
const unitCornerWedge = polyGeometry(
  [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5], [0.5, 0.5, -0.5]],
  [[0, 1, 2, 3], [0, 4, 1], [1, 4, 2], [2, 4, 3], [3, 4, 0]]);

function shapeGeometry(inst, size) {
  // returns [geometry, scale]
  if (inst.className === 'WedgePart') return [unitWedge, size];
  if (inst.className === 'CornerWedgePart') return [unitCornerWedge, size];
  if (inst.className === 'Part' || inst.className === 'SpawnLocation' || inst.className === 'Seat') {
    const shape = inst.props.shape ?? 1;
    if (shape === 0) { const d = Math.min(size.x, size.y, size.z); return [unitSphere, new THREE.Vector3(d, d, d)]; }
    if (shape === 2) { const d = Math.min(size.y, size.z); return [unitCylinderX, new THREE.Vector3(size.x, d, d)]; }
    if (shape === 3) return [unitWedge, size];
    if (shape === 4) return [unitCornerWedge, size];
  }
  return [unitBox, size];
}

// ---------- materials ----------
export function makeMaterial(inst, color) {
  const mat = inst.props.material ?? MAT.PLASTIC;
  const transparency = Math.min(1, Math.max(0, inst.props.transparency ?? 0));
  const reflectance = inst.props.reflectance ?? 0;
  let roughness = mat === MAT.SMOOTH ? 0.55 : mat === MAT.PLASTIC ? 0.7 : 0.85;
  let metalness = 0;
  if (METALS.has(mat)) { metalness = 0.85; roughness = mat === MAT.FOIL ? 0.2 : 0.35; }
  if (mat === MAT.ICE || mat === MAT.GLACIER) roughness = 0.15;
  if (mat === MAT.GLASS) roughness = 0.05;
  roughness *= 1 - reflectance * 0.8;
  metalness = Math.max(metalness, reflectance);

  // Non-metals get weaker reflections: grazing-angle Fresnel otherwise washes out top faces vs Roblox's look.
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity: metalness > 0.5 || mat === MAT.GLASS ? 1 : 0.5 });
  if (mat === MAT.NEON) {
    m.color.setScalar(0);
    m.emissive.copy(color);
    m.userData.neon = true; // emissiveIntensity set per render from settings
  }
  if (mat === MAT.FORCEFIELD) {
    m.transparent = true; m.blending = THREE.AdditiveBlending; m.depthWrite = false;
    m.emissive.copy(color); m.opacity = 0.6 * (1 - transparency); m.color.setScalar(0);
  } else if (transparency > 0 || mat === MAT.GLASS) {
    m.transparent = true;
    m.opacity = 1 - transparency;
    if (mat === MAT.GLASS) m.opacity = Math.min(m.opacity, 0.35 + 0.65 * (1 - transparency) ** 2);
    m.depthWrite = transparency < 0.5;
  }
  return m;
}

// Newer SurfaceAppearances keep maps in *Content properties, or only in TexturePack (an XML list of image ids).
export async function surfaceMaps(p, warn) {
  const maps = {
    color: p.colormapcontent || p.colormap, normal: p.normalmapcontent || p.normalmap,
    roughness: p.roughnessmapcontent || p.roughnessmap, metalness: p.metalnessmapcontent || p.metalnessmap,
    emissive: p.emissivemaskcontent,
  };
  if (p.texturepack) {
    try {
      const xml = new TextDecoder().decode(await getAssetBytes(p.texturepack));
      for (const [, k, id] of xml.matchAll(/<(color|normal|roughness|metalness|emissive)>\s*(\d+)\s*</g)) maps[k] ||= id;
    } catch (e) { warn(`TexturePack: ${e.message}`); }
  }
  return maps;
}

async function applySurfaceAppearance(material, sa, partCol, warn) {
  const p = sa.props;
  const maps = await surfaceMaps(p, warn);
  const tint = color3(p.color, 0xffffff);
  const load = async (url, srgb, slot) => {
    if (!url) return;
    try { material[slot] = await loadTexture(url, srgb); } catch (e) { warn(e.message); }
  };
  if (maps.color) {
    try {
      const overlay = (p.alphamode ?? 0) === 0;
      material.map = overlay ? await loadOverlayTexture(maps.color, partCol) : await loadTexture(maps.color);
      if (!overlay) { material.transparent = true; material.alphaTest = 0.02; }
      material.color.copy(tint);
    } catch (e) { warn(e.message); }
  }
  await Promise.all([
    load(maps.normal, false, 'normalMap'),
    load(maps.roughness, false, 'roughnessMap'),
    load(maps.metalness, false, 'metalnessMap'),
  ]);
  if (maps.emissive && (p.emissivestrength ?? 1) > 0) {
    try {
      material.emissiveMap = await loadEmissiveTexture(maps.emissive, maps.color);
      material.emissive.copy(color3(p.emissivetint, 0xffffff));
      material.userData.emissiveStrength = p.emissivestrength ?? 1; // intensity set per render with the neon setting
    } catch (e) { warn(e.message); }
  }
  if (material.roughnessMap) material.roughness = 1;
  if (material.metalnessMap) material.metalness = 1;
  material.needsUpdate = true;
}

// ---------- decals / textures ----------
const FACES = [
  // NormalId: Right, Top, Back, Left, Bottom, Front -> [normal axis, sign, plane rotation, width axis, height axis]
  { axis: 'x', sign: 1, rot: [0, Math.PI / 2, 0], w: 'z', h: 'y' },
  { axis: 'y', sign: 1, rot: [-Math.PI / 2, 0, 0], w: 'x', h: 'z' },
  { axis: 'z', sign: 1, rot: [0, 0, 0], w: 'x', h: 'y' },
  { axis: 'x', sign: -1, rot: [0, -Math.PI / 2, 0], w: 'z', h: 'y' },
  { axis: 'y', sign: -1, rot: [Math.PI / 2, 0, 0], w: 'x', h: 'z' },
  { axis: 'z', sign: -1, rot: [0, Math.PI, 0], w: 'x', h: 'y' },
];

// Decal on a mesh: Roblox projects it along the face normal onto the mesh surfaces facing that way,
// spanning the mesh bounds (so a face decal lands on a round head, not on the hidden part box).
export function projectedDecalGeometry(mesh, f) {
  mesh.updateMatrix();
  const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const pos = src.attributes.position, n = new THREE.Vector3();
  n[f.axis] = f.sign;
  const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(...f.rot));
  const uDir = new THREE.Vector3(1, 0, 0).applyQuaternion(rot), vDir = new THREE.Vector3(0, 1, 0).applyQuaternion(rot);
  const pts = [];
  for (let i = 0; i < pos.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrix));
  const span = (dir) => { let lo = Infinity, hi = -Infinity; for (const p of pts) { const d = p.dot(dir); lo = Math.min(lo, d); hi = Math.max(hi, d); } return [lo, hi - lo || 1]; };
  const [u0, uw] = span(uDir), [v0, vh] = span(vDir);
  const out = [], uv = [], e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const [a, b, c] = [pts[i], pts[i + 1], pts[i + 2]];
    if (e1.subVectors(b, a).cross(e2.subVectors(c, a)).normalize().dot(n) <= 0.05) continue;
    for (const p of [a, b, c]) { out.push(p.x, p.y, p.z); uv.push((p.dot(uDir) - u0) / uw, (p.dot(vDir) - v0) / vh); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return { geometry: g, w: uw, h: vh };
}

async function buildDecal(dec, size, warn, target) {
  const url = dec.props.texture || dec.props.colormapcontent;
  if (!url) return null;
  let tex;
  try { tex = await loadTexture(url); } catch (e) { warn(`${nameOf(dec)}: ${e.message}`); return null; }
  const f = FACES[dec.props.face ?? 5] || FACES[5];
  const projected = target && target.geometry !== unitBox ? projectedDecalGeometry(target, f) : null;
  const w = projected?.w ?? size[f.w], h = projected?.h ?? size[f.h];
  const transparency = dec.props.transparency ?? 0;
  if (dec.className === 'Texture') {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const su = dec.props.studspertileu || 2, sv = dec.props.studspertilev || 2;
    tex.repeat.set(w / su, h / sv);
    tex.offset.set((dec.props.offsetstudsu ?? 0) / su, -(dec.props.offsetstudsv ?? 0) / sv);
  }
  const mat = new THREE.MeshStandardMaterial({
    map: tex, color: color3(dec.props.color3, 0xffffff), transparent: true, opacity: 1 - transparency,
    roughness: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const plane = new THREE.Mesh(projected?.geometry ?? new THREE.PlaneGeometry(w, h), mat);
  if (!projected) {
    plane.rotation.set(...f.rot);
    plane.position[f.axis] = f.sign * (size[f.axis] / 2 + 0.002);
  }
  plane.renderOrder = 1 + (dec.props.zindex ?? 1);
  return plane;
}

// ---------- parts ----------
async function buildPart(inst, ctx) {
  const size = v3(inst.props.size, 1);
  const group = new THREE.Group();
  group.name = nameOf(inst);
  group.matrixAutoUpdate = false;
  group.matrix.copy(cframeMatrix(inst.props.cframe));

  const transparency = inst.props.transparency ?? 0;
  const appearance = ctx.appearances.get(inst);
  const col = appearance?.color ? color3(appearance.color) : partColor(inst);
  const material = makeMaterial(inst, col);
  const kids = inst.children;
  const special = kids.find((c) => c.className === 'SpecialMesh' || c.className === 'BlockMesh' || c.className === 'CylinderMesh');
  const sa = kids.find((c) => c.className === 'SurfaceAppearance');

  let mesh;
  const cm = appearance?.characterMesh?.props;
  const characterMeshUrl = cm?.meshcontent || (cm?.meshid ? String(cm.meshid) : null);
  if (appearance?.classic) {
    let geo;
    try { geo = await loadMesh(classicLimbUrl(group.name)); }
    catch (e) { ctx.warn(`Classic R6 body: ${e.message}; using an approximation`); geo = chamferedLimb(group.name); }
    geo.computeBoundingBox();
    const ext = geo.boundingBox.getSize(new THREE.Vector3());
    mesh = new THREE.Mesh(geo, material);
    mesh.scale.set(size.x / ext.x, size.y / ext.y, size.z / ext.z);
    mesh.userData.classicUv = !geo.userData.approx;
  } else if (characterMeshUrl) {
    try {
      const geo = await loadMesh(characterMeshUrl);
      geo.computeBoundingBox();
      const extent = geo.boundingBox.getSize(new THREE.Vector3()), center = geo.boundingBox.getCenter(new THREE.Vector3());
      mesh = new THREE.Mesh(geo, material);
      mesh.scale.set(size.x / (extent.x || 1), size.y / (extent.y || 1), size.z / (extent.z || 1));
      mesh.position.copy(center.multiply(mesh.scale).negate());
    } catch (e) { ctx.warn(`${group.name}: ${e.message}`); mesh = new THREE.Mesh(unitBox, material); mesh.scale.copy(size); }
  } else if (inst.className === 'MeshPart' && (inst.props.meshid || inst.props.meshcontent)) {
    const url = inst.props.meshid || inst.props.meshcontent;
    try {
      const geo = await loadMesh(url);
      geo.computeBoundingBox();
      const bb = geo.boundingBox, bsize = bb.getSize(new THREE.Vector3()), center = bb.getCenter(new THREE.Vector3());
      const scale = new THREE.Vector3(size.x / (bsize.x || 1), size.y / (bsize.y || 1), size.z / (bsize.z || 1));
      mesh = new THREE.Mesh(geo, material);
      mesh.scale.copy(scale);
      mesh.position.copy(center.multiply(scale).negate());
      if (geo.userData.skin) ctx.skinned.push({ part: inst, mesh });
    } catch (e) {
      ctx.warn(`${group.name}: ${e.message}`);
      mesh = new THREE.Mesh(unitBox, material); mesh.scale.copy(size);
    }
    const tex = inst.props.textureid || inst.props.texturecontent;
    if (tex && !sa) {
      try { material.map = await loadOverlayTexture(tex, col); material.color.set(0xffffff); material.needsUpdate = true; }
      catch (e) { ctx.warn(`${group.name}: ${e.message}`); }
    }
  } else if (special) {
    const p = special.props;
    const scale = v3(p.scale, 1), offset = v3(p.offset, 0);
    const type = special.className === 'BlockMesh' ? 6 : special.className === 'CylinderMesh' ? 4 : p.meshtype ?? 6;
    let geo = unitBox, geoScale = size.clone().multiply(scale);
    if (type === 5) {
      try { geo = await loadMesh(p.meshid); geoScale = scale; } catch (e) { ctx.warn(`${group.name}: ${e.message}`); }
    } else if (type === 0) {
      // Head keeps a round cross-section: a default 2x1x1 head is a 1.25-stud cylinder, not an oval.
      // Roblox's own head mesh when installed, else a close stand-in.
      const d = Math.min(size.x, size.z);
      geo = await loadMesh('rbxasset://avatar/heads/head.mesh').catch(() => unitHead);
      geo.computeBoundingBox();
      const ext = geo.boundingBox.getSize(new THREE.Vector3());
      geoScale = new THREE.Vector3(d / ext.x, size.y / ext.y, d / ext.z).multiply(scale);
    } else if (type === 3) geo = unitSphere;
    else if (type === 4) geo = unitCylinderY;
    else if (type === 2) geo = unitWedge;
    else if (type === 11) geo = unitCornerWedge;
    mesh = new THREE.Mesh(geo, material);
    mesh.scale.copy(geoScale);
    mesh.position.copy(offset);
    if (p.textureid) {
      // VertexColor is a Vector3 tint, not a Color3.
      const vc = p.vertexcolor && { r: p.vertexcolor.x, g: p.vertexcolor.y, b: p.vertexcolor.z };
      try { material.map = await loadTexture(p.textureid); material.color.copy(color3(vc, 0xffffff)); material.needsUpdate = true; }
      catch (e) { ctx.warn(`${group.name}: ${e.message}`); }
    }
  } else if (inst.className.endsWith('Operation')) {
    try {
      const geo = await unionGeometry(inst), init = v3(inst.props.initialsize, 0);
      const ref = init.x > 0 && init.y > 0 && init.z > 0 ? init : geo.boundingBox.getSize(new THREE.Vector3());
      mesh = new THREE.Mesh(geo, material);
      mesh.scale.copy(size).divide(ref);
      // UsePartColor off: each piece keeps the color it was unioned with.
      if (!inst.props.usepartcolor) { material.vertexColors = true; material.color.set(0xffffff); }
    } catch (e) {
      ctx.warn(`${group.name}: union shape unavailable (${e.message}); drawn as its bounding box`);
      mesh = new THREE.Mesh(unitBox, material); mesh.scale.copy(size);
    }
  } else {
    const [geo, s] = shapeGeometry(inst, size);
    mesh = new THREE.Mesh(geo, material);
    mesh.scale.copy(s);
  }

  const base = cm?.basetexturecontent || (cm?.basetextureid ? String(cm.basetextureid) : null);
  if (base) {
    try { material.map = await loadOverlayTexture(base, col); material.color.set(0xffffff); }
    catch (e) { ctx.warn(`${group.name}: ${e.message}`); }
  }
  if (sa) await applySurfaceAppearance(material, sa, col, ctx.warn);
  await applyAppearance(mesh, appearance, ctx.warn);
  // A zero-thickness axis would zero the lighting normals (renders black), and thin parts / flat meshes
  // (cards, leaves, blades) should show from both sides, as they do in Studio. DoubleSided meshes too.
  mesh.scale.set(...mesh.scale.toArray().map((v) => (Math.abs(v) < 1e-4 ? 1e-4 : v)));
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const ext = mesh.geometry.boundingBox.getSize(new THREE.Vector3()).multiply(mesh.scale).toArray().map(Math.abs);
  if (inst.props.doublesided || Math.min(...ext) < 0.02 * Math.max(...ext)) material.side = THREE.DoubleSide;
  if (transparency >= 1) mesh.visible = false;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.userData.inst = inst;
  group.add(mesh);

  for (const dec of kids.filter((c) => c.className === 'Decal' || c.className === 'Texture')) {
    const plane = await buildDecal(dec, size, ctx.warn, mesh);
    if (plane) group.add(plane);
  }
  // After the decals: they project onto the shared unit box, which these swap for a tiled-UV copy.
  if (!material.map && !sa && !special && !appearance) {
    // A MaterialVariant saved in the file wins; otherwise (or when it's missing, as in Roblox) the base material.
    const vName = inst.props.materialvariantserialized || inst.props.materialvariant, variant = vName && ctx.variants.get(vName);
    const baseIds = BASE_MATERIALS[inst.props.material];
    if (variant && (variant.props.basematerial ?? inst.props.material) === inst.props.material) {
      const m = await surfaceMaps(variant.props, ctx.warn);
      if (m.color || m.normal) await applyBaseMaterial(mesh, [m.color, m.normal, m.metalness, m.roughness], ctx.warn, variant.props.studspertile || 10);
    } else if (baseIds) await applyBaseMaterial(mesh, baseIds, ctx.warn);
    else if (mesh.geometry === unitBox || mesh.geometry === unitWedge || mesh.geometry === unitCornerWedge) await applyStuds(mesh, inst.props);
  }
  ctx.partObjects.set(inst, group);
  return group;
}

// ---------- entry ----------
export async function buildScene(tree, warn) {
  const root = new THREE.Group();
  const variants = new Map([...walk(tree.roots)].filter((i) => i.className === 'MaterialVariant').map((i) => [nameOf(i), i]));
  const ctx = { warn, partObjects: new Map(), skinned: [], appearances: collectAppearances(tree), variants };
  const vfx = [], trails = [], lights = [], highlights = [];
  const jobs = [];

  for (const inst of walk(tree.roots)) {
    const cls = inst.className;
    if (isPart(inst)) jobs.push(buildPart(inst, ctx).then((g) => root.add(g)));
    else if (cls === 'ParticleEmitter' || cls === 'Beam' || cls === 'Trail' || cls === 'Fire' || cls === 'Smoke' || cls === 'Sparkles') {
      if (cls === 'Trail') trails.push(inst);
      else vfx.push(inst);
    } else if (cls === 'PointLight' || cls === 'SpotLight' || cls === 'SurfaceLight') lights.push(inst);
    else if (cls === 'Highlight') highlights.push(inst);
    else if (cls === 'WrapLayer') warn(`${nameOf(inst)}: layered clothing cage deformation is not supported; rendering the saved mesh`);
  }
  await Promise.all(jobs);
  root.updateMatrixWorld(true);
  const hls = highlights.map((h) => resolveHighlight(h, ctx)).filter(Boolean);
  return { root, vfx, trails, lights: lights.map(buildLight).filter(Boolean), highlights: hls, hlGroup: highlightGroup(hls), partObjects: ctx.partObjects, skinned: ctx.skinned };
}

const NORMALS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];

function buildLight(inst) {
  const p = inst.props;
  if (p.enabled === false) return null;
  const color = color3(p.color, 0xffffff);
  const m = worldMatrix(inst.parent);
  const pos = new THREE.Vector3().setFromMatrixPosition(m);
  const range = p.range ?? 8, brightness = p.brightness ?? 1;
  let light;
  if (inst.className === 'PointLight') light = new THREE.PointLight(color, brightness * 6, range * 1.5, 1.5);
  else {
    const angle = inst.className === 'SpotLight' ? p.angle ?? 90 : 120;
    light = new THREE.SpotLight(color, brightness * 10, range * 1.5, THREE.MathUtils.degToRad(Math.min(angle, 179) / 2), 0.4, 1.5);
    const dir = new THREE.Vector3(...NORMALS[p.face ?? 5]).transformDirection(m);
    light.add(light.target);
    light.target.position.copy(dir); // local to the light
  }
  light.position.copy(pos);
  light.userData = { base: light.intensity, shadows: !!p.shadows };
  return light;
}

function resolveHighlight(inst, ctx) {
  const p = inst.props;
  if (p.enabled === false) return null;
  const adornee = p.adornee || inst.parent;
  if (!adornee) return null;
  const meshes = [];
  const collect = (i) => { const g = ctx.partObjects.get(i); if (g) g.traverse((o) => o.isMesh && meshes.push(o)); i.children.forEach(collect); };
  collect(adornee);
  if (!meshes.length) return null;
  return {
    meshes,
    fillColor: color3(p.fillcolor, 0xff0000), fillOpacity: 1 - (p.filltransparency ?? 0.5),
    outlineColor: color3(p.outlinecolor, 0xffffff), outlineOpacity: 1 - (p.outlinetransparency ?? 0),
    alwaysOnTop: (p.depthmode ?? 0) === 0,
  };
}

// Fill overlays (drawn in 3D) and white masks (for the 2D outline) for each Highlight.
function highlightGroup(hls) {
  if (!hls.length) return null;
  const group = new THREE.Group();
  for (const hl of hls) {
    const fill = new THREE.MeshBasicMaterial({ color: hl.fillColor, transparent: true, opacity: hl.fillOpacity, depthTest: !hl.alwaysOnTop, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false });
    hl.maskGroup = new THREE.Group();
    for (const m of hl.meshes) {
      if (!m.visible) continue;
      for (const [mat, layer, parent] of [[fill, 4, group], [white, 5, hl.maskGroup]]) {
        if (layer === 4 && hl.fillOpacity <= 0) continue;
        const c = new THREE.Mesh(m.geometry, mat);
        c.matrixAutoUpdate = false;
        c.matrix.copy(m.matrixWorld);
        c.userData.src = m; // re-synced when an animation moves the part
        c.layers.set(layer);
        parent.add(c);
      }
    }
    group.add(hl.maskGroup);
  }
  return group;
}
