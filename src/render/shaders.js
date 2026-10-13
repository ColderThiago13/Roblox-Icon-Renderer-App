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
  // One NaN/Inf pixel would otherwise blur across the whole frame and blacken it.
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
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

// Lens flare: anamorphic streaks (a horizontal blur chain of the bright pass) plus ghosts and a halo mirrored
// through the frame center (after John Chapman's pseudo lens flare).
export const streakFS = /* glsl */`
uniform sampler2D tSrc; uniform vec2 texel; uniform float stepPx; varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.24;
  for (int i = 1; i <= 3; i++) {
    float w = i == 1 ? 0.2 : i == 2 ? 0.12 : 0.06;
    vec2 o = vec2(float(i) * stepPx * texel.x, 0.0);
    c += (texture2D(tSrc, vUv + o).rgb + texture2D(tSrc, vUv - o).rgb) * w;
  }
  gl_FragColor = vec4(c, 1.0);
}`;
export const flareFS = /* glsl */`
uniform sampler2D tBright, tStreak; uniform vec3 streakColor; uniform float streaks, ghosts, halo; varying vec2 vUv;
void main() {
  vec2 uv = 1.0 - vUv, toC = (vec2(0.5) - uv) * 0.45;
  vec3 g = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 p = fract(uv + toC * float(i));
    float w = pow(1.0 - length(vec2(0.5) - p) / 0.7071, 8.0);
    vec3 tint = i == 1 ? vec3(1.0, 0.7, 0.4) : i == 2 ? vec3(0.5, 0.8, 1.0) : i == 3 ? vec3(0.8, 1.0, 0.6) : vec3(1.0);
    g += texture2D(tBright, p).rgb * w * tint;
  }
  vec2 hv = normalize(vec2(0.5) - uv + 1e-5) * 0.4;
  float hw = pow(1.0 - length(vec2(0.5) - fract(uv + hv)) / 0.7071, 6.0);
  vec3 h = vec3(texture2D(tBright, uv + hv * 1.02).r, texture2D(tBright, uv + hv).g, texture2D(tBright, uv + hv * 0.98).b) * hw;
  gl_FragColor = vec4(texture2D(tStreak, vUv).rgb * streakColor * streaks + g * ghosts * 0.5 + h * halo, 1.0);
}`;

// Screen-space ambient occlusion from the normal/depth pass (view-space hemisphere samples), then a depth-aware blur.
export const aoFS = /* glsl */`
uniform sampler2D tNormal, tDepth; uniform mat4 proj, projInv; uniform float radius; uniform vec2 res; varying vec2 vUv;
vec3 viewPos(vec2 uv) { vec4 p = projInv * vec4(uv * 2.0 - 1.0, texture2D(tDepth, uv).r * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
void main() {
  if (texture2D(tDepth, vUv).r >= 1.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv), N = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
  vec3 T = normalize(cross(N, abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))), B = cross(N, T);
  vec2 cell = mod(floor(vUv * res), 4.0); // 4x4 interleaved rotations, which the 4x4 blur below averages out
  float a0 = (cell.x * 4.0 + cell.y) / 16.0 * 6.2831853, occ = 0.0;
  for (int i = 0; i < 16; i++) {
    float f = (float(i) + 0.5) / 16.0, th = a0 + float(i) * 2.39996;
    vec3 dir = (T * cos(th) + B * sin(th)) * sqrt(f) + N * sqrt(1.0 - f);
    vec3 S = P + dir * radius * mix(0.15, 1.0, f * f);
    vec4 c = proj * vec4(S, 1.0);
    vec2 su = c.xy / c.w * 0.5 + 0.5;
    if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0 || texture2D(tDepth, su).r >= 1.0) continue;
    vec3 Q = viewPos(su);
    occ += step(S.z + radius * 0.03, Q.z) * smoothstep(0.0, 1.0, radius / max(abs(P.z - Q.z), 1e-5));
  }
  gl_FragColor = vec4(vec3(1.0 - occ / 16.0), 1.0);
}`;
export const aoBlurFS = /* glsl */`
uniform sampler2D tAO, tDepth; uniform vec2 texel; varying vec2 vUv;
void main() {
  float z0 = texture2D(tDepth, vUv).r, sum = 0.0, wsum = 0.0;
  for (int y = -2; y <= 1; y++) for (int x = -2; x <= 1; x++) {
    vec2 uv = vUv + (vec2(float(x), float(y)) + 0.5) * texel;
    float w = 1.0 / (1.0 + abs(texture2D(tDepth, uv).r - z0) * 4000.0);
    sum += texture2D(tAO, uv).r * w; wsum += w;
  }
  gl_FragColor = vec4(vec3(sum / wsum), 1.0);
}`;

// HDR premultiplied scene + bloom -> display-space (sRGB) premultiplied, with grading, overlay and stylize.
export const gradeFS = common + /* glsl */`
uniform sampler2D tScene; uniform sampler2D tBloom; uniform vec2 texel;
uniform float bloomStrength; uniform int toneMode; uniform float exposure;
uniform float brightness, contrast, saturation, hue, gamma, temperature;
uniform int overlayMode; uniform int overlayBlend; uniform vec3 ov1, ov2; uniform float ovAngle, ovStrength;
uniform float chroma, sharpen, posterize, grain, vignette, seed;
uniform sampler2D tFlare, tAO, tNormal, tDepth, tLut; uniform float aoAmount, lutSize, lutStrength; uniform mat4 projInv;
uniform float rimOn, rimPower; uniform vec3 rimColor;
uniform float edgeW, edgeOpacity, edgeDepth, edgeNormal; uniform vec3 edgeColor;
uniform int htMode; uniform float htSize, htAngle, htStrength; uniform vec3 htInk;
varying vec2 vUv;

float viewZ(vec2 uv) { vec4 p = projInv * vec4(uv * 2.0 - 1.0, texture2D(tDepth, uv).r * 2.0 - 1.0, 1.0); return p.z / p.w; }
// Creases and depth steps inside the model (second derivative of depth, normal differences).
float edgeAt(vec2 uv) {
  vec2 ox = vec2(texel.x * edgeW, 0.0), oy = vec2(0.0, texel.y * edgeW);
  vec4 n0 = texture2D(tNormal, uv);
  if (n0.a < 0.5) return 0.0;
  vec4 a = texture2D(tNormal, uv + ox), b = texture2D(tNormal, uv - ox), c = texture2D(tNormal, uv + oy), d = texture2D(tNormal, uv - oy);
  if (min(min(a.a, b.a), min(c.a, d.a)) < 0.5) return 0.0; // the silhouette belongs to the outline
  vec3 n = n0.xyz * 2.0 - 1.0;
  float nd = 4.0 - dot(n, a.xyz * 2.0 - 1.0) - dot(n, b.xyz * 2.0 - 1.0) - dot(n, c.xyz * 2.0 - 1.0) - dot(n, d.xyz * 2.0 - 1.0);
  float z = viewZ(uv), dd = (abs(viewZ(uv + ox) + viewZ(uv - ox) - 2.0 * z) + abs(viewZ(uv + oy) + viewZ(uv - oy) - 2.0 * z)) / max(abs(z), 1e-4);
  float tn = mix(1.6, 0.06, edgeNormal), td = mix(0.08, 0.0008, edgeDepth);
  return max(smoothstep(tn, tn * 1.6, nd), smoothstep(td, td * 1.6, dd));
}
vec3 lut(vec3 c) {
  float n = lutSize; c = clamp(c, 0.0, 1.0) * (n - 1.0);
  float b0 = floor(c.b), b1 = min(b0 + 1.0, n - 1.0);
  vec2 uv = vec2((c.r + 0.5) / (n * n), (c.g + 0.5) / n);
  return mix(texture2D(tLut, uv + vec2(b0 / n, 0.0)).rgb, texture2D(tLut, uv + vec2(b1 / n, 0.0)).rgb, c.b - b0);
}
// Dot coverage of a halftone screen at angle a for ink amount v (0..1).
float screen(vec2 px, float a, float v) {
  vec2 p = mat2(cos(a), -sin(a), sin(a), cos(a)) * px / htSize;
  float r = sqrt(clamp(v, 0.0, 1.0)) * 0.7071, d = length(fract(p) - 0.5), aa = 0.75 / htSize;
  return 1.0 - smoothstep(r - aa, r + aa, d);
}

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
  if (aoAmount > 0.0) c.rgb *= pow(texture2D(tAO, uv).r, aoAmount);
  vec3 hdr = c.rgb + texture2D(tBloom, uv).rgb * bloomStrength + texture2D(tFlare, uv).rgb;
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
  if (rimOn > 0.0) { vec4 n = texture2D(tNormal, uv); col += rimColor * pow(1.0 - clamp(n.z * 2.0 - 1.0, 0.0, 1.0), rimPower) * rimOn * n.a; }

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
  if (lutStrength > 0.0) col = mix(col, lut(col), lutStrength);
  if (posterize >= 2.0) col = floor(col * posterize + 0.5) / posterize;
  if (htMode > 0) {
    vec2 px = vUv / texel;
    float l = dot(clamp(col, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722)), t = radians(htAngle);
    vec3 ht;
    if (htMode == 1) ht = col / max(l, 0.05) * screen(px, t, l) * min(l * 3.0, 1.0); // color dots sized by brightness
    else if (htMode == 2) ht = mix(vec3(1.0), htInk, screen(px, t, 1.0 - l));
    else {
      vec3 cmy = 1.0 - clamp(col, 0.0, 1.0); float k = min(cmy.r, min(cmy.g, cmy.b)); cmy = (cmy - k) / max(1.0 - k, 1e-3);
      float K = screen(px, t, k);
      ht = vec3(1.0 - screen(px, t - 0.2618, cmy.r), 1.0 - screen(px, t + 0.2618, cmy.g), 1.0 - screen(px, t - 0.7854, cmy.b)) * (1.0 - K);
    }
    col = mix(col, ht, htStrength);
  }
  if (grain > 0.0) col += (hash(vUv * 1024.0) - 0.5) * grain * 0.25;
  if (vignette > 0.0) col *= 1.0 - vignette * smoothstep(0.35, 0.95, length(vUv - 0.5) * 1.414);
  if (edgeOpacity > 0.0) col = mix(col, edgeColor, edgeAt(uv) * edgeOpacity);
  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}`;

// Depth of field (blur grows with distance from the focus depth) and tilt-shift (outside a sharp band), one gather pass.
export const lensBlurFS = /* glsl */`
uniform sampler2D tSrc, tDepth; uniform vec2 texel; uniform mat4 projInv;
uniform float dofBlur, focusZ, dofRange, tiltBlur, tiltCenter, tiltWidth; uniform vec2 tiltNormal;
varying vec2 vUv;
float coc(vec2 uv) {
  float r = 0.0;
  if (dofBlur > 0.0) {
    float d = texture2D(tDepth, uv).r;
    vec4 p = projInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    float z = d >= 1.0 ? focusZ + dofRange : -p.z / p.w;
    r = clamp(abs(z - focusZ) / dofRange, 0.0, 1.0) * dofBlur;
  }
  if (tiltBlur > 0.0) r = max(r, smoothstep(tiltWidth * 0.5, tiltWidth * 0.5 + 0.25, abs(dot(uv - 0.5, tiltNormal) - tiltCenter)) * tiltBlur);
  return r;
}
void main() {
  float r = coc(vUv);
  vec4 c = texture2D(tSrc, vUv);
  if (r < 0.5) { gl_FragColor = c; return; }
  vec4 sum = c; float n = 1.0;
  for (int i = 1; i < 40; i++) {
    float f = sqrt(float(i) / 40.0), th = float(i) * 2.39996;
    vec2 uv = vUv + vec2(cos(th), sin(th)) * f * r * texel;
    float w = smoothstep(f * r - 1.0, f * r, coc(uv) + 0.5 * r); // sharp neighbors don't smear into the blur
    sum += texture2D(tSrc, uv) * w; n += w;
  }
  gl_FragColor = sum / n;
}`;

// Separable gaussian blur (premultiplied), one direction per pass; taps spread out past 32 px.
export const blurFS = /* glsl */`
uniform sampler2D tSrc; uniform vec2 dir; uniform float radius; varying vec2 vUv;
void main() {
  float sigma = max(radius, 0.5) * 0.5, st = max(1.0, radius / 32.0), wsum = 1.0;
  vec4 acc = texture2D(tSrc, vUv);
  for (int i = 1; i <= 32; i++) {
    float x = float(i) * st;
    if (x > radius) break;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    acc += (texture2D(tSrc, vUv + dir * x) + texture2D(tSrc, vUv - dir * x)) * w;
    wsum += 2.0 * w;
  }
  gl_FragColor = acc / wsum;
}`;

// Light rays: a glowing disc behind the model, blurred radially toward its center; the model blocks it.
export const raysFS = /* glsl */`
uniform sampler2D tMask; uniform vec2 light; uniform vec3 color; uniform float intensity, len, size; varying vec2 vUv;
float src(vec2 uv) { return (1.0 - texture2D(tMask, uv).a) * smoothstep(size, 0.0, distance(uv, light)); }
void main() {
  vec2 d = (light - vUv) * len / 64.0;
  float sum = 0.0, w = 1.0;
  vec2 p = vUv;
  for (int i = 0; i < 64; i++) { sum += src(p) * w; w *= 0.97; p += d; }
  float a = clamp(sum / 20.0 * intensity, 0.0, 1.0);
  gl_FragColor = vec4(color * a, a);
}`;

// Extra outline strokes, up to 8 per pass: rings stacked outward from radius r0 (they partition the distance, so they add).
export const strokesFS = /* glsl */`
uniform sampler2D tPrev, tDist; uniform vec4 col[8]; uniform float rad[8]; uniform float r0; uniform int count; varying vec2 vUv;
void main() {
  float d = texture2D(tDist, vUv).r, inner = clamp(r0 - d + 0.5, 0.0, 1.0);
  vec4 acc = texture2D(tPrev, vUv);
  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    float outer = clamp(rad[i] - d + 0.5, 0.0, 1.0), a = (outer - inner) * col[i].a;
    acc += vec4(col[i].rgb * a, a);
    inner = outer;
  }
  gl_FragColor = acc;
}`;

// Reflection floor: the mirrored model, fading out below the floor line, slid under what's already drawn.
export const reflectFS = /* glsl */`
uniform sampler2D tSrc; uniform float opacity, floorY, fadeLen; varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv) * opacity * (1.0 - smoothstep(0.0, fadeLen, floorY - vUv.y)) * step(vUv.y, floorY + 0.02); }`;

// CRT / VHS over the finished image (premultiplied in, straight out when asked).
export const retroFS = /* glsl */`
uniform sampler2D tSrc; uniform bool straight; uniform float scan, scanSize, curv, mask, vhs, noise, time;
varying vec2 vUv;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vec2 uv = vUv;
  if (curv > 0.0) {
    vec2 c = uv * 2.0 - 1.0;
    c *= 1.0 + curv * 0.18 * dot(c, c);
    uv = c * 0.5 + 0.5;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { gl_FragColor = vec4(0.0); return; }
  }
  if (vhs > 0.0) {
    float line = floor(uv.y * 180.0);
    uv.x += (hash(line + floor(time * 24.0) * 7.0) - 0.5) * 0.006 * vhs + sin(uv.y * 24.0 + time * 6.0) * 0.003 * vhs;
  }
  vec4 c = texture2D(tSrc, uv);
  if (vhs > 0.0) {
    vec2 o = vec2(0.004 * vhs, 0.0);
    vec4 l = texture2D(tSrc, uv - o), r = texture2D(tSrc, uv + o);
    c = vec4(r.r, (c.g + l.g + r.g) / 3.0, l.b, max(c.a, max(l.a, r.a)));
  }
  if (scan > 0.0) c.rgb *= 1.0 - scan * (0.5 + 0.5 * cos(uv.y * 512.0 / scanSize * 6.2831853));
  if (mask > 0.0) { float m = mod(floor(uv.x * 512.0), 3.0); c.rgb *= mix(vec3(1.0), vec3(m == 0.0 ? 1.4 : 0.7, m == 1.0 ? 1.4 : 0.7, m == 2.0 ? 1.4 : 0.7), mask); }
  if (noise > 0.0) {
    float y = floor(uv.y * 240.0), t = floor(time * 24.0);
    float n = step(1.0 - 0.03 * noise, hash(y * 1.7 + t * 13.1)) * 0.5 + (hash(dot(floor(uv * 512.0), vec2(1.0, 57.0)) + t) - 0.5) * 0.15 * noise;
    c.rgb += n * c.a;
  }
  c.rgb = clamp(c.rgb, 0.0, c.a);
  if (straight) c.rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  gl_FragColor = c;
}`;

// Jump flood: seeds are pixels with coverage; stores (seed px, seed alpha).
// invert: seeds are the empty pixels instead, giving the distance from inside the model to its edge.
export const jfaInitFS = /* glsl */`
uniform sampler2D tMask; uniform vec2 res; uniform bool invert; varying vec2 vUv;
void main() {
  float a = texture2D(tMask, vUv).a;
  if (invert) a = 1.0 - a;
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

// Outline / strokes / glow / drop shadow / light rays drawn under the image; inner shadow and bevel on it.
export const silhouetteFS = /* glsl */`
uniform sampler2D tColor; uniform sampler2D tDist; uniform sampler2D tDistIn; uniform sampler2D tStrokes; uniform sampler2D tRays; uniform vec2 texel;
uniform sampler2D tMask; // a = outlined coverage, r = pedestal left out of it (outline and strokes go over that)
uniform float outlineW; uniform vec3 outlineColor; uniform float outlineOpacity;
uniform float glowSize; uniform vec3 glowColor; uniform float glowIntensity;
uniform float shadowBlur; uniform vec2 shadowOffset; uniform vec3 shadowColor; uniform float shadowOpacity;
uniform float innerBlur, innerOpacity; uniform vec2 innerOffset; uniform vec3 innerColor;
uniform float bevelSize, bevelStrength; uniform vec2 bevelLight; uniform vec3 bevelHi, bevelLo;
varying vec2 vUv;
vec4 over(vec4 top, vec4 bottom) { return top + bottom * (1.0 - top.a); }
void main() {
  vec4 c = texture2D(tColor, vUv), m = texture2D(tMask, vUv);
  float d = texture2D(tDist, vUv).r;
  if (c.a > 0.0 && innerOpacity > 0.0) {
    float di = texture2D(tDistIn, vUv - innerOffset * texel).r;
    float a = (1.0 - smoothstep(0.0, innerBlur + 1.0, di)) * innerOpacity * m.a;
    c.rgb = mix(c.rgb, innerColor * c.a, a);
  }
  if (c.a > 0.0 && bevelStrength > 0.0) {
    float di = texture2D(tDistIn, vUv).r;
    if (di < bevelSize) {
      vec2 g = vec2(texture2D(tDistIn, vUv + vec2(texel.x, 0.0)).r - texture2D(tDistIn, vUv - vec2(texel.x, 0.0)).r,
                    texture2D(tDistIn, vUv + vec2(0.0, texel.y)).r - texture2D(tDistIn, vUv - vec2(0.0, texel.y)).r) * 0.5;
      float slope = 1.0 - clamp(di / bevelSize, 0.0, 1.0); // rounded edge: steep at the rim, flat inside
      float shade = dot(-g * slope * 1.6, bevelLight) * m.a;
      c.rgb = mix(c.rgb, bevelHi * c.a, clamp(shade, 0.0, 1.0) * bevelStrength);
      c.rgb = mix(c.rgb, bevelLo * c.a, clamp(-shade, 0.0, 1.0) * bevelStrength);
    }
  }
  vec4 under = texture2D(tRays, vUv);
  if (shadowOpacity > 0.0) {
    float ds = texture2D(tDist, vUv - shadowOffset * texel).r;
    float a = shadowBlur > 0.0 ? pow(1.0 - smoothstep(-0.25 * shadowBlur, shadowBlur, ds), 1.5) : clamp(0.5 - ds, 0.0, 1.0);
    a *= shadowOpacity;
    under = over(vec4(shadowColor * a, a), under);
  }
  if (glowIntensity > 0.0 && glowSize > 0.0) {
    float a = clamp(exp(-max(d, 0.0) / (glowSize * 0.4)) * glowIntensity, 0.0, 1.0);
    under = over(vec4(glowColor * a, a), under);
  }
  vec4 lines = texture2D(tStrokes, vUv);
  if (outlineW > 0.0 && outlineOpacity > 0.0) {
    float a = clamp(outlineW - d + 0.5, 0.0, 1.0) * outlineOpacity;
    lines = over(vec4(outlineColor * a, a), lines);
  }
  vec4 o = over(c, over(lines, under));
  gl_FragColor = mix(o, over(lines, o), m.r);
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
uniform sampler2D tBgImage; uniform sampler2D tText; // premultiplied 2D-canvas layers (render/overlay.js)
uniform float patCount, patScale, patSpin;
uniform int ditherMode; uniform float ditherLevels, ditherSpread; uniform bool bayer8; uniform vec3 pal[16]; uniform int palN;
uniform int frameShape; uniform vec2 crop; uniform float frameTh, frameRadius, frameInset, frameGlow; uniform vec3 fr1, fr2;
varying vec2 vUv;
vec4 over(vec4 top, vec4 bottom) { return top + bottom * (1.0 - top.a); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer(vec2 a) { return bayer8 ? bayer4(0.5 * a) * 0.25 + bayer2(a) : bayer4(a); }
// Background patterns (sunburst, stripes, dots, stars) from color 1 / color 2.
vec3 pattern(vec2 p) {
  float s = sin(patSpin), co = cos(patSpin), aa;
  p = mat2(co, -s, s, co) * p / patScale;
  if (bgMode == 5) {
    float a = atan(p.y, p.x) / 6.2831853 * patCount, f = abs(fract(a) - 0.5) * 2.0;
    aa = patCount / 6.2831853 * length(fwidth(p)) / max(length(p), 1e-4) * 2.0; // not fwidth(a): atan jumps by a full turn on one line
    vec3 rays = mix(bg2, bg1, smoothstep(0.5 - aa, 0.5 + aa, f));
    return mix(rays, bg1 * 1.15, smoothstep(0.32, 0.0, length(p)));
  }
  if (bgMode == 6) { float u = dot(p, vec2(0.7071, 0.7071)) * patCount * 0.5, t = fract(u); aa = fwidth(u) * 1.5; return mix(bg1, bg2, smoothstep(0.5 - aa, 0.5 + aa, t)); }
  if (bgMode == 7) { vec2 q = p * patCount * 0.5; q.x += mod(floor(q.y), 2.0) * 0.5; float d = length(fract(q) - 0.5); aa = fwidth(d) * 1.5; return mix(bg2, bg1, smoothstep(0.28 - aa, 0.28 + aa, d)); }
  vec3 sky = mix(bg1, bg2, clamp(length(p) * 1.414, 0.0, 1.0)); // stars
  for (int l = 0; l < 3; l++) {
    vec2 q = p * (patCount * (1.0 + float(l))) + float(l) * 17.0, cell = floor(q);
    vec2 o = vec2(hash(cell), hash(cell + 3.1)) * 0.7 + 0.15;
    float b = step(0.55, hash(cell + 7.7)), d = length(fract(q) - o), r = 0.05 + 0.06 * hash(cell + 9.2);
    sky += vec3(1.0, 0.97, 0.9) * b * smoothstep(r, 0.0, d) * (0.6 + 0.4 * hash(cell + 1.3));
  }
  return sky;
}
float sdRound(vec2 p, vec2 h, float r) { vec2 q = abs(p) - h + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  // Pixelate runs last so outline, glow, shadow and highlights are pixelated too (background stays smooth).
  vec4 c;
  if (pixelBlock > 0.0) { // average the block (4x4 taps) so thin outlines stay continuous
    vec2 b0 = floor(vUv / pixelBlock) * pixelBlock;
    c = vec4(0.0);
    for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) c += texture2D(tColor, b0 + (vec2(float(x), float(y)) + 0.5) * 0.25 * pixelBlock);
    c /= 16.0;
  } else c = texture2D(tColor, vUv);
  if (ditherMode > 0 && c.a > 0.0) { // ordered dither in 512-px cells (or pixelate blocks), to N levels or a palette
    vec2 cell = pixelBlock > 0.0 ? floor(vUv / pixelBlock) : floor(vUv * 512.0);
    vec3 v = c.rgb / c.a + (bayer(cell) - 0.5) * ditherSpread / (palN > 0 ? 3.0 : ditherLevels - 1.0);
    if (palN == 0) v = floor(clamp(v, 0.0, 1.0) * (ditherLevels - 1.0) + 0.5) / (ditherLevels - 1.0);
    else {
      vec3 best = pal[0]; float bd = 1e9;
      for (int i = 0; i < 16; i++) { if (i >= palN) break; vec3 e = (v - pal[i]) * vec3(0.299, 0.587, 0.114); float d = dot(e, e); if (d < bd) { bd = d; best = pal[i]; } }
      v = best;
    }
    c.rgb = v * c.a;
  }
  vec4 bg = vec4(0.0);
  if (bgMode == 1) bg = vec4(bg1, 1.0);
  else if (bgMode == 2) { float t = clamp(dot(vUv - 0.5, vec2(cos(bgAngle), sin(bgAngle))) + 0.5, 0.0, 1.0); bg = vec4(mix(bg1, bg2, t), 1.0); }
  else if (bgMode == 3) { float t = clamp(length(vUv - 0.5) * 1.414, 0.0, 1.0); bg = vec4(mix(bg1, bg2, t), 1.0); }
  else if (bgMode == 4) bg = texture2D(tBgImage, vUv);
  else if (bgMode >= 5) bg = vec4(pattern(vUv - 0.5), 1.0);
  vec4 o = c + bg * (1.0 - c.a);
  if (frameShape > 0) { // rarity frame inside the visible crop, glowing inward and outward
    vec2 h = crop * 0.5 - frameInset, p = vUv - 0.5;
    float m = min(h.x, h.y), d = frameShape == 2 ? length(p) - m : sdRound(p, h, frameShape == 3 ? 0.0 : frameRadius * 2.0 * m);
    float aa = fwidth(d), band = smoothstep(-frameTh - aa, -frameTh + aa, d) * (1.0 - smoothstep(-aa, aa, d));
    float gl = frameGlow * (exp(-max(-d - frameTh, 0.0) * 40.0) * step(d, -frameTh) * 0.7 + exp(-max(d, 0.0) * 60.0) * step(0.0, d));
    vec3 fc = mix(fr1, fr2, clamp(0.5 - p.y / max(h.y * 2.0, 1e-3), 0.0, 1.0));
    fc += smoothstep(0.6, 1.0, sin((p.x + p.y) * 9.0) * 0.5 + 0.5) * 0.35; // shine
    o = over(vec4(fr1 * clamp(gl, 0.0, 1.0), clamp(gl, 0.0, 1.0)), o);
    o = over(vec4(fc * band, band), o);
  }
  vec4 txt = texture2D(tText, vUv);
  o = txt + o * (1.0 - txt.a);
  if (straight) o.rgb = o.a > 0.0 ? o.rgb / o.a : vec3(0.0);
  gl_FragColor = o;
}`;

export const copyAlphaFS = /* glsl */`uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, texture2D(tSrc, vUv).a); }`;
// Model-only mask: a = the model where it shows, r = the pedestal around it (full pass minus model).
export const pedMaskFS = /* glsl */`uniform sampler2D tFull, tModel; varying vec2 vUv;
void main() { float m = texture2D(tModel, vUv).a; gl_FragColor = vec4(clamp(texture2D(tFull, vUv).a - m, 0.0, 1.0), 0.0, 0.0, m); }`;
