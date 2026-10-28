'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stfRemoteUi', {
  decide: (allow) => ipcRenderer.send('remote-ui:decide', allow === true),
  endNow: () => ipcRenderer.send('remote-ui:end'),
});
