import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { parseMesh, lod0 } from '../rbx/mesh.js';
import { assetId } from '../rbx/instance.js';

const bytesCache = new Map();
const imageCache = new Map();
const meshCache = new Map();
const draco = new DRACOLoader().setDecoderPath('node_modules/three/examples/jsm/libs/draco/');

export function getAssetBytes(url) {
  const id = assetId(url);
  if (!id) return Promise.reject(new Error(`Unsupported content URL "${url}"`));
  if (!bytesCache.has(id)) {
    const p = window.native.getAsset(id).then((b) => new Uint8Array(b), (e) => {
      throw new Error(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    });
    p.catch(() => bytesCache.delete(id)); // allow retry after the user sets credentials
    bytesCache.set(id, p);
  }
  return bytesCache.get(id);
}

export function clearMemoryCache() { bytesCache.clear(); imageCache.clear(); meshCache.clear(); }

// -> HTMLImageElement (decoded) or rejects
export function loadImage(url) {
  if (!imageCache.has(url)) {
    imageCache.set(url, getAssetBytes(url).then(async (bytes) => {
      const img = new Image();
      img.src = URL.createObjectURL(new Blob([bytes]));
      await img.decode();
      return img;
    }));
  }
  return imageCache.get(url);
}

export function textureFrom(source, srgb = true) {
  const tex = source instanceof HTMLCanvasElement ? new THREE.CanvasTexture(source) : new THREE.Texture(source);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export async function loadTexture(url, srgb = true) {
  return textureFrom(await loadImage(url), srgb);
}

// Texture drawn over a solid color: Roblox shows the part Color through transparent texture pixels.
export async function loadOverlayTexture(url, color) {
  const img = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.fillStyle = '#' + color.getHexString(THREE.SRGBColorSpace);
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0);
  return textureFrom(c);
}

function decodeDraco(bytes, uniqueIds) {
  const ids = uniqueIds ? { position: 0, normal: 1, uv: 2 } : { position: 'POSITION', normal: 'NORMAL', uv: 'TEX_COORD' };
  const types = { position: 'Float32Array', normal: 'Float32Array', uv: 'Float32Array' };
  return new Promise((resolve, reject) => {
    const cfg = { attributeIDs: ids, attributeTypes: types, useUniqueIDs: uniqueIds, vertexColorSpace: THREE.LinearSRGBColorSpace };
    draco.decodeGeometry(bytes.slice().buffer, cfg).then(resolve, reject);
  });
}

function geometryFromMesh(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  if (m.colors) g.setAttribute('color', new THREE.BufferAttribute(m.colors, 4));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  if (m.skin) g.userData.skin = m.skin;
  return g;
}

async function meshFromBytes(bytes) {
  const m = parseMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (!m.draco) return geometryFromMesh(m);
  // Roblox tags attributes by unique id (0 position, 1 normal as GENERIC, 2 uv); fall back to semantic types.
  let g;
  try { g = await decodeDraco(m.draco, true); if (!g.attributes.position) throw new Error('no position'); }
  catch { g = await decodeDraco(m.draco, false); }
  const uv = g.attributes.uv;
  if (uv) for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  // ponytail: assumes Draco keeps face order so LOD offsets still apply; if holes appear, drop the truncation.
  if (g.index) {
    const faces = lod0(m.lods, g.index.count / 3);
    if (faces * 3 < g.index.count) g.setIndex(new THREE.BufferAttribute(g.index.array.slice(0, faces * 3), 1));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (m.skin && m.skin.joints.length === g.attributes.position.count * 4) g.userData.skin = m.skin;
  return g;
}

// -> BufferGeometry (shared, do not dispose per use)
export function loadMesh(url) {
  if (!meshCache.has(url)) {
    const p = getAssetBytes(url).then(meshFromBytes);
    p.catch(() => meshCache.delete(url));
    meshCache.set(url, p);
  }
  return meshCache.get(url);
}
