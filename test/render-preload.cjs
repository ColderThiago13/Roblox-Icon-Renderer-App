const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('renderTest', { done: (result) => ipcRenderer.send('render-result', result) });
