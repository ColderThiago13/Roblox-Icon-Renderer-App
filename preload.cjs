const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('native', {
  getAsset: (id) => ipcRenderer.invoke('asset:get', id),
  getRbxAsset: (rel) => ipcRenderer.invoke('rbxasset:get', rel),
  listRbxAssets: (rel) => ipcRenderer.invoke('rbxasset:list', rel),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  getProfiles: () => ipcRenderer.invoke('profiles:get'),
  setProfiles: (profiles) => ipcRenderer.invoke('profiles:set', profiles),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  openCache: () => ipcRenderer.invoke('cache:open'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  pickSavePath: (name) => ipcRenderer.invoke('dialog:save', name),
  writeFile: (filePath, data) => ipcRenderer.invoke('file:write', filePath, data),
  joinPath: (...parts) => ipcRenderer.invoke('file:join', ...parts),
  version: () => ipcRenderer.invoke('app:version'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, msg) => cb(msg)),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getSession: () => ipcRenderer.invoke('session:get'),
  putSessionBlob: (key, data) => ipcRenderer.invoke('session:blob', key, data),
  saveSession: (json) => ipcRenderer.sendSync('session:save', json),
  hideToTray: () => ipcRenderer.invoke('win:tray'),
  setActivity: (a) => ipcRenderer.send('discord:activity', a),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (p) => ipcRenderer.invoke('prefs:set', p),
  setZoom: (f) => webFrame.setZoomFactor(f),
  assetName: (id) => ipcRenderer.invoke('asset:name', id),
  pluginStatus: () => ipcRenderer.invoke('plugin:status'),
  installPlugin: () => ipcRenderer.invoke('plugin:install'),
  openPluginFolder: () => ipcRenderer.invoke('plugin:open'),
  onStudioItems: (cb) => ipcRenderer.on('studio:items', (_e, items) => cb(items)),
  // AI agents: main asks, the page answers through the handler (see src/ui/agent.js).
  onAgentCall: (handler) => {
    ipcRenderer.on('agent:call', async (_e, { id, method, params }) => {
      try { ipcRenderer.send('agent:reply', id, true, await handler(method, params)); }
      catch (e) { ipcRenderer.send('agent:reply', id, false, e?.message ?? String(e)); }
    });
    ipcRenderer.send('agent:ready');
  },
  readLocal: (filePath, kind) => ipcRenderer.invoke('file:readLocal', filePath, kind),
  agentSetup: (client) => ipcRenderer.invoke('agent:setup', client),
  agentStatus: () => ipcRenderer.invoke('agent:status'),
});
