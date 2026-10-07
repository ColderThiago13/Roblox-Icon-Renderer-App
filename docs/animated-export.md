# GIF and sprite-sheet export

Status: implemented (toolbar → **Export animation…**; `src/ui/app.js` export section, `src/ui/animexport.js`, `src/ui/gif.worker.js`). GIF encoding uses [gifenc](https://github.com/mattdesl/gifenc) (MIT). The notes below are the original design.

Recommendation: add PNG frame sequences and sprite sheets first, then GIF as a sharing format.

PNG retains smooth transparency, full color, and crisp edges. A sprite sheet is directly useful for Roblox UI animations and game effects. GIF is convenient to share but limited to 256 colors per frame and binary transparency, which makes glow and soft particle edges look worse. Offer a solid background for GIF; consider animated WebP later for full alpha.

The existing `draw(file, size, { out: 'pixels', supersample })` path already handles poses, deterministic particles, trails, lighting, and post-processing. Export should call it at exact frame times rather than recording realtime playback.

## Proposed controls

- Format: PNG sequence, PNG sprite sheet, GIF.
- Start time, duration, FPS (default 24), loop, size, supersampling.
- Time source: rig animation, VFX, or both together. The current animation and VFX clocks are separate; explicitly choosing which advances avoids a surprising export.
- Sprite sheet: columns and padding; write JSON with frame rectangles, FPS, and duration. Offer numbered PNG files when a sheet would exceed the GPU/canvas dimension limit.
- Progress and Cancel; process one frame at a time and allow the UI to repaint.

## Export details

Render frames at `start + frameIndex / FPS` and omit the duplicate endpoint of a looping clip. Pause playback while exporting, and restore the selected file, both clocks, and preview afterward, including on cancellation or failure.

Lock the camera framing across the clip. Today's auto-fit follows each pose and optionally the effects; applying that independently to each frame would make the model appear to grow or shrink. Precompute combined bounds or let the user lock the current camera. Trails should sample motion preceding each frame so a PNG sequence matches an isolated export of that time.

For GIF, encode in a worker, quantize against a shared palette to reduce flicker, and check the encoder's license and disposal behavior. GIF delays use hundredths of a second, so FPS such as 24 needs alternating frame delays. Avoid retaining every full-resolution frame in memory: 120 frames at 512px already use about 120 MiB of raw RGBA pixels; 4096px would use about 7.5 GiB before supersampling. Stream sequences to disk and bound the number of frames/sheet dimensions.

Validate loop seams, transparent particles, trail history, frame order, cancellation, camera stability, and batch export with different animations per file. Start with current-file export, then extend the existing checked/all-file workflow.
