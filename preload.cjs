const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  getAsset: (id) => ipcRenderer.invoke('asset:get', id),
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
});
