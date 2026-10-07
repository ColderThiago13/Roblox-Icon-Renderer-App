// Roblox XML model format (.rbxmx) reader. Tiny purpose-built XML tokenizer so it runs in Node and Electron alike.
import { makeInstance, finalizeTree, decodeAttributes } from './instance.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);

function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += unescape(m[6]);
    else if (m[3]) {
      if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescape(a[2] ?? a[3]);
      const node = { tag: m[3], attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  return root;
}

const child = (n, tag) => n.children.find((c) => c.tag.toLowerCase() === tag);
const num = (n, tag) => parseFloat(child(n, tag)?.text ?? '0');
const nums = (s) => s.trim().split(/\s+/).filter(Boolean).map(Number);

function b64(s) {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function convert(node, shared) {
  const t = node.text.trim();
  switch (node.tag.toLowerCase()) {
    case 'string': case 'protectedstring': return node.text;
    case 'binarystring': return t ? b64(t) : new Uint8Array(0);
    case 'bool': return t === 'true';
    case 'int': case 'int64': case 'float': case 'double': case 'token': case 'brickcolor': return parseFloat(t);
    case 'vector3': return { x: num(node, 'x'), y: num(node, 'y'), z: num(node, 'z') };
    case 'vector2': return { x: num(node, 'x'), y: num(node, 'y') };
    case 'color3':
      if (!node.children.length) { const v = +t; return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 }; }
      return { r: num(node, 'r'), g: num(node, 'g'), b: num(node, 'b') };
    case 'color3uint8': { const v = +t; return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 }; }
    case 'coordinateframe': case 'cframe':
      return { p: ['x', 'y', 'z'].map((k) => num(node, k)), r: ['r00', 'r01', 'r02', 'r10', 'r11', 'r12', 'r20', 'r21', 'r22'].map((k) => num(node, k)) };
    case 'optionalcoordinateframe': { const cf = child(node, 'cframe'); return cf ? convert(cf, shared) : null; }
    case 'content': case 'contentid': { const u = child(node, 'url') || child(node, 'uri'); return u ? u.text.trim() : (t || null); }
    case 'ref': return t && t !== 'null' ? { ref: t } : null;
    case 'numbersequence': { const a = nums(t), out = []; for (let i = 0; i + 2 < a.length; i += 3) out.push({ t: a[i], v: a[i + 1], e: a[i + 2] }); return out; }
    case 'colorsequence': { const a = nums(t), out = []; for (let i = 0; i + 4 < a.length; i += 5) out.push({ t: a[i], c: { r: a[i + 1], g: a[i + 2], b: a[i + 3] } }); return out; }
    case 'numberrange': { const a = nums(t); return { min: a[0], max: a[1] ?? a[0] }; }
    case 'sharedstring': return shared.get(t) ?? null;
    default: return undefined;
  }
}

export function parseXmlModel(text) {
  const doc = parseXml(text);
  const robloxNode = child(doc, 'roblox');
  if (!robloxNode) throw new Error('Not a Roblox XML file');
  const shared = new Map();
  for (const ss of child(robloxNode, 'sharedstrings')?.children ?? []) shared.set(ss.attrs.md5, b64(ss.text));

  const byRef = new Map(), all = [];
  const build = (node, parent) => {
    const inst = makeInstance(node.attrs.class, node.attrs.referent);
    inst.parent = parent;
    if (node.attrs.referent) byRef.set(node.attrs.referent, inst);
    all.push(inst);
    for (const c of node.children) {
      if (c.tag === 'Properties') {
        for (const p of c.children) {
          const v = convert(p, shared);
          if (v !== undefined && p.attrs.name) inst.props[p.attrs.name.toLowerCase()] = v;
        }
      } else if (c.tag === 'Item') inst.children.push(build(c, inst));
    }
    return inst;
  };
  const roots = robloxNode.children.filter((c) => c.tag === 'Item').map((c) => build(c, null));
  for (const inst of all) {
    for (const [k, v] of Object.entries(inst.props)) if (v && typeof v === 'object' && 'ref' in v) inst.props[k] = byRef.get(v.ref) || null;
    if (inst.props.attributesserialize) inst.attributes = decodeAttributes(inst.props.attributesserialize);
  }
  return finalizeTree(roots);
}
