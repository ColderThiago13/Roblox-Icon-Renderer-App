import { IconRenderer } from '../render/renderer.js';
import { createJob, updateVfx, updateTrails, setPose } from '../scene/job.js';
import { wheelZoom } from './zoom.js';
import { loadAnimationId } from '../scene/anim.js';
import { assetId, nameOf, pathOf, atPath } from '../rbx/instance.js';
import { clearMemoryCache } from '../scene/assets.js';
import { SCHEMA, TEXT_FIELDS, textLayer, defaultSettings, withDefaults, clone, hexToVec3, PREFS, prefsWithDefaults } from '../settings.js';
import { hitText, fontFamilies, loadFamily, overlayPending, overlayReady, fontString } from '../render/overlay.js';
import { frameTimes, gifDelays, sheetLayout, flatten, opaqueSamples, MAX_GIF_SIZE, MAX_SHEET, frameSizeForSheet } from './animexport.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const renderer = new IconRenderer(canvas);
const files = [];
let current = null;
let nextId = 1;

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { status('Could not save locally (storage full — a large background image?)'); } },
};
const baseSettings = () => withDefaults(store.get('defaultSettings', null));
const status = (t) => { $('status').textContent = t; };

// ---------------- files ----------------
// src: key of the source file's bytes in the saved session (shared by models split out of it); path: see subtree().
function newFile(props) {
  const file = { id: nextId++, path: null, disabled: [], animSel: '', animTime: 0, checked: true, warnings: new Set(), status: 'loading', job: null, thumb: '', ...props };
  files.push(file);
  return file;
}

async function addFiles(list) {
  for (const f of list) {
    if (!/\.(rbxmx?|obj)$/i.test(f.name)) { status(`Skipped ${f.name}: unsupported type`); continue; }
    const bytes = new Uint8Array(await f.arrayBuffer()), src = crypto.randomUUID().replaceAll('-', '');
    window.native.putSessionBlob(src, bytes).catch((e) => status(`${f.name} won't reopen next launch: ${e.message}`));
    const file = newFile({ name: f.name, bytes, src, settings: baseSettings() });
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
    file.job = await createJob(file.name, file.bytes, warn, file.path, file.disabled.map(keyPath));
    file.status = 'ready';
    restoreAnimation(file);
  } catch (e) {
    console.error(e);
    file.status = 'error'; file.error = e.message;
  }
  renderList();
  if (file === current) { renderWarnings(); syncTimeline(); syncAnimBar(); requestPreview(); renderWorkspace(); }
  thumb(file);
}

function select(file) {
  closeTextEdit();
  current = file;
  selectedText = null;
  setPlaying(false); setAnimPlaying(false);
  renderList(); buildPanel(); renderWarnings(); syncTimeline(); syncAnimBar(); requestPreview(); renderWorkspace();
}

function removeFile(file) {
  files.splice(files.indexOf(file), 1);
  if (current === file) current = files[0] || null;
  renderList(); buildPanel(); renderWarnings(); requestPreview(); renderWorkspace();
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
  window.native.setActivity({ details: !current ? 'Getting started' : prefs.discordFile ? `Editing ${current.name}` : 'Editing an icon',
    state: prefs.discordCount ? `${files.length} file${files.length === 1 ? '' : 's'} open` : '', showTime: prefs.discordTime });
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderWarnings() {
  const w = current ? [...current.warnings] : [];
  $('warnBox').hidden = !w.length;
  $('warnSummary').textContent = `${w.length} warning${w.length > 1 ? 's' : ''} for ${current?.name ?? ''}`;
  $('warnList').replaceChildren(...w.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
}

// ---------------- workspace ----------------
// The current file's instance tree. Select rows (Ctrl/Shift for several) and drag them onto the file list:
// each becomes its own file that renders only that instance, starting from the current settings.
const ICONS = {
  model: 'Model Actor WorldModel Tool', part: 'Part WedgePart CornerWedgePart TrussPart SpawnLocation Seat VehicleSeat SkateboardPlatform FlagStand',
  meshpart: 'MeshPart SpecialMesh BlockMesh CylinderMesh FileMesh CharacterMesh WrapLayer WrapTarget', union: 'UnionOperation NegateOperation IntersectOperation PartOperation',
  folder: 'Folder Configuration', accessory: 'Accessory Hat', attachment: 'Attachment Bone', particles: 'ParticleEmitter Fire Smoke Sparkles',
  light: 'PointLight SpotLight SurfaceLight Highlight', humanoid: 'Humanoid HumanoidDescription BodyColors Shirt Pants ShirtGraphic Animator AnimationController',
  decal: 'Decal Texture SurfaceAppearance', trail: 'Trail Beam',
};
const ICON_OF = new Map(Object.entries(ICONS).flatMap(([icon, classes]) => classes.split(' ').map((c) => [c, icon])));
const classIcon = (c) => ICON_OF.get(c) ?? (/Script$/.test(c) ? 'script' : /Weld$|Constraint$|^Motor/.test(c) ? 'weld' : 'instance');

// Rows are keyed by path ("0/3/1", see pathOf), so open/selected/disabled rows survive the file rebuilding.
const ws = { file: null, full: null, roots: null, open: null, sel: new Set(), anchor: null, rows: [], drag: null };
const keyPath = (key) => key.split('/').map(Number);
const instAt = (key) => atPath(ws.full, keyPath(key));
function renderWorkspace() {
  const ul = $('wsTree'), job = current?.job;
  if (ws.file !== current) Object.assign(ws, { file: current, full: null, roots: null, open: null, sel: new Set(), anchor: null });
  if (job?.treeRoots) Object.assign(ws, { full: job.tree.roots, roots: job.treeRoots });
  else if (current?.status !== 'loading') ws.roots = null; // while rebuilding (e.g. after disabling) the last tree stays up
  if (!ws.roots) {
    const msg = !current ? 'Open a file to see its models' : current.status === 'loading' ? 'Loading…' : job ? 'OBJ files have no hierarchy' : 'Nothing to show';
    ul.replaceChildren(Object.assign(document.createElement('li'), { className: 'hint', textContent: msg }));
    return;
  }
  const rootKeys = ws.roots.map((r) => pathOf(r, ws.full).join('/')), off = new Set(current.disabled);
  ws.open ??= new Set(rootKeys.length === 1 ? rootKeys : []);
  ws.rows = [];
  const add = (inst, key, depth, inherited) => {
    const own = off.has(key);
    ws.rows.push({ inst, key, depth, own, dim: own || inherited });
    if (ws.open.has(key)) inst.children.forEach((c, i) => add(c, `${key}/${i}`, depth + 1, own || inherited));
  };
  ws.roots.forEach((r, i) => add(r, rootKeys[i], 0, false));
  ul.replaceChildren(...ws.rows.map(({ inst, key, depth, own, dim }, i) => {
    const li = Object.assign(document.createElement('li'), { className: `${ws.sel.has(key) ? 'sel' : ''}${dim ? ' off' : ''}`, title: `${nameOf(inst)} (${inst.className})${dim ? ' — not rendered' : ''}` });
    li.dataset.i = i;
    li.style.paddingLeft = `${4 + depth * 14}px`;
    li.innerHTML = `<span class="tw">${inst.children.length ? (ws.open.has(key) ? '▾' : '▸') : ''}</span><i class="ico ico-${classIcon(inst.className)}"></i><span class="name"></span>${own ? '<span class="offTag">(Disabled)</span>' : ''}<span class="cls"></span>`;
    li.querySelector('.name').textContent = nameOf(inst);
    li.querySelector('.cls').textContent = inst.className;
    return li;
  }));
}
const wsRowAt = (e) => ws.rows[e.target.closest('#wsTree li[data-i]')?.dataset.i];
const overFileList = (e) => { const r = $('fileList').getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
const toggleOpen = (key) => { ws.open.has(key) ? ws.open.delete(key) : ws.open.add(key); renderWorkspace(); };

$('wsTree').addEventListener('pointerdown', (e) => {
  const row = wsRowAt(e);
  if (!row || e.button !== 0) return;
  if (e.target.classList.contains('tw')) return toggleOpen(row.key);
  let collapseTo = null;
  if (e.shiftKey && ws.anchor) {
    const order = ws.rows.map((r) => r.key), [a, b] = [order.indexOf(ws.anchor), order.indexOf(row.key)].sort((x, y) => x - y);
    if (a >= 0) ws.sel = new Set(order.slice(a, b + 1));
  } else if (e.ctrlKey || e.metaKey) { ws.sel.has(row.key) ? ws.sel.delete(row.key) : ws.sel.add(row.key); ws.anchor = row.key; }
  else if (ws.sel.has(row.key)) collapseTo = row.key; // keep a multi-selection draggable; a plain click narrows it on release
  else { ws.sel = new Set([row.key]); ws.anchor = row.key; }
  ws.drag = { x: e.clientX, y: e.clientY, ghost: null, collapseTo };
  renderWorkspace();
});
// Tracked on the window so the drag keeps working outside the tree.
addEventListener('pointermove', (e) => {
  const d = ws.drag;
  if (!d || !ws.sel.size) return;
  if (!d.ghost && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) {
    d.ghost = Object.assign(document.createElement('div'), { id: 'wsGhost', textContent: ws.sel.size > 1 ? `${ws.sel.size} models` : nameOf(instAt([...ws.sel][0])) });
    document.body.append(d.ghost);
  }
  if (!d.ghost) return;
  Object.assign(d.ghost.style, { left: `${e.clientX + 12}px`, top: `${e.clientY + 10}px` });
  $('fileList').classList.toggle('dropTarget', overFileList(e));
});
const endWsDrag = (e, drop) => {
  if (!ws.drag) return;
  const { ghost, collapseTo } = ws.drag;
  ws.drag = null;
  ghost?.remove();
  $('fileList').classList.remove('dropTarget');
  if (ghost && drop && overFileList(e)) splitOut([...ws.sel]);
  else if (!ghost && collapseTo) { ws.sel = new Set([collapseTo]); ws.anchor = collapseTo; renderWorkspace(); }
};
addEventListener('pointerup', (e) => endWsDrag(e, true));
addEventListener('pointercancel', (e) => endWsDrag(e, false));
$('wsTree').addEventListener('dblclick', (e) => {
  const row = wsRowAt(e);
  if (row?.inst.children.length && !e.target.classList.contains('tw')) toggleOpen(row.key);
});

// Right-click: disable / enable. Disabled instances (and everything under them) are left out of the render.
$('wsTree').addEventListener('contextmenu', (e) => {
  const row = wsRowAt(e);
  if (!row) return;
  e.preventDefault();
  if (!ws.sel.has(row.key)) { ws.sel = new Set([row.key]); ws.anchor = row.key; renderWorkspace(); }
  const keys = [...ws.sel], off = keys.every((k) => current.disabled.includes(k)), n = keys.length > 1 ? ` ${keys.length} items` : '';
  const menu = $('ctxMenu'), btn = Object.assign(document.createElement('button'), { textContent: off ? `Enable${n}` : `Disable${n}` });
  btn.onclick = () => { closeMenu(); setDisabled(keys, !off); };
  menu.replaceChildren(btn);
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  Object.assign(menu.style, { left: `${Math.min(e.clientX, innerWidth - r.width - 4)}px`, top: `${Math.min(e.clientY, innerHeight - r.height - 4)}px` });
});
const closeMenu = () => { $('ctxMenu').hidden = true; };
addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctxMenu')) closeMenu(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
addEventListener('blur', closeMenu);

function setDisabled(keys, off) {
  const f = current, set = new Set(f.disabled);
  for (const k of keys) off ? set.add(k) : set.delete(k);
  f.disabled = [...set];
  renderWorkspace();
  load(f);
  status(`${off ? 'Disabled' : 'Enabled'} ${keys.length > 1 ? `${keys.length} items` : nameOf(instAt(keys[0]))}`);
}

// A split-out model keeps the disabled state of its own descendants.
function splitOut(keys) {
  const src = current;
  if (!ws.full || !keys.length) return;
  for (const key of keys) {
    load(newFile({ name: nameOf(instAt(key)), bytes: src.bytes, src: src.src, path: keyPath(key), disabled: src.disabled.filter((k) => k.startsWith(key + '/')), settings: clone(src.settings), checked: src.checked }));
  }
  renderList();
  status(`Added ${keys.length} model${keys.length > 1 ? 's' : ''} from ${src.name} as separate icons`);
}

// ---------------- app settings ----------------
// Theme, accent, interface size, Discord privacy and behavior. Main reads the ones it acts on from the same file.
let prefs = prefsWithDefaults({});
const prefsLoaded = window.native.getPrefs().then((p) => { prefs = prefsWithDefaults(p); applyPrefs(); }, () => applyPrefs());
function applyPrefs() {
  const root = document.documentElement, custom = prefs.accent.toLowerCase() !== PREFS[0].fields[1].def;
  root.dataset.theme = prefs.theme;
  for (const [k, v] of [['--accent', prefs.accent], ['--accent2', `color-mix(in srgb, ${prefs.accent} 75%, #000)`]]) custom ? root.style.setProperty(k, v) : root.style.removeProperty(k);
  window.native.setZoom(parseFloat(prefs.uiScale) / 100 || 1);
  renderList(); // refreshes the Discord status text
}
function setPref(key, value) {
  prefs[key] = value;
  applyPrefs();
  window.native.setPrefs(prefs).catch((e) => status(`Could not save settings: ${e.message}`));
}
let settingsTab = PREFS[0].id;
function buildSettings() {
  $('setNav').replaceChildren(...PREFS.map((sec) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: sec.id === settingsTab ? 'active' : '' });
    b.innerHTML = `<i class="uiIco ui-${sec.icon}"></i><span></span>`;
    b.querySelector('span').textContent = sec.title;
    b.onclick = () => { settingsTab = sec.id; buildSettings(); };
    return b;
  }));
  const sec = PREFS.find((s) => s.id === settingsTab), body = $('setBody');
  body.replaceChildren(...sec.fields.map((fd) => fieldEl(fd, prefs[fd.key], (v) => {
    setPref(fd.key, v);
    if (fd.key === 'discordActivity') buildSettings(); // the detail toggles below follow it
  }, `pref.${fd.key}`)));
  if (sec.id === 'activity') for (const row of body.querySelectorAll('.field:not([data-key="pref.discordActivity"])')) row.style.opacity = prefs.discordActivity ? '' : '.45';
  if (sec.hint) body.append(Object.assign(document.createElement('p'), { className: 'setHint', textContent: sec.hint }));
  if (sec.id === 'access') {
    const row = Object.assign(document.createElement('div'), { className: 'setActions' });
    for (const [label, fn] of [['Roblox access…', () => $('credsBtn').click()], ['Open asset cache', () => window.native.openCache()],
      ['Clear asset cache', async () => { await window.native.clearCache(); clearMemoryCache(); status('Asset cache cleared'); }]]) {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
      b.onclick = fn;
      row.append(b);
    }
    body.append(row);
  }
}
$('settingsBtn').onclick = () => { buildSettings(); $('settingsDlg').showModal(); };
$('setDone').onclick = () => $('settingsDlg').close();
$('setReset').onclick = () => {
  if (!confirm('Reset all settings to their defaults? Your files and render settings are not affected.')) return;
  prefs = prefsWithDefaults({});
  applyPrefs(); buildSettings();
  window.native.setPrefs(prefs);
};

// ---------------- session ----------------
// Open files and their edits are saved every few seconds and on close, then reopened on the next launch.
function sessionJson() {
  return JSON.stringify({ current: files.indexOf(current), linkEdits: $('linkEdits').checked,
    files: files.map((f) => ({ name: f.name, src: f.src, path: f.path, disabled: f.disabled, settings: f.settings, animSel: f.animSel, animTime: f.animTime, checked: f.checked })) });
}
let savedSession = null; // null until the previous session is restored, so an early save can't wipe it
function saveSession() {
  if (savedSession == null) return;
  const json = sessionJson();
  if (json === savedSession) return;
  const r = window.native.saveSession(json);
  if (r === true) savedSession = json; else status(`Could not save the session: ${r}`);
}
async function restoreSession() {
  try {
    await prefsLoaded;
    const s = prefs.restoreSession ? await window.native.getSession() : null;
    for (const f of s?.files ?? []) if (s.blobs[f.src]) newFile({ ...f, bytes: s.blobs[f.src], settings: withDefaults(f.settings) });
    if (s) $('linkEdits').checked = !!s.linkEdits;
    if (files.length) { select(files[s.current] ?? files[0]); files.forEach(load); status(`Reopened ${files.length} file${files.length > 1 ? 's' : ''} from last time`); }
  } catch (e) { console.error(e); status(`Could not reopen last session: ${e.message}`); }
  savedSession = '';
}
const sessionRestored = restoreSession();
setInterval(saveSession, 3000);
addEventListener('beforeunload', saveSession);

// Animation picked before a reload/restart: added IDs are re-downloaded, file animations reloaded.
function restoreAnimation(file) {
  const key = file.animSel, job = file.job;
  if (!key) return;
  let entry = job.rig && job.animations.find((a) => a.key === key);
  if (!entry && job.rig && key.startsWith('id:')) job.animations.push(entry = { key, name: `Animation ${key.slice(3)}`, id: key.slice(3), track: null });
  if (!entry) { file.animSel = ''; return; }
  ensureTrack(entry).then(() => { entry.name = entry.track?.name ?? entry.name; }, (e) => { file.animSel = ''; file.warnings.add(e.message); })
    .finally(() => { if (file === current) { syncAnimBar(); renderWarnings(); } renderList(); requestPreview(); thumb(file); });
}

// ---------------- rendering ----------------
// VFX state lives on each file's job, so simulate at that file's time right before every render.
function prepare(file) {
  const poseChanged = setPose(file.job, animEntry(file)?.track ?? null, file.animTime);
  updateTrails(file.job, file.settings.trails);
  updateVfx(file.job, file.settings.vfx, poseChanged);
}
function draw(file, size, opts) {
  prepare(file);
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
  previewLayouts = renderer.layouts ?? [];
  syncTextSel();
  // Fonts / background image still loading: draw again (and refresh the thumbnail) once they are ready.
  const file = current;
  overlayPending(file.settings)?.then(() => { requestPreview(); thumb(file); });
}
let previewLayouts = [];
new ResizeObserver(requestPreview).observe($('viewport'));

const thumbTimers = new Map();
function thumb(file, delay = 0) {
  clearTimeout(thumbTimers.get(file));
  thumbTimers.set(file, setTimeout(async () => {
    await overlayReady(file.settings);
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
    for (const fd of sec.fields) det.append(fieldEl(fd, s[sec.id][fd.key], (v) => {
      setValue(sec.id, fd.key, v);
      if (sec.id === 'vfx') syncTimeline();
      if (fd.type === 'image') { if (v) setValue('background', 'mode', 'image'); buildPanel(); }
    }, `${sec.id}.${fd.key}`));
    panel.append(det);
  }
  buildTextSection();
  syncTimeline();
}

// One settings row. set(value) applies it; dataKey lets viewport gestures update the row in place.
function fieldEl(fd, value, set, dataKey = '') {
  const row = document.createElement('div');
  row.className = 'field' + (fd.type === 'range' || fd.type === 'textarea' ? '' : ' inline');
  if (dataKey) row.dataset.key = dataKey;
  row.append(Object.assign(document.createElement('span'), { textContent: fd.label }));
  if (fd.type === 'range') {
    const num = Object.assign(document.createElement('input'), { type: 'number', min: fd.min, max: fd.max, step: fd.step, value });
    const rng = Object.assign(document.createElement('input'), { type: 'range', min: fd.min, max: fd.max, step: fd.step, value });
    rng.oninput = () => { num.value = rng.value; set(+rng.value); };
    num.onchange = () => { rng.value = num.value; set(+num.value); };
    row.append(num, rng);
  } else if (fd.type === 'bool') {
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: value });
    cb.onchange = () => set(cb.checked);
    row.append(cb);
  } else if (fd.type === 'color') {
    const ci = Object.assign(document.createElement('input'), { type: 'color', value });
    ci.oninput = () => set(ci.value);
    row.append(ci);
  } else if (fd.type === 'textarea') {
    const ta = Object.assign(document.createElement('textarea'), { value, rows: 2, spellcheck: false });
    ta.oninput = () => set(ta.value);
    row.append(ta);
  } else if (fd.type === 'image') {
    const box = Object.assign(document.createElement('span'), { className: 'imgField' });
    if (value) box.append(Object.assign(document.createElement('img'), { src: value, alt: '' }));
    const pick = Object.assign(document.createElement('button'), { textContent: value ? 'Change…' : 'Choose…', title: 'Pick an image file (or drop one on the preview)' });
    pick.onclick = async () => { const url = await pickImage(); if (url) set(url); };
    box.append(pick);
    if (value) { const rm = Object.assign(document.createElement('button'), { textContent: '✕', title: 'Remove image' }); rm.onclick = () => set(''); box.append(rm); }
    row.append(box);
  } else if (fd.type === 'font' || fd.type === 'weight') {
    const sel = document.createElement('select');
    sel.append(new Option(String(value), value, true, true));
    sel.onchange = () => set(fd.type === 'weight' ? +sel.value : sel.value);
    fontFamilies().then((list) => (fd.type === 'font' ? fillFonts(sel, list, value) : fillWeights(sel, list, fd.font, value)));
    row.append(sel);
  } else {
    const sel = document.createElement('select');
    for (const o of fd.options) sel.append(new Option(o[0].toUpperCase() + o.slice(1), o, false, o === value));
    sel.onchange = () => set(sel.value);
    row.append(sel);
  }
  return row;
}

// Roblox Studio fonts first (from the local install), then system fonts.
function fillFonts(sel, list, value) {
  sel.replaceChildren();
  if (!list.some((f) => f.family === value)) sel.append(new Option(`${value} (missing)`, value));
  for (const [label, roblox] of [['Roblox Studio fonts', true], ['System fonts', false]]) {
    const items = list.filter((f) => f.roblox === roblox);
    if (!items.length) continue;
    const group = Object.assign(document.createElement('optgroup'), { label });
    for (const f of items) group.append(new Option(f.family, f.family));
    sel.append(group);
  }
  sel.value = value;
}
function fillWeights(sel, list, family, value) {
  const faces = list.find((f) => f.family === family)?.faces ?? [{ weight: 400 }, { weight: 700 }];
  const weights = [...new Map(faces.map((f) => [f.weight ?? 400, f.name])).entries()].sort((a, b) => a[0] - b[0]);
  if (!weights.some(([w]) => w === value)) weights.push([value, 'Custom']);
  sel.replaceChildren(...weights.map(([w, name]) => new Option(name ? `${name} (${w})` : String(w), w, false, w === value)));
}

function pickImage() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.onchange = () => (input.files[0] ? imageDataUrl(input.files[0]).then(resolve, (e) => { status('Could not read image: ' + e.message); resolve(null); }) : resolve(null));
    input.click();
  });
}
// Kept inside the settings (so profiles and copied settings carry it), downscaled to at most 2048 px.
async function imageDataUrl(file, max = 2048) {
  const bmp = await createImageBitmap(file), k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = canvasOf(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.92);
}

// ---------------- text layers ----------------
let selectedText = null; // layer id in the current file
const layerOf = (f, id) => f?.settings.texts.find((t) => t.id === id);
const layerName = (text) => String(text).split('\n')[0].trim() || '(empty)';

// Edits go to the layer with this id in the current file (and in checked files when edits are linked).
function setText(id, patch, rebuild = false) {
  for (const f of targets()) { const t = layerOf(f, id); if (t) { Object.assign(t, patch); thumb(f, 500); } }
  if ('font' in patch) loadFamily(patch.font).then(() => { requestPreview(); for (const f of targets()) thumb(f); });
  requestPreview();
  if (rebuild) return buildTextSection();
  for (const [k, v] of Object.entries(patch)) {
    const row = document.querySelector(`#textSection .field[data-key="text.${k}"]`);
    if (row) for (const i of row.querySelectorAll('input, textarea')) if (i.type !== 'checkbox' && i !== document.activeElement) i.value = v;
    const name = k === 'text' && document.querySelector(`#textSection li[data-id="${id}"] .name`);
    if (name) name.textContent = layerName(v);
  }
}

function selectText(id) {
  if (id === selectedText) return syncTextSel();
  if (editingText && editingText !== id) closeTextEdit();
  selectedText = id;
  if (id) openSections.add('text');
  buildTextSection();
  syncTextSel();
  if (id) $('textSection').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function moveLayer(id, delta) {
  for (const f of targets()) {
    const list = f.settings.texts, i = list.findIndex((t) => t.id === id), j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) continue;
    [list[i], list[j]] = [list[j], list[i]];
    thumb(f, 200);
  }
  buildTextSection(); requestPreview();
}
function deleteLayer(id) {
  for (const f of targets()) { f.settings.texts = f.settings.texts.filter((t) => t.id !== id); thumb(f, 200); }
  if (selectedText === id) selectedText = null;
  buildTextSection(); requestPreview();
}
async function addText() {
  if (!current) return;
  const t = textLayer({ font: (await fontFamilies()).some((f) => f.family === 'Builder Sans') ? 'Builder Sans' : 'Arial' });
  for (const f of targets()) { f.settings.texts.push(clone(t)); thumb(f, 300); }
  loadFamily(t.font).then(requestPreview);
  selectText(t.id);
  requestPreview();
  $('textSection').querySelector('textarea')?.select();
}

function buildTextSection() {
  const det = Object.assign(document.createElement('details'), { id: 'textSection', open: openSections.has('text') });
  det.ontoggle = () => { det.open ? openSections.add('text') : openSections.delete('text'); store.set('openSections', [...openSections]); };
  const sum = Object.assign(document.createElement('summary'), { textContent: 'Text' });
  const apply = Object.assign(document.createElement('button'), { className: 'apply', textContent: 'Apply to all', title: 'Copy these text layers to every file' });
  apply.onclick = (e) => {
    e.preventDefault();
    for (const f of files) if (f !== current) { f.settings.texts = clone(current.settings.texts); thumb(f, 200); }
    status(`Text applied to ${files.length} files`);
  };
  sum.append(apply);
  const add = Object.assign(document.createElement('button'), { className: 'primary addText', textContent: '+ Add text' });
  add.onclick = addText;
  const list = Object.assign(document.createElement('ul'), { className: 'tlist' });
  for (const t of [...(current?.settings.texts ?? [])].reverse()) { // topmost first
    const li = Object.assign(document.createElement('li'), { className: t.id === selectedText ? 'active' : '' });
    li.dataset.id = t.id;
    li.innerHTML = '<span class="name"></span><button title="Bring forward">▲</button><button title="Send backward">▼</button><button title="Delete">✕</button>';
    li.querySelector('.name').textContent = layerName(t.text);
    const [up, down, del] = li.querySelectorAll('button');
    up.onclick = (e) => { e.stopPropagation(); moveLayer(t.id, 1); };
    down.onclick = (e) => { e.stopPropagation(); moveLayer(t.id, -1); };
    del.onclick = (e) => { e.stopPropagation(); deleteLayer(t.id); };
    li.onclick = () => selectText(t.id === selectedText ? null : t.id);
    list.append(li);
  }
  det.append(sum, add, list);
  const t = layerOf(current, selectedText);
  if (t) for (const fd of TEXT_FIELDS) {
    det.append(fieldEl(fd.type === 'weight' ? { ...fd, font: t.font } : fd, t[fd.key], (v) => setText(t.id, { [fd.key]: v }, fd.key === 'font'), `text.${fd.key}`));
  }
  det.append(Object.assign(document.createElement('p'), { className: 'hint', textContent:
    'On the preview: drag a text to move it, corner handles resize, the top handle rotates (Shift snaps to 15°), the wheel over a text resizes it, double-click edits, Delete removes, arrow keys nudge.' }));
  const old = $('textSection');
  if (old) old.replaceWith(det); else $('sections').append(det);
}

// Selection box over the preview, placed from the last preview render's text layout.
function syncTextSel() {
  const el = $('textSel'), L = current && previewLayouts.find((l) => l.id === selectedText);
  if (!L) { el.hidden = true; if (editingText) closeTextEdit(); return; }
  const vr = $('viewport').getBoundingClientRect(), cr = canvas.getBoundingClientRect(), w = cr.width;
  const left = `${cr.left - vr.left + L.cx * w}px`, top = `${cr.top - vr.top + L.cy * w}px`;
  el.hidden = false;
  Object.assign(el.style, {
    left, top, width: `${(L.box[2] - L.box[0]) * w}px`, height: `${(L.box[3] - L.box[1]) * w}px`,
    transform: `rotate(${L.rot}rad) translate(${L.box[0] * w}px, ${L.box[1] * w}px)`,
  });
  const t = editingText === selectedText && layerOf(current, editingText);
  if (!t) return;
  // Same font, size, spacing and stretch as the render, so the caret sits on the real glyphs underneath.
  const k = w / 512, px = t.size * k, lineH = px * t.lineHeight, pad = Math.max(0, t.strokeWidth) * k, half = px * 0.62 + pad;
  Object.assign($('textEdit').style, {
    left, top, width: `${((L.box[2] - L.box[0]) * w) / t.scaleX}px`, height: `${((L.box[3] - L.box[1]) * w) / t.scaleY}px`,
    font: fontString(t, px), letterSpacing: `${t.spacing * k}px`, lineHeight: `${lineH}px`, textAlign: t.align,
    padding: `${Math.max(0, half - lineH / 2)}px ${pad}px 0`,
    transform: `rotate(${L.rot}rad) translate(${L.box[0] * w}px, ${L.box[1] * w}px) scale(${t.scaleX}, ${t.scaleY})`,
  });
  $('textEdit').classList.toggle('curved', !!t.curve); // curved text can't line up with a textarea: show the text itself
}

// Double-click a text on the preview: type right on it. Enter or clicking away finishes, Shift+Enter adds a line.
let editingText = null;
function openTextEdit(id) {
  const t = layerOf(current, id), ed = $('textEdit');
  if (!t) return;
  editingText = id;
  ed.value = t.text;
  ed.hidden = false;
  syncTextSel();
  ed.focus(); ed.select();
}
function closeTextEdit() {
  editingText = null;
  $('textEdit').hidden = true;
}
$('textEdit').oninput = () => { if (editingText) setText(editingText, { text: $('textEdit').value }); };
$('textEdit').onblur = closeTextEdit;
$('textEdit').onkeydown = (e) => {
  e.stopPropagation(); // Delete/arrows/Space edit the text, not the layer or playback
  if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); $('textEdit').blur(); }
};

// Sync range fields after viewport interaction without rebuilding the panel.
function syncField(sec, key) {
  const row = document.querySelector(`.field[data-key="${sec}.${key}"]`);
  if (row) for (const i of row.querySelectorAll('input')) i.value = current.settings[sec][key];
}

// ---------------- viewport interaction ----------------
// Texts: drag to move, handles scale/rotate, wheel resizes. Alt: drag/wheel the background image. Else: camera.
let drag = null;
const framePoint = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
const round3 = (v) => Math.round(v * 1000) / 1000;
const bgImageActive = () => current?.settings.background.mode === 'image' && !!current.settings.background.image;

canvas.addEventListener('pointerdown', (e) => {
  if (!current) return;
  canvas.setPointerCapture(e.pointerId);
  const [px, py] = framePoint(e);
  const hit = e.button === 0 && !e.altKey ? hitText(previewLayouts, px, py) : null;
  if (hit) {
    selectText(hit);
    const t = layerOf(current, hit);
    drag = { mode: 'move', id: hit, px, py, x: t.x, y: t.y };
    return;
  }
  if (selectedText) selectText(null);
  if (e.altKey && bgImageActive()) drag = { mode: 'bg', x: e.clientX, y: e.clientY };
  else drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || drag.handle) return;
  if (drag.mode === 'move') {
    const [px, py] = framePoint(e);
    setText(drag.id, { x: round3(clamp(drag.x + px - drag.px, -0.5, 0.5)), y: round3(clamp(drag.y - (py - drag.py), -0.5, 0.5)) });
    return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.mode === 'bg') {
    const b = current.settings.background, k = 1 / canvas.clientWidth;
    setValue('background', 'imageX', round3(clamp(b.imageX + dx * k, -1, 1)));
    setValue('background', 'imageY', round3(clamp(b.imageY - dy * k, -1, 1)));
    syncField('background', 'imageX'); syncField('background', 'imageY');
    return;
  }
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
canvas.addEventListener('dblclick', (e) => {
  const hit = current && hitText(previewLayouts, ...framePoint(e));
  if (!hit) return;
  selectText(hit);
  openTextEdit(hit);
});
canvas.addEventListener('wheel', (e) => {
  if (!current) return;
  e.preventDefault();
  const steps = -e.deltaY / (e.deltaMode === 1 ? 3 : 100), hit = !e.altKey && hitText(previewLayouts, ...framePoint(e));
  if (hit) {
    const t = layerOf(current, hit), f = 1.1 ** (e.ctrlKey ? steps / 5 : steps);
    selectText(hit);
    setText(hit, { size: clamp(Math.round(t.size * f), 4, 400), strokeWidth: Math.round(t.strokeWidth * f * 2) / 2 });
  } else if (e.altKey && bgImageActive()) {
    setValue('background', 'imageScale', round3(clamp(current.settings.background.imageScale * 1.1 ** steps, 0.05, 8)));
    syncField('background', 'imageScale');
  } else {
    setValue('camera', 'zoom', wheelZoom(current.settings.camera.zoom, e, canvas.clientHeight));
    syncField('camera', 'zoom');
  }
}, { passive: false });

// Selection handles: corners scale (size and stroke together), the top knob rotates around the anchor.
$('textSel').addEventListener('pointerdown', (e) => {
  const mode = e.target.dataset.h, t = layerOf(current, selectedText), L = previewLayouts.find((l) => l.id === selectedText);
  if (!mode || !t || !L) return;
  e.stopPropagation();
  e.target.setPointerCapture(e.pointerId);
  const r = canvas.getBoundingClientRect(), cx = r.left + L.cx * r.width, cy = r.top + L.cy * r.height;
  drag = { handle: true, mode, cx, cy, d0: Math.hypot(e.clientX - cx, e.clientY - cy) || 1, a0: Math.atan2(e.clientY - cy, e.clientX - cx), size: t.size, stroke: t.strokeWidth, rot: t.rotation };
  if (mode === 'sx' || mode === 'sy') {
    const a = L.rot + (mode === 'sy' ? Math.PI / 2 : 0);
    drag.axis = [Math.cos(a), Math.sin(a)];
    drag.d0 = Math.abs((e.clientX - cx) * drag.axis[0] + (e.clientY - cy) * drag.axis[1]) || 1;
    drag.stretch = mode === 'sx' ? t.scaleX : t.scaleY;
  }
});
// Tracked on the window so the gesture keeps working wherever the pointer goes.
addEventListener('pointermove', (e) => {
  if (!drag?.handle) return;
  if (drag.mode === 'scale') {
    const f = Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) / drag.d0;
    setText(selectedText, { size: clamp(Math.round(drag.size * f), 4, 400), strokeWidth: Math.round(drag.stroke * f * 2) / 2 });
  } else if (drag.axis) {
    const d = Math.abs((e.clientX - drag.cx) * drag.axis[0] + (e.clientY - drag.cy) * drag.axis[1]);
    setText(selectedText, { [drag.mode === 'sx' ? 'scaleX' : 'scaleY']: clamp(Math.round(drag.stretch * (d / drag.d0) * 100) / 100, 0.1, 5) });
  } else {
    let deg = drag.rot + ((Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx) - drag.a0) * 180) / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    setText(selectedText, { rotation: Math.round(((deg + 540) % 360) - 180) });
  }
});
addEventListener('pointerup', () => { if (drag?.handle) drag = null; });

addEventListener('keydown', (e) => {
  if (!selectedText || !current || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  const t = layerOf(current, selectedText);
  if (!t) return;
  const step = (e.shiftKey ? 10 : 1) / 512, nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteLayer(t.id); }
  else if (e.key === 'Escape') selectText(null);
  else if (nudge) { e.preventDefault(); setText(t.id, { x: round3(clamp(t.x + nudge[0], -0.5, 0.5)), y: round3(clamp(t.y + nudge[1], -0.5, 0.5)) }); }
});
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

function canvasOf(w, h, img = null) {
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  if (img) c.getContext('2d').putImageData(img, 0, 0);
  return c;
}
async function canvasBytes(c, format = 'png') {
  const blob = await new Promise((res) => c.toBlob(res, 'image/' + format, 0.95));
  return new Uint8Array(await blob.arrayBuffer());
}

async function encode(file, { size, format, ss }) {
  await overlayReady(file.settings);
  let c = canvasOf(size, size, draw(file, size, { out: 'pixels', supersample: ss }));
  if (format === 'jpeg') {
    const flat = canvasOf(size, size), g = flat.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size); g.drawImage(c, 0, 0);
    c = flat;
  }
  requestPreview();
  return canvasBytes(c, format);
}
const baseName = (n) => n.replace(/\.(rbxmx?|obj)$/i, ''); // split-out models have no extension and may contain dots

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

// ---------------- animated export ----------------
// Frames render at exact times through the same path as stills (pose, deterministic VFX/trails, post), never realtime.
const yieldUI = () => new Promise((r) => setTimeout(r));
// Frame size is the dialog's own (it starts at the toolbar size). Sheets can instead be sized as a whole, with frames
// shrinking to fit. The line under the options shows the resulting image.
const sheetPlan = () => {
  const n = frameTimes(Math.max(0, +$('axStart').value || 0), Math.max(0.01, +$('axDuration').value || 1), clamp(Math.round(+$('axFps').value || 24), 1, 60), $('axLoop').checked).length;
  const cols = Math.max(0, Math.round(+$('axCols').value || 0)), pad = Math.max(0, Math.round(+$('axPad').value || 0));
  const sheet = $('axSizeBy').value === 'sheet' ? +$('axSheetSize').value : 0, size = sheet ? frameSizeForSheet(n, sheet, cols, pad) : +$('axSize').value;
  return { n, size, sheet, layout: sheetLayout(n, size, cols, pad) };
};
function syncAnimDlg() {
  const fmt = $('axFormat').value;
  Object.assign($('animDlg').dataset, { format: fmt, sizeby: $('axSizeBy').value });
  if (fmt !== 'sheet') return;
  const { n, size, sheet, layout: L } = sheetPlan(), w = sheet || L.width, h = sheet || L.height;
  $('axSheetInfo').textContent = `${n} frames · ${L.cols} × ${L.rows} grid · ${size} px per frame · sheet ${w} × ${h} px`
    + (!L.fits ? ` — over the ${MAX_SHEET} px limit, so numbered PNGs are saved instead. Lower the frame size, FPS or duration.`
      : sheet && size < 32 ? ' — frames are very small; use a bigger sheet or fewer frames.' : '');
  $('axSheetInfo').className = `sheetOnly ${L.fits && !(sheet && size < 32) ? 'muted' : 'warn'}`;
}
for (const id of ['axStart', 'axDuration']) $(id).oninput = syncAnimDlg;
if (store.get('ax:axSize', null) == null) $('axSize').value = $('expSize').value;
for (const id of ['axScope', 'axFormat', 'axSizeBy', 'axSheetSize', 'axSize', 'axSource', 'axFps', 'axLoop', 'axLock', 'axCols', 'axPad', 'axGifBg', 'axGifColor']) {
  const el = $(id), prop = el.type === 'checkbox' ? 'checked' : 'value', saved = store.get('ax:' + id, null);
  if (saved != null) el[prop] = saved;
  el.onchange = () => { store.set('ax:' + id, el[prop]); syncAnimDlg(); };
}
let axState = null; // { cancelled } while an export runs

$('exportAnim').onclick = () => {
  if (!current?.job) return status('Nothing to export');
  $('axDuration').value = +(animEntry(current)?.track?.length || current.settings.vfx.duration).toFixed(3);
  $('axStart').value = 0;
  $('axProgressRow').hidden = true;
  syncAnimDlg();
  $('animDlg').showModal();
};
$('axCancel').onclick = () => { if (axState) axState.cancelled = true; else $('animDlg').close(); };
$('animDlg').oncancel = (e) => { if (axState) { e.preventDefault(); axState.cancelled = true; } };
$('axGo').onclick = () => exportAnimation();

async function exportAnimation() {
  const scope = $('axScope').value;
  const list = (scope === 'current' ? [current] : scope === 'checked' ? files.filter((f) => f.checked) : files).filter((f) => f?.job);
  if (!list.length) return status('Nothing ready to export');
  const folder = await window.native.pickFolder();
  if (!folder) return;
  const o = { ...exportOpts(), size: +$('axSize').value, format: $('axFormat').value, source: $('axSource').value,
    fps: clamp(Math.round(+$('axFps').value || 24), 1, 60), start: Math.max(0, +$('axStart').value || 0), duration: Math.max(0.01, +$('axDuration').value || 1),
    loop: $('axLoop').checked, lock: $('axLock').checked, cols: Math.max(0, Math.round(+$('axCols').value || 0)), pad: Math.max(0, Math.round(+$('axPad').value || 0)),
    gifBg: $('axGifBg').value === 'solid' ? hexToVec3($('axGifColor').value).map((v) => v * 255) : null };
  if (o.format === 'gif') o.size = Math.min(o.size, MAX_GIF_SIZE);
  if (o.format === 'sheet') ({ size: o.size, sheet: o.sheet } = sheetPlan()); // same frame count for every file
  setPlaying(false); setAnimPlaying(false);
  const saved = list.map((f) => [f, f.animTime, f.settings.vfx.time]);
  axState = { cancelled: false };
  $('axGo').disabled = true; $('axCancel').textContent = 'Cancel'; $('axProgressRow').hidden = false;
  const used = new Set(), notes = [];
  try {
    for (const [k, f] of list.entries()) {
      let name = baseName(f.name), n = 2;
      while (used.has(name)) name = `${baseName(f.name)}_${n++}`;
      used.add(name);
      const note = await exportClip(f, o, folder, name, (i, total, what) => {
        $('axProgress').value = (k + i / total) / list.length;
        $('axProgressLabel').textContent = `${list.length > 1 ? `${f.name} (${k + 1}/${list.length}) · ` : ''}${what} ${i}/${total}`;
      });
      if (note) notes.push(note);
      if (axState.cancelled) break;
    }
    status(axState.cancelled ? 'Animated export cancelled' : `Exported ${list.length} animation${list.length > 1 ? 's' : ''} to ${folder}${notes.length ? ' — ' + notes.join('; ') : ''}`);
  } catch (e) {
    console.error(e); status('Animated export failed: ' + e.message);
  } finally {
    for (const [f, animTime, vfxTime] of saved) { f.animTime = animTime; f.settings.vfx.time = vfxTime; }
    axState = null;
    $('axGo').disabled = false; $('axCancel').textContent = 'Close';
    $('animDlg').close();
    syncTimeline(); syncAnimBar(); requestPreview();
  }
}

function gifWorker() {
  const w = new Worker(new URL('./gif.worker.js', import.meta.url), { type: 'module' });
  let wait = null;
  w.onmessage = ({ data }) => (data.type === 'error' ? wait.reject(new Error(data.message)) : wait.resolve(data));
  w.onerror = (e) => wait?.reject(new Error(e.message || 'GIF encoder failed'));
  return {
    call: (msg, transfer = []) => new Promise((resolve, reject) => { wait = { resolve, reject }; w.postMessage(msg, transfer); }),
    terminate: () => w.terminate(),
  };
}

// One file's clip. Frames stream to disk (or into the sheet / GIF encoder) instead of piling up in memory.
// Returns a note for the status line, if any.
async function exportClip(f, o, folder, name, progress) {
  await overlayReady(f.settings);
  const times = frameTimes(o.start, o.duration, o.fps, o.loop);
  const at = (t) => { if (o.source !== 'vfx') f.animTime = t; if (o.source !== 'animation') f.settings.vfx.time = t; };
  // Lock framing across the clip, so per-frame auto-fit doesn't make the model grow and shrink.
  const fit = o.lock ? renderer.clipFit(f.job, f.settings, times, (t) => { at(t); prepare(f); }) : null;
  const frame = (t, size = o.size, ss = o.ss) => { at(t); return draw(f, size, { out: 'pixels', supersample: ss, fit }); };
  const write = async (file, bytes) => window.native.writeFile(await window.native.joinPath(folder, file), bytes);
  let format = o.format, note = null;
  const layout = format === 'sheet' ? sheetLayout(times.length, o.size, o.cols, o.pad) : null;
  if (layout && o.sheet) Object.assign(layout, { width: o.sheet, height: o.sheet }); // fixed sheet: frames already fit
  if (layout && !layout.fits) { format = 'png'; note = `${name}: a ${layout.width}×${layout.height} sheet is too large, wrote numbered PNGs`; }

  if (format === 'png') {
    const digits = Math.max(4, String(times.length - 1).length);
    for (const [i, t] of times.entries()) {
      if (axState?.cancelled) return note;
      progress(i, times.length, 'Frame');
      await write(`${name}_${String(i).padStart(digits, '0')}.png`, await canvasBytes(canvasOf(o.size, o.size, frame(t))));
      await yieldUI();
    }
    return note;
  }

  if (format === 'sheet') {
    const sheet = canvasOf(layout.width, layout.height), g = sheet.getContext('2d');
    for (const [i, t] of times.entries()) {
      if (axState?.cancelled) return note;
      progress(i, times.length, 'Frame');
      g.putImageData(frame(t), layout.frames[i].x, layout.frames[i].y);
      await yieldUI();
    }
    progress(times.length, times.length, 'Saving');
    await write(`${name}.png`, await canvasBytes(sheet));
    const meta = { image: `${name}.png`, fps: o.fps, duration: o.duration, loop: o.loop, frameWidth: o.size, frameHeight: o.size,
      columns: layout.cols, rows: layout.rows, padding: o.pad, frames: layout.frames.map((r, i) => ({ ...r, time: +times[i].toFixed(4) })) };
    await write(`${name}.json`, new TextEncoder().encode(JSON.stringify(meta, null, 1)));
    return note;
  }

  // GIF: one palette from a few evenly spaced frames, then frames encode in a worker while the next one renders.
  const gif = gifWorker();
  try {
    const samples = [], picks = Math.min(times.length, 12);
    for (let k = 0; k < picks; k++) {
      if (axState?.cancelled) return note;
      progress(k, picks, 'Palette');
      const img = frame(times[Math.floor((k * times.length) / picks)], Math.min(o.size, 256), 1);
      if (o.gifBg) flatten(img.data, o.gifBg);
      opaqueSamples(img.data, 20000, samples);
      await yieldUI();
    }
    await gif.call({ type: 'start', samples: new Uint8Array(samples), width: o.size, height: o.size, transparent: !o.gifBg, repeat: o.loop ? 0 : -1 });
    const delays = gifDelays(times.length, o.fps);
    let pending = null;
    for (const [i, t] of times.entries()) {
      if (axState?.cancelled) return note;
      progress(i, times.length, 'Frame');
      const img = frame(t);
      if (o.gifBg) flatten(img.data, o.gifBg);
      await pending;
      pending = gif.call({ type: 'frame', pixels: img.data.buffer, delay: delays[i] }, [img.data.buffer]);
      await yieldUI();
    }
    await pending;
    progress(times.length, times.length, 'Encoding');
    await write(`${name}.gif`, (await gif.call({ type: 'finish' })).bytes);
  } finally { gif.terminate(); }
  return note;
}

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
$('trayBtn').onclick = () => window.native.hideToTray();
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
addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
  const dropped = [...e.dataTransfer.files], image = dropped.find((f) => f.type.startsWith('image/'));
  addFiles(dropped.filter((f) => f !== image));
  if (image && current) { // an image becomes the background of the current (or linked) files
    const url = await imageDataUrl(image).catch((err) => status('Could not read image: ' + err.message));
    if (url) { setValue('background', 'image', url); setValue('background', 'mode', 'image'); buildPanel(); status(`Background image: ${image.name}`); }
  }
});

buildPanel();
renderList();
renderWorkspace();

// Launch splash (built in index.html): fade out once the renderer is up, after the intro has played (~2 s).
{
  const splash = $('splash');
  const hide = () => { splash.classList.add('done'); setTimeout(() => splash.remove(), 700); };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const schedule = () => {
    if (window.__splashStart == null) return requestAnimationFrame(schedule);
    setTimeout(hide, reduced ? 0 : Math.max(400, window.__splashStart + 2300 - performance.now()));
  };
  prefsLoaded.then(() => (prefs.splash ? schedule() : hide()));
}

// Test hook: lets an automated harness load files and grab renders.
window.__app = { addFiles, files, renderer, encode, select, loadAnimationId, exportClip, sessionRestored, saveSession, splitOut, sheetPlan };
