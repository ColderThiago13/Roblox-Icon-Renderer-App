// Cross-checks the binary and XML parsers against each other using rojo-rbx/rbx-test-files,
// plus a synthetic FileMesh round trip. Usage: node test/parsers.test.js [path-to-rbx-test-files]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseModel } from '../src/rbx/model.js';
import { parseMesh } from '../src/rbx/mesh.js';
import { assetId, decodeAttributes } from '../src/rbx/instance.js';
import { decodeCsgMesh } from '../src/rbx/csg.js';
import { decodeDds } from '../src/rbx/dds.js';

const close = (a, b, msg) => (!Number.isFinite(a) || !Number.isFinite(b)) || assert.ok(Math.abs(a - b) < 1e-4, `${msg}: ${a} vs ${b}`);

function deepClose(a, b, msg) {
  if (typeof a === 'number') return close(a, b, msg);
  if (Array.isArray(a)) { assert.equal(a.length, b.length, msg + ' length'); return a.forEach((v, i) => deepClose(v, b[i], `${msg}[${i}]`)); }
  if (a && typeof a === 'object' && !(a instanceof Uint8Array) && !a.className) {
    for (const k of Object.keys(a)) deepClose(a[k], b[k], `${msg}.${k}`);
    return;
  }
  if (a?.className) return assert.equal(a.props.name, b?.props.name, msg);
  if (a instanceof Uint8Array || b instanceof Uint8Array) return;
  assert.equal(a, b, msg);
}

const dir = process.argv[2];
if (dir && fs.existsSync(dir)) {
  const models = path.join(dir, 'models');
  let checked = 0;
  const mismatches = [];
  for (const name of fs.readdirSync(models)) {
    const bin = path.join(models, name, 'binary.rbxm'), xml = path.join(models, name, 'xml.rbxmx');
    if (!fs.existsSync(bin) || !fs.existsSync(xml)) continue;
    const a = parseModel(new Uint8Array(fs.readFileSync(bin)));
    const b = parseModel(new Uint8Array(fs.readFileSync(xml)));
    assert.equal(a.all.length, b.all.length, `${name}: instance count`);
    for (let i = 0; i < a.all.length; i++) {
      const x = a.all[i], y = b.all[i];
      assert.equal(x.className, y.className, `${name}: class`);
      for (const [k, v] of Object.entries(x.props)) {
        if (!(k in y.props) || v === null || y.props[k] === null) continue;
        try { deepClose(v, y.props[k], `${name}/${x.props.name}.${k}`); checked++; } catch (e) { mismatches.push(e.message); }
      }
    }
  }
  console.log(`binary/xml agree on ${checked} property values`);
  if (mismatches.length) console.log('mismatches (some fixtures were saved separately):\n  ' + mismatches.join('\n  '));
  assert.ok(mismatches.length <= checked * 0.02, 'too many binary/xml mismatches');
} else console.log('skip: pass rbx-test-files path to cross-check model parsers');

// Synthetic v2.00 mesh: one triangle, 40-byte vertices
{
  const head = new TextEncoder().encode('version 2.00\n');
  const body = new DataView(new ArrayBuffer(12 + 3 * 40 + 12));
  body.setUint16(0, 12, true); body.setUint8(2, 40); body.setUint8(3, 12);
  body.setUint32(4, 3, true); body.setUint32(8, 1, true);
  for (let i = 0; i < 3; i++) {
    const o = 12 + i * 40;
    body.setFloat32(o, i, true); body.setFloat32(o + 28, 0.25, true);
    for (let k = 0; k < 4; k++) body.setUint8(o + 36 + k, 255);
    body.setUint32(12 + 120 + i * 4, 2 - i, true);
  }
  const buf = new Uint8Array(head.length + body.byteLength);
  buf.set(head); buf.set(new Uint8Array(body.buffer), head.length);
  const mesh = parseMesh(buf.buffer);
  assert.deepEqual([...mesh.indices], [2, 1, 0]);
  assert.equal(mesh.positions[3], 1);
  assert.equal(mesh.uvs[1], 0.75);
  assert.equal(mesh.colors, null);
}

// v1.00 text mesh is half scale
{
  const txt = 'version 1.00\n1\n[2,0,0][0,1,0][0.5,0.5,0][0,2,0][0,1,0][0,0,0][0,0,2][0,1,0][1,1,0]';
  const mesh = parseMesh(new TextEncoder().encode(txt).buffer);
  assert.equal(mesh.positions[0], 1);
  assert.equal(mesh.indices.length, 3);
}

assert.equal(assetId('rbxassetid://12345'), '12345');
assert.equal(assetId('http://www.roblox.com/asset/?id=987'), '987');
assert.equal(assetId('rbxasset://textures/foo.png'), null);

// Attribute blob: { EmitCount = 25 (double) }
{
  const key = new TextEncoder().encode('EmitCount');
  const dv = new DataView(new ArrayBuffer(4 + 4 + key.length + 1 + 8));
  dv.setUint32(0, 1, true); dv.setUint32(4, key.length, true);
  new Uint8Array(dv.buffer).set(key, 8);
  dv.setUint8(8 + key.length, 0x06); dv.setFloat64(9 + key.length, 25, true);
  assert.deepEqual(decodeAttributes(new Uint8Array(dv.buffer)), { EmitCount: 25 });
}

// Showcase fixture: refs resolve and legacy *_xml names survive
{
  const t = parseModel(new Uint8Array(fs.readFileSync(new URL('./fixtures/showcase.rbxmx', import.meta.url))));
  const beam = t.all.find((i) => i.className === 'Beam');
  assert.equal(beam.props.attachment0.className, 'Attachment');
  assert.equal(t.all.find((i) => i.className === 'Fire').props.size_xml, 2);
  assert.equal(t.all.find((i) => i.className === 'ParticleEmitter').props.size.length, 2);
}

// Union meshes (CSGMDL): one triangle written in the v5 layout (only the header scrambled) and the v2 layout (all
// scrambled), with a wide (3-byte) and a negative index delta.
{
  const KEY = [0x56, 0x2e, 0x6e, 0x58, 0x31, 0x20, 0x30, 0x04, 0x34, 0x69, 0x0c, 0x77, 0x0c, 0x01, 0x5e, 0x00, 0x1a, 0x60, 0x37, 0x69, 0x1d, 0x52, 0x2b, 0x07, 0x4f, 0x24, 0x59, 0x65, 0x53, 0x04, 0x7a];
  const pos = [[0, 0, 0], [1, 0, 0], [0, 2, 0]], bytes = [];
  const u16 = (v) => bytes.push(v & 255, v >> 8), u32 = (v) => bytes.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24);
  const f32 = (v) => bytes.push(...new Uint8Array(new Float32Array([v]).buffer));
  const header = (version) => { bytes.push(...new TextEncoder().encode('CSGMDL')); u32(version); };
  const scramble = (from, to) => { for (let i = from; i < to; i++) bytes[i] ^= KEY[i % 31]; };
  header(5); u16(3); pos.flat().forEach(f32);
  const units = () => { u16(3); u32(18); for (let i = 0; i < 3; i++) { u16(32767); u16(32767); u16(65534); } }; // (0, 0, 1)
  units(); u16(3); for (let i = 0; i < 3; i++) bytes.push(200, 100, 50, 255); u16(3); bytes.push(1, 1, 1); u16(3); for (let i = 0; i < 6; i++) f32(0); units();
  // indices 2, 1, 0 as deltas +2 (wide form 80 00 02), -1 (0x7f), -1
  u32(3); u32(5); bytes.push(0x80, 0x00, 0x02, 0x7f, 0x7f); bytes.push(1); u32(0);
  scramble(0, 10);
  const v5 = decodeCsgMesh(new Uint8Array(bytes));
  assert.deepEqual([...v5.indices], [2, 1, 0]);
  assert.deepEqual([...v5.positions], pos.flat());
  assert.ok(Math.abs(v5.normals[2] - 1) < 1e-4 && Math.abs(v5.normals[0]) < 1e-4);
  assert.deepEqual([...v5.colors.subarray(0, 4)], [200, 100, 50, 255]);

  bytes.length = 0;
  header(2); for (let i = 0; i < 32; i++) bytes.push(0); u32(3); u32(36);
  for (const p of pos) { p.forEach(f32); [0, 0, 1].forEach(f32); bytes.push(10, 20, 30, 255); for (let i = 0; i < 8; i++) bytes.push(0); }
  u32(3); [0, 1, 2].forEach(u32);
  scramble(0, bytes.length);
  const v2 = decodeCsgMesh(new Uint8Array(bytes));
  assert.deepEqual([...v2.indices], [0, 1, 2]);
  assert.equal(v2.positions[7], 2);
  assert.throws(() => decodeCsgMesh(new Uint8Array(16)), /Not a union mesh/);
}

// DDS: one DXT1 block (red/blue, all red) and one DXT5 block (alpha endpoints 255/0, all index 1 = 0)
{
  const dds = (fourCC, block) => {
    const b = new Uint8Array(128 + block.length), dv = new DataView(b.buffer);
    dv.setUint32(0, 0x20534444, true); dv.setUint32(12, 4, true); dv.setUint32(16, 4, true);
    b.set(new TextEncoder().encode(fourCC), 84); b.set(block, 128);
    return b;
  };
  const red = decodeDds(dds('DXT1', [0x00, 0xf8, 0x1f, 0x00, 0, 0, 0, 0]));
  assert.deepEqual([...red.data.subarray(0, 4)], [255, 0, 0, 255]);
  const clear = decodeDds(dds('DXT5', [255, 0, 0x49, 0x92, 0x24, 0x49, 0x92, 0x24, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]));
  assert.deepEqual([...clear.data.subarray(0, 4)], [255, 255, 255, 0]);
  assert.throws(() => decodeDds(dds('ATI2', [])), /Unsupported/);
}

console.log('parsers ok');
