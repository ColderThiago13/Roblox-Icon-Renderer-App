// What AI agents can do in the app (through the MCP server in src/mcp/server.mjs and main's local API).
// Each handler takes one params object and returns JSON (images as base64 PNG). Files are picked by their id from
// list_files; `files` may also be "all" or "checked", and an omitted file means the one open in the app.
import { SCHEMA, TEXT_FIELDS, LIGHTING_PRESETS, patchSettings, withDefaults, clone } from '../settings.js';
import { nameOf, atPath } from '../rbx/instance.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const VIEWS = { front: [0, 0, 0], '3/4': [35, 20, 0], side: [90, 0, 0], back: [180, 0, 0], top: [0, 89, 0], tilt: [30, 18, -14] };
const IMAGE_FORMATS = { png: 'png', webp: 'webp', jpeg: 'jpg' };

export function createAgent(app) {
  const one = (id) => {
    const f = id == null ? app.current() : app.files.find((x) => x.id === Number(id));
    if (!f) throw new Error(id == null ? 'No file is open; add one first' : `No file with id ${id} (see list_files)`);
    return f;
  };
  const many = (sel) => (sel === 'all' ? [...app.files] : sel === 'checked' ? app.files.filter((f) => f.checked) : sel == null ? [one()] : [].concat(sel).map(one));
  const ready = async (f) => { for (let i = 0; f.status === 'loading' && i < 1200; i++) await sleep(100); return f; };
  const summary = (f) => ({
    id: f.id, name: f.name, status: f.status, error: f.error ?? undefined, warnings: [...f.warnings], checked: f.checked, open: f === app.current(),
    hasVfx: !!f.job?.vfxSystem, hasRig: !!f.job?.rig, animation: f.animSel || null, animationTime: f.animTime,
    animations: (f.job?.animations ?? []).map((a) => ({ key: a.key, name: a.name, length: a.track ? +a.track.length.toFixed(3) : null })),
  });
  const refresh = (list) => { for (const f of list) app.thumb(f, 100); app.buildPanel(); app.renderList(); app.requestPreview(); };
  const safeName = (n) => String(n).replace(/\.(rbxmx?|obj)$/i, '').replace(/[\\/:*?"<>|]/g, '_') || 'icon';

  return {
    async status() {
      return { files: app.files.length, open: app.current()?.id ?? null, aspect: app.aspect() };
    },
    async listFiles() { return app.files.map(summary); },
    async addFile({ path }) {
      const bytes = new Uint8Array(await window.native.readLocal(String(path), 'model'));
      const f = app.addBytes(String(path).split(/[\\/]/).pop(), bytes);
      return summary(await ready(f));
    },
    async addAssets({ ids }) {
      const added = await app.addAssetIds([...new Set([].concat(ids).flatMap((s) => String(s).match(/\d{3,}/g) ?? []))]);
      return Promise.all(added.map(async (f) => (f.error ? f : summary(await ready(f)))));
    },
    // Models sent by the Studio plugin when an agent asks for them (main forwards the plugin's reply).
    // (an instance imported again replaces its earlier file and keeps that file's settings)
    async importStudioItems({ items }) {
      return Promise.all(app.receiveStudio(items).map(async (f) => summary(await ready(f))));
    },
    async removeFiles({ files }) {
      const list = many(files);
      for (const f of list) app.removeFile(f);
      return { removed: list.map((f) => f.id) };
    },
    async selectFile({ file }) { const f = one(file); app.select(f); return summary(f); },

    async modelTree({ file, path = '', depth = 3, limit = 400 }) {
      const f = await ready(one(file)), roots = f.job?.tree?.roots;
      if (!roots) throw new Error(`${f.name} has no instance tree (OBJ files have none)`);
      const off = new Set(f.disabled), nodes = [];
      const walk = (inst, key, d) => {
        if (nodes.length >= limit) return;
        nodes.push({ path: key, name: nameOf(inst), class: inst.className, depth: d, children: inst.children.length, disabled: off.has(key) || undefined });
        if (d < depth) inst.children.forEach((c, i) => walk(c, `${key}/${i}`, d + 1));
      };
      if (path) walk(atPath(roots, path.split('/').map(Number)), path, 0);
      else roots.forEach((r, i) => walk(r, String(i), 0));
      return { file: f.id, truncated: nodes.length >= limit, nodes };
    },
    async setDisabled({ file, paths, disabled = true }) {
      const f = await ready(one(file));
      app.setDisabled([].concat(paths).map(String), !!disabled, f);
      return summary(await ready(f));
    },
    async splitModels({ file, paths }) {
      const f = await ready(one(file));
      const made = app.splitOut([].concat(paths).map(String), f);
      return Promise.all(made.map(async (m) => summary(await ready(m))));
    },

    async schema() {
      const field = (f) => ({ key: f.key, label: f.label, type: f.type, ...(f.min != null && { min: f.min, max: f.max, step: f.step }), ...(f.options && { options: f.options }), default: f.def });
      return {
        sections: SCHEMA.map((s) => ({ id: s.id, title: s.title, fields: s.fields.map(field) })),
        textLayer: TEXT_FIELDS.map(field), lightingPresets: Object.keys(LIGHTING_PRESETS), views: Object.keys(VIEWS),
        notes: 'Pixel values are "px at 512" and scale with the output size. Text x/y run -0.5..0.5 with +y up. camera.yaw 0 looks at the model front.',
      };
    },
    async getSettings({ file }) {
      const s = clone(one(file).settings);
      if (s.background.image) s.background.image = '(image set)';
      return s;
    },
    // settings: { section: { key: value }, texts: [...] }; view: a camera angle preset name.
    async setSettings({ files, settings = {}, view }) {
      const list = many(files), notes = new Set();
      for (const f of list) {
        for (const n of patchSettings(f.settings, settings)) notes.add(n);
        if (view) {
          const v = VIEWS[String(view).toLowerCase()];
          if (!v) throw new Error(`Unknown view "${view}" (${Object.keys(VIEWS).join(', ')})`);
          Object.assign(f.settings.camera, { yaw: v[0], pitch: v[1], roll: v[2] });
        }
      }
      refresh(list);
      return { files: list.map((f) => f.id), notes: [...notes] };
    },
    async setBackgroundImage({ files, path }) {
      const list = many(files);
      let url = '';
      if (path) url = await app.imageDataUrl(new Blob([new Uint8Array(await window.native.readLocal(String(path), 'image'))]));
      for (const f of list) Object.assign(f.settings.background, url ? { image: url, mode: 'image' } : { image: '', mode: 'transparent' });
      refresh(list);
      return { files: list.map((f) => f.id) };
    },
    async listProfiles() { return Object.keys(app.profiles()); },
    async applyProfile({ files, name }) {
      const p = app.profiles()[name];
      if (!p) throw new Error(`No profile named "${name}"`);
      const list = many(files);
      for (const f of list) f.settings = withDefaults(clone(p));
      refresh(list);
      return { files: list.map((f) => f.id) };
    },
    async saveProfile({ file, name }) {
      if (!name) throw new Error('Give the profile a name');
      await app.saveProfile(String(name), clone(one(file).settings));
      return { saved: String(name) };
    },
    // animation: a key from list_files, an animation asset ID, or null for the pose saved in the file.
    async setAnimation({ file, animation, time = 0 }) {
      const f = await ready(one(file));
      if (!f.job?.rig) throw new Error(`${f.name} has no rig to animate`);
      if (animation == null || animation === '') { f.animSel = ''; f.animTime = 0; }
      else {
        let entry = f.job.animations.find((a) => a.key === String(animation) || a.name === String(animation));
        const id = !entry && String(animation).match(/\d{5,}/)?.[0];
        if (id) f.job.animations.push(entry = { key: `id:${id}`, name: `Animation ${id}`, id, track: null });
        if (!entry) throw new Error(`No animation "${animation}" in ${f.name}`);
        await app.ensureTrack(entry);
        entry.name = entry.track?.name ?? entry.name;
        f.animSel = entry.key;
        f.animTime = Math.max(0, Math.min(+time || 0, entry.track?.length ?? 0));
      }
      app.syncAnimBar(); refresh([f]);
      return summary(f);
    },

    // What the agent sees: the render exactly as an export would make it.
    async preview({ file, size = 512, aspect, supersample = 1 }) {
      const f = await ready(one(file));
      if (!f.job) throw new Error(`${f.name} failed to load: ${f.error}`);
      const bytes = await app.encode(f, { size: Math.min(2048, Math.max(64, +size || 512)), format: 'png', ss: supersample > 1 ? 2 : 1, aspect: +aspect || app.aspect() });
      return { image: b64(bytes), file: summary(f) };
    },
    async exportImages({ files, folder, size = 512, format = 'png', aspect, supersample = 2 }) {
      if (!folder) throw new Error('folder is required');
      const ext = IMAGE_FORMATS[format];
      if (!ext) throw new Error(`format must be ${Object.keys(IMAGE_FORMATS).join(', ')}`);
      const list = (await Promise.all(many(files).map(ready))).filter((f) => f.job), used = new Set(), written = [];
      for (const f of list) {
        let name = safeName(f.name), n = 2;
        while (used.has(name)) name = `${safeName(f.name)}_${n++}`;
        used.add(name);
        const path = await window.native.joinPath(String(folder), `${name}.${ext}`);
        await window.native.writeFile(path, await app.encode(f, { size: Math.min(4096, Math.max(16, +size || 512)), format, ss: supersample > 1 ? 2 : 1, aspect: +aspect || app.aspect() }));
        written.push(path);
      }
      app.requestPreview();
      return { written };
    },
    async exportAnimation({ files, folder, format = 'gif', size = 512, fps = 24, start = 0, duration, source = 'both', turntable = false,
      loop = true, lock = true, aspect, supersample = 1, transparent = true, backgroundColor = '#2b2d42' }) {
      if (!folder) throw new Error('folder is required');
      if (!['png', 'sheet', 'gif', 'mp4', 'webm'].includes(format)) throw new Error('format must be png, sheet, gif, mp4 or webm');
      const bg = /^#[0-9a-f]{6}$/i.test(backgroundColor) ? [1, 3, 5].map((i) => parseInt(backgroundColor.slice(i, i + 2), 16)) : [43, 45, 66];
      const list = (await Promise.all(many(files).map(ready))).filter((f) => f.job), out = [];
      for (const f of list) {
        const len = duration ?? (f.job.animations.find((a) => a.key === f.animSel)?.track?.length || f.settings.vfx.duration);
        const o = { size: Math.min(format === 'gif' ? 1024 : 4096, Math.max(16, +size || 512)), ss: supersample > 1 ? 2 : 1, format, source, fps: Math.min(60, Math.max(1, Math.round(+fps || 24))),
          start: Math.max(0, +start || 0), duration: Math.max(0.05, +len || 2), loop, lock, turntable, cols: 0, pad: 0, aspect: +aspect || app.aspect(),
          gifBg: transparent ? null : bg, bgColor: bg };
        const saved = [f.animTime, f.settings.vfx.time], name = safeName(f.name);
        try { await app.exportClip(f, o, String(folder), name, () => {}); } finally { [f.animTime, f.settings.vfx.time] = saved; }
        out.push({ file: f.id, folder: String(folder), name, format });
      }
      app.requestPreview();
      return { exported: out };
    },
  };
}
