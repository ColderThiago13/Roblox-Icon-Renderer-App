import * as THREE from 'three';

export const fsVS = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// colorspace_pars_fragment is already in three's ShaderMaterial prefix; tone mapping is ours (renderer.toneMapping stays off).
const common = THREE.ShaderChunk.tonemapping_pars_fragment;

export const bloomPrefilterFS = /* glsl */`
uniform sampler2D tSrc; uniform float threshold; uniform vec2 texel; varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + texel * vec2(-0.5, -0.5)).rgb; c += texture2D(tSrc, vUv + texel * vec2(0.5, -0.5)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(-0.5, 0.5)).rgb;  c += texture2D(tSrc, vUv + texel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float knee = threshold * 0.5;
  float soft = clamp(l - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  gl_FragColor = vec4(c * max(soft, l - threshold) / max(l, 1e-4), 1.0);
}`;

// Dual-filter (Kawase) down/up sampling.
export const downFS = /* glsl */`
uniform sampler2D tSrc; uniform vec2 texel; varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb; c += texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb;  c += texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;
export const upFS = /* glsl */`
uniform sampler2D tSrc; uniform vec2 texel; uniform float weight; varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + texel * vec2(-2.0, 0.0)).rgb; c += texture2D(tSrc, vUv + texel * vec2(2.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(0.0, -2.0)).rgb; c += texture2D(tSrc, vUv + texel * vec2(0.0, 2.0)).rgb;
  c += (texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb
      + texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb) * 2.0;
  gl_FragColor = vec4(c / 12.0 * weight, 1.0);
}`;

// HDR premultiplied scene + bloom -> display-space (sRGB) premultiplied, with grading, overlay and stylize.
export const gradeFS = common + /* glsl */`
uniform sampler2D tScene; uniform sampler2D tBloom; uniform vec2 texel;
uniform float bloomStrength; uniform int toneMode; uniform float exposure;
uniform float brightness, contrast, saturation, hue, gamma, temperature;
uniform int overlayMode; uniform int overlayBlend; uniform vec3 ov1, ov2; uniform float ovAngle, ovStrength;
uniform float chroma, sharpen, posterize, grain, vignette, seed;
varying vec2 vUv;

vec3 hsv2rgb(vec3 c) { vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y); }
vec3 hueShift(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  vec4 c = texture2D(tScene, uv);
  if (chroma > 0.0) {
    vec2 d = (uv - 0.5) * chroma * texel * 2.0;
    vec4 r = texture2D(tScene, uv + d), b = texture2D(tScene, uv - d);
    c = vec4(r.r, c.g, b.b, max(c.a, max(r.a, b.a)));
  }
  if (sharpen > 0.0) {
    vec4 n = texture2D(tScene, uv + vec2(texel.x, 0.0)) + texture2D(tScene, uv - vec2(texel.x, 0.0))
           + texture2D(tScene, uv + vec2(0.0, texel.y)) + texture2D(tScene, uv - vec2(0.0, texel.y));
    c = max(c + (c * 4.0 - n) * sharpen * 0.5, 0.0);
  }
  vec3 hdr = c.rgb + texture2D(tBloom, uv).rgb * bloomStrength;
  float a = clamp(max(c.a, max(hdr.r, max(hdr.g, hdr.b))), 0.0, 1.0);
  if (a <= 0.0) { gl_FragColor = vec4(0.0); return; }
  vec3 col = hdr / a * exposure;

  if (toneMode == 1) col = ACESFilmicToneMapping(col);
  else if (toneMode == 2) col = AgXToneMapping(col);
  else if (toneMode == 3) col = NeutralToneMapping(col);
  else col = clamp(col, 0.0, 1.0);
  col = sRGBTransferOETF(vec4(col, 1.0)).rgb;

  col *= brightness;
  col = (col - 0.5) * contrast + 0.5;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, saturation);
  if (hue != 0.0) col = hueShift(col, hue);
  col *= vec3(1.0 + temperature * 0.15, 1.0, 1.0 - temperature * 0.15);
  col = pow(max(col, 0.0), vec3(1.0 / gamma));

  if (overlayMode > 0) {
    vec2 dir = vec2(cos(ovAngle), sin(ovAngle));
    float t = clamp(dot(vUv - 0.5, dir) + 0.5, 0.0, 1.0);
    vec3 oc = overlayMode == 1 ? ov1 : overlayMode == 2 ? mix(ov1, ov2, t) : hsv2rgb(vec3(t, 0.75, 1.0));
    vec3 b;
    if (overlayBlend == 1) b = col * oc;
    else if (overlayBlend == 2) b = 1.0 - (1.0 - col) * (1.0 - oc);
    else if (overlayBlend == 3) b = mix(2.0 * col * oc, 1.0 - 2.0 * (1.0 - col) * (1.0 - oc), step(0.5, col));
    else if (overlayBlend == 4) b = vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))) * oc * 1.6;
    else b = oc;
    col = mix(col, b, ovStrength);
  }
  if (posterize >= 2.0) col = floor(col * posterize + 0.5) / posterize;
  if (grain > 0.0) col += (hash(vUv * 1024.0) - 0.5) * grain * 0.25;
  if (vignette > 0.0) col *= 1.0 - vignette * smoothstep(0.35, 0.95, length(vUv - 0.5) * 1.414);
  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}`;

// Jump flood: seeds are pixels with coverage; stores (seed px, seed alpha).
export const jfaInitFS = /* glsl */`
uniform sampler2D tMask; uniform vec2 res; varying vec2 vUv;
void main() {
  float a = texture2D(tMask, vUv).a;
  gl_FragColor = a > 0.02 ? vec4(floor(vUv * res), a, 1.0) : vec4(-1.0);
}`;
export const jfaStepFS = /* glsl */`
uniform sampler2D tSrc; uniform vec2 res; uniform float stepPx; varying vec2 vUv;
void main() {
  vec2 p = floor(vUv * res);
  vec4 best = vec4(-1.0); float bd = 1e9;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 q = p + vec2(float(x), float(y)) * stepPx;
    if (q.x < 0.0 || q.y < 0.0 || q.x >= res.x || q.y >= res.y) continue;
    vec4 s = texture2D(tSrc, (q + 0.5) / res);
    if (s.w < 0.0) continue;
    float d = distance(p, s.xy) - (s.z - 0.5);
    if (d < bd) { bd = d; best = s; }
  }
  gl_FragColor = best;
}`;
// -> signed-ish edge distance in px (<= 0 inside), 1e4 where no seed in range
export const jfaDistFS = /* glsl */`
uniform sampler2D tSrc; uniform vec2 res; varying vec2 vUv;
void main() {
  vec4 s = texture2D(tSrc, vUv);
  float d = s.w < 0.0 ? 1e4 : distance(floor(vUv * res), s.xy) - (s.z - 0.5);
  gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
}`;

// Outline / glow / drop shadow drawn under the image.
export const silhouetteFS = /* glsl */`
uniform sampler2D tColor; uniform sampler2D tDist; uniform vec2 texel;
uniform float outlineW; uniform vec3 outlineColor; uniform float outlineOpacity;
uniform float glowSize; uniform vec3 glowColor; uniform float glowIntensity;
uniform float shadowBlur; uniform vec2 shadowOffset; uniform vec3 shadowColor; uniform float shadowOpacity;
varying vec2 vUv;
vec4 over(vec4 top, vec4 bottom) { return top + bottom * (1.0 - top.a); }
void main() {
  vec4 c = texture2D(tColor, vUv);
  float d = texture2D(tDist, vUv).r;
  vec4 under = vec4(0.0);
  if (shadowOpacity > 0.0) {
    float ds = texture2D(tDist, vUv - shadowOffset * texel).r;
    float a = shadowBlur > 0.0 ? pow(1.0 - smoothstep(-0.25 * shadowBlur, shadowBlur, ds), 1.5) : clamp(0.5 - ds, 0.0, 1.0);
    a *= shadowOpacity;
    under = vec4(shadowColor * a, a);
  }
  if (glowIntensity > 0.0 && glowSize > 0.0) {
    float a = clamp(exp(-max(d, 0.0) / (glowSize * 0.4)) * glowIntensity, 0.0, 1.0);
    under = over(vec4(glowColor * a, a), under);
  }
  if (outlineW > 0.0 && outlineOpacity > 0.0) {
    float a = clamp(outlineW - d + 0.5, 0.0, 1.0) * outlineOpacity;
    under = over(vec4(outlineColor * a, a), under);
  }
  gl_FragColor = over(c, under);
}`;

// Highlight outline drawn on top (outside the adornee's mask only).
export const hlOutlineFS = /* glsl */`
uniform sampler2D tColor; uniform sampler2D tDist; uniform float width; uniform vec3 color; uniform float opacity;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tColor, vUv);
  float d = texture2D(tDist, vUv).r;
  float a = clamp(width - d + 0.5, 0.0, 1.0) * clamp(d + 0.5, 0.0, 1.0) * opacity;
  gl_FragColor = vec4(color * a, a) + c * (1.0 - a);
}`;

export const finalFS = /* glsl */`
uniform sampler2D tColor; uniform int bgMode; uniform vec3 bg1, bg2; uniform float bgAngle; uniform bool straight; uniform float pixelBlock;
varying vec2 vUv;
void main() {
  // Pixelate runs last so outline, glow, shadow and highlights are pixelated too (background stays smooth).
  vec4 c;
  if (pixelBlock > 0.0) { // average the block (4x4 taps) so thin outlines stay continuous
    vec2 b0 = floor(vUv / pixelBlock) * pixelBlock;
    c = vec4(0.0);
    for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) c += texture2D(tColor, b0 + (vec2(float(x), float(y)) + 0.5) * 0.25 * pixelBlock);
    c /= 16.0;
  } else c = texture2D(tColor, vUv);
  vec4 bg = vec4(0.0);
  if (bgMode == 1) bg = vec4(bg1, 1.0);
  else if (bgMode == 2) { float t = clamp(dot(vUv - 0.5, vec2(cos(bgAngle), sin(bgAngle))) + 0.5, 0.0, 1.0); bg = vec4(mix(bg1, bg2, t), 1.0); }
  else if (bgMode == 3) { float t = clamp(length(vUv - 0.5) * 1.414, 0.0, 1.0); bg = vec4(mix(bg1, bg2, t), 1.0); }
  vec4 o = c + bg * (1.0 - c.a);
  if (straight) o.rgb = o.a > 0.0 ? o.rgb / o.a : vec3(0.0);
  gl_FragColor = o;
}`;

export const copyAlphaFS = /* glsl */`uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, texture2D(tSrc, vUv).a); }`;
