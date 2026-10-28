'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stfDraw', {
  onEvent: (cb) => ipcRenderer.on('draw:event', (_e, ev) => cb(ev)),
});
