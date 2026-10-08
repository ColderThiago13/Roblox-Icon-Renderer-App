// Per-file render settings. The schema drives both the UI panel and defaults.
// Pixel values are "px at 512" and scale with the output size.

const r = (key, label, min, max, step, def) => ({ key, label, type: 'range', min, max, step, def });
const b = (key, label, def) => ({ key, label, type: 'bool', def });
const c = (key, label, def) => ({ key, label, type: 'color', def });
const s = (key, label, options, def) => ({ key, label, type: 'select', options, def });

// Optional one-click looks: picking one writes these lighting/shadow values (then edit freely). 'none' changes nothing.
// Approximations of Studio's Lighting.Technology modes plus two icon looks.
export const LIGHTING_PRESETS = {
  studio: { lighting: { toneMapping: 'neutral', exposure: 1, ambient: 0.9, env: 0.5, key: 2.4, keyColor: '#fff5e6', keyYaw: -40, keyPitch: 50, fill: 0.6, rim: 1, rimColor: '#ffffff' }, shadows: { selfShadows: true, softness: 2 } },
  future: { lighting: { toneMapping: 'aces', exposure: 1.1, ambient: 0.6, env: 0.9, key: 3.2, keyColor: '#fff1dd', keyYaw: -45, keyPitch: 40, fill: 0.4, rim: 1.4, rimColor: '#ffffff' }, shadows: { selfShadows: true, softness: 0.5 } },
  shadowmap: { lighting: { toneMapping: 'aces', exposure: 1.05, ambient: 0.75, env: 0.6, key: 2.8, keyColor: '#fff1dd', keyYaw: -45, keyPitch: 45, fill: 0.5, rim: 1.1, rimColor: '#ffffff' }, shadows: { selfShadows: true, softness: 3 } },
  voxel: { lighting: { toneMapping: 'none', exposure: 1, ambient: 1.3, env: 0.3, key: 1.6, keyColor: '#ffffff', keyYaw: -40, keyPitch: 55, fill: 1, rim: 0.4, rimColor: '#ffffff' }, shadows: { selfShadows: false, softness: 6 } },
  showcase: { lighting: { toneMapping: 'neutral', exposure: 1.05, ambient: 1, env: 0.6, key: 2, keyColor: '#ffffff', keyYaw: -35, keyPitch: 40, fill: 1.2, rim: 2.2, rimColor: '#ffffff' }, shadows: { selfShadows: true, softness: 6 } },
  dramatic: { lighting: { toneMapping: 'aces', exposure: 1, ambient: 0.25, env: 0.4, key: 4, keyColor: '#ffe2c2', keyYaw: -70, keyPitch: 25, fill: 0.2, rim: 3, rimColor: '#9ec5ff' }, shadows: { selfShadows: true, softness: 1 } },
};

export const SCHEMA = [
  { id: 'camera', title: 'Camera', fields: [
    r('yaw', 'Rotation', -180, 180, 1, 30), r('pitch', 'Tilt', -89, 89, 1, 20), r('roll', 'Roll', -180, 180, 1, 0),
    r('zoom', 'Zoom', 0.01, 4, 0.0001, 1), s('projection', 'Projection', ['perspective', 'orthographic'], 'perspective'),
    r('fov', 'Field of view', 5, 90, 1, 30), r('offsetX', 'Offset X', -0.5, 0.5, 0.005, 0), r('offsetY', 'Offset Y', -0.5, 0.5, 0.005, 0),
    r('padding', 'Padding', 0, 0.45, 0.01, 0.08), b('fitVfx', 'Fit VFX in frame', false),
  ] },
  { id: 'lighting', title: 'Lighting', fields: [
    s('preset', 'Preset (optional)', ['none', ...Object.keys(LIGHTING_PRESETS)], 'none'),
    b('robloxSky', 'Roblox sky reflections', false),
    s('toneMapping', 'Tone mapping', ['neutral', 'aces', 'agx', 'none'], 'neutral'), r('exposure', 'Exposure', 0, 3, 0.01, 1),
    r('ambient', 'Ambient', 0, 3, 0.01, 0.7), r('env', 'Reflections', 0, 3, 0.01, 0.45),
    r('key', 'Key light', 0, 10, 0.05, 2.6), c('keyColor', 'Key color', '#ffffff'), r('keyYaw', 'Key direction', -180, 180, 1, -40), r('keyPitch', 'Key height', -10, 90, 1, 45),
    b('followCamera', 'Light follows camera', true), r('fill', 'Fill light', 0, 5, 0.05, 0.8),
    r('rim', 'Rim light', 0, 10, 0.05, 1.6), c('rimColor', 'Rim color', '#ffffff'),
    b('modelLights', 'Use model lights', true), r('modelLightStrength', 'Model light strength', 0, 5, 0.05, 1),
    r('neon', 'Neon intensity', 0, 10, 0.05, 4),
  ] },
  { id: 'shadows', title: 'Shadows', fields: [
    b('selfShadows', 'Self shadows', true), b('ground', 'Ground shadow', false),
    r('groundOpacity', 'Ground opacity', 0, 1, 0.01, 0.35), r('softness', 'Softness', 0, 12, 0.1, 3),
  ] },
  { id: 'vfx', title: 'VFX', fields: [
    b('enabled', 'Show VFX', true), r('time', 'Time since VFX start (s)', 0, 60, 0.01, 2), r('duration', 'Timeline length (s)', 0.5, 60, 0.5, 5),
    b('prewarm', 'Prewarm (emitters already running, like Studio)', true),
    r('litLight', 'Scene light for lit VFX (LightInfluence)', 0, 5, 0.05, 2),
    r('seed', 'Random seed', 0, 999, 1, 1), b('includeBursts', 'Fire EmitCount bursts (at EmitDelay)', true),
    r('maxParticles', 'Max particles / emitter', 100, 20000, 100, 20000), b('outlineVfx', 'Outline/glow includes VFX', false),
  ] },
  { id: 'trails', title: 'Trails', fields: [
    b('enabled', 'Show trails', false), r('length', 'Length / motion cap (studs)', 0, 100, 0.05, 4),
    s('mode', 'Path', ['auto', 'direction', 'animation'], 'auto'),
    r('yaw', 'Direction path: yaw', -180, 180, 1, 180), r('pitch', 'Direction path: tilt', -89, 89, 1, 0),
    r('litLight', 'Scene light for lit trails', 0, 5, 0.05, 2),
    b('fit', 'Fit trails in frame', false), b('outline', 'Include in outline/glow', false),
  ] },
  { id: 'bloom', title: 'Bloom', fields: [
    b('enabled', 'Enabled', true), r('threshold', 'Threshold', 0, 4, 0.01, 1.5), r('strength', 'Strength', 0, 3, 0.01, 0.6), r('radius', 'Radius', 0, 1, 0.01, 0.6),
  ] },
  { id: 'color', title: 'Color', fields: [
    r('brightness', 'Brightness', 0, 3, 0.01, 1), r('contrast', 'Contrast', 0, 3, 0.01, 1), r('saturation', 'Saturation', 0, 3, 0.01, 1),
    r('hue', 'Hue shift', -180, 180, 1, 0), r('gamma', 'Gamma', 0.2, 3, 0.01, 1), r('temperature', 'Temperature', -1, 1, 0.01, 0),
  ] },
  { id: 'overlay', title: 'Color overlay', fields: [
    s('mode', 'Mode', ['none', 'solid', 'gradient', 'rainbow'], 'none'), s('blend', 'Blend', ['normal', 'multiply', 'screen', 'overlay', 'tint'], 'tint'),
    c('color1', 'Color 1', '#ff4d6d'), c('color2', 'Color 2', '#4d7cff'), r('angle', 'Angle', 0, 360, 1, 90), r('strength', 'Strength', 0, 1, 0.01, 0.5),
  ] },
  { id: 'outline', title: 'Outline', fields: [
    b('enabled', 'Enabled', true), r('thickness', 'Thickness (px)', 0, 40, 0.5, 3), c('color', 'Color', '#000000'), r('opacity', 'Opacity', 0, 1, 0.01, 1),
  ] },
  { id: 'glow', title: 'Outer glow', fields: [
    b('enabled', 'Enabled', false), r('size', 'Size (px)', 0, 80, 0.5, 16), c('color', 'Color', '#ffd166'), r('intensity', 'Intensity', 0, 3, 0.01, 1),
  ] },
  { id: 'dropShadow', title: 'Drop shadow', fields: [
    b('enabled', 'Enabled', false), r('offsetX', 'Offset X (px)', -60, 60, 0.5, 6), r('offsetY', 'Offset Y (px)', -60, 60, 0.5, -6),
    r('blur', 'Blur (px)', 0, 60, 0.5, 10), c('color', 'Color', '#000000'), r('opacity', 'Opacity', 0, 1, 0.01, 0.5),
  ] },
  { id: 'stylize', title: 'Stylize', fields: [
    r('sharpen', 'Sharpen', 0, 2, 0.01, 0), r('chroma', 'Chromatic aberration', 0, 20, 0.1, 0), r('pixelate', 'Pixelate (0 = off)', 0, 32, 1, 0),
    r('posterize', 'Posterize levels (0=off)', 0, 32, 1, 0), r('grain', 'Film grain', 0, 1, 0.01, 0), r('vignette', 'Vignette', 0, 1, 0.01, 0),
  ] },
  { id: 'background', title: 'Background', fields: [
    s('mode', 'Mode', ['transparent', 'solid', 'linear', 'radial', 'image'], 'transparent'), c('color1', 'Color 1', '#2b2d42'), c('color2', 'Color 2', '#0b0c10'), r('angle', 'Angle', 0, 360, 1, 90),
    { key: 'image', label: 'Image', type: 'image', def: '' }, s('imageFit', 'Image fit', ['cover', 'contain', 'stretch', 'tile'], 'cover'),
    r('imageScale', 'Image scale (Alt+wheel)', 0.05, 8, 0.01, 1), r('imageX', 'Image offset X (Alt+drag)', -1, 1, 0.005, 0), r('imageY', 'Image offset Y', -1, 1, 0.005, 0),
    r('imageRotation', 'Image rotation', -180, 180, 1, 0),
  ] },
];

// Color modes for text fill and stroke, like the model's color overlay. Angle 90 runs top to bottom.
export const FILLS = ['solid', 'gradient', 'radial', 'rainbow'];

// Text layers (settings.texts, drawn in order, last on top). Sizes are px at 512; x/y are -0.5..0.5 with +y up.
export const TEXT_FIELDS = [
  { key: 'text', label: 'Text', type: 'textarea', def: 'Text' }, { key: 'font', label: 'Font', type: 'font', def: 'Builder Sans' },
  { key: 'weight', label: 'Weight', type: 'weight', def: 800 }, b('italic', 'Italic', false),
  r('size', 'Size (px)', 4, 400, 1, 64), r('scaleX', 'Width stretch', 0.1, 5, 0.01, 1), r('scaleY', 'Height stretch', 0.1, 5, 0.01, 1), s('align', 'Align', ['center', 'left', 'right'], 'center'),
  r('spacing', 'Letter spacing (px)', -20, 100, 0.5, 0), r('lineHeight', 'Line height', 0.6, 3, 0.01, 1.1),
  s('fill', 'Fill', FILLS, 'solid'), c('color', 'Color', '#ffffff'), c('color2', 'Color 2 (gradient)', '#ffd166'),
  r('fillAngle', 'Gradient / rainbow angle', 0, 360, 1, 90), r('opacity', 'Opacity', 0, 1, 0.01, 1),
  r('strokeWidth', 'Stroke (px)', 0, 40, 0.5, 6), s('strokeFill', 'Stroke fill', FILLS, 'solid'), c('strokeColor', 'Stroke color', '#000000'), c('strokeColor2', 'Stroke color 2', '#ffffff'),
  r('shadowSize', 'Shadow blur (px)', 0, 60, 0.5, 0), c('shadowColor', 'Shadow color', '#000000'), r('shadowX', 'Shadow X (px)', -60, 60, 0.5, 0), r('shadowY', 'Shadow Y (px)', -60, 60, 0.5, 4),
  r('x', 'Position X', -0.5, 0.5, 0.001, 0), r('y', 'Position Y', -0.5, 0.5, 0.001, 0.36),
  r('rotation', 'Rotation', -180, 180, 1, 0), r('curve', 'Curve (arc degrees)', -360, 360, 1, 0),
];
export function textLayer(patch = {}) {
  const t = { ...Object.fromEntries(TEXT_FIELDS.map((f) => [f.key, f.def])), id: Math.random().toString(36).slice(2, 10), ...patch };
  if (patch.gradient && !patch.fill) t.fill = 'gradient'; // layers saved before fill modes
  delete t.gradient;
  return t;
}

export function defaultSettings() {
  const out = {};
  for (const sec of SCHEMA) { out[sec.id] = {}; for (const f of sec.fields) out[sec.id][f.key] = f.def; }
  out.texts = [];
  return out;
}

// Fill in any keys missing from older saved settings.
export function withDefaults(saved) {
  const d = defaultSettings();
  for (const id of Object.keys(d)) if (id !== 'texts') Object.assign(d[id], saved?.[id]);
  d.texts = (Array.isArray(saved?.texts) ? saved.texts : []).map((t) => textLayer(t));
  return d;
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

// Edits from AI agents: merges { section: { key: value }, texts: [layers] } into settings, checking every key, type,
// range and option against the schema. A lighting preset applies first, so explicit values in the same patch win.
// Returns notes about anything ignored or clamped.
export function patchSettings(settings, patch) {
  const notes = [];
  for (const [id, vals] of Object.entries(patch ?? {})) {
    if (id === 'texts') {
      if (Array.isArray(vals)) settings.texts = vals.map((t) => textLayer(t && typeof t === 'object' ? t : { text: String(t) }));
      else notes.push('texts must be an array of text layers');
      continue;
    }
    const sec = SCHEMA.find((x) => x.id === id);
    if (!sec || !vals || typeof vals !== 'object') { notes.push(`unknown section "${id}"`); continue; }
    if (id === 'lighting' && LIGHTING_PRESETS[vals.preset]) for (const [sid, pv] of Object.entries(LIGHTING_PRESETS[vals.preset])) Object.assign(settings[sid], pv);
    for (const [k, v] of Object.entries(vals)) {
      const f = sec.fields.find((x) => x.key === k);
      if (!f) { notes.push(`unknown setting ${id}.${k}`); continue; }
      let val;
      if (f.type === 'range') { val = Number(v); if (Number.isFinite(val)) val = Math.min(f.max, Math.max(f.min, val)); else val = undefined; }
      else if (f.type === 'bool') val = typeof v === 'boolean' ? v : undefined;
      else if (f.type === 'color') val = /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined;
      else if (f.type === 'select') val = f.options.includes(v) ? v : undefined;
      else if (f.type === 'image') val = typeof v === 'string' && (v === '' || v.startsWith('data:image/')) ? v : undefined;
      if (val === undefined) { notes.push(`ignored ${id}.${k}: expected ${f.type === 'select' ? f.options.join(' | ') : f.type}`); continue; }
      if (f.type === 'range' && val !== Number(v)) notes.push(`${id}.${k} clamped to ${val}`);
      settings[id][k] = val;
    }
  }
  return notes;
}

export const hexToVec3 = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// ---------- app preferences (Settings dialog), stored in userData/prefs.json ----------
export const PREFS = [
  { id: 'appearance', title: 'Appearance', icon: 'appearance', fields: [
    { key: 'theme', label: 'Theme', type: 'select', options: ['dark', 'light', 'midnight', 'studio'], def: 'dark' },
    { key: 'accent', label: 'Accent color', type: 'color', def: '#5b8cff' },
    { key: 'uiScale', label: 'Interface size', type: 'select', options: ['90%', '100%', '110%', '125%'], def: '100%' },
    { key: 'splash', label: 'Launch animation', type: 'bool', def: true },
  ] },
  { id: 'activity', title: 'Discord activity', icon: 'activity', hint: 'While the Discord desktop app is open, your profile shows "Playing Roblox Icon Renderer".', fields: [
    { key: 'discordActivity', label: 'Show activity on Discord', type: 'bool', def: true },
    { key: 'discordFile', label: 'Show the file name', type: 'bool', def: true },
    { key: 'discordCount', label: 'Show how many files are open', type: 'bool', def: true },
    { key: 'discordTime', label: 'Show time elapsed', type: 'bool', def: true },
  ] },
  { id: 'behavior', title: 'Behavior', icon: 'behavior', fields: [
    { key: 'restoreSession', label: 'Reopen files from last time', type: 'bool', def: true },
    { key: 'closeToTray', label: 'Closing the window hides it to the tray', type: 'bool', def: false },
    { key: 'autoUpdate', label: 'Check for updates automatically', type: 'bool', def: true },
  ] },
  { id: 'studio', title: 'Roblox Studio', icon: 'plugin', hint: 'The plugin adds a "Send to Renderer" button to Studio\'s Plugins tab: each selected model, part or effect arrives here as its own render, and sending it again updates that render.', fields: [] },
  { id: 'agents', title: 'AI agents', icon: 'robot', hint: 'Connect an AI agent (Claude Code, Codex, Claude Desktop or any MCP client) and it can import models from Studio or Roblox, style them, look at previews and export icons, images and animations, all through this app. The app starts on its own when an agent needs it.', fields: [] },
  { id: 'access', title: 'Roblox access', icon: 'key', hint: 'An API key or cookie lets the app download meshes and textures referenced by your files.', fields: [] },
];
export const prefsWithDefaults = (saved) => ({ ...Object.fromEntries(PREFS.flatMap((s) => s.fields).map((f) => [f.key, f.def])), ...saved });
