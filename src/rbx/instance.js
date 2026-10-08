// Shared instance tree model. Property keys are lowercased ("size", "meshid", "color3uint8").

export function makeInstance(className, ref) {
  return { className, ref, props: {}, attributes: {}, children: [], parent: null };
}

export function finalizeTree(roots) {
  return { roots, all: [...walk(roots)] };
}

export function* walk(list) {
  for (const inst of list) { yield inst; yield* walk(inst.children); }
}

// Path = child indexes from the file's top level down to one instance (stable across re-parses of the same bytes).
export function pathOf(inst, roots) {
  const path = [];
  for (let i = inst; i; i = i.parent) path.unshift((i.parent?.children ?? roots).indexOf(i));
  return path;
}

export function atPath(roots, path) {
  let node = { children: roots };
  for (const i of path) node = node?.children[i];
  return node ?? null;
}

// What gets rendered: the instance at `path` (or the whole file) minus disabled instances and their descendants.
// Disabled ones are cut out of `tree` itself, so pass a parse that doesn't need to stay whole.
// Parents stay linked, so pivots/ancestors still resolve.
export function renderTree(tree, path = null, disabled = []) {
  const root = path && atPath(tree.roots, path);
  if (path && !root) throw new Error('This model is no longer in the file');
  const off = disabled.map((p) => atPath(tree.roots, p)).filter(Boolean); // resolve all first: cutting shifts indexes
  for (const inst of off) { const list = inst.parent ? inst.parent.children : tree.roots; list.splice(list.indexOf(inst), 1); }
  return finalizeTree(path ? (off.includes(root) ? [] : [root]) : tree.roots);
}

export const nameOf =(inst) => inst.props.name ?? inst.className;

export function isA(inst, ...classes) { return classes.includes(inst.className); }

export function findAncestor(inst, pred) {
  for (let p = inst.parent; p; p = p.parent) if (pred(p)) return p;
  return null;
}

// Attribute blob (AttributesSerialize). Only decodes until an unknown type is hit.
export function decodeAttributes(bytes) {
  const out = {};
  if (!bytes || bytes.length < 4) return out;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const td = new TextDecoder();
  let p = 0;
  const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(p, true); p += 4; return v; };
  const str = () => { const n = u32(); const s = td.decode(bytes.subarray(p, p + n)); p += n; return s; };
  try {
    const count = u32();
    for (let i = 0; i < count; i++) {
      const key = str(), type = bytes[p++];
      let v;
      switch (type) {
        case 0x02: v = str(); break;
        case 0x03: v = bytes[p++] !== 0; break;
        case 0x04: v = dv.getInt32(p, true); p += 4; break;
        case 0x05: v = f32(); break;
        case 0x06: v = dv.getFloat64(p, true); p += 8; break;
        case 0x09: p += 8; break;
        case 0x0a: p += 16; break;
        case 0x0e: v = u32(); break;
        case 0x0f: v = { r: f32(), g: f32(), b: f32() }; break;
        case 0x10: v = { x: f32(), y: f32() }; break;
        case 0x11: v = { x: f32(), y: f32(), z: f32() }; break;
        case 0x14: { p += 12; const id = bytes[p++]; if (id === 0) p += 36; break; }
        case 0x15: str(); p += 4; break;
        case 0x17: { const n = u32(); p += n * 12; break; }
        case 0x19: { const n = u32(); p += n * 20; break; }
        case 0x1b: v = { min: f32(), max: f32() }; break;
        case 0x1c: p += 16; break;
        case 0x21: p += 3; str(); str(); break;
        default: return out;
      }
      if (v !== undefined) out[key] = v;
    }
  } catch { /* truncated blob */ }
  return out;
}

// "rbxassetid://123", "http://www.roblox.com/asset/?id=123", "...assetdelivery...?id=123" -> "123"
export function assetId(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/rbxassetid:\/\/(\d+)/i) || url.match(/[?&]id=(\d+)/i) || url.match(/^\s*(\d+)\s*$/);
  return m ? m[1] : null;
}
