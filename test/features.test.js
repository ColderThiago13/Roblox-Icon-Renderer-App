// Post-effect settings, export encoders, LUTs, scenes, avatars and stage helpers. Usage: node test/features.test.js
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { defaultSettings, withDefaults, patchSettings, cameraAt, randomLook, withoutPost, SCHEMA } from '../src/settings.js';
import { assembleApng, pngChunks, crc32, assembleWebp, riffChunks, webpDurations, trimImage, fileNameFrom, accumulate, resolveAccumulated, EXPORT_PRESETS } from '../src/ui/animexport.js';
import { parseCube, cubeToStrip, imageToStrip } from '../src/render/lut.js';
import { layoutOffsets, treeBounds, compositeTree, sceneFile, toB64, fromB64 } from '../src/scene/composite.js';
import { buildAvatarTree } from '../src/scene/avatar.js';
import { buildRig } from '../src/scene/anim.js';
import { motionMatrix, motionFramePoints, pedestalPoints } from '../src/render/stage.js';
import { makeInstance, walk, nameOf, renderTree } from '../src/rbx/instance.js';
import { parseModel } from '../src/rbx/model.js';
import { cframeMatrix } from '../src/scene/build.js';

// ---------- settings: list layers, camera keys, random looks, before/after ----------
{
  const s = defaultSettings();
  assert.deepEqual([s.strokes, s.camKeys], [[], []]);
  const notes = patchSettings(s, { strokes: [{ color: '#FF0000', width: 6 }, { width: 99, bogus: 1 }], camKeys: [{ t: 0, yaw: 170 }, { t: 2, yaw: -170, zoom: 2 }] });
  assert.deepEqual(notes, ['strokes[1].width clamped to 40', 'unknown setting strokes[1].bogus']);
  assert.equal(s.strokes[0].color, '#ff0000');
  assert.notEqual(s.strokes[0].id, s.strokes[1].id);
  const back = withDefaults(JSON.parse(JSON.stringify(s)));
  assert.equal(back.strokes.length, 2); assert.equal(back.camKeys[1].zoom, 2);
  assert.equal(cameraAt([], 1), null);
  assert.equal(cameraAt(s.camKeys, 1).yaw, -180, 'yaw eases the short way round');
  assert.equal(cameraAt(s.camKeys, -5).yaw, 170); assert.equal(cameraAt(s.camKeys, 9).zoom, 2);
  assert.ok(Math.abs(cameraAt(s.camKeys, 1).zoom - 1.5) < 1e-9, 'halfway between keys');
  for (let i = 0; i < 20; i++) {
    const r = randomLook(), t = defaultSettings();
    assert.deepEqual(patchSettings(t, r), [], 'random looks fit the schema');
  }
  const off = withoutPost({ ...defaultSettings(), strokes: [{ width: 3 }], outline: { enabled: true, thickness: 3 } });
  assert.equal(off.outline.enabled, false); assert.deepEqual(off.strokes, []); assert.equal(off.outline.thickness, 3);
  assert.equal(patchSettings(defaultSettings(), { lighting: { hdri: '../evil.hdr' } })[0], 'ignored lighting.hdri: expected hdri');
  assert.deepEqual(patchSettings(defaultSettings(), { lighting: { hdri: '0123456789abcdef.exr' }, background: { mode: 'sunburst' }, frame: { style: 'mythic' } }), []);
  assert.ok(SCHEMA.every((sec) => new Set(sec.fields.map((f) => f.key)).size === sec.fields.length), 'no duplicate keys');
}

// ---------- APNG / animated WebP ----------
{
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), Buffer.from(data)]), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = (idat) => new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...idat.map((d) => chunk('IDAT', d)), chunk('IEND', [])]));
  assert.equal(crc32(new TextEncoder().encode('IEND')), 0xae426082);
  const apng = assembleApng([png([[1, 2]]), png([[3], [4, 5]]), png([[6]])], 24, true), cs = pngChunks(apng);
  assert.deepEqual(cs.map((c) => c.type), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
  const dv = (c) => new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
  assert.equal(dv(cs[1]).getUint32(0), 3); assert.equal(dv(cs[1]).getUint32(4), 0, 'loops forever');
  const seqs = cs.filter((c) => c.type === 'fcTL' || c.type === 'fdAT').map((c) => dv(c).getUint32(0));
  assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5], 'one sequence across fcTL and fdAT');
  assert.equal(dv(cs[2]).getUint16(20), 1); assert.equal(dv(cs[2]).getUint16(22), 24, 'delay is exactly 1/fps');
  assert.deepEqual([...cs[5].data.subarray(4)], [3]);
  // every chunk's CRC is right
  for (let p = 8; p < apng.length;) { const len = new DataView(apng.buffer).getUint32(p); assert.equal(new DataView(apng.buffer).getUint32(p + 8 + len), crc32(apng.subarray(p + 4, p + 8 + len))); p += 12 + len; }

  const riff = (chunks) => { const body = Buffer.concat(chunks.map(([t, d]) => { const h = Buffer.alloc(8); h.write(t, 0); h.writeUInt32LE(d.length, 4); return Buffer.concat([h, Buffer.from(d), Buffer.alloc(d.length & 1)]); })); const head = Buffer.alloc(12); head.write('RIFF'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8); return new Uint8Array(Buffer.concat([head, body])); };
  const a = riff([['VP8X', new Array(10).fill(0)], ['ALPH', [1, 2, 3]], ['VP8 ', [9, 9]]]), b = riff([['VP8L', [7, 7, 7, 7]]]);
  const webp = assembleWebp([a, b], 30, false, 4, 3), top = riffChunks(webp);
  assert.equal(new TextDecoder().decode(webp.subarray(8, 12)), 'WEBP');
  assert.equal(new DataView(webp.buffer).getUint32(4, true), webp.length - 8);
  assert.deepEqual(top.map((c) => c.type), ['VP8X', 'ANIM', 'ANMF', 'ANMF']);
  assert.equal(top[0].raw[8], 0x12, 'animation + alpha flags');
  assert.equal(top[1].raw[12], 1, 'plays once');
  const frame = top[2].raw.subarray(8), le24 = (o) => frame[o] | (frame[o + 1] << 8) | (frame[o + 2] << 16);
  assert.deepEqual([le24(6) + 1, le24(9) + 1, le24(12)], [4, 3, 33]);
  assert.deepEqual(riffChunks(new Uint8Array([...new Array(12).fill(0), ...frame.subarray(16)])).map((c) => c.type), ['ALPH', 'VP8 '], 'frame keeps only image chunks');
  assert.equal(webpDurations(30, 30).reduce((x, y) => x + y), 1000, 'durations add up');
}

// ---------- still export helpers ----------
{
  const img = { width: 6, height: 5, data: new Uint8ClampedArray(6 * 5 * 4) };
  img.data[(2 * 6 + 3) * 4 + 3] = 255; img.data[(3 * 6 + 4) * 4 + 3] = 10;
  const t = trimImage(img, 2);
  assert.deepEqual([t.width, t.height], [6, 6]);
  assert.equal(t.data[(2 * 6 + 2) * 4 + 3], 255);
  const empty = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  assert.equal(trimImage(empty, 3), empty, 'nothing to trim');
  assert.equal(fileNameFrom('{name}_{size}', { name: 'Sword', size: 512 }), 'Sword_512');
  assert.equal(fileNameFrom('{name}_{profile}', { name: 'Sword', profile: '' }), 'Sword');
  assert.equal(fileNameFrom('{name}/{x}', { name: 'a:b' }), 'a_b_{x}');
  assert.equal(fileNameFrom('', { name: 'X' }), 'X');
  const acc = new Float32Array(4);
  accumulate(acc, [255, 0, 0, 255]); accumulate(acc, [0, 0, 255, 0]);
  assert.deepEqual([...resolveAccumulated(acc, 2, new Uint8ClampedArray(4))], [255, 0, 0, 128], 'transparent samples don\'t darken the color');
  assert.ok(Object.values(EXPORT_PRESETS).every((p) => p.size && p.aspect && ['png'].includes(p.format) && ['none', 'circle', 'rounded'].includes(p.mask)));
}

// ---------- LUTs ----------
{
  const cube = 'TITLE "t"\nLUT_3D_SIZE 2\n# red fastest\n' + [0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`))).join('\n');
  const lut = parseCube(cube), strip = cubeToStrip(lut);
  assert.equal(lut.size, 2);
  assert.deepEqual([strip.width, strip.height], [4, 2]);
  assert.deepEqual([...strip.data.subarray(0, 4)], [255, 255, 255, 255], '(0,0,0) -> white');
  assert.deepEqual([...strip.data.subarray(((1 * 4) + 2 + 1) * 4, ((1 * 4) + 2 + 1) * 4 + 4)], [0, 0, 0, 255], '(1,1,1) at (b·2+r, g) -> black');
  assert.throws(() => parseCube('LUT_3D_SIZE 3\n0 0 0'), /3D \.cube/);
  // a 4×2 tiled square (size 2 = 8 px in 2 tiles of 2×2) becomes the same strip
  const tiled = { width: 4, height: 2, data: strip.data };
  assert.equal(imageToStrip(tiled).width, 4, 'already a strip');
  const sq = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) }; // 4³ in 2×2 tiles of 4×4
  sq.data[((4 + 1) * 8 + 4 + 2) * 4] = 200; // tile b=3 (x 4, y 4), r=2, g=1
  const fromSq = imageToStrip(sq);
  assert.deepEqual([fromSq.width, fromSq.height, fromSq.size], [16, 4, 4]);
  assert.equal(fromSq.data[(1 * 16 + 3 * 4 + 2) * 4], 200);
  assert.throws(() => imageToStrip({ width: 5, height: 3, data: new Uint8ClampedArray(60) }), /layout/);
}

// ---------- scenes ----------
{
  const xml = (name, x) => new TextEncoder().encode(`<roblox version="4"><Item class="Model" referent="M"><Properties><string name="Name">${name}</string></Properties>
    <Item class="Part" referent="P"><Properties><string name="Name">Block</string><Vector3 name="size"><X>2</X><Y>4</Y><Z>2</Z></Vector3>
    <CoordinateFrame name="CFrame"><X>${x}</X><Y>10</Y><Z>5</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame></Properties></Item></Item></roblox>`);
  const b = treeBounds(parseModel(xml('A', 3)).roots);
  assert.deepEqual(b, { lo: [2, 8, 4], hi: [4, 12, 6] });
  const offs = layoutOffsets([b, b, b], 'row', 0.5);
  const xs = offs.map((o) => o[0] + 3);
  assert.deepEqual(xs, [-3, 0, 3], 'side by side with a gap, centered');
  assert.ok(offs.every((o) => o[1] === -8 && o[2] === -5), 'on the floor, centered in depth');
  const arc = layoutOffsets([b, b, b], 'arc', 0.5);
  assert.ok(arc[0][2] > arc[1][2] && Math.abs(arc[0][2] - arc[2][2]) < 1e-9, 'arc: middle in front');
  assert.equal(new Set(layoutOffsets([b, b, b, b], 'grid').map((o) => o.join())).size, 4);
  const file = sceneFile([{ name: 'A.rbxmx', bytes: xml('A', 3) }, { name: 'B.rbxmx', bytes: xml('B', 50), path: [0, 0], disabled: [] }]);
  const scene = JSON.parse(new TextDecoder().decode(file));
  assert.deepEqual(fromB64(scene.members[0].data), xml('A', 3));
  assert.equal(toB64(new Uint8Array([255, 0, 1])), '/wAB');
  const roots = scene.members.map((m) => renderTree(parseModel(fromB64(m.data)), m.path, m.disabled).roots);
  const tree = compositeTree(roots, scene.layout), parts = tree.all.filter((i) => i.className === 'Part');
  assert.equal(tree.roots.length, 2);
  assert.equal(parts[0].props.cframe.p[1], 2, 'feet on y = 0');
  assert.ok(Math.abs(parts[0].props.cframe.p[0] + parts[1].props.cframe.p[0]) < 1e-9, 'symmetric around x = 0');
}

// ---------- avatars ----------
{
  const cfXml = (n, x, y, z) => `<CoordinateFrame name="${n}"><X>${x}</X><Y>${y}</Y><Z>${z}</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>`;
  const assets = {
    1: `<roblox version="4"><Item class="Accessory" referent="A"><Properties><string name="Name">Cap</string></Properties><Item class="Part" referent="H"><Properties><string name="Name">Handle</string>${cfXml('CFrame', 50, 50, 50)}<Vector3 name="size"><X>1</X><Y>1</Y><Z>1</Z></Vector3></Properties>
      <Item class="Attachment" referent="T"><Properties><string name="Name">HatAttachment</string>${cfXml('CFrame', 0, -0.3, 0)}</Properties></Item></Item></Item></roblox>`,
    2: `<roblox version="4"><Item class="Shirt" referent="S"><Properties><string name="Name">Shirt</string><Content name="ShirtTemplate"><url>rbxassetid://99</url></Content></Properties></Item></roblox>`,
    3: `<roblox version="4"><Item class="Decal" referent="F"><Properties><string name="Name">face</string><Content name="Texture"><url>rbxassetid://77</url></Content></Properties></Item></roblox>`,
    4: `<roblox version="4"><Item class="Folder" referent="R"><Properties><string name="Name">R6</string></Properties><Item class="CharacterMesh" referent="C"><Properties><string name="Name">Arm</string><int name="BodyPart">3</int></Properties></Item></Item></roblox>`,
  };
  const warnings = [];
  const tree = await buildAvatarTree({ username: 'Tester', avatar: {
    bodyColor3s: { headColor3: 'FF0000', torsoColor3: '00FF00' },
    assets: [{ id: 1, name: 'Cap', assetType: { id: 8 } }, { id: 2, name: 'Shirt', assetType: { id: 11 } }, { id: 3, name: 'Smile', assetType: { id: 18 } },
      { id: 4, name: 'Arm', assetType: { id: 28 } }, { id: 5, name: 'Jacket', assetType: { id: 67 } }, { id: 6, name: 'Gear', assetType: { id: 19 } }, { id: 7, name: 'Broken', assetType: { id: 41 } }],
  } }, (w) => warnings.push(w), async (id) => { if (!assets[id]) throw new Error('download failed'); return new TextEncoder().encode(assets[id]); });
  const all = [...walk(tree.roots)], by = (n) => all.find((i) => nameOf(i) === n);
  assert.equal(nameOf(tree.roots[0]), 'Tester');
  assert.deepEqual(by('Body Colors').props.headcolor3, { r: 1, g: 0, b: 0 });
  assert.equal(by('Shirt').parent, tree.roots[0]);
  assert.equal(by('face').props.texture, 'rbxassetid://77', 'face replaced');
  assert.equal(by('Head').children.filter((c) => c.className === 'Decal').length, 1);
  assert.equal(all.filter((i) => i.className === 'CharacterMesh').length, 1, 'R6 package mesh');
  const handle = by('Handle');
  assert.deepEqual(handle.props.cframe.p, [0, 4.5 + 0.6 + 0.3, 0], 'hat sits on the HatAttachment');
  assert.ok(handle.children.some((c) => c.className === 'Weld' && c.props.part0 === by('Head')), 'welded to the head');
  assert.ok(warnings.some((w) => /Jacket \(layered clothing\)/.test(w)) && warnings.some((w) => /Broken: download failed/.test(w)), warnings.join('; '));
  assert.ok(!warnings.some((w) => /Gear/.test(w)), 'gear is simply left out');
  // Joints put every limb where the parts are: a rig built from them keeps the standard pose.
  for (const j of all.filter((i) => i.className === 'Motor6D')) {
    const p1 = cframeMatrix(j.props.part0.props.cframe).multiply(cframeMatrix(j.props.c0)).multiply(cframeMatrix(j.props.c1).invert());
    assert.ok(new THREE.Vector3().setFromMatrixPosition(p1).distanceTo(new THREE.Vector3(...j.props.part1.props.cframe.p)) < 1e-9, nameOf(j));
  }
  assert.ok(buildRig(tree, new Map(), []), 'animatable rig');
  const anims = (t) => [...walk(t.roots)].filter((i) => i.className === 'Animation').map((i) => `${nameOf(i)}=${i.props.animationid.match(/\d+/)[0]}`);
  assert.deepEqual(anims(tree).slice(0, 4), ['Idle A=180435571', 'Idle B=180435792', 'Walk=180426354', 'Jump=125750702'], 'R6 default animations without a Roblox install (walk = run)');

  // R15: Roblox's default rig, a torso package (the folder for the body type), a dynamic head, a hat on the moved head.
  const item = (cls, ref, name, body = '', kids = '') => `<Item class="${cls}" referent="${ref}"><Properties><string name="Name">${name}</string>${body}</Properties>${kids}</Item>`;
  const att = (ref, name, y) => item('Attachment', ref, name, cfXml('CFrame', 0, y, 0));
  const part = (cls, ref, name, y, kids) => item(cls, ref, name, cfXml('CFrame', 0, y, 0) + '<Vector3 name="size"><X>2</X><Y>1</Y><Z>1</Z></Vector3>', kids);
  const motor = (ref, name, p0, p1) => item('Motor6D', ref, name, `<Ref name="Part0">${p0}</Ref><Ref name="Part1">${p1}</Ref>`);
  const rig = `<roblox version="4">${item('Model', 'M', 'Player', '', item('Humanoid', 'Hu', 'Humanoid')
    + part('Part', 'HRP', 'HumanoidRootPart', 3, att('a1', 'RootRigAttachment', -0.5))
    + part('MeshPart', 'LT', 'LowerTorso', 2.5, att('a2', 'RootRigAttachment', 0) + att('a3', 'WaistRigAttachment', 0.2) + motor('m1', 'Root', 'HRP', 'LT'))
    + part('MeshPart', 'UT', 'UpperTorso', 3.5, att('a4', 'WaistRigAttachment', -0.8) + att('a5', 'NeckRigAttachment', 0.8) + motor('m2', 'Waist', 'LT', 'UT'))
    + part('Part', 'HD', 'Head', 4.8, att('a6', 'NeckRigAttachment', -0.5) + att('a7', 'HatAttachment', 0.6) + item('SpecialMesh', 'sm', 'Mesh')
      + item('Decal', 'fc', 'face') + motor('m3', 'Neck', 'UT', 'HD')))}</roblox>`;
  const torso = (folder, h) => item('Folder', folder, folder, '', part('MeshPart', folder + 'p', 'UpperTorso', 0, att(folder + 'w', 'WaistRigAttachment', -h) + att(folder + 'n', 'NeckRigAttachment', h)));
  const r15Assets = { 'rbxasset://avatar/characterR15.rbxm': rig, 1: assets[1], 3: assets[3],
    10: `<roblox version="4">${torso('R15Fixed', 2)}${torso('R15ArtistIntent', 1)}${item('Folder', 'r6', 'R6')}</roblox>`,
    11: `<roblox version="4">${part('MeshPart', 'dh', 'Head', 0, att('dn', 'FaceFrontAttachment', 0))}</roblox>`,
    'rbxasset://avatar/animations/humanoidR15AnimateChildren.rbxm': `<roblox version="4">${item('Folder', 'ad', 'AnimationDefaultChildren', '', item('StringValue', 's1', 'run', '', item('Animation', 'n1', 'RunAnim', '<Content name="AnimationId"><url>http://www.roblox.com/asset/?id=913376220</url></Content>'))
      + item('StringValue', 's2', 'idle', '', item('Animation', 'n2', 'Animation1', '<Content name="AnimationId"><url>rbxassetid://507766388</url></Content>') + item('Animation', 'n3', 'Animation2', '<Content name="AnimationId"><url>rbxassetid://507766666</url></Content>')))}</roblox>`,
    12: `<roblox version="4">${item('Folder', 'pk', 'R15Anim', '', item('StringValue', 's3', 'run', '', item('Animation', 'n4', 'RunAnim', '<Content name="AnimationId"><url>http://www.roblox.com/asset/?id=10921261968</url></Content>')))}</roblox>` };
  const r15Warnings = [], r15Fetch = async (id) => { if (!r15Assets[id]) throw new Error('download failed'); return new TextEncoder().encode(r15Assets[id]); };
  const r15 = await buildAvatarTree({ username: 'R', rig: 'R15', avatar: { scales: { bodyType: 0 }, assets: [{ id: 1, name: 'Cap', assetType: { id: 8 } },
    { id: 3, name: 'Smile', assetType: { id: 18 } }, { id: 10, name: 'Torso', assetType: { id: 27 } }, { id: 11, name: 'Dyn', assetType: { id: 79 } }, { id: 12, name: 'Rthro Run', assetType: { id: 53 } }] } }, (w) => r15Warnings.push(w), r15Fetch);
  const r15all = [...walk(r15.roots)], r15by = (n) => r15all.find((i) => nameOf(i) === n), y = (n) => r15by(n).props.cframe.p[1];
  assert.deepEqual(r15Warnings, []);
  assert.equal(nameOf(r15.roots[0]), 'R');
  assert.ok(Math.abs(y('UpperTorso') - 3.7) < 1e-6 && Math.abs(y('Head') - 5.2) < 1e-6, `R15ArtistIntent torso moves the head up: ${y('UpperTorso')}, ${y('Head')}`);
  assert.equal(r15by('Head').className, 'MeshPart', 'dynamic head swapped in');
  assert.ok(!r15by('Head').children.some((c) => c.className === 'Decal' || c.className === 'SpecialMesh'), 'dynamic head has no face decal or head mesh');
  assert.ok(r15by('Head').children.some((c) => nameOf(c) === 'NeckRigAttachment'), 'rig attachments the package lacks stay');
  assert.ok(Math.abs(r15by('Handle').props.cframe.p[1] - 6.1) < 1e-6, 'hat sits on the moved head');
  assert.deepEqual(anims(r15), ['Idle A=507766388', 'Idle B=507766666', 'Run=10921261968'], 'R15 defaults, with the player pack in its slot');
  for (const j of r15all.filter((i) => i.className === 'Motor6D')) {
    const p1 = cframeMatrix(j.props.part0.props.cframe).multiply(cframeMatrix(j.props.c0)).multiply(cframeMatrix(j.props.c1).invert());
    assert.ok(new THREE.Vector3().setFromMatrixPosition(p1).distanceTo(new THREE.Vector3(...j.props.part1.props.cframe.p)) < 1e-9, nameOf(j));
  }
  // Avatar scales (R15 only): body per axis, head uniformly; joints rebuilt from the scaled attachments, hats follow.
  const scaled = await buildAvatarTree({ username: 'S', rig: 'R15', avatar: { scales: { width: 0.5, height: 2, depth: 1, head: 1.5 }, assets: [{ id: 1, name: 'Cap', assetType: { id: 8 } }] } }, () => {}, r15Fetch);
  const sAll = [...walk(scaled.roots)], sBy = (n) => sAll.find((i) => nameOf(i) === n);
  assert.deepEqual(sBy('UpperTorso').props.size, { x: 1, y: 2, z: 1 }, 'width and height scale the body');
  assert.deepEqual(sBy('Head').props.size, { x: 3, y: 1.5, z: 1.5 }, 'head scale is uniform');
  assert.ok(Math.abs(sBy('Head').props.cframe.p[1] - (3 - 0.5 * 2 + 0.2 * 2 + 0.8 * 2 + 0.8 * 2 + 0.5 * 1.5)) < 1e-6, 'joints follow the scaled attachments: ' + sBy('Head').props.cframe.p[1]);
  assert.deepEqual(sBy('Handle').props.size, { x: 1.5, y: 1.5, z: 1.5 }, 'a hat scales with the head');
  // Headless (a head item that is just a SpecialMesh with a near-empty mesh) on both rigs; a dynamic head on R6.
  const headless = `<roblox version="4">${item('SpecialMesh', 'hm', 'Mesh', '<int name="MeshType">5</int><Content name="MeshId"><url>rbxassetid://134079402</url></Content>')}</roblox>`;
  const headAssets = { ...r15Assets, 20: headless, 21: r15Assets[11] }, headFetch = async (id) => new TextEncoder().encode(headAssets[id]);
  for (const rig of ['R6', 'R15']) {
    const t2 = await buildAvatarTree({ username: 'H', rig, avatar: { assets: [{ id: 20, name: 'Headless Head', assetType: { id: 79 } }] } }, () => {}, headFetch);
    const head = [...walk(t2.roots)].find((i) => nameOf(i) === 'Head'), meshes = head.children.filter((c) => c.className === 'SpecialMesh');
    assert.ok(meshes.length === 1 && /134079402/.test(meshes[0].props.meshid), `${rig}: headless mesh replaces the head mesh`);
  }
  const r6dyn = await buildAvatarTree({ username: 'D', rig: 'R6', avatar: { assets: [{ id: 21, name: 'Dyn', assetType: { id: 79 } }] } }, () => {}, headFetch);
  const dAll = [...walk(r6dyn.roots)], dHead = dAll.find((i) => nameOf(i) === 'Head');
  assert.equal(dHead.className, 'MeshPart', 'R6 wears a dynamic head too');
  assert.ok(!dHead.children.some((c) => c.className === 'Decal') && Math.abs(dHead.props.cframe.p[1] - (4 + 0.5)) < 1e-6, 'seated on the neck by its height, no face decal: ' + dHead.props.cframe.p[1]);
  const noRig = [];
  const fallback = await buildAvatarTree({ username: 'F', rig: 'R15', avatar: {} }, (w) => noRig.push(w), async () => { throw new Error('not installed'); });
  assert.ok(/built as R6/.test(noRig[0]) && [...walk(fallback.roots)].some((i) => nameOf(i) === 'Torso'), 'R15 falls back to R6 without a Roblox install');
}

// ---------- motion and pedestal ----------
{
  const c = new THREE.Vector3(0, 1, 0), m = (mode, t) => motionMatrix({ mode, amount: 1, speed: 1 }, t, c, 0, 1);
  assert.ok(m('none', 0.3).equals(new THREE.Matrix4()));
  assert.ok(m('spin', 0).equals(new THREE.Matrix4()), 'spin starts unturned');
  assert.ok(new THREE.Vector3(1, 1, 0).applyMatrix4(m('spin', 0.25)).distanceTo(new THREE.Vector3(0, 1, -1)) < 1e-9, 'quarter turn after a quarter cycle');
  assert.ok(new THREE.Vector3().setFromMatrixPosition(m('bounce', 0.5)).y > 0.2, 'mid-hop is in the air');
  const pts = new Float32Array([1, 0, 0, -1, 2, 0]);
  assert.equal(motionFramePoints(pts, { mode: 'none' }, c, 0, 1), pts);
  assert.ok(motionFramePoints(pts, { mode: 'float', amount: 1, speed: 1 }, c, 0, 1).length > pts.length);
  assert.equal(pedestalPoints({ shape: 'none' }, c, 0, 1).length, 0);
  const ped = pedestalPoints({ shape: 'disc', size: 1, height: 0.2, gap: 0 }, c, 0, 1);
  assert.ok(Math.min(...ped.filter((_, i) => i % 3 === 1)) < -0.19 && Math.max(...ped.filter((_, i) => i % 3 === 1)) === 0, 'from the model floor down');
}

console.log('features: settings lists, camera keys, APNG/WebP, trim, names, LUTs, scenes, avatars, motion ok');
