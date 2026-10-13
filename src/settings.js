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

// Rarity frames (frame.style): border gradient colors. 'custom' uses the frame's own colors.
export const RARITIES = {
  common: ['#c9cdd8', '#7c8190'], uncommon: ['#6ef07a', '#1f9a3a'], rare: ['#5cb0ff', '#1d4fd6'],
  epic: ['#d27dff', '#6a1fd1'], legendary: ['#ffe066', '#ff8a00'], mythic: ['#ff5c7a', '#8a1fff'],
};

const CAMERA_FIELDS = [
  r('yaw', 'Rotation', -180, 180, 1, 30), r('pitch', 'Tilt', -89, 89, 1, 20), r('roll', 'Roll', -180, 180, 1, 0),
  r('zoom', 'Zoom', 0.01, 4, 0.0001, 1), s('projection', 'Projection', ['perspective', 'orthographic'], 'perspective'),
  r('fov', 'Field of view', 5, 90, 1, 30), r('offsetX', 'Offset X', -0.5, 0.5, 0.005, 0), r('offsetY', 'Offset Y', -0.5, 0.5, 0.005, 0),
  r('padding', 'Padding', 0, 0.45, 0.01, 0.08), b('fitVfx', 'Fit VFX in frame', false),
];

export const SCHEMA = [
  { id: 'camera', title: 'Camera', fields: CAMERA_FIELDS },
  { id: 'lighting', title: 'Lighting', fields: [
    s('preset', 'Preset (optional)', ['none', ...Object.keys(LIGHTING_PRESETS)], 'none'),
    b('robloxSky', 'Roblox sky reflections', false),
    { key: 'hdri', label: 'HDRI environment (.hdr, .exr, image)', type: 'hdri', def: '' }, r('hdriRotation', 'HDRI rotation', -180, 180, 1, 0),
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
  { id: 'ao', title: 'Ambient occlusion', fields: [
    b('enabled', 'Enabled', false), r('radius', 'Radius (of model size)', 0.01, 1, 0.01, 0.12), r('intensity', 'Intensity', 0, 3, 0.01, 1),
  ] },
  { id: 'toon', title: 'Toon shading', fields: [
    b('enabled', 'Enabled', false), r('bands', 'Light bands', 2, 8, 1, 3),
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
  // Procedural idle motion on the timeline clock (no rig needed): for animated item icons.
  { id: 'motion', title: 'Motion', fields: [
    s('mode', 'Mode', ['none', 'float', 'bounce', 'wobble', 'spin', 'pulse'], 'none'), r('amount', 'Amount', 0, 2, 0.01, 1), r('speed', 'Speed (cycles/s)', 0.05, 4, 0.05, 0.5),
  ] },
  { id: 'pedestal', title: 'Pedestal', fields: [
    s('shape', 'Shape', ['none', 'disc', 'podium', 'platform', 'grass', 'hexagon'], 'none'), c('color', 'Color', '#3a3f55'), c('color2', 'Trim / top color', '#5b8cff'),
    r('size', 'Size', 0.5, 3, 0.01, 1.1), r('height', 'Height', 0.02, 1, 0.01, 0.12), r('gap', 'Gap under model', -0.5, 0.5, 0.005, 0),
    b('outline', 'Outline/glow includes pedestal', false),
  ] },
  { id: 'reflection', title: 'Reflection floor', fields: [
    b('enabled', 'Enabled', false), r('opacity', 'Opacity', 0, 1, 0.01, 0.35), r('fade', 'Fade length', 0.05, 1, 0.01, 0.4),
  ] },
  { id: 'bloom', title: 'Bloom', fields: [
    b('enabled', 'Enabled', true), r('threshold', 'Threshold', 0, 4, 0.01, 1.5), r('strength', 'Strength', 0, 3, 0.01, 0.6), r('radius', 'Radius', 0, 1, 0.01, 0.6),
  ] },
  { id: 'lensFlare', title: 'Lens flare & streaks', fields: [
    b('enabled', 'Enabled', false), r('threshold', 'Threshold', 0, 4, 0.01, 1.2), r('streaks', 'Anamorphic streaks', 0, 3, 0.01, 1), r('streakLength', 'Streak length', 0, 1, 0.01, 0.6),
    c('streakColor', 'Streak color', '#8fb8ff'), r('ghosts', 'Flare ghosts', 0, 3, 0.01, 0.6), r('halo', 'Halo', 0, 3, 0.01, 0.3),
  ] },
  { id: 'color', title: 'Color', fields: [
    r('brightness', 'Brightness', 0, 3, 0.01, 1), r('contrast', 'Contrast', 0, 3, 0.01, 1), r('saturation', 'Saturation', 0, 3, 0.01, 1),
    r('hue', 'Hue shift', -180, 180, 1, 0), r('gamma', 'Gamma', 0.2, 3, 0.01, 1), r('temperature', 'Temperature', -1, 1, 0.01, 0),
  ] },
  { id: 'lut', title: 'LUT color grade', fields: [
    { key: 'image', label: 'LUT (.cube or PNG)', type: 'lut', def: '' }, r('strength', 'Strength', 0, 1, 0.01, 1),
  ] },
  { id: 'overlay', title: 'Color overlay', fields: [
    s('mode', 'Mode', ['none', 'solid', 'gradient', 'rainbow'], 'none'), s('blend', 'Blend', ['normal', 'multiply', 'screen', 'overlay', 'tint'], 'tint'),
    c('color1', 'Color 1', '#ff4d6d'), c('color2', 'Color 2', '#4d7cff'), r('angle', 'Angle', 0, 360, 1, 90), r('strength', 'Strength', 0, 1, 0.01, 0.5),
  ] },
  { id: 'rim', title: 'Rim glow', fields: [
    b('enabled', 'Enabled', false), c('color', 'Color', '#ffffff'), r('intensity', 'Intensity', 0, 3, 0.01, 0.8), r('power', 'Sharpness', 0.5, 8, 0.1, 3),
  ] },
  { id: 'edges', title: 'Inner edge lines', fields: [
    b('enabled', 'Enabled', false), r('thickness', 'Thickness (px)', 0.5, 4, 0.1, 1), c('color', 'Color', '#000000'), r('opacity', 'Opacity', 0, 1, 0.01, 1),
    r('depth', 'Depth sensitivity', 0, 1, 0.01, 0.5), r('normal', 'Angle sensitivity', 0, 1, 0.01, 0.5),
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
  { id: 'innerShadow', title: 'Inner shadow', fields: [
    b('enabled', 'Enabled', false), r('offsetX', 'Offset X (px)', -40, 40, 0.5, 3), r('offsetY', 'Offset Y (px)', -40, 40, 0.5, -3),
    r('blur', 'Blur (px)', 0, 40, 0.5, 6), c('color', 'Color', '#000000'), r('opacity', 'Opacity', 0, 1, 0.01, 0.6),
  ] },
  { id: 'bevel', title: 'Bevel', fields: [
    b('enabled', 'Enabled', false), r('size', 'Size (px)', 1, 40, 0.5, 6), r('angle', 'Light angle', 0, 360, 1, 135),
    c('highlight', 'Highlight', '#ffffff'), c('shadow', 'Shadow', '#000000'), r('strength', 'Strength', 0, 1, 0.01, 0.6),
  ] },
  { id: 'godRays', title: 'Light rays', fields: [
    b('enabled', 'Enabled', false), r('x', 'Source X', -0.5, 0.5, 0.005, 0), r('y', 'Source Y', -0.5, 0.5, 0.005, 0.15), c('color', 'Color', '#fff1c4'),
    r('intensity', 'Intensity', 0, 3, 0.01, 1), r('length', 'Length', 0, 1, 0.01, 0.6), r('size', 'Source size', 0.02, 1, 0.01, 0.3),
  ] },
  { id: 'dof', title: 'Depth of field', fields: [
    b('enabled', 'Enabled', false), r('focus', 'Focus (near → far)', 0, 1, 0.01, 0.5), r('blur', 'Blur (px)', 0, 20, 0.1, 6),
  ] },
  { id: 'tiltShift', title: 'Tilt-shift', fields: [
    b('enabled', 'Enabled', false), r('center', 'Band center', -0.5, 0.5, 0.005, 0), r('width', 'Sharp band width', 0, 1, 0.01, 0.25),
    r('blur', 'Blur (px)', 0, 20, 0.1, 8), r('angle', 'Angle', -90, 90, 1, 0),
  ] },
  { id: 'blur', title: 'Blur', fields: [
    b('enabled', 'Enabled', false), r('size', 'Blur (px)', 0, 40, 0.1, 4), s('target', 'Apply to', ['both', 'model', 'background'], 'both'),
  ] },
  { id: 'stylize', title: 'Stylize', fields: [
    r('sharpen', 'Sharpen', 0, 2, 0.01, 0), r('chroma', 'Chromatic aberration', 0, 20, 0.1, 0), r('pixelate', 'Pixelate (0 = off)', 0, 32, 1, 0),
    r('posterize', 'Posterize levels (0=off)', 0, 32, 1, 0), r('grain', 'Film grain', 0, 1, 0.01, 0), r('vignette', 'Vignette', 0, 1, 0.01, 0),
  ] },
  { id: 'halftone', title: 'Halftone', fields: [
    b('enabled', 'Enabled', false), s('mode', 'Mode', ['color', 'mono', 'cmyk'], 'color'), r('size', 'Dot size (px)', 2, 40, 0.5, 6),
    r('angle', 'Screen angle', 0, 90, 1, 45), c('ink', 'Ink color (mono)', '#111111'), r('strength', 'Strength', 0, 1, 0.01, 1),
  ] },
  { id: 'dither', title: 'Dithering', fields: [
    b('enabled', 'Enabled', false), s('palette', 'Palette', ['levels', '1-bit', 'gameboy', 'pico-8', 'cga', 'sepia'], 'levels'),
    r('levels', 'Levels per channel', 2, 16, 1, 4), s('pattern', 'Pattern', ['bayer4x4', 'bayer8x8'], 'bayer4x4'), r('spread', 'Spread', 0, 1, 0.01, 1),
  ] },
  { id: 'retro', title: 'Retro (CRT / VHS)', fields: [
    r('scanlines', 'Scanlines', 0, 1, 0.01, 0), r('scanlineSize', 'Scanline size (px)', 1, 8, 0.5, 2), r('curvature', 'CRT curvature', 0, 1, 0.01, 0),
    r('mask', 'RGB mask', 0, 1, 0.01, 0), r('vhs', 'VHS wobble & bleed', 0, 1, 0.01, 0), r('noise', 'Noise lines', 0, 1, 0.01, 0),
  ] },
  { id: 'background', title: 'Background', fields: [
    s('mode', 'Mode', ['transparent', 'solid', 'linear', 'radial', 'image', 'sunburst', 'stripes', 'dots', 'stars'], 'transparent'),
    c('color1', 'Color 1', '#2b2d42'), c('color2', 'Color 2', '#0b0c10'), r('angle', 'Angle', 0, 360, 1, 90),
    r('patternCount', 'Pattern count (rays, stripes)', 2, 64, 1, 16), r('patternScale', 'Pattern scale', 0.1, 4, 0.01, 1), r('patternSpin', 'Pattern spin (°/s on the timeline)', -180, 180, 1, 0),
    { key: 'image', label: 'Image', type: 'image', def: '' }, s('imageFit', 'Image fit', ['cover', 'contain', 'stretch', 'tile'], 'cover'),
    r('imageScale', 'Image scale (Alt+wheel)', 0.05, 8, 0.01, 1), r('imageX', 'Image offset X (Alt+drag)', -1, 1, 0.005, 0), r('imageY', 'Image offset Y', -1, 1, 0.005, 0),
    r('imageRotation', 'Image rotation', -180, 180, 1, 0),
  ] },
  { id: 'frame', title: 'Rarity frame', fields: [
    s('style', 'Rarity', ['none', ...Object.keys(RARITIES), 'custom'], 'none'), s('shape', 'Shape', ['rounded', 'circle', 'square'], 'rounded'),
    r('thickness', 'Thickness (px)', 1, 40, 0.5, 10), r('radius', 'Corner radius', 0, 0.5, 0.01, 0.12), r('inset', 'Inset', 0, 0.2, 0.005, 0.03),
    r('glow', 'Glow', 0, 2, 0.01, 0.6), c('color1', 'Color 1 (custom)', '#ffe066'), c('color2', 'Color 2 (custom)', '#ff8a00'),
  ] },
];

// Effects the before/after compare turns off: everything after the 3D render, except background and text.
const POST_OFF = { bloom: { enabled: false }, lensFlare: { enabled: false }, ao: { enabled: false }, toon: { enabled: false },
  color: { brightness: 1, contrast: 1, saturation: 1, hue: 0, gamma: 1, temperature: 0 }, lut: { image: '' }, overlay: { mode: 'none' },
  rim: { enabled: false }, edges: { enabled: false }, outline: { enabled: false }, glow: { enabled: false }, dropShadow: { enabled: false },
  innerShadow: { enabled: false }, bevel: { enabled: false }, godRays: { enabled: false }, dof: { enabled: false }, tiltShift: { enabled: false }, blur: { enabled: false },
  stylize: { sharpen: 0, chroma: 0, pixelate: 0, posterize: 0, grain: 0, vignette: 0 }, halftone: { enabled: false }, dither: { enabled: false },
  retro: { scanlines: 0, curvature: 0, mask: 0, vhs: 0, noise: 0 }, frame: { style: 'none' } };
export function withoutPost(s) {
  const o = { ...s, strokes: [] };
  for (const [id, vals] of Object.entries(POST_OFF)) o[id] = { ...s[id], ...vals };
  return o;
}

// Extra outline strokes (settings.strokes), stacked outward from the outline: first = innermost.
export const STROKE_FIELDS = [c('color', 'Color', '#ffffff'), r('width', 'Width (px)', 0.5, 40, 0.5, 4), r('opacity', 'Opacity', 0, 1, 0.01, 1)];
export const strokeLayer = (patch = {}) => ({ ...Object.fromEntries(STROKE_FIELDS.map((f) => [f.key, f.def])), id: Math.random().toString(36).slice(2, 10), ...patch });

// Camera keyframes (settings.camKeys) on the timeline clock: the camera eases between them during playback and exports.
const KEYED = ['yaw', 'pitch', 'roll', 'zoom', 'offsetX', 'offsetY'];
export const CAMKEY_FIELDS = [r('t', 'Time (s)', 0, 60, 0.001, 0), ...CAMERA_FIELDS.filter((f) => KEYED.includes(f.key))];
const camKey = (patch = {}) => ({ ...Object.fromEntries(CAMKEY_FIELDS.map((f) => [f.key, f.def])), ...patch });
export function cameraAt(keys, t) {
  if (!keys?.length) return null;
  const k = [...keys].sort((a, b) => a.t - b.t);
  if (t <= k[0].t) return Object.fromEntries(KEYED.map((n) => [n, k[0][n]]));
  if (t >= k.at(-1).t) return Object.fromEntries(KEYED.map((n) => [n, k.at(-1)[n]]));
  const i = k.findIndex((x) => x.t > t), a = k[i - 1], b = k[i], u = (t - a.t) / Math.max(1e-6, b.t - a.t), e = u * u * (3 - 2 * u);
  return Object.fromEntries(KEYED.map((n) => {
    let d = b[n] - a[n];
    if (n === 'yaw' || n === 'roll') d = ((d + 540) % 360) - 180; // shortest way around
    const v = a[n] + d * e;
    return [n, n === 'yaw' || n === 'roll' ? ((v + 540) % 360) - 180 : v];
  }));
}

// "Surprise me": a coherent random look (lighting, background, outline, glow) within tasteful ranges.
const hsl = (h, s, l) => {
  h = ((h % 360) + 360) % 360;
  const f = (n) => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
};
export function randomLook(rand = Math.random) {
  const pick = (a) => a[Math.floor(rand() * a.length)], range = (a, b) => a + rand() * (b - a), hue = rand() * 360;
  return {
    camera: { yaw: Math.round(range(15, 45)) * (rand() < 0.5 ? -1 : 1), pitch: Math.round(range(8, 25)) },
    lighting: { preset: pick(Object.keys(LIGHTING_PRESETS)), keyYaw: Math.round(range(-70, 70)), keyPitch: Math.round(range(25, 60)), rimColor: hsl(hue + 180, 0.6, 0.8) },
    background: { mode: pick(['linear', 'radial', 'radial', 'sunburst', 'stars', 'dots']), color1: hsl(hue, 0.55, 0.45), color2: hsl(hue + range(-40, 40), 0.6, 0.12),
      angle: Math.round(range(45, 135)), patternCount: pick([12, 16, 20, 24]) },
    outline: { enabled: rand() < 0.8, thickness: +range(2, 6).toFixed(1), color: rand() < 0.7 ? '#000000' : hsl(hue, 0.7, 0.2) },
    glow: { enabled: rand() < 0.35, color: hsl(hue + 30, 0.9, 0.65), size: Math.round(range(8, 24)) },
    bloom: { enabled: true, strength: +range(0.3, 0.9).toFixed(2) },
    rim: { enabled: rand() < 0.5, color: hsl(hue + 180, 0.5, 0.85), intensity: +range(0.3, 1).toFixed(2) },
  };
}

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

// Settings that are lists of layers: key -> [fields, make(patch)].
const LISTS = { texts: [TEXT_FIELDS, textLayer], strokes: [STROKE_FIELDS, strokeLayer], camKeys: [CAMKEY_FIELDS, camKey] };

export function defaultSettings() {
  const out = {};
  for (const sec of SCHEMA) { out[sec.id] = {}; for (const f of sec.fields) out[sec.id][f.key] = f.def; }
  for (const k of Object.keys(LISTS)) out[k] = [];
  return out;
}

// Fill in any keys missing from older saved settings.
export function withDefaults(saved) {
  const d = defaultSettings();
  for (const id of Object.keys(d)) if (!LISTS[id]) Object.assign(d[id], saved?.[id]);
  for (const [k, [, make]] of Object.entries(LISTS)) d[k] = (Array.isArray(saved?.[k]) ? saved[k] : []).map((t) => make(t));
  return d;
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

// One schema field: the accepted (clamped) value, or undefined when v doesn't fit the field.
function checkValue(f, v) {
  switch (f.type) {
    case 'range': { const n = Number(v); return Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : undefined; }
    case 'bool': return typeof v === 'boolean' ? v : undefined;
    case 'color': return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined;
    case 'select': return f.options.includes(v) ? v : undefined;
    case 'image': case 'lut': return typeof v === 'string' && (v === '' || v.startsWith('data:image/')) ? v : undefined;
    case 'hdri': return typeof v === 'string' && /^([0-9a-f]{8,64}\.(hdr|exr|png|jpe?g|webp))?$/i.test(v) ? v : undefined; // a file in the app's HDRI library
    case 'textarea': return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
    case 'font': return typeof v === 'string' && /^[^"\\;{}]{1,100}$/.test(v.trim()) ? v.trim() : undefined; // goes into a CSS font string
    case 'weight': { const n = Math.round(Number(v)); return n >= 1 && n <= 1000 ? n : undefined; }
  }
}
const expected = (f) => (f.type === 'select' ? f.options.join(' | ') : f.type === 'range' ? `number ${f.min}..${f.max}` : f.type);

// Validates and applies { key: value } for one schema section (or a text layer) into target; notes what was dropped.
function applyFields(target, fields, vals, label, notes) {
  for (const [k, v] of Object.entries(vals)) {
    const f = fields.find((x) => x.key === k);
    if (!f) { notes.push(`unknown setting ${label}.${k}`); continue; }
    const val = checkValue(f, v);
    if (val === undefined) { notes.push(`ignored ${label}.${k}: expected ${expected(f)}`); continue; }
    if (f.type === 'range' && val !== Number(v)) notes.push(`${label}.${k} clamped to ${val}`);
    target[k] = val;
  }
}

// Edits from AI agents: merges { section: { key: value }, texts/strokes/camKeys: [layers] } into settings, checking
// every key, type, range and option against the schema (layers against their fields). A lighting preset applies first,
// so explicit values in the same patch win. Returns notes about anything ignored or clamped.
export function patchSettings(settings, patch) {
  const notes = [];
  for (const [id, vals] of Object.entries(patch ?? {})) {
    if (LISTS[id]) {
      if (!Array.isArray(vals)) { notes.push(`${id} must be an array`); continue; }
      const [fields, make] = LISTS[id], ids = new Set();
      settings[id] = vals.flatMap((t, i) => {
        if (id === 'texts' && typeof t === 'string') t = { text: t };
        if (!t || typeof t !== 'object' || Array.isArray(t)) { notes.push(`${id}[${i}] ignored: expected ${id === 'texts' ? 'a text layer object' : 'an object'}`); return []; }
        const { id: wantId, gradient, ...rest } = t;
        const layer = make();
        if (gradient && !rest.fill && id === 'texts') layer.fill = 'gradient'; // layers saved before fill modes
        applyFields(layer, fields, rest, `${id}[${i}]`, notes);
        if ('id' in layer && typeof wantId === 'string' && wantId && !ids.has(wantId)) layer.id = wantId;
        ids.add(layer.id);
        return [layer];
      });
      continue;
    }
    const sec = SCHEMA.find((x) => x.id === id);
    if (!sec || !vals || typeof vals !== 'object') { notes.push(`unknown section "${id}"`); continue; }
    if (id === 'lighting' && LIGHTING_PRESETS[vals.preset]) for (const [sid, pv] of Object.entries(LIGHTING_PRESETS[vals.preset])) Object.assign(settings[sid], pv);
    applyFields(settings[id], sec.fields, vals, id, notes);
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
