// 3D color LUTs for the grade pass, all normalized to one strip image: width size², height size, where pixel
// (b·size + r, g) holds the output for input (r, g, b). Pure functions on plain pixel arrays.

// .cube text -> { size, data } (rgb floats, red fastest, then green, then blue).
export function parseCube(text) {
  let size = 0, lo = [0, 0, 0], hi = [1, 1, 1];
  const vals = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] === '#') continue;
    const [k, ...rest] = t.split(/\s+/);
    if (k === 'LUT_3D_SIZE') size = Math.round(+rest[0]);
    else if (k === 'DOMAIN_MIN') lo = rest.map(Number);
    else if (k === 'DOMAIN_MAX') hi = rest.map(Number);
    else if (/^[-+.\d]/.test(k)) vals.push(+k, +rest[0], +rest[1]);
  }
  if (!(size >= 2 && size <= 128) || vals.length !== size ** 3 * 3) throw new Error('not a 3D .cube LUT (it needs LUT_3D_SIZE and size³ color rows)');
  const data = new Float32Array(vals.length);
  for (let i = 0; i < vals.length; i++) data[i] = (vals[i] - lo[i % 3]) / (hi[i % 3] - lo[i % 3] || 1);
  return { size, data };
}

export function cubeToStrip({ size, data }) {
  const w = size * size, out = new Uint8ClampedArray(w * size * 4);
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const s = ((b * size + g) * size + r) * 3, d = (g * w + b * size + r) * 4;
    out[d] = data[s] * 255; out[d + 1] = data[s + 1] * 255; out[d + 2] = data[s + 2] * 255; out[d + 3] = 255;
  }
  return { data: out, width: w, height: size, size };
}

// PNG LUTs: already a strip (width = height²), or a square of tiles like 512×512 = 64³ in 8×8 tiles.
export function imageToStrip({ data, width, height }) {
  if (width === height * height) return { data, width, height, size: height };
  const size = Math.round(Math.cbrt(width * height)), tiles = width / size;
  if (size ** 3 !== width * height || !Number.isInteger(tiles)) throw new Error(`unrecognized LUT image layout ${width}×${height} (use a strip like 1024×32 or tiles like 512×512)`);
  const w = size * size, out = new Uint8ClampedArray(w * size * 4);
  for (let b = 0; b < size; b++) {
    const tx = (b % tiles) * size, ty = Math.floor(b / tiles) * size;
    for (let g = 0; g < size; g++) out.set(data.subarray(((ty + g) * width + tx) * 4, ((ty + g) * width + tx + size) * 4), (g * w + b * size) * 4);
  }
  return { data: out, width: w, height: size, size };
}
