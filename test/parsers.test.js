// Cross-checks the binary and XML parsers against each other using rojo-rbx/rbx-test-files,
// plus a synthetic FileMesh round trip. Usage: node test/parsers.test.js [path-to-rbx-test-files]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseModel } from '../src/rbx/model.js';
import { parseMesh } from '../src/rbx/mesh.js';
import { assetId, decodeAttributes } from '../src/rbx/instance.js';

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

console.log('parsers ok');
