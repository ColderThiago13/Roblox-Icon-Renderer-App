// DDS (DXT1 / DXT5) top mip level -> RGBA pixels. Roblox ships its built-in textures (particles, studs, sky) this way.
// -> { width, height, data: Uint8ClampedArray } or throws for other formats.
export function decodeDds(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x20534444) throw new Error('Not a DDS file'); // "DDS "
  const height = dv.getUint32(12, true), width = dv.getUint32(16, true);
  const fourCC = String.fromCharCode(bytes[84], bytes[85], bytes[86], bytes[87]);
  if (fourCC !== 'DXT1' && fourCC !== 'DXT5') throw new Error(`Unsupported DDS format ${fourCC}`);
  const dxt5 = fourCC === 'DXT5', data = new Uint8ClampedArray(width * height * 4), color = [[], [], [], []], alpha = new Array(8);
  let o = 128;
  const rgb565 = (c, out) => { out[0] = ((c >> 11) & 31) * 255 / 31; out[1] = ((c >> 5) & 63) * 255 / 63; out[2] = (c & 31) * 255 / 31; };
  for (let by = 0; by < Math.ceil(height / 4); by++) {
    for (let bx = 0; bx < Math.ceil(width / 4); bx++) {
      let alphaBits = 0n;
      if (dxt5) {
        const a0 = bytes[o], a1 = bytes[o + 1];
        alpha[0] = a0; alpha[1] = a1;
        for (let i = 1; i < 7; i++) alpha[i + 1] = a0 > a1 ? ((7 - i) * a0 + i * a1) / 7 : i < 5 ? ((5 - i) * a0 + i * a1) / 5 : i === 5 ? 0 : 255;
        for (let k = 5; k >= 0; k--) alphaBits = (alphaBits << 8n) | BigInt(bytes[o + 2 + k]);
        o += 8;
      }
      const c0 = dv.getUint16(o, true), c1 = dv.getUint16(o + 2, true), idx = dv.getUint32(o + 4, true);
      o += 8;
      rgb565(c0, color[0]); rgb565(c1, color[1]);
      const four = c0 > c1 || dxt5;
      for (let k = 0; k < 3; k++) {
        color[2][k] = four ? (2 * color[0][k] + color[1][k]) / 3 : (color[0][k] + color[1][k]) / 2;
        color[3][k] = four ? (color[0][k] + 2 * color[1][k]) / 3 : 0;
      }
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
        if (x >= width || y >= height) continue;
        const ci = (idx >>> (2 * i)) & 3, q = (y * width + x) * 4, c = color[ci];
        data[q] = c[0]; data[q + 1] = c[1]; data[q + 2] = c[2];
        data[q + 3] = dxt5 ? alpha[Number((alphaBits >> BigInt(3 * i)) & 7n)] : !four && ci === 3 ? 0 : 255;
      }
    }
  }
  return { width, height, data };
}
