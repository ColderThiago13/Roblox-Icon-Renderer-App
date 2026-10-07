import { app, BrowserWindow, ipcMain, dialog, protocol, net, safeStorage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Fixed data folder (config with the saved API key, asset cache, settings) so updates/renames never lose it.
app.setPath('userData', path.join(app.getPath('appData'), 'roblox-icon-renderer'));
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
ipcMain.handle('cache:clear', () => fs.rm(CACHE(), { recursive: true, force: true }));
ipcMain.handle('cache:open', async () => { await fs.mkdir(CACHE(), { recursive: true }); shell.openPath(CACHE()); });

ipcMain.handle('dialog:folder', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:save', async (e, defaultName) => {
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: defaultName });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('file:write', async (_e, filePath, data) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(data));
});
ipcMain.handle('file:join', (_e, ...parts) => path.join(...parts));

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
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  win.webContents.once('did-finish-load', check);
  setInterval(check, 60 * 60 * 1000);
}
ipcMain.handle('update:download', () => autoUpdater.downloadUpdate());
ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true));
ipcMain.handle('app:version', () => app.getVersion());

app.whenReady().then(() => {
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
  setupUpdates(win);
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
  await fs.writeFile(path.join(out, 'ui.png'), (await win.webContents.capturePage()).toPNG());
  app.quit();
}

app.on('window-all-closed', () => app.quit());
