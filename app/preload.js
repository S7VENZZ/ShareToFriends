'use strict';

/** Sandboxed preload: a minimal, explicit API for the renderer (`window.stf`). */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stf', {
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  savePrefs: (prefs) => ipcRenderer.invoke('settings:setPrefs', prefs),
  regenerateId: () => ipcRenderer.invoke('id:regenerate'),

  listSources: (opts) => ipcRenderer.invoke('sources:list', opts),
  identifyMonitors: () => ipcRenderer.invoke('monitors:identify'),
  selectSource: (id) => ipcRenderer.invoke('capture:select', id),

  // Remote control (host executes input natively; the viewer only sends it)
  remoteSupported: () => ipcRenderer.invoke('remote:supported'),
  remoteRequest: (req) => ipcRenderer.invoke('remote:request', req),
  remoteEnd: (reason) => ipcRenderer.invoke('remote:end', reason),
  remoteInput: (msg) => ipcRenderer.send('remote:input', msg),
  onRemoteEnded: (cb) => ipcRenderer.on('remote:ended', (_e, info) => cb(info)),
  onRemoteBlocked: (cb) => ipcRenderer.on('remote:blocked', () => cb()),
  onRemoteLockBlock: (cb) => ipcRenderer.on('remote:lock-block', () => cb()),

  // Windows key / Alt+Tab capture while controlling (viewer side)
  keyHook: (on) => ipcRenderer.invoke('keyhook:set', on),
  keyHookSupported: () => ipcRenderer.invoke('keyhook:supported'),
  onHookKey: (cb) => ipcRenderer.on('keyhook:key', (_e, ev) => cb(ev)),

  // Clipboard
  clipboardToken: () => ipcRenderer.invoke('clipboard:token'),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (payload) => ipcRenderer.invoke('clipboard:write', payload),

  // Per-application audio
  appAudioSupported: () => ipcRenderer.invoke('appaudio:supported'),
  appAudioList: () => ipcRenderer.invoke('appaudio:list'),
  appAudioStart: (pid) => ipcRenderer.invoke('appaudio:start', pid),
  appAudioStop: (pid) => ipcRenderer.invoke('appaudio:stop', pid),
  appAudioStopAll: () => ipcRenderer.invoke('appaudio:stopAll'),
  onAppAudio: (cb) => ipcRenderer.on('appaudio:chunk', (_e, pid, chunk) => cb(pid, chunk)),
  onAppAudioEnded: (cb) => ipcRenderer.on('appaudio:ended', (_e, pid) => cb(pid)),

  // Drawing overlay on the host screen
  drawEvent: (ev) => ipcRenderer.invoke('draw:event', ev),
  drawClose: () => ipcRenderer.invoke('draw:close'),

  // Auto-update
  updaterGet: () => ipcRenderer.invoke('updater:get'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus: (cb) => ipcRenderer.on('updater:status', (_e, status) => cb(status)),
});
