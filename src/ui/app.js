import { IconRenderer } from '../render/renderer.js';
import { createJob, updateVfx, setPose } from '../scene/job.js';
import { loadAnimationId } from '../scene/anim.js';
import { assetId } from '../rbx/instance.js';
import { clearMemoryCache } from '../scene/assets.js';
import { SCHEMA, defaultSettings, withDefaults, clone } from '../settings.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const renderer = new IconRenderer(canvas);
const files = [];
let current = null;
let nextId = 1;

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};
const baseSettings = () => withDefaults(store.get('defaultSettings', null));
const status = (t) => { $('status').textContent = t; };

// ---------------- files ----------------
async function addFiles(list) {
  for (const f of list) {
    if (!/\.(rbxmx?|obj)$/i.test(f.name)) { status(`Skipped ${f.name}: unsupported type`); continue; }
    const file = { id: nextId++, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), settings: baseSettings(), animSel: '', animTime: 0, checked: true, warnings: new Set(), status: 'loading', job: null, thumb: '' };
    files.push(file);
    renderList();
    if (!current) select(file);
    load(file);
  }
}

async function load(file) {
  file.status = 'loading'; file.error = null; file.warnings.clear(); file.job = null;
  renderList();
  const warn = (m) => { file.warnings.add(m); if (file === current) renderWarnings(); };
  try {
    file.job = await createJob(file.name, file.bytes, warn);
    file.status = 'ready';
  } catch (e) {
    console.error(e);
    file.status = 'error'; file.error = e.message;
  }
  renderList();
  if (file === current) { renderWarnings(); syncTimeline(); syncAnimBar(); requestPreview(); }
  thumb(file);
}

function select(file) {
  current = file;
  setPlaying(false); setAnimPlaying(false);
  renderList(); buildPanel(); renderWarnings(); syncTimeline(); syncAnimBar(); requestPreview();
}

function removeFile(file) {
  files.splice(files.indexOf(file), 1);
  if (current === file) current = files[0] || null;
  renderList(); buildPanel(); renderWarnings(); requestPreview();
}

function renderList() {
  const ul = $('fileList');
  ul.replaceChildren(...files.map((f) => {
    const li = document.createElement('li');
    li.className = f === current ? 'active' : '';
    const sub = f.status === 'error' ? `<div class="sub err" title="${esc(f.error)}">Error: ${esc(f.error)}</div>`
      : f.status === 'loading' ? '<div class="sub">Loading…</div>'
      : f.warnings.size ? `<div class="sub warn">${f.warnings.size} warning${f.warnings.size > 1 ? 's' : ''}</div>` : '<div class="sub">Ready</div>';
    li.innerHTML = `<input type="checkbox" ${f.checked ? 'checked' : ''} title="Include in batch export / linked edits">
      <img class="thumb" ${f.thumb ? `src="${f.thumb}"` : ''} alt="">
      <div style="min-width:0"><div class="name" title="${esc(f.name)}">${esc(f.name)}</div>${sub}</div>
      <button class="del" title="Remove">✕</button>`;
    li.querySelector('input').onclick = (e) => { e.stopPropagation(); f.checked = e.target.checked; };
    li.querySelector('.del').onclick = (e) => { e.stopPropagation(); removeFile(f); };
    li.onclick = () => select(f);
    return li;
  }));
  $('emptyHint').hidden = files.length > 0;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderWarnings() {
  const w = current ? [...current.warnings] : [];
  $('warnBox').hidden = !w.length;
  $('warnSummary').textContent = `${w.length} warning${w.length > 1 ? 's' : ''} for ${current?.name ?? ''}`;
  $('warnList').replaceChildren(...w.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
}

// ---------------- rendering ----------------
// VFX state lives on each file's job, so simulate at that file's time right before every render.
function draw(file, size, opts) {
  const poseChanged = setPose(file.job, animEntry(file)?.track ?? null, file.animTime);
  updateVfx(file.job, file.settings.vfx, poseChanged);
  return renderer.render(file.job, file.settings, size, opts);
}

let previewQueued = false;
function requestPreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => { previewQueued = false; drawPreview(); });
}

function drawPreview() {
  const box = $('viewport').getBoundingClientRect();
  const css = Math.max(64, Math.floor(Math.min(box.width, box.height) - 24));
  const px = Math.round(css * devicePixelRatio);
  canvas.style.width = canvas.style.height = css + 'px';
  if (canvas.width !== px) renderer.gl.setSize(px, px, false);
  if (!current?.job) { renderer.gl.setRenderTarget(null); renderer.gl.clear(); return; }
  try { draw(current, px); }
  catch (e) { console.error(e); status('Render error: ' + e.message); }
}
new ResizeObserver(requestPreview).observe($('viewport'));

const thumbTimers = new Map();
function thumb(file, delay = 0) {
  clearTimeout(thumbTimers.get(file));
  thumbTimers.set(file, setTimeout(() => {
    if (!file.job) return;
    const img = draw(file, 112, { out: 'pixels' });
    const c = document.createElement('canvas'); c.width = c.height = 112;
    c.getContext('2d').putImageData(img, 0, 0);
    file.thumb = c.toDataURL();
    renderList();
    requestPreview(); // thumbnail render replaced the canvas contents
  }, delay));
}

// ---------------- settings panel ----------------
const openSections = new Set(store.get('openSections', ['camera', 'outline', 'bloom']));

function targets() {
  if (!current) return [];
  if (!$('linkEdits').checked) return [current];
  return [...new Set([current, ...files.filter((f) => f.checked)])];
}

function setValue(sec, key, value) {
  for (const f of targets()) {
    f.settings[sec][key] = value;
    thumb(f, 500);
  }
  requestPreview();
}

function buildPanel() {
  const panel = $('sections');
  panel.replaceChildren();
  $('panel').classList.toggle('disabled', !current);
  const s = current?.settings ?? defaultSettings();
  for (const sec of SCHEMA) {
    const det = document.createElement('details');
    det.open = openSections.has(sec.id);
    det.ontoggle = () => { det.open ? openSections.add(sec.id) : openSections.delete(sec.id); store.set('openSections', [...openSections]); };
    const sum = document.createElement('summary');
    sum.textContent = sec.title;
    const apply = Object.assign(document.createElement('button'), { className: 'apply', textContent: 'Apply to all', title: `Copy ${sec.title} settings to every file` });
    apply.onclick = (e) => {
      e.preventDefault();
      for (const f of files) if (f !== current) { f.settings[sec.id] = clone(current.settings[sec.id]); thumb(f, 200); }
      status(`${sec.title} applied to ${files.length} files`);
    };
    sum.append(apply);
    det.append(sum);
    for (const fd of sec.fields) det.append(fieldEl(sec.id, fd, s[sec.id][fd.key]));
    panel.append(det);
  }
  syncTimeline();
}

function fieldEl(sec, fd, value) {
  const row = document.createElement('div');
  row.className = 'field' + (fd.type === 'range' ? '' : ' inline');
  const label = Object.assign(document.createElement('span'), { textContent: fd.label });
  row.append(label);
  if (fd.type === 'range') {
    const num = Object.assign(document.createElement('input'), { type: 'number', min: fd.min, max: fd.max, step: fd.step, value });
    const rng = Object.assign(document.createElement('input'), { type: 'range', min: fd.min, max: fd.max, step: fd.step, value });
    rng.oninput = () => { num.value = rng.value; setValue(sec, fd.key, +rng.value); if (sec === 'vfx') syncTimeline(); };
    num.onchange = () => { rng.value = num.value; setValue(sec, fd.key, +num.value); if (sec === 'vfx') syncTimeline(); };
    row.append(num, rng);
    row.dataset.key = `${sec}.${fd.key}`;
  } else if (fd.type === 'bool') {
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: value });
    cb.onchange = () => setValue(sec, fd.key, cb.checked);
    row.append(cb);
  } else if (fd.type === 'color') {
    const ci = Object.assign(document.createElement('input'), { type: 'color', value });
    ci.oninput = () => setValue(sec, fd.key, ci.value);
    row.append(ci);
  } else {
    const sel = document.createElement('select');
    for (const o of fd.options) sel.append(new Option(o[0].toUpperCase() + o.slice(1), o, false, o === value));
    sel.onchange = () => setValue(sec, fd.key, sel.value);
    row.append(sel);
  }
  return row;
}

// Sync range fields after viewport interaction without rebuilding the panel.
function syncField(sec, key) {
  const row = document.querySelector(`.field[data-key="${sec}.${key}"]`);
  if (row) for (const i of row.querySelectorAll('input')) i.value = current.settings[sec][key];
}

// ---------------- viewport interaction ----------------
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!current) return;
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  const c = current.settings.camera;
  if (drag.pan) {
    const k = 1 / canvas.clientWidth;
    setValue('camera', 'offsetX', clamp(+(c.offsetX + dx * k).toFixed(3), -0.5, 0.5));
    setValue('camera', 'offsetY', clamp(+(c.offsetY - dy * k).toFixed(3), -0.5, 0.5));
    syncField('camera', 'offsetX'); syncField('camera', 'offsetY');
  } else {
    setValue('camera', 'yaw', wrap180(c.yaw - dx * 0.5));
    setValue('camera', 'pitch', clamp(Math.round(c.pitch + dy * 0.4), -89, 89));
    syncField('camera', 'yaw'); syncField('camera', 'pitch');
  }
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  if (!current) return;
  e.preventDefault();
  setValue('camera', 'zoom', clamp(+(current.settings.camera.zoom * Math.exp(-e.deltaY * 0.001)).toFixed(3), 0.2, 4));
  syncField('camera', 'zoom');
}, { passive: false });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap180 = (v) => Math.round(((v + 540) % 360) - 180);

for (const chip of document.querySelectorAll('[data-bg]')) chip.onclick = () => {
  document.querySelectorAll('[data-bg]').forEach((c) => c.classList.toggle('active', c === chip));
  $('viewport').className = 'bg-' + chip.dataset.bg;
};

// ---------------- VFX timeline ----------------
let playing = false, lastTick = 0;
function syncTimeline() {
  const v = current?.settings.vfx;
  $('timeline').hidden = !current?.job?.vfxSystem;
  if (!v) return;
  $('timeSlider').max = v.duration;
  $('timeMax').value = v.duration;
  $('timeSlider').value = v.time;
  $('timeLabel').textContent = `${(+v.time).toFixed(2)} s`;
  syncField('vfx', 'time'); syncField('vfx', 'duration');
}
function setTime(t) {
  if (!current) return;
  setValue('vfx', 'time', Math.round(t * 1000) / 1000);
  syncTimeline();
}
function setPlaying(on) {
  playing = on && !!current?.job?.vfxSystem;
  $('playBtn').textContent = playing ? '❚❚' : '▶';
  if (playing) { lastTick = performance.now(); requestAnimationFrame(tick); }
}
function tick(now) {
  if (!playing || !current) return;
  const v = current.settings.vfx;
  let t = +v.time + ((now - lastTick) / 1000) * +$('playSpeed').value;
  lastTick = now;
  if (t > v.duration) t = 0;
  setTime(t);
  requestAnimationFrame(tick);
}
$('timeSlider').oninput = () => { setPlaying(false); setTime(+$('timeSlider').value); };
$('timeMax').onchange = () => { setValue('vfx', 'duration', Math.max(0.5, +$('timeMax').value || 5)); syncTimeline(); };
$('playBtn').onclick = () => setPlaying(!playing);
$('restartBtn').onclick = () => setTime(0);
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName)) { e.preventDefault(); setPlaying(!playing); }
});

// ---------------- animation ----------------
const animEntry = (file) => (file?.animSel && file.job?.animations.find((a) => a.key === file.animSel)) || null;
let animPlaying = false, animLast = 0;

function syncAnimBar() {
  const job = current?.job;
  $('animbar').hidden = !job?.rig;
  if (!job?.rig) return;
  const sel = $('animSelect');
  sel.replaceChildren(new Option(job.animations.length ? 'Pose saved in file' : 'Pose saved in file (no animations yet)', ''),
    ...job.animations.map((a) => new Option(a.track ? `${a.name} — ${a.track.length.toFixed(2)} s` : `${a.name} (not loaded)`, a.key)));
  sel.value = current.animSel;
  const len = animEntry(current)?.track?.length ?? 0;
  $('animSlider').disabled = !len;
  $('animSlider').value = len ? current.animTime / len : 0;
  $('animLabel').textContent = `${current.animTime.toFixed(2)} / ${len.toFixed(2)} s`;
}

// Makes sure the entry's track is loaded (Animation instances / added IDs download on first use).
async function ensureTrack(entry) {
  if (entry.track || !entry.id) return entry.track;
  entry.loading ??= loadAnimationId(entry.id).then((t) => { entry.track = t; return t; }).finally(() => { entry.loading = null; });
  return entry.loading;
}

async function selectAnimation(key) {
  setAnimPlaying(false);
  for (const f of targets()) {
    const entry = key && f.job?.animations.find((a) => a.key === key);
    if (key && !entry) continue;
    f.animSel = key; f.animTime = 0;
    if (entry) {
      try { status(`Loading ${entry.name}…`); await ensureTrack(entry); status(`${entry.name} ready`); }
      catch (e) { f.animSel = ''; f.warnings.add(e.message); status(e.message); renderWarnings(); renderList(); }
    }
    thumb(f, 300);
  }
  syncAnimBar(); requestPreview();
}

function setAnimTime(t) {
  for (const f of targets()) if (f.animSel === current.animSel) { f.animTime = Math.round(t * 1000) / 1000; thumb(f, 500); }
  syncAnimBar(); requestPreview();
}

function setAnimPlaying(on) {
  animPlaying = on && !!animEntry(current)?.track?.length;
  $('animPlay').textContent = animPlaying ? '❚❚' : '▶';
  if (animPlaying) { animLast = performance.now(); requestAnimationFrame(animTick); }
}
function animTick(now) {
  if (!animPlaying || !current) return;
  const len = animEntry(current)?.track?.length ?? 0;
  if (!len) return setAnimPlaying(false);
  setAnimTime((current.animTime + (now - animLast) / 1000 * +$('playSpeed').value) % len);
  animLast = now;
  requestAnimationFrame(animTick);
}

$('animSelect').onchange = () => selectAnimation($('animSelect').value);
$('animSlider').oninput = () => { setAnimPlaying(false); setAnimTime(+$('animSlider').value * (animEntry(current)?.track?.length ?? 0)); };
$('animPlay').onclick = () => setAnimPlaying(!animPlaying);
$('animAdd').onclick = async () => {
  const raw = $('animId').value.trim();
  const id = assetId(raw) || raw.match(/(\d{5,})/)?.[1];
  if (!id) return status('Enter an animation ID (number or rbxassetid:// link)');
  const key = `id:${id}`;
  const entry = { key, name: `Animation ${id}`, id, track: null };
  for (const f of targets()) if (f.job?.rig && !f.job.animations.some((a) => a.key === key)) f.job.animations.push(entry);
  $('animId').value = '';
  try {
    status(`Downloading animation ${id}…`);
    await ensureTrack(entry);
    entry.name = entry.track.name;
  } catch (e) {
    for (const f of targets()) if (f.job) f.job.animations = f.job.animations.filter((a) => a !== entry);
    syncAnimBar();
    return status(e.message);
  }
  await selectAnimation(key);
};
$('animId').onkeydown = (e) => { if (e.key === 'Enter') $('animAdd').click(); };

// ---------------- export ----------------
const EXT = { png: 'png', webp: 'webp', jpeg: 'jpg' };
const exportOpts = () => ({ size: +$('expSize').value, format: $('expFormat').value, ss: +$('expSS').value });
for (const id of ['expSize', 'expFormat', 'expSS']) {
  const saved = store.get(id, null);
  if (saved != null) $(id).value = saved;
  $(id).onchange = () => store.set(id, $(id).value);
}

async function encode(file, { size, format, ss }) {
  const img = draw(file, size, { out: 'pixels', supersample: ss });
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  if (format === 'jpeg') {
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = size;
    tmp.getContext('2d').putImageData(img, 0, 0);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size); g.drawImage(tmp, 0, 0);
  } else g.putImageData(img, 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, 'image/' + format, 0.95));
  requestPreview();
  return new Uint8Array(await blob.arrayBuffer());
}
const baseName = (n) => n.replace(/\.[^.]+$/, '');

async function exportFiles(list) {
  const ready = list.filter((f) => f.job);
  if (!ready.length) return status('Nothing ready to export');
  const folder = await window.native.pickFolder();
  if (!folder) return;
  const o = exportOpts();
  const used = new Set();
  for (let i = 0; i < ready.length; i++) {
    const f = ready[i];
    status(`Exporting ${i + 1}/${ready.length}: ${f.name}`);
    let name = baseName(f.name), n = 2;
    while (used.has(name)) name = `${baseName(f.name)}_${n++}`;
    used.add(name);
    await window.native.writeFile(await window.native.joinPath(folder, `${name}.${EXT[o.format]}`), await encode(f, o));
  }
  status(`Exported ${ready.length} icon${ready.length > 1 ? 's' : ''} to ${folder}`);
}

$('exportOne').onclick = async () => {
  if (!current?.job) return status('Nothing to export');
  const o = exportOpts();
  const path = await window.native.pickSavePath(`${baseName(current.name)}.${EXT[o.format]}`);
  if (!path) return;
  await window.native.writeFile(path, await encode(current, o));
  status(`Saved ${path}`);
};
$('exportSel').onclick = () => exportFiles(files.filter((f) => f.checked));
$('exportAll').onclick = () => exportFiles(files);

// ---------------- toolbar ----------------
$('addBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
$('copyBtn').onclick = () => { if (current) { store.set('clipboard', current.settings); status('Settings copied'); } };
$('pasteBtn').onclick = () => {
  const s = store.get('clipboard', null);
  if (!s || !current) return;
  for (const f of targets()) { f.settings = withDefaults(clone(s)); thumb(f, 100); }
  buildPanel(); requestPreview();
};
$('applyAllBtn').onclick = () => {
  if (!current) return;
  for (const f of files) if (f !== current) { f.settings = clone(current.settings); thumb(f, 100); }
  status(`Settings applied to ${files.length} files`);
};
$('resetBtn').onclick = () => {
  for (const f of targets()) { f.settings = defaultSettings(); thumb(f, 100); }
  buildPanel(); requestPreview();
};
$('defaultBtn').onclick = () => { if (current) { store.set('defaultSettings', current.settings); status('Saved as default for new files'); } };
$('reloadBtn').onclick = () => { if (current) { clearMemoryCache(); load(current); } };
$('checkAll').onclick = () => { files.forEach((f) => { f.checked = true; }); renderList(); };
$('checkNone').onclick = () => { files.forEach((f) => { f.checked = false; }); renderList(); };

// ---------------- profiles ----------------
let profiles = {};
async function loadProfiles() {
  profiles = (await window.native.getProfiles()) || {};
  renderProfiles();
}
function renderProfiles(selected = '') {
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  $('profileSelect').replaceChildren(new Option(names.length ? '— choose —' : '— none saved —', ''), ...names.map((n) => new Option(n, n)));
  $('profileSelect').value = selected;
  $('profileDelete').disabled = !selected;
}
$('profileSelect').onchange = () => {
  const name = $('profileSelect').value;
  $('profileDelete').disabled = !name;
  if (!name || !current) return;
  for (const f of targets()) { f.settings = withDefaults(clone(profiles[name])); thumb(f, 100); }
  buildPanel(); requestPreview();
  status(`Profile "${name}" applied to ${targets().length} file${targets().length > 1 ? 's' : ''}`);
};
$('profileSave').onclick = () => {
  if (!current) return status('Open a file first');
  $('profileName').value = $('profileSelect').value || '';
  $('profileDlg').showModal();
  $('profileName').select();
};
$('profileOk').onclick = async (e) => {
  e.preventDefault();
  const name = $('profileName').value.trim();
  if (!name) return;
  profiles[name] = clone(current.settings);
  await window.native.setProfiles(profiles);
  $('profileDlg').close();
  renderProfiles(name);
  status(`Profile "${name}" saved`);
};
$('profileDelete').onclick = async () => {
  const name = $('profileSelect').value;
  if (!name || !confirm(`Delete profile "${name}"?`)) return;
  delete profiles[name];
  await window.native.setProfiles(profiles);
  renderProfiles();
  status(`Profile "${name}" deleted`);
};
loadProfiles();

// ---------------- updates ----------------
{
  const btn = $('updateBtn');
  let state = 'idle';
  window.native.onUpdate((m) => {
    if (m.type === 'available') { state = 'available'; btn.hidden = false; btn.disabled = false; btn.textContent = `⬆ Update to v${m.version}`; }
    else if (m.type === 'progress') { btn.textContent = `Downloading… ${m.percent}%`; }
    else if (m.type === 'downloaded') { state = 'ready'; btn.disabled = false; btn.textContent = `Restart to update (v${m.version})`; }
    else if (m.type === 'error' && state !== 'idle') { state = 'available'; btn.disabled = false; btn.textContent = 'Update failed — retry'; status(`Update error: ${m.message}`); }
  });
  btn.onclick = async () => {
    if (state === 'ready') return window.native.installUpdate();
    state = 'downloading'; btn.disabled = true; btn.textContent = 'Downloading…';
    try { await window.native.downloadUpdate(); } catch (e) { state = 'available'; btn.disabled = false; btn.textContent = 'Update failed — retry'; status(e.message); }
  };
  window.native.version().then((v) => { document.title = `Roblox Icon Renderer v${v}`; });
}

// ---------------- credentials ----------------
async function refreshCreds() {
  const c = await window.native.getConfig();
  $('credsState').textContent = `Saved: API key ${c.hasApiKey ? '✔' : '—'} · cookie ${c.hasCookie ? '✔' : '—'}`;
}
$('credsBtn').onclick = async () => { $('apiKey').value = ''; $('cookie').value = ''; await refreshCreds(); $('credsDlg').showModal(); };
$('credsSave').onclick = async (e) => {
  e.preventDefault();
  const patch = {};
  if ($('apiKey').value.trim()) patch.apiKey = $('apiKey').value.trim();
  if ($('cookie').value.trim()) patch.cookie = $('cookie').value.trim();
  await window.native.setConfig(patch);
  $('credsDlg').close();
  clearMemoryCache();
  const failed = files.filter((f) => f.status === 'error' || f.warnings.size);
  failed.forEach(load);
  status(failed.length ? `Credentials saved, reloading ${failed.length} file(s)` : 'Credentials saved');
};
$('credsClear').onclick = async () => { await window.native.setConfig({ apiKey: '', cookie: '' }); refreshCreds(); };
$('cacheClear').onclick = async () => { await window.native.clearCache(); clearMemoryCache(); status('Asset cache cleared'); };
$('cacheOpen').onclick = () => window.native.openCache();

// ---------------- drag & drop ----------------
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true; addFiles([...e.dataTransfer.files]); });

buildPanel();
renderList();

// Launch splash (built in index.html): fade out once the renderer is up, after the intro has played (~2 s).
{
  const splash = $('splash');
  const hide = () => { splash.classList.add('done'); setTimeout(() => splash.remove(), 700); };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const schedule = () => {
    if (window.__splashStart == null) return requestAnimationFrame(schedule);
    setTimeout(hide, reduced ? 0 : Math.max(400, window.__splashStart + 2300 - performance.now()));
  };
  schedule();
}

// Test hook: lets an automated harness load files and grab renders.
window.__app = { addFiles, files, renderer, encode, select, loadAnimationId };
