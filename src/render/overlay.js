// Background image and text layers. Both are drawn with Canvas 2D at the output resolution and composited by the
// final shader (background under the model, text over everything), so preview, thumbnails and exports match.
// Sizes are "px at 512" like the other effects; positions are -0.5..0.5 of the frame with +y up.
import { getAssetBytes } from '../scene/assets.js';

const rad = (d) => (d * Math.PI) / 180;
const graphemes = (s) => (Intl.Segmenter ? [...new Intl.Segmenter().segment(s)].map((g) => g.segment) : [...s]);

// ---------- layout (pure: measure(str) -> width in px with the layer's font and letter spacing) ----------
// Returns glyph runs centered on the layer anchor in unrotated local px (y down), plus their bounding box.
// curve = degrees of arc the widest line bends through: > 0 arches up (∩), < 0 sags (∪).
export function layoutText(t, S, measure) {
  const k = S / 512, fontPx = t.size * k, lineH = fontPx * t.lineHeight;
  const lines = String(t.text ?? '').split('\n'), n = lines.length, widths = lines.map(measure);
  const maxW = Math.max(1e-6, ...widths), A = rad(t.curve || 0), s = Math.sign(A);
  const R = Math.abs(A) > 1e-4 ? maxW / Math.abs(A) : 0, glyphs = [];
  lines.forEach((line, i) => {
    const y = (i - (n - 1) / 2) * lineH, w = widths[i];
    const start = t.align === 'left' ? -maxW / 2 : t.align === 'right' ? maxW / 2 - w : -w / 2;
    if (!R) { if (line) glyphs.push({ text: line, x: start + w / 2, y, rot: 0, w }); return; } // whole line keeps kerning
    const Ri = Math.max(fontPx * 0.5, R - s * y); // lines stack outward/inward around one center
    let a = start;
    for (const ch of graphemes(line)) {
      const cw = measure(ch), th = (a + cw / 2) / Ri;
      glyphs.push({ text: ch, x: Ri * Math.sin(th), y: s * (R - Ri * Math.cos(th)), rot: s * th, w: cw });
      a += cw;
    }
  });
  const pad = Math.max(0, t.strokeWidth) * k, half = fontPx * 0.62 + pad;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const g of glyphs) {
    const c = Math.cos(g.rot), sn = Math.sin(g.rot);
    for (const [dx, dy] of [[-g.w / 2 - pad, -half], [g.w / 2 + pad, -half], [-g.w / 2 - pad, half], [g.w / 2 + pad, half]]) {
      const x = g.x + dx * c - dy * sn, y = g.y + dx * sn + dy * c;
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
    }
  }
  if (!glyphs.length) box.splice(0, 4, -fontPx / 2, -half, fontPx / 2, half); // empty text stays selectable
  return { glyphs, fontPx, box };
}

// Layout in normalized frame coordinates (0..1, y down) for hit testing and the selection box.
export function frameLayout(t, layout, S) {
  return { id: t.id, cx: 0.5 + t.x, cy: 0.5 - t.y, rot: rad(t.rotation), box: layout.box.map((v) => v / S) };
}

// Topmost layer under the normalized point, or null.
export function hitText(layouts, px, py) {
  for (let i = layouts.length - 1; i >= 0; i--) {
    const L = layouts[i], dx = px - L.cx, dy = py - L.cy, c = Math.cos(-L.rot), s = Math.sin(-L.rot);
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    if (lx >= L.box[0] && lx <= L.box[2] && ly >= L.box[1] && ly <= L.box[3]) return L.id;
  }
  return null;
}

// ---------- drawing ----------
export const fontString = (t, px) => `${t.italic ? 'italic ' : ''}${t.weight} ${px}px "${t.font}", "Builder Sans", Arial, sans-serif`;

let scratch = null;
export function drawTexts(ctx, texts, S) {
  const k = S / 512, layouts = [];
  scratch ??= document.createElement('canvas');
  if (scratch.width !== S) scratch.width = scratch.height = S;
  const g = scratch.getContext('2d');
  for (const t of texts) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S, S);
    g.font = fontString(t, t.size * k);
    g.letterSpacing = `${t.spacing * k}px`;
    const L = layoutText(t, S, (str) => g.measureText(str).width);
    layouts.push(frameLayout(t, L, S));
    if (!L.glyphs.length) continue;
    g.translate((0.5 + t.x) * S, (0.5 - t.y) * S);
    g.rotate(rad(t.rotation));
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.miterLimit = 2;
    g.lineWidth = Math.max(0, t.strokeWidth) * k * 2; // centered stroke; the fill covers the inner half
    for (const pass of t.strokeWidth > 0 ? ['strokeText', 'fillText'] : ['fillText']) {
      for (const gl of L.glyphs) {
        g.save(); g.translate(gl.x, gl.y); g.rotate(gl.rot);
        if (pass === 'fillText') g.fillStyle = paint(g, t.fill, t.color, t.color2, t.fillAngle, L.box, gl);
        else g.strokeStyle = paint(g, t.strokeFill, t.strokeColor, t.strokeColor2, t.fillAngle, L.box, gl);
        g[pass](gl.text, 0, 0); g.restore();
      }
    }
    // Composite the finished layer once: one opacity for stroke + fill, and a shadow of the whole shape.
    ctx.save();
    ctx.globalAlpha = t.opacity;
    if (t.shadowSize > 0 || t.shadowX || t.shadowY) {
      Object.assign(ctx, { shadowColor: t.shadowColor, shadowBlur: t.shadowSize * k, shadowOffsetX: t.shadowX * k, shadowOffsetY: t.shadowY * k });
    }
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }
  return layouts;
}

// Fill/stroke style spanning the whole layer's box (it rotates with the text; angle 90 = top to bottom).
// Canvas gradients live in the current transform, so the geometry is mapped into the glyph's own space.
export function paint(g, mode, c1, c2, angle, box, glyph) {
  if (mode !== 'gradient' && mode !== 'radial' && mode !== 'rainbow') return c1;
  const c = Math.cos(-glyph.rot), s = Math.sin(-glyph.rot);
  const local = (x, y) => [(x - glyph.x) * c - (y - glyph.y) * s, (x - glyph.x) * s + (y - glyph.y) * c];
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2, w = box[2] - box[0], h = box[3] - box[1];
  let grad;
  if (mode === 'radial') grad = g.createRadialGradient(...local(cx, cy), 0, ...local(cx, cy), Math.hypot(w, h) / 2);
  else {
    const dx = Math.cos(rad(angle)), dy = Math.sin(rad(angle)), half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    grad = g.createLinearGradient(...local(cx - dx * half, cy - dy * half), ...local(cx + dx * half, cy + dy * half));
  }
  if (mode === 'rainbow') for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60}, 100%, 55%)`);
  else { grad.addColorStop(0, c1); grad.addColorStop(1, c2); }
  return grad;
}

// Background image: fit (cover/contain/stretch/tile), then scale, rotation and offset (fractions of the frame, +y up).
export function drawBackground(ctx, img, b, S) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  ctx.save();
  ctx.translate(S / 2 + b.imageX * S, S / 2 - b.imageY * S);
  ctx.rotate(rad(b.imageRotation));
  ctx.scale(b.imageScale, b.imageScale);
  if (b.imageFit === 'stretch') ctx.drawImage(img, -S / 2, -S / 2, S, S);
  else if (b.imageFit === 'tile') {
    const k = S / 512, pattern = ctx.createPattern(img, 'repeat'), reach = (S * 1.5) / Math.min(1, b.imageScale);
    pattern.setTransform(new DOMMatrix().scale(k).translate(-iw / 2, -ih / 2));
    ctx.fillStyle = pattern;
    ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
  } else {
    const f = b.imageFit === 'contain' ? Math.min(S / iw, S / ih) : Math.max(S / iw, S / ih);
    ctx.drawImage(img, (-iw * f) / 2, (-ih * f) / 2, iw * f, ih * f);
  }
  ctx.restore();
}

// ---------- assets: background images and fonts ----------
const images = new Map(); // data URL -> { img, ready: Promise }
export function imageFor(url) {
  if (!url) return null;
  if (!images.has(url)) {
    const img = new Image();
    img.src = url;
    const e = { img, failed: false };
    e.ready = img.decode().catch(() => { e.failed = true; });
    images.set(url, e);
  }
  const e = images.get(url);
  return e.img.complete && e.img.naturalWidth ? e.img : null;
}

// Roblox's font families (content/fonts/families/*.json from the local install) first, then common Windows fonts.
const SYSTEM = ['Arial', 'Arial Black', 'Impact', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Comic Sans MS'];
let registry = null;
export function fontFamilies() {
  registry ??= (async () => {
    let roblox = [];
    try {
      const files = await globalThis.native.listRbxAssets('fonts/families');
      roblox = (await Promise.all(files.filter((f) => f.endsWith('.json')).map(async (f) => {
        try {
          const j = JSON.parse(new TextDecoder().decode(await getAssetBytes(`rbxasset://fonts/families/${f}`)));
          return j.name && !j.loadStrategy && j.faces?.length ? { family: j.name, roblox: true, faces: j.faces } : null;
        } catch { return null; }
      }))).filter(Boolean).sort((a, b) => (a.family === 'Builder Sans' ? -1 : b.family === 'Builder Sans' ? 1 : a.family.localeCompare(b.family)));
    } catch { /* no Roblox install: system fonts only */ }
    return [...roblox, ...SYSTEM.map((family) => ({ family, roblox: false, faces: [{ weight: 400, style: 'normal' }, { weight: 700, style: 'normal' }] }))];
  })();
  return registry;
}

// Registers a Roblox family's faces (local files, or rbxassetid faces through the asset API) once.
const families = new Map(), fontsReady = new Set();
export function loadFamily(family) {
  if (!families.has(family)) {
    families.set(family, fontFamilies().then(async (list) => {
      const f = list.find((x) => x.family === family);
      if (!f?.roblox) return;
      await Promise.all(f.faces.map(async (face) => {
        try {
          const ff = new FontFace(family, await getAssetBytes(face.assetId), { weight: String(face.weight ?? 400), style: face.style || 'normal' });
          document.fonts.add(await ff.load());
        } catch { /* missing face: the browser picks the nearest loaded weight */ }
      }));
    }).finally(() => fontsReady.add(family)));
  }
  return families.get(family);
}

// Resolves once the settings' background image and fonts are usable (null when they already are).
export function overlayPending(s) {
  const waits = [];
  const b = s.background;
  if (b.mode === 'image' && b.image && !imageFor(b.image) && !images.get(b.image).failed) waits.push(images.get(b.image).ready);
  for (const t of s.texts ?? []) if (!fontsReady.has(t.font)) waits.push(loadFamily(t.font));
  return waits.length ? Promise.all(waits) : null;
}
export const overlayReady = (s) => overlayPending(s) ?? Promise.resolve();
