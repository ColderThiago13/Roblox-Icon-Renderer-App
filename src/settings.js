// Per-file render settings. The schema drives both the UI panel and defaults.
// Pixel values are "px at 512" and scale with the output size.

const r = (key, label, min, max, step, def) => ({ key, label, type: 'range', min, max, step, def });
const b = (key, label, def) => ({ key, label, type: 'bool', def });
const c = (key, label, def) => ({ key, label, type: 'color', def });
const s = (key, label, options, def) => ({ key, label, type: 'select', options, def });

export const SCHEMA = [
  { id: 'camera', title: 'Camera', fields: [
    r('yaw', 'Rotation', -180, 180, 1, 30), r('pitch', 'Tilt', -89, 89, 1, 20), r('roll', 'Roll', -180, 180, 1, 0),
    r('zoom', 'Zoom', 0.2, 4, 0.01, 1), s('projection', 'Projection', ['perspective', 'orthographic'], 'perspective'),
    r('fov', 'Field of view', 5, 90, 1, 30), r('offsetX', 'Offset X', -0.5, 0.5, 0.005, 0), r('offsetY', 'Offset Y', -0.5, 0.5, 0.005, 0),
    r('padding', 'Padding', 0, 0.45, 0.01, 0.08), b('fitVfx', 'Fit VFX in frame', false),
  ] },
  { id: 'lighting', title: 'Lighting', fields: [
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
    s('mode', 'Mode', ['transparent', 'solid', 'linear', 'radial'], 'transparent'), c('color1', 'Color 1', '#2b2d42'), c('color2', 'Color 2', '#0b0c10'), r('angle', 'Angle', 0, 360, 1, 90),
  ] },
];

export function defaultSettings() {
  const out = {};
  for (const sec of SCHEMA) { out[sec.id] = {}; for (const f of sec.fields) out[sec.id][f.key] = f.def; }
  return out;
}

// Fill in any keys missing from older saved settings.
export function withDefaults(saved) {
  const d = defaultSettings();
  for (const id of Object.keys(d)) Object.assign(d[id], saved?.[id]);
  return d;
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

export const hexToVec3 = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
