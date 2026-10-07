// Real Electron/WebGL smoke tests; isolated from the app's credentials, cache, and settings.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
app.commandLine.appendSwitch('disable-gpu-sandbox');
let finished = false;
const finish = (code, message) => { if (finished) return; finished = true; console.log(message); app.exit(code); };
ipcMain.on('render-result', (_, result) => finish(result.ok ? 0 : 1, result.message));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 400,
    webPreferences: { preload: path.join(__dirname, 'render-preload.cjs'), contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') finish(1, 'Browser error: ' + event.message);
  });
  win.webContents.on('render-process-gone', (_, details) => finish(1, 'Renderer exited: ' + details.reason));
  await win.loadFile(path.join(__dirname, 'render.html'));
}).catch((e) => finish(1, e.stack));
setTimeout(() => finish(1, 'WebGL tests timed out'), 45000).unref();
