// Roblox FileMesh reader, versions 1.00 - 7.00.
// Spec: https://devforum.roblox.com/t/roblox-filemesh-format-specification/326114
// Returns LOD0 only: { positions, normals, uvs, colors|null, indices } or { draco, lod0Faces } for v7.

const ascii = new TextDecoder('latin1');

function fromVerts(dv, off, numVerts, vsize, faceOff, faces) {
  const positions = new Float32Array(numVerts * 3), normals = new Float32Array(numVerts * 3), uvs = new Float32Array(numVerts * 2);
  const colors = vsize >= 40 ? new Float32Array(numVerts * 4) : null;
  let allWhite = true;
  for (let i = 0; i < numVerts; i++) {
    const o = off + i * vsize;
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = dv.getFloat32(o + k * 4, true);
      normals[i * 3 + k] = dv.getFloat32(o + 12 + k * 4, true);
    }
    uvs[i * 2] = dv.getFloat32(o + 24, true);
    uvs[i * 2 + 1] = 1 - dv.getFloat32(o + 28, true);
    if (colors) for (let k = 0; k < 4; k++) { const c = dv.getUint8(o + 36 + k); colors[i * 4 + k] = c / 255; if (c !== 255) allWhite = false; }
  }
  const indices = new Uint32Array(faces * 3);
  for (let i = 0; i < faces * 3; i++) indices[i] = dv.getUint32(faceOff + i * 4, true);
  return { positions, normals, uvs, colors: allWhite ? null : colors, indices };
}

// Skin weights: per vertex 4 subset-local bone indices + 4 byte weights; subsets map to global mesh bones.
// -> { names: [boneName...], joints: Uint16Array(n*4) global bone index, weights: Float32Array(n*4) }
function readSkin(dv, skinOff, numVerts, bonesOff, numBones, namesOff, namesSize, subsetsOff, numSubsets) {
  const td = new TextDecoder();
  const nameAt = (i) => { const start = namesOff + i; let end = start; while (end < namesOff + namesSize && dv.getUint8(end) !== 0) end++; return td.decode(new Uint8Array(dv.buffer, dv.byteOffset + start, end - start)); };
  const names = [];
  for (let b = 0; b < numBones; b++) names.push(nameAt(dv.getUint32(bonesOff + b * 60, true)));
  const subsets = [];
  for (let k = 0; k < numSubsets; k++) {
    const o = subsetsOff + k * 72;
    subsets.push({ vb: dv.getUint32(o + 8, true), vl: dv.getUint32(o + 12, true), bones: Array.from({ length: 26 }, (_, j) => dv.getUint16(o + 20 + j * 2, true)) });
  }
  const joints = new Uint16Array(numVerts * 4), weights = new Float32Array(numVerts * 4);
  let s = subsets[0];
  for (let v = 0; v < numVerts; v++) {
    if (!s || v < s.vb || v >= s.vb + s.vl) s = subsets.find((x) => v >= x.vb && v < x.vb + x.vl);
    for (let k = 0; k < 4; k++) {
      const local = dv.getUint8(skinOff + v * 8 + k), w = dv.getUint8(skinOff + v * 8 + 4 + k) / 255;
      const g = s ? s.bones[local] : 0xffff;
      if (g === 0xffff || g >= numBones) continue;
      joints[v * 4 + k] = g; weights[v * 4 + k] = w;
    }
  }
  return { names, joints, weights };
}

function lod0(lods, faces) {
  return lods && lods.length > 1 && lods[1] > 0 && lods[1] <= faces ? lods[1] : faces;
}

function parseV1(text, version) {
  const lines = text.split(/\r?\n/);
  const faces = parseInt(lines[1], 10);
  const v = (lines[2].match(/-?[\d.]+(?:e[-+]?\d+)?/gi) || []).map(Number);
  const n = faces * 3, scale = version === '1.00' ? 0.5 : 1;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), uvs = new Float32Array(n * 2), indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    for (let k = 0; k < 3; k++) { positions[i * 3 + k] = v[o + k] * scale; normals[i * 3 + k] = v[o + 3 + k]; }
    uvs[i * 2] = v[o + 6]; uvs[i * 2 + 1] = v[o + 7];
    indices[i] = i;
  }
  return { positions, normals, uvs, colors: null, indices };
}

export function parseMesh(buffer) {
  const bytes = new Uint8Array(buffer);
  const header = ascii.decode(bytes.subarray(0, 12));
  const m = header.match(/^version (\d\.\d\d)/);
  if (!m) throw new Error('Unknown mesh header: ' + JSON.stringify(header));
  const version = m[1];
  if (version.startsWith('1.')) return parseV1(ascii.decode(bytes), version);

  const nl = bytes.indexOf(10);
  const start = nl + 1;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = version[0];

  if (major === '2' || major === '3') {
    const hsize = dv.getUint16(start, true), vsize = dv.getUint8(start + 2);
    const numLods = major === '3' ? dv.getUint16(start + 6, true) : 0;
    const numVerts = dv.getUint32(start + (major === '3' ? 8 : 4), true);
    const numFaces = dv.getUint32(start + (major === '3' ? 12 : 8), true);
    const vOff = start + hsize, fOff = vOff + numVerts * vsize, lOff = fOff + numFaces * 12;
    const lods = []; for (let i = 0; i < numLods; i++) lods.push(dv.getUint32(lOff + i * 4, true));
    return fromVerts(dv, vOff, numVerts, vsize, fOff, lod0(lods, numFaces));
  }

  if (major === '4' || major === '5') {
    const hsize = dv.getUint16(start, true);
    const numVerts = dv.getUint32(start + 4, true), numFaces = dv.getUint32(start + 8, true);
    const numLods = dv.getUint16(start + 12, true), numBones = dv.getUint16(start + 14, true);
    const vOff = start + hsize;
    // vertex size isn't in the header; 40 is standard since v4
    const vsize = 40;
    const fOff = vOff + numVerts * vsize + (numBones > 0 ? numVerts * 8 : 0);
    const lOff = fOff + numFaces * 12;
    const lods = []; for (let i = 0; i < numLods; i++) lods.push(dv.getUint32(lOff + i * 4, true));
    const mesh = fromVerts(dv, vOff, numVerts, vsize, fOff, lod0(lods, numFaces));
    if (numBones > 0) {
      const namesSize = dv.getUint32(start + 16, true), numSubsets = dv.getUint16(start + 20, true);
      const bOff = lOff + numLods * 4, nOff = bOff + numBones * 60;
      mesh.skin = readSkin(dv, vOff + numVerts * vsize, numVerts, bOff, numBones, nOff, namesSize, nOff + namesSize, numSubsets);
    }
    return mesh;
  }

  if (major === '6' || major === '7') {
    let p = start, core = null, lods = null, skin = null;
    while (p + 16 <= bytes.length) {
      const type = ascii.decode(bytes.subarray(p, p + 8)).replace(/\0+$/, '');
      const ver = dv.getUint32(p + 8, true), size = dv.getUint32(p + 12, true);
      const d = p + 16;
      if (type === 'COREMESH') core = { ver, d, size };
      else if (type === 'LODS') {
        const n = dv.getUint32(d + 3, true);
        lods = []; for (let i = 0; i < n; i++) lods.push(dv.getUint32(d + 7 + i * 4, true));
      }
      else if (type === 'SKINNING') {
        const n = dv.getUint32(d, true), sOff = d + 4;
        const bCountOff = sOff + n * 8, numBones = dv.getUint32(bCountOff, true), bOff = bCountOff + 4;
        const nSizeOff = bOff + numBones * 60, namesSize = dv.getUint32(nSizeOff, true), nOff = nSizeOff + 4;
        const subCountOff = nOff + namesSize;
        if (numBones > 0) skin = readSkin(dv, sOff, n, bOff, numBones, nOff, namesSize, subCountOff + 4, dv.getUint32(subCountOff, true));
      }
      p = d + size;
    }
    if (!core) throw new Error('Mesh has no COREMESH chunk');
    if (core.ver === 2) {
      const len = dv.getUint32(core.d, true);
      return { draco: bytes.slice(core.d + 4, core.d + 4 + len), lods, skin };
    }
    const numVerts = dv.getUint32(core.d, true);
    let vsize = 40;
    if (numVerts > 0) {
      const facesAt = (vs) => core.d + 4 + numVerts * vs;
      const fits = (vs) => facesAt(vs) + 4 <= core.d + core.size && facesAt(vs) + 4 + dv.getUint32(facesAt(vs), true) * 12 === core.d + core.size;
      vsize = fits(40) ? 40 : 36;
    }
    const fOff = core.d + 4 + numVerts * vsize;
    const numFaces = dv.getUint32(fOff, true);
    const mesh = fromVerts(dv, core.d + 4, numVerts, vsize, fOff + 4, lod0(lods, numFaces));
    if (skin && skin.joints.length === numVerts * 4) mesh.skin = skin;
    return mesh;
  }
  throw new Error('Unsupported mesh version ' + version);
}

export { lod0 };
