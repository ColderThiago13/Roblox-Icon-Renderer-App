// GIF encoding off the UI thread, one shared palette for every frame (less flicker).
// gifenc: https://github.com/mattdesl/gifenc (MIT). Workers don't see the page's import map, hence the path.
import { GIFEncoder, quantize, applyPalette } from '../../node_modules/gifenc/dist/gifenc.esm.js';

let gif = null, palette = null, opts = null;
onmessage = ({ data: m }) => {
  try {
    if (m.type === 'start') {
      opts = m; gif = GIFEncoder();
      const samples = m.samples.length ? new Uint8Array(m.samples) : new Uint8Array([0, 0, 0, 255]);
      // Transparent mode reserves index 0 for fully transparent pixels.
      palette = quantize(samples, m.transparent ? 255 : 256);
      if (m.transparent) palette.unshift([0, 0, 0]);
      postMessage({ type: 'ack' });
    } else if (m.type === 'frame') {
      const rgba = new Uint8Array(m.pixels), shift = opts.transparent ? 1 : 0;
      const index = applyPalette(rgba, shift ? palette.slice(1) : palette);
      if (shift) for (let i = 0; i < index.length; i++) index[i] = rgba[i * 4 + 3] < 128 ? 0 : index[i] + 1;
      // dispose 2 clears to transparent between frames; otherwise frames simply replace each other.
      gif.writeFrame(index, opts.width, opts.height, { palette, delay: m.delay * 10, repeat: opts.repeat,
        transparent: !!shift, transparentIndex: 0, dispose: shift ? 2 : 1 });
      postMessage({ type: 'ack' });
    } else if (m.type === 'finish') {
      gif.finish();
      const bytes = gif.bytes();
      postMessage({ type: 'done', bytes }, [bytes.buffer]);
    }
  } catch (e) { postMessage({ type: 'error', message: e.message }); }
};
