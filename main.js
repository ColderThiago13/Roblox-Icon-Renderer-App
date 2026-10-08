import { app, BrowserWindow, ipcMain, dialog, protocol, net, safeStorage, shell, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createConnection } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Fixed data folder (config with the saved API key, asset cache, settings) so updates/renames never lose it.
app.setPath('userData', process.env.RIR_USER_DATA || path.join(app.getPath('appData'), 'roblox-icon-renderer')); // env: isolated test runs
const CONFIG = () => path.join(app.getPath('userData'), 'config.json');
const CACHE = () => path.join(app.getPath('userData'), 'asset-cache');

// app:// serves the project folder so fetch(), workers and ES module imports all work (file:// blocks fetch).
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

async function readConfig() {
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG(), 'utf8'));
    for (const k of ['apiKey', 'cookie']) if (raw[k]) raw[k] = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(raw[k], 'base64')) : raw[k];
    return raw;
  } catch { return {}; }
}

async function writeConfig(cfg) {
  const out = { ...cfg };
  for (const k of ['apiKey', 'cookie']) if (out[k]) out[k] = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(out[k]).toString('base64') : out[k];
  await fs.mkdir(path.dirname(CONFIG()), { recursive: true });
  await fs.writeFile(CONFIG(), JSON.stringify(out));
}

const inflight = new Map();

async function downloadAsset(id) {
  const cfg = await readConfig();
  const attempts = [];
  if (cfg.apiKey) attempts.push(async () => {
    const r = await net.fetch(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${id}`, { headers: { 'x-api-key': cfg.apiKey } });
    if (!r.ok) throw new Error(`API key: HTTP ${r.status}`);
    const { location } = await r.json();
    if (!location) throw new Error('API key: no location in response');
    return net.fetch(location);
  });
  const cookieHeaders = cfg.cookie ? { Cookie: `.ROBLOSECURITY=${cfg.cookie.replace(/^\.ROBLOSECURITY=/, '')}` } : {};
  attempts.push(() => net.fetch(`https://assetdelivery.roblox.com/v1/asset/?id=${id}`, { headers: cookieHeaders }));

  const errors = [];
  for (const attempt of attempts) {
    try {
      const r = await attempt();
      if (!r.ok) { errors.push(`HTTP ${r.status}`); continue; }
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(`Asset ${id} download failed (${errors.join('; ')}). Set a Roblox API key or cookie in Settings.`);
}

ipcMain.handle('asset:get', async (_e, id) => {
  if (!/^\d+$/.test(String(id))) throw new Error('Bad asset id');
  const file = path.join(CACHE(), String(id));
  try { return await fs.readFile(file); } catch { /* not cached */ }
  if (!inflight.has(id)) inflight.set(id, downloadAsset(id).then(async (buf) => {
    await fs.mkdir(CACHE(), { recursive: true });
    await fs.writeFile(file, buf);
    return buf;
  }).finally(() => inflight.delete(id)));
  return inflight.get(id);
});

// rbxasset:// files (classic body meshes, the default face, …) ship with Roblox, not the asset API,
// so read them from the newest local Roblox Studio/Player install. Read-only, confined to its content folder.
let robloxContent = null; // one shared lookup, however many requests arrive at once
function robloxContentDir() {
  robloxContent ??= (async () => {
    const roots = [path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'Versions'), path.join(process.env['ProgramFiles(x86)'] || '', 'Roblox', 'Versions')];
    let best = null;
    for (const root of roots) {
      for (const d of await fs.readdir(root).catch(() => [])) {
        const content = path.join(root, d, 'content');
        const stat = await fs.stat(path.join(content, 'avatar', 'meshes', 'torso.mesh')).catch(() => null);
        if (stat && (!best || stat.mtimeMs > best.time)) best = { content, time: stat.mtimeMs };
      }
    }
    return best?.content ?? null;
  })();
  return robloxContent;
}
ipcMain.handle('rbxasset:get', async (_e, rel) => {
  const dir = await robloxContentDir();
  if (!dir) throw new Error(`rbxasset://${rel} needs Roblox Studio or the Roblox player installed`);
  const file = path.normalize(path.join(dir, String(rel)));
  if (!file.startsWith(dir + path.sep)) throw new Error('Bad rbxasset path');
  return fs.readFile(file);
});
ipcMain.handle('rbxasset:list', async (_e, rel) => {
  const dir = await robloxContentDir();
  if (!dir) return [];
  const folder = path.normalize(path.join(dir, String(rel)));
  if (!folder.startsWith(dir + path.sep)) throw new Error('Bad rbxasset path');
  return fs.readdir(folder).catch(() => []);
});

ipcMain.handle('config:get', async () => {
  const cfg = await readConfig();
  return { hasApiKey: !!cfg.apiKey, hasCookie: !!cfg.cookie };
});
ipcMain.handle('config:set', async (_e, patch) => {
  const cfg = { ...(await readConfig()), ...patch };
  for (const k of Object.keys(cfg)) if (cfg[k] === '') delete cfg[k];
  await writeConfig(cfg);
});
// Saved render profiles: { [name]: settings }. Kept in userData so updates don't lose them.
const PROFILES = () => path.join(app.getPath('userData'), 'profiles.json');
ipcMain.handle('profiles:get', async () => { try { return JSON.parse(await fs.readFile(PROFILES(), 'utf8')); } catch { return {}; } });
ipcMain.handle('profiles:set', async (_e, profiles) => {
  await fs.mkdir(path.dirname(PROFILES()), { recursive: true });
  await fs.writeFile(PROFILES(), JSON.stringify(profiles, null, 1));
});
// Open files survive restarts: session.json (names, settings, …) plus one <key>.bin per source file's bytes.
const SESSION = () => path.join(app.getPath('userData'), 'session');
const blobPath = (key) => {
  if (!/^[a-z0-9]{1,40}$/i.test(String(key))) throw new Error('Bad session key');
  return path.join(SESSION(), `${key}.bin`);
};
ipcMain.handle('session:get', async () => {
  let s;
  try { s = JSON.parse(await fs.readFile(path.join(SESSION(), 'session.json'), 'utf8')); } catch { return null; }
  const keys = new Set(s.files.map((f) => f.src));
  for (const f of await fs.readdir(SESSION())) if (f !== 'session.json' && !keys.has(f.replace(/\.bin$/, ''))) await fs.rm(path.join(SESSION(), f), { force: true });
  s.blobs = {};
  for (const k of keys) s.blobs[k] = await fs.readFile(blobPath(k)).catch(() => null);
  return s;
});
ipcMain.handle('session:blob', async (_e, key, data) => {
  const file = blobPath(key);
  await fs.mkdir(SESSION(), { recursive: true });
  if (await fs.stat(file).catch(() => null)) return;
  await fs.writeFile(file + '.tmp', Buffer.from(data));
  await fs.rename(file + '.tmp', file);
});
// Synchronous so it still completes while the window is closing. tmp + rename: a crash never leaves half a file.
ipcMain.on('session:save', (e, json) => {
  try {
    fsSync.mkdirSync(SESSION(), { recursive: true });
    const file = path.join(SESSION(), 'session.json');
    fsSync.writeFileSync(file + '.tmp', json);
    fsSync.renameSync(file + '.tmp', file);
    e.returnValue = true;
  } catch (err) { e.returnValue = err.message; }
});
ipcMain.handle('win:tray', (e) => BrowserWindow.fromWebContents(e.sender).hide());

ipcMain.handle('cache:clear', () => fs.rm(CACHE(), { recursive: true, force: true }));
ipcMain.handle('cache:open', async () => { await fs.mkdir(CACHE(), { recursive: true }); shell.openPath(CACHE()); });

ipcMain.handle('dialog:folder', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// The extension comes from the suggested name; a typed name without it still saves as that format.
ipcMain.handle('dialog:save', async (e, defaultName) => {
  const ext = path.extname(String(defaultName)).slice(1).toLowerCase();
  const filters = ext ? [{ name: `${ext.toUpperCase()} image`, extensions: ext === 'jpg' ? ['jpg', 'jpeg'] : [ext] }] : [];
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: defaultName, filters });
  if (r.canceled || !r.filePath) return null;
  const typed = path.extname(r.filePath).slice(1).toLowerCase();
  return !ext || filters[0].extensions.includes(typed) ? r.filePath : `${r.filePath}.${ext}`;
});
ipcMain.handle('file:write', async (_e, filePath, data) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(data));
});
ipcMain.handle('file:join', (_e, ...parts) => path.join(...parts));

// ---------- preferences (Settings dialog) ----------
// The renderer owns the list and defaults (src/settings.js PREFS); main reads the ones it acts on.
const PREFS = () => path.join(app.getPath('userData'), 'prefs.json');
let prefs = {};
ipcMain.handle('prefs:get', () => prefs);
ipcMain.handle('prefs:set', async (_e, next) => {
  prefs = { ...next };
  await fs.mkdir(path.dirname(PREFS()), { recursive: true });
  await fs.writeFile(PREFS(), JSON.stringify(prefs, null, 1));
  if (prefs.discordActivity === false) discordClose(); else discordConnect();
});

// ---------- auto update (GitHub Releases) ----------
// Checks on launch and hourly; the renderer only shows the Update button when a newer release exists.
function setupUpdates(win) {
  if (!app.isPackaged || process.env.RIR_TEST_FILES) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  const send = (type, data = {}) => { if (!win.isDestroyed()) win.webContents.send('update', { type, ...data }); };
  autoUpdater.on('update-available', (info) => send('available', { version: info.version }));
  autoUpdater.on('download-progress', (p) => send('progress', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('downloaded', { version: info.version }));
  autoUpdater.on('error', (e) => send('error', { message: String(e?.message || e).split('\n')[0] }));
  const check = () => { if (prefs.autoUpdate !== false) autoUpdater.checkForUpdates().catch(() => {}); };
  win.webContents.once('did-finish-load', check);
  setInterval(check, 60 * 60 * 1000);
}
ipcMain.handle('update:download', () => autoUpdater.downloadUpdate());
ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true));
ipcMain.handle('app:version', () => app.getVersion());

// ---------- Discord activity ----------
// Rich Presence over Discord's local IPC pipe (frames: int32 opcode, int32 length, JSON). Retries quietly while Discord is closed.
// The client ID is a Discord application (discord.com/developers/applications); its name is what friends see you "playing".
const DISCORD_CLIENT_ID = '1557549358738833428';
const DISCORD_ICON = 'https://raw.githubusercontent.com/ColderThiago13/Roblox-Icon-Renderer-App/main/build/icon.png';
let discord = null, activity = null, activityTimer = null;
const discordStart = Date.now();
function discordConnect() {
  if (!DISCORD_CLIENT_ID || discord || prefs.discordActivity === false) return;
  const sock = createConnection(String.raw`\\?\pipe\discord-ipc-0`);
  const send = (op, data) => {
    const body = Buffer.from(JSON.stringify(data)), head = Buffer.alloc(8);
    head.writeInt32LE(op, 0); head.writeInt32LE(body.length, 4);
    sock.write(Buffer.concat([head, body]));
  };
  discord = { send, sock, ready: false };
  sock.on('connect', () => send(0, { v: 1, client_id: DISCORD_CLIENT_ID }));
  sock.on('data', (buf) => {
    const op = buf.readInt32LE(0), body = buf.subarray(8, 8 + buf.readInt32LE(4)).toString();
    if (op === 3) send(4, JSON.parse(body)); // ping -> pong
    else if (op === 2) sock.destroy(); // Discord closed the connection (e.g. unknown client ID)
    else if (!discord.ready && body.includes('"READY"')) { discord.ready = true; pushActivity(); }
  });
  sock.on('error', () => {});
  sock.on('close', () => { discord = null; });
}
// Turning the setting off clears the status and drops the connection (Discord removes it when the pipe closes).
function discordClose() { discord?.sock.destroy(); discord = null; }
function pushActivity() {
  if (!discord?.ready || !activity) return;
  const { details, state, showTime } = activity;
  discord.send(1, { cmd: 'SET_ACTIVITY', nonce: String(Date.now()), args: { pid: process.pid, activity: {
    details, ...(state && { state }), ...(showTime && { timestamps: { start: discordStart } }),
    assets: { large_image: DISCORD_ICON, large_text: 'Roblox Icon Renderer' } } } });
}
// Discord allows about 5 updates per 20 s, so changes are batched. Texts must be 2-128 characters.
ipcMain.on('discord:activity', (_e, a) => {
  const text = (v) => { const s = String(v ?? '').slice(0, 128); return s.trim().length >= 2 ? s : ''; };
  const next = { details: text(a?.details) || 'Roblox Icon Renderer', state: text(a?.state), showTime: a?.showTime !== false };
  if (JSON.stringify(next) === JSON.stringify(activity)) return;
  activity = next;
  clearTimeout(activityTimer);
  activityTimer = setTimeout(pushActivity, 4000);
});

// One instance: launching again (e.g. while hidden in the tray) brings the existing window back.
let mainWin = null, tray = null;
const showWindow = () => { if (!mainWin) return; mainWin.show(); if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); };
if (!process.env.RIR_TEST_FILES && !app.requestSingleInstanceLock()) app.exit(0);
// Test runs: keep animating when other windows cover this one (the splash only clears after a frame).
if (process.env.RIR_TEST_FILES) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.on('second-instance', showWindow);

let quitting = false;
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(async () => {
  try { prefs = JSON.parse(await fs.readFile(PREFS(), 'utf8')); } catch { /* defaults */ }
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 1000, minHeight: 640,
    backgroundColor: '#15161a',
    title: 'Roblox Icon Renderer',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadURL('app://local/index.html');
  mainWin = win;
  win.on('close', (e) => { if (prefs.closeToTray && !quitting) { e.preventDefault(); win.hide(); } }); // tray menu / updates still quit
  // Always in the notification area ("hidden icons"); the toolbar's tray button hides the window there.
  tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('Roblox Icon Renderer');
  tray.on('click', showWindow);
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show Roblox Icon Renderer', click: showWindow }, { type: 'separator' }, { label: 'Quit', click: () => app.quit() }]));
  setupUpdates(win);
  if (!process.env.RIR_TEST_FILES) { discordConnect(); setInterval(discordConnect, 15000); }
  if (process.env.RIR_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  if (process.env.RIR_TEST_FILES) win.webContents.once('did-finish-load', () => renderTest(win));
});

// Automated check: RIR_TEST_FILES="a.rbxm;b.obj" RIR_TEST_OUT=dir renders each file (plain + effects) to PNG and quits.
async function renderTest(win) {
  const out = process.env.RIR_TEST_OUT || path.join(ROOT, 'test-out');
  await fs.mkdir(out, { recursive: true });
  const files = await Promise.all(process.env.RIR_TEST_FILES.split(';').map(async (f) => ({ name: path.basename(f), b64: (await fs.readFile(f)).toString('base64') })));
  win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
  if (process.env.RIR_SPLASH_SHOT) {
    await new Promise((r) => setTimeout(r, +process.env.RIR_SPLASH_SHOT));
    await fs.writeFile(path.join(out, 'splash.png'), (await win.webContents.capturePage()).toPNG());
  }
  const results = await win.webContents.executeJavaScript(`(async () => {
    const app = window.__app;
    await app.sessionRestored;
    console.log('session restored: ' + JSON.stringify(app.files.map((f) => f.name)));
    const input = ${JSON.stringify(files)}.map((f) => new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name));
    await app.addFiles(input);
    while (app.files.some((f) => f.status === 'loading')) await new Promise((r) => setTimeout(r, 100));
    const outFiles = [];
    for (const f of app.files) {
      if (!f.job) { outFiles.push({ name: f.name, error: f.error }); continue; }
      const extra = ${process.env.RIR_TEST_SETTINGS || '{}'};
      for (const [sec, vals] of Object.entries(extra)) Object.assign(f.settings[sec], vals);
      const cam = ${JSON.stringify(process.env.RIR_TEST_CAMERA || '')};
      if (cam) { const [yaw, pitch] = cam.split(',').map(Number); Object.assign(f.settings.camera, { yaw, pitch }); }
      const animId = ${JSON.stringify(process.env.RIR_TEST_ANIMID || '')};
      if (animId && f.job.rig) {
        try { const track = await app.loadAnimationId(animId); f.job.animations.push({ key: 'id:' + animId, name: track.name, id: animId, track }); }
        catch (e) { f.warnings.add(e.message); }
      }
      const anim = ${JSON.stringify(process.env.RIR_TEST_ANIM || '')};
      if (anim && f.job.animations?.length) { const [i, t] = anim.split('@').map(Number); f.animSel = f.job.animations.at(i)?.key ?? ''; f.animTime = t; }
      // RIR_TEST_EXPORT="png,sheet,gif": a 1 s, 12 fps clip per format, written next to the stills.
      for (const format of ${JSON.stringify((process.env.RIR_TEST_EXPORT || '').split(',').filter(Boolean))}) {
        await app.exportClip(f, { size: ${+(process.env.RIR_TEST_EXPORT_SIZE || 192)}, ss: ${+(process.env.RIR_TEST_EXPORT_SS || 1)}, format, source: 'both', fps: 12, start: 0, duration: 1, loop: true, lock: true, cols: 0, pad: 2, gifBg: null },
          ${JSON.stringify(out)}, f.name.replace(/\\.[^.]+$/, '') + '-' + format, () => {});
      }
      const plain = await app.encode(f, { size: 512, format: 'png', ss: 2 });
      const times = [];
      for (const t of ${JSON.stringify((process.env.RIR_TEST_TIMES || '').split(',').filter(Boolean).map(Number))}) {
        Object.assign(f.settings.vfx, { time: t }); f.settings.camera.fitVfx = true;
        times.push(Array.from(await app.encode(f, { size: 384, format: 'png', ss: 1 })));
      }
      f.settings.camera.fitVfx = false; f.settings.vfx.time = 2;
      Object.assign(f.settings.glow, { enabled: true, size: 14 });
      Object.assign(f.settings.dropShadow, { enabled: true });
      Object.assign(f.settings.background, { mode: 'solid', color1: '#d8dce6' });
      Object.assign(f.settings.overlay, { mode: 'rainbow', strength: 0.25 });
      f.settings.shadows.ground = true;
      const fx = await app.encode(f, { size: 512, format: 'png', ss: 2 });
      outFiles.push({ name: f.name, anims: (f.job.animations || []).map((a) => a.name + (a.track ? ' ' + a.track.length.toFixed(2) + 's' : '')), warnings: [...f.warnings], plain: Array.from(plain), fx: Array.from(fx), times });
    }
    return outFiles;
  })()`);
  for (const [i, r] of results.entries()) {
    if (r.error) { console.log(`${r.name}: ERROR ${r.error}`); continue; }
    await fs.writeFile(path.join(out, `${i}-${r.name}.png`), Buffer.from(r.plain));
    await fs.writeFile(path.join(out, `${i}-${r.name}.fx.png`), Buffer.from(r.fx));
    for (const [k, t] of r.times.entries()) await fs.writeFile(path.join(out, `${i}-${r.name}.t${k}.png`), Buffer.from(t));
    console.log(`${r.name}: ok${r.warnings.length ? ' — ' + r.warnings.join(' | ') : ''}${r.anims.length ? ' | animations: ' + r.anims.join(', ') : ''}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mouse = (type, [x, y], modifiers = []) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers });
  const click = async (at, modifiers) => { mouse('mouseMove', at, modifiers); await wait(80); mouse('mouseDown', at, modifiers); await wait(80); mouse('mouseUp', at, modifiers); await wait(150); };
  const centerOf = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + Math.min(60, r.width / 2), r.top + r.height / 2]; })()`);
  // RIR_TEST_WORKSPACE=1: real mouse in the workspace tree. Click row 2, Ctrl+click row 4, drag both onto the file list.
  if (process.env.RIR_TEST_WORKSPACE) {
    win.focus(); win.webContents.focus();
    for (let i = 0; i < 100 && await js(`!!document.getElementById('splash')`); i++) await wait(100);
    await js('window.__app.select(window.__app.files.find((f) => f.job?.treeRoots))');
    await wait(500);
    const before = await js('window.__app.files.length');
    const a = await centerOf('#wsTree li[data-i="2"]'), b = await centerOf('#wsTree li[data-i="4"]'), target = await centerOf('#fileList');
    await click(a); await click(b, ['control']);
    console.log('workspace selected:', await js(`[...document.querySelectorAll('#wsTree li.sel .name')].map((e) => e.textContent).join(', ')`));
    mouse('mouseMove', a); await wait(80); mouse('mouseDown', a); await wait(80);
    for (let i = 1; i <= 12; i++) { mouse('mouseMove', [a[0] + ((target[0] - a[0]) * i) / 12, a[1] + ((target[1] - a[1]) * i) / 12], ['leftButtonDown']); await wait(40); }
    console.log('drop target highlighted:', await js(`document.getElementById('fileList').classList.contains('dropTarget')`), '| ghost:', await js(`document.getElementById('wsGhost')?.textContent ?? null`));
    mouse('mouseUp', target); await wait(200);
    await js('(async () => { while (window.__app.files.some((f) => f.status === "loading")) await new Promise((r) => setTimeout(r, 100)); })()');
    const added = await js(`window.__app.files.slice(${before}).map((f) => ({ name: f.name, path: f.path, status: f.status, points: f.job?.points.length ?? 0 }))`);
    console.log('workspace split out:', JSON.stringify(added));
    for (const [i, f] of added.entries()) {
      const png = await js(`window.__app.encode(window.__app.files[${before + i}], { size: 256, format: 'png', ss: 1 }).then(Array.from)`);
      await fs.writeFile(path.join(out, `split-${i}-${f.name}.png`), Buffer.from(png));
    }
    const idle = () => js('(async () => { while (window.__app.files.some((f) => f.status === "loading")) await new Promise((r) => setTimeout(r, 100)); })()');
    const rightClick = async (at) => { for (const type of ['mouseDown', 'mouseUp']) { win.webContents.sendInputEvent({ type, x: Math.round(at[0]), y: Math.round(at[1]), button: 'right', clickCount: 1 }); await wait(80); } await wait(150); };
    // Right-click Base (row 1) -> Disable: it leaves the render and its row says (Disabled).
    await js('window.__app.select(window.__app.files[0])'); await wait(500);
    const pts0 = await js('window.__app.files[0].job.points.length');
    await rightClick(await centerOf('#wsTree li[data-i="1"]'));
    console.log('context menu:', await js(`document.getElementById('ctxMenu').hidden ? null : document.getElementById('ctxMenu').textContent`));
    await click(await centerOf('#ctxMenu button')); await wait(300); await idle(); await wait(300);
    console.log('disabled:', await js(`JSON.stringify({ disabled: window.__app.files[0].disabled, row: document.querySelector('#wsTree li.off .name')?.textContent, tag: document.querySelector('#wsTree li.off .offTag')?.textContent, points: window.__app.files[0].job.points.length })`), 'points before', pts0);
    await fs.writeFile(path.join(out, 'disabled-base.png'), Buffer.from(await js(`window.__app.encode(window.__app.files[0], { size: 256, format: 'png', ss: 1 }).then(Array.from)`)));
    // Text: add one, double-click it on the preview, type, Enter; then stretch it with the right side handle.
    await js(`(() => { const d = document.getElementById('textSection'); d.open = true; d.querySelector('.addText').scrollIntoView(); })()`); await wait(300);
    await click(await centerOf('#textSection .addText')); await wait(1200);
    const textAt = await js(`(() => { const r = document.getElementById('textSel').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    mouse('mouseMove', textAt); await wait(80);
    for (const clickCount of [1, 2]) for (const type of ['mouseDown', 'mouseUp']) { win.webContents.sendInputEvent({ type, x: Math.round(textAt[0]), y: Math.round(textAt[1]), button: 'left', clickCount }); await wait(60); }
    await wait(300);
    win.webContents.insertText('Sword'); await wait(800);
    console.log('inline edit:', await js(`JSON.stringify({ open: !document.getElementById('textEdit').hidden, focused: document.activeElement?.id, text: window.__app.files[0].settings.texts.at(-1).text, panel: document.querySelector('#textSection .field[data-key="text.text"] textarea')?.value })`));
    await fs.writeFile(path.join(out, 'text-editing.png'), (await win.webContents.capturePage()).toPNG());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); await wait(300);
    console.log('after Enter, editor open:', await js(`!document.getElementById('textEdit').hidden`));
    const east = await js(`(() => { const r = document.querySelector('#textSel .e').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    mouse('mouseMove', east); await wait(80); mouse('mouseDown', east); await wait(80);
    for (let i = 1; i <= 8; i++) { mouse('mouseMove', [east[0] + i * 10, east[1]], ['leftButtonDown']); await wait(40); }
    mouse('mouseUp', [east[0] + 80, east[1]]); await wait(500);
    console.log('side stretch:', await js(`JSON.stringify((({ scaleX, scaleY, size }) => ({ scaleX, scaleY, size }))(window.__app.files[0].settings.texts.at(-1)))`));
    await fs.writeFile(path.join(out, 'text-stretched.png'), Buffer.from(await js(`window.__app.encode(window.__app.files[0], { size: 256, format: 'png', ss: 1 }).then(Array.from)`)));
    // Animation dialog: sheet sized as a whole stays 2048 px whatever the FPS; frames shrink to fit.
    await click(await centerOf('#exportAnim')); await wait(300);
    const setDlg = (vals) => js(`(() => { for (const [id, v] of Object.entries(${JSON.stringify(vals)})) { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change')); e.dispatchEvent(new Event('input')); } return document.getElementById('axSheetInfo').textContent; })()`);
    console.log('sheet 24fps:', await setDlg({ axFormat: 'sheet', axSizeBy: 'sheet', axSheetSize: '2048', axFps: '24', axDuration: '2', axPad: '0', axCols: '0' }));
    console.log('sheet 60fps:', await setDlg({ axFps: '60' }));
    console.log('frame-size input hidden:', await js(`getComputedStyle(document.getElementById('axSize').closest('label')).display === 'none'`));
    const plan = await js(`(() => { const p = window.__app.sheetPlan(); return { size: p.size, sheet: p.sheet }; })()`);
    await js(`window.__app.exportClip(window.__app.files[0], { size: ${plan.size}, sheet: ${plan.sheet}, ss: 1, format: 'sheet', source: 'both', fps: 60, start: 0, duration: 2, loop: true, lock: true, cols: 0, pad: 0, gifBg: null }, ${JSON.stringify(out)}, 'wholesheet', () => {})`);
    await setDlg({ axFps: '24', axSizeBy: 'frame' });
    await click(await centerOf('#axCancel')); await wait(300);
    // Settings: real click on the gear, switch to the light theme, turn Discord activity off with a real click.
    await click(await centerOf('#settingsBtn')); await wait(400);
    await fs.writeFile(path.join(out, 'settings-dark.png'), (await win.webContents.capturePage()).toPNG());
    await js(`(() => { const s = document.querySelector('#setBody [data-key="pref.theme"] select'); s.value = 'light'; s.dispatchEvent(new Event('change')); })()`); await wait(300);
    await click(await centerOf('#setNav button:nth-child(2)')); await wait(300);
    await click(await js(`(() => { const r = document.querySelector('#setBody [data-key="pref.discordActivity"] input').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`)); await wait(500);
    await fs.writeFile(path.join(out, 'settings-light.png'), (await win.webContents.capturePage()).toPNG());
    console.log('settings:', await js(`document.documentElement.dataset.theme`), JSON.stringify(JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'prefs.json'), 'utf8'))));
    await click(await centerOf('#setDone')); await wait(300);
    prefs.closeToTray = true; win.close(); await wait(400);
    console.log('close-to-tray: window kept', !win.isDestroyed(), '| hidden', !win.isVisible());
    prefs.closeToTray = false; win.show(); await wait(400);
    await fs.writeFile(path.join(out, 'light-app.png'), (await win.webContents.capturePage()).toPNG());
    await js(`window.__app.select(window.__app.files[${before}])`); await wait(800);
    await js('window.native.hideToTray()'); await wait(300);
    const hidden = !win.isVisible();
    tray.emit('click'); await wait(300);
    console.log('tray: hidden', hidden, '| shown again', win.isVisible());
    await js('window.__app.files[0].settings.camera.yaw = 77'); // must reach the session through the save on close
  }
  // RIR_TEST_DRAG="x0,y0,x1,y1" (0..1 of the preview): real mouse drag of a text, then of its rotate handle.
  if (process.env.RIR_TEST_DRAG) {
    win.focus(); win.webContents.focus();
    for (let i = 0; i < 100 && await js(`!!document.getElementById('splash')`); i++) await new Promise((r) => setTimeout(r, 100)); // splash covers the window
    await js('window.__app.select(window.__app.files[0])'); // fresh preview (and text layout) after the edits above
    await new Promise((r) => setTimeout(r, 1500));
    const rect = () => js(`(() => { const r = document.getElementById('view').getBoundingClientRect(); return [r.left, r.top, r.width]; })()`);
    let [left, top, size] = await rect();
    for (let i = 0; i < 30; i++) { // wait until the preview stops resizing
      await new Promise((r) => setTimeout(r, 200));
      const next = await rect();
      if (next.join() === [left, top, size].join()) break;
      [left, top, size] = next;
    }
    const drag = async (from, to) => {
      mouse('mouseMove', from); await wait(100); mouse('mouseDown', from); await wait(100);
      for (let i = 1; i <= 10; i++) { mouse('mouseMove', [from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10]); await new Promise((r) => setTimeout(r, 30)); }
      mouse('mouseUp', to);
      await new Promise((r) => setTimeout(r, 300));
    };
    const [x0, y0, x1, y1] = process.env.RIR_TEST_DRAG.split(',').map(Number);
    await drag([left + x0 * size, top + y0 * size], [left + x1 * size, top + y1 * size]);
    console.log('after move:', await js(`JSON.stringify(window.__app.files[0].settings.texts.map((t) => [t.x, t.y, t.rotation]))`));
    const knob = await js(`(() => { const e = document.querySelector('#textSel:not([hidden]) .rot'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (knob) await drag(knob, [knob[0] + 120, knob[1] + 60]);
    const corner = await js(`(() => { const e = document.querySelector('#textSel:not([hidden]) .se'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (corner) await drag(corner, [corner[0] + 60, corner[1] + 60]);
    console.log('drag result:', knob ? 'handle found' : 'no selection handle', await js(`JSON.stringify(window.__app.files[0].settings.texts.map((t) => [t.x, t.y, t.rotation, t.size, t.strokeWidth]))`));
    await new Promise((r) => setTimeout(r, 500));
  }
  await fs.writeFile(path.join(out, 'ui.png'), (await win.webContents.capturePage()).toPNG());
  app.quit();
}

app.on('window-all-closed', () => app.quit());
