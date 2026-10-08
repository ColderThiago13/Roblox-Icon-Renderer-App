// Union (PartOperation) baked meshes: the CSGMDL blob in MeshData/MeshData2, inline or in the PartOperationAsset
// named by AssetId. Roblox doesn't document it; layouts follow the community readers (chteau/rbx-native, MIT;
// krakow10/rbx_mesh), checked against real v2/v4/v5 blobs.
// -> { positions: Float32Array, normals: Float32Array, colors: Uint8Array (RGBA), indices: Uint32Array }
// Positions are studs at the union's InitialSize.

const KEY = [0x56, 0x2e, 0x6e, 0x58, 0x31, 0x20, 0x30, 0x04, 0x34, 0x69, 0x0c, 0x77, 0x0c, 0x01, 0x5e, 0x00,
  0x1a, 0x60, 0x37, 0x69, 0x1d, 0x52, 0x2b, 0x07, 0x4f, 0x24, 0x59, 0x65, 0x53, 0x04, 0x7a];
const MAGIC = 'CSGMDL';
const isMagic = (b) => b.length >= 10 && String.fromCharCode(...b.subarray(0, 6)) === MAGIC;

// Versions 2 and 4 XOR the whole blob with the key; version 5 only its 10-byte magic + version.
function unscramble(bytes) {
  if (isMagic(bytes)) return bytes;
  const b = bytes.slice();
  for (let i = 0; i < Math.min(10, b.length); i++) b[i] ^= KEY[i % 31];
  if (!isMagic(b)) throw new Error('Not a union mesh');
  if (b[6] === 2 || b[6] === 4) for (let i = 10; i < b.length; i++) b[i] ^= KEY[i % 31];
  return b;
}

export function decodeCsgMesh(bytes) {
  const b = unscramble(bytes), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 10;
  const need = (n) => { if (o + n > b.length) throw new Error('Union mesh is truncated'); const at = o; o += n; return at; };
  const u8 = () => b[need(1)], u16 = () => dv.getUint16(need(2), true), u32 = () => dv.getUint32(need(4), true);
  const version = dv.getUint32(6, true);
  let positions, normals, colors, indices;

  if (version === 2 || version === 4) {
    need(32); // two digests
    const count = u32(), stride = u32();
    if (stride < 28) throw new Error(`Union mesh vertex stride ${stride}`);
    positions = new Float32Array(count * 3); normals = new Float32Array(count * 3); colors = new Uint8Array(count * 4);
    const base = need(count * stride);
    for (let i = 0; i < count; i++) {
      const v = base + i * stride;
      for (let k = 0; k < 3; k++) { positions[i * 3 + k] = dv.getFloat32(v + k * 4, true); normals[i * 3 + k] = dv.getFloat32(v + 12 + k * 4, true); }
      colors.set(b.subarray(v + 24, v + 28), i * 4);
    }
    const n = u32(), at = need(n * 4);
    indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = dv.getUint32(at + i * 4, true);
    if (version === 4) indices = firstLod(indices, Array.from({ length: u32() }, u32));
  } else if (version === 5) {
    const count = u16();
    const expect = () => { if (u16() !== count) throw new Error('Union mesh arrays disagree'); };
    const units = () => {
      expect();
      if (u32() !== count * 6) throw new Error('Union mesh arrays disagree');
      const at = need(count * 6), out = new Float32Array(count * 3);
      for (let i = 0; i < count * 3; i++) out[i] = (dv.getUint16(at + i * 2, true) - 32767) / 32767; // 0 = -1, 32767 = 0
      return out;
    };
    const pAt = need(count * 12);
    positions = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) positions[i] = dv.getFloat32(pAt + i * 4, true);
    normals = units();
    expect(); colors = b.slice(need(count * 4), o);
    expect(); need(count); // source face per vertex
    expect(); need(count * 8); // texture coordinates
    units(); // tangents
    const n = u32(), len = u32();
    let p = need(len), cur = 0;
    const end = p + len;
    // Each index is the previous plus a delta: a byte < 0x80 is a 7-bit two's-complement delta; otherwise it opens
    // a 3-byte big-endian word whose low 23 bits are the delta.
    indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      if (p >= end) throw new Error('Union mesh index stream is truncated');
      const c = b[p++];
      let d;
      if (c < 0x80) d = (c << 25) >> 25;
      else { if (p + 2 > end) throw new Error('Union mesh index stream is truncated'); d = ((((c & 0x7f) << 16) | (b[p] << 8) | b[p + 1]) << 9) >> 9; p += 2; }
      cur += d;
      indices[i] = cur;
    }
    indices = firstLod(indices, Array.from({ length: u8() }, u32));
  } else throw new Error(`Union mesh version ${version} is not supported`);

  const count = positions.length / 3;
  if (indices.length % 3 || indices.some((i) => i >= count)) throw new Error('Union mesh has bad triangles');
  return { positions, normals, colors, indices };
}

// LOD offsets into the indices: keep the finest level, between the first two.
function firstLod(indices, offsets) {
  return offsets.length >= 2 && offsets[1] <= indices.length && offsets[0] < offsets[1] ? indices.slice(offsets[0], offsets[1]) : indices;
}
