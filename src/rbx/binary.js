// Roblox binary model format (.rbxm/.rbxl) reader.
// Spec: https://dom.rojo.space/binary.html
// Only property types the renderer needs are decoded; other PROP chunks are skipped.
import { decompress as zstdDecompress } from 'fzstd';
import { makeInstance, finalizeTree, decodeAttributes } from './instance.js';

const utf8 = new TextDecoder();
const f32 = new DataView(new ArrayBuffer(4));

function lz4Block(src, outLen) {
  const dst = new Uint8Array(outLen);
  let i = 0, o = 0;
  while (i < src.length) {
    const tok = src[i++];
    let lit = tok >> 4;
    if (lit === 15) { let b; do { b = src[i++]; lit += b; } while (b === 255); }
    dst.set(src.subarray(i, i + lit), o); i += lit; o += lit;
    if (i >= src.length) break;
    const off = src[i] | (src[i + 1] << 8); i += 2;
    let len = tok & 15;
    if (len === 15) { let b; do { b = src[i++]; len += b; } while (b === 255); }
    len += 4;
    for (let k = 0; k < len; k++, o++) dst[o] = dst[o - off];
  }
  return dst;
}

class Reader {
  constructor(bytes) { this.b = bytes; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.p = 0; }
  get left() { return this.b.length - this.p; }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  rawString() { return this.bytes(this.u32()); }
  string() { return utf8.decode(this.rawString()); }

  // Byte-interleaved big-endian u32 words.
  words(count) {
    const out = new Uint32Array(count), b = this.b, p = this.p;
    for (let i = 0; i < count; i++)
      out[i] = ((b[p + i] << 24) | (b[p + count + i] << 16) | (b[p + 2 * count + i] << 8) | b[p + 3 * count + i]) >>> 0;
    this.p += count * 4;
    return out;
  }
  ints(count) { return Array.from(this.words(count), (u) => (u >>> 1) ^ -(u & 1)); }
  floats(count) {
    return Array.from(this.words(count), (u) => { f32.setUint32(0, (u >>> 1) | ((u & 1) << 31)); return f32.getFloat32(0); });
  }
  refs(count) {
    const raw = this.ints(count);
    for (let i = 1; i < count; i++) raw[i] += raw[i - 1];
    return raw;
  }
}

function rotationFromId(id) {
  const N = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const o = id - 1, c0 = N[Math.floor(o / 6)], c1 = N[o % 6];
  const c2 = [c0[1] * c1[2] - c0[2] * c1[1], c0[2] * c1[0] - c0[0] * c1[2], c0[0] * c1[1] - c0[1] * c1[0]];
  // columns are the basis vectors; stored row-major R00..R22
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]].map((v) => v + 0);
}

function readValues(r, type, n, name, sstr) {
  switch (type) {
    case 0x01: { const out = []; for (let i = 0; i < n; i++) { const raw = r.rawString(); out.push(name === 'attributesserialize' ? raw.slice() : utf8.decode(raw)); } return out; }
    case 0x02: return Array.from(r.bytes(n), (v) => v !== 0);
    case 0x03: return r.ints(n);
    case 0x04: return r.floats(n);
    case 0x05: { const out = []; for (let i = 0; i < n; i++) out.push(r.f64()); return out; }
    case 0x0b: case 0x12: return Array.from(r.words(n));
    case 0x0c: { const R = r.floats(n), G = r.floats(n), B = r.floats(n); return R.map((v, i) => ({ r: v, g: G[i], b: B[i] })); }
    case 0x0d: { const X = r.floats(n), Y = r.floats(n); return X.map((v, i) => ({ x: v, y: Y[i] })); }
    case 0x0e: { const X = r.floats(n), Y = r.floats(n), Z = r.floats(n); return X.map((v, i) => ({ x: v, y: Y[i], z: Z[i] })); }
    case 0x10: {
      const rots = [];
      for (let i = 0; i < n; i++) {
        const id = r.u8();
        if (id === 0) { const m = []; for (let k = 0; k < 9; k++) m.push(r.f32()); rots.push(m); } else rots.push(rotationFromId(id));
      }
      const X = r.floats(n), Y = r.floats(n), Z = r.floats(n);
      return rots.map((m, i) => ({ p: [X[i], Y[i], Z[i]], r: m }));
    }
    case 0x13: return r.refs(n).map((v) => ({ ref: v }));
    case 0x15: {
      const out = [];
      for (let i = 0; i < n; i++) { const k = r.u32(), seq = []; for (let j = 0; j < k; j++) seq.push({ t: r.f32(), v: r.f32(), e: r.f32() }); out.push(seq); }
      return out;
    }
    case 0x16: {
      const out = [];
      for (let i = 0; i < n; i++) { const k = r.u32(), seq = []; for (let j = 0; j < k; j++) { const t = r.f32(), c = { r: r.f32(), g: r.f32(), b: r.f32() }; r.f32(); seq.push({ t, c }); } out.push(seq); }
      return out;
    }
    case 0x17: { const out = []; for (let i = 0; i < n; i++) out.push({ min: r.f32(), max: r.f32() }); return out; }
    case 0x1a: { const R = r.bytes(n), G = r.bytes(n), B = r.bytes(n); return Array.from(R, (v, i) => ({ r: v / 255, g: G[i] / 255, b: B[i] / 255 })); }
    case 0x1b: { // int64: 8-byte interleaved, big-endian, zigzag
      const b = r.b, p = r.p, out = [];
      for (let i = 0; i < n; i++) {
        let v = 0n;
        for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(b[p + k * n + i]);
        out.push(Number((v >> 1n) ^ -(v & 1n)));
      }
      r.p += 8 * n;
      return out;
    }
    case 0x1c: return Array.from(r.words(n), (i) => sstr[i]);
    case 0x1e: { // OptionalCoordinateFrame: 0x10 + CFrame array, 0x02 + bool array
      r.u8(); const cfs = readValues(r, 0x10, n); r.u8();
      const has = r.bytes(n);
      return cfs.map((cf, i) => (has[i] ? cf : null));
    }
    case 0x22: { // Content
      const kinds = Array.from(r.bytes(n));
      const uris = []; const uc = r.u32(); for (let i = 0; i < uc; i++) uris.push(r.string());
      let u = 0;
      return kinds.map((k) => (k === 1 ? uris[u++] : null));
    }
    default: return null;
  }
}

export function parseBinary(bytes) {
  const r = new Reader(bytes);
  if (utf8.decode(r.bytes(8)) !== '<roblox!') throw new Error('Not a binary Roblox file');
  r.bytes(6); r.u16(); r.i32(); r.i32(); r.bytes(8);

  const classes = new Map();   // classId -> { name, refs }
  const byRef = new Map();     // referent -> instance
  const sstr = [];
  const parents = [];

  while (r.left >= 16) {
    const name = utf8.decode(r.bytes(4)).replace(/\0+$/, '');
    const clen = r.u32(), ulen = r.u32(); r.u32();
    let data;
    if (clen === 0) data = r.bytes(ulen);
    else {
      const comp = r.bytes(clen);
      data = comp[0] === 0x28 && comp[1] === 0xb5 && comp[2] === 0x2f && comp[3] === 0xfd ? zstdDecompress(comp) : lz4Block(comp, ulen);
    }
    if (name === 'END') break;
    const c = new Reader(data);
    if (name === 'SSTR') {
      c.u32(); const n = c.u32();
      for (let i = 0; i < n; i++) { c.bytes(16); sstr.push(c.rawString().slice()); }
    } else if (name === 'INST') {
      const id = c.u32(), cls = c.string(); c.u8(); const n = c.u32();
      const refs = c.refs(n);
      classes.set(id, { name: cls, refs });
      for (const ref of refs) byRef.set(ref, makeInstance(cls, ref));
    } else if (name === 'PROP') {
      const cls = classes.get(c.u32());
      const prop = c.string().toLowerCase(), type = c.u8();
      if (!cls) continue;
      let vals;
      try { vals = readValues(c, type, cls.refs.length, prop, sstr); } catch { vals = null; }
      if (!vals) continue;
      cls.refs.forEach((ref, i) => { byRef.get(ref).props[prop] = vals[i]; });
    } else if (name === 'PRNT') {
      c.u8(); const n = c.u32();
      const kids = c.refs(n), pars = c.refs(n);
      for (let i = 0; i < n; i++) parents.push([kids[i], pars[i]]);
    }
  }

  for (const inst of byRef.values()) {
    for (const [k, v] of Object.entries(inst.props)) if (v && typeof v === 'object' && 'ref' in v) inst.props[k] = byRef.get(v.ref) || null;
    if (inst.props.attributesserialize) inst.attributes = decodeAttributes(inst.props.attributesserialize);
  }
  const roots = [];
  for (const [kid, par] of parents) {
    const k = byRef.get(kid), p = byRef.get(par);
    if (!k) continue;
    if (p) { k.parent = p; p.children.push(k); } else roots.push(k);
  }
  return finalizeTree(roots);
}
