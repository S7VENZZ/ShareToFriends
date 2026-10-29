'use strict';

/**
 * ShareToFriends – Electron main process.
 *
 *  - hardened window (contextIsolation, sandbox, CSP)
 *  - capture sources (monitors / windows) and the display-media handler
 *  - settings (own ID, signaling server, display name) – there are no secrets on disk
 *  - native helpers: remote input, keyboard hooks, per-app audio, draw overlay, auto-update
 *
 * The WebRTC session itself (signaling, authentication, media) lives in the renderer.
 */

const { app, BrowserWindow, Menu, ipcMain, globalShortcut, desktopCapturer, screen, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { RemoteController } = require('./remote-controller');
const { normalizeUpdateUrl, DEFAULT_UPDATE_SOURCE } = require('./update-url');
const { KeyHook } = require('./key-hook');
const { AppAudio } = require('./app-audio');
const { DrawOverlay } = require('./draw-overlay');
const DrawStyle = require('./draw-style');
const { Secrets } = require('./secrets');

const IS_DEV = process.argv.includes('--dev');
const INDEX_FILE = path.join(__dirname, 'index.html');
const TRUSTED_URL_PREFIX = pathToFileURL(INDEX_FILE).href;

// Keep streaming alive when the window is hidden, and let viewers autoplay video + audio.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let selectedSourceId = null;
const sourceDisplayIds = new Map();
/** @type {RemoteController | null} */ let remote = null;
/** @type {import('./updater').Updater | null} */ let updater = null;
/** @type {KeyHook | null} */ let keyHook = null;
/** @type {AppAudio | null} */ let appAudio = null;
/** @type {DrawOverlay | null} */ let drawOverlay = null;

/* ------------------------------------------------------------------ */
/* Settings                                                             */
/* ------------------------------------------------------------------ */

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

function newId() {
  // 9 digits, no leading zero; crypto-random so IDs cannot be guessed from each other
  return String(crypto.randomInt(100_000_000, 1_000_000_000));
}

function loadSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
  } catch {
    /* first start */
  }
  const settings = {
    id: /^\d{9}$/.test(raw.id) ? raw.id : newId(),
    serverUrl: typeof raw.serverUrl === 'string' ? raw.serverUrl : '',
    displayName: typeof raw.displayName === 'string' ? raw.displayName : '',
    updateUrl: '', // no longer a setting: updates always come from the GitHub releases (older versions stored one)
    autoUpdate: raw.autoUpdate !== false,
    prefs: raw.prefs && typeof raw.prefs === 'object' ? raw.prefs : {},
  };
  if (raw.id !== settings.id) writeSettings(settings);
  return settings;
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function cleanServerUrl(value) {
  const str = typeof value === 'string' ? value.trim().slice(0, 300) : '';
  if (!str) return '';
  let url;
  try {
    url = new URL(str);
  } catch {
    throw new Error(`Ungültige Server-Adresse: ${str}`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('Die Server-Adresse muss mit wss:// beginnen (ws:// nur für localhost).');
  }
  if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
  return url.toString();
}

/** Updates come from the GitHub releases of the project (STF_UPDATE_URL only exists for local testing). */
function effectiveUpdateUrl() {
  return normalizeUpdateUrl(process.env.STF_UPDATE_URL || DEFAULT_UPDATE_SOURCE);
}

function publicSettings(settings) {
  return { ...settings, derivedUpdateUrl: effectiveUpdateUrl(settings) };
}

function saveSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Ungültige Einstellungen');
  const current = loadSettings();
  const next = {
    ...current,
    serverUrl: cleanServerUrl(input.serverUrl),
    // eslint-disable-next-line no-control-regex
    displayName: String(input.displayName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32),
    updateUrl: '',
    autoUpdate: input.autoUpdate !== false,
  };
  writeSettings(next);
  return publicSettings(next);
}

function savePrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') throw new Error('Ungültige Einstellungen');
  const json = JSON.stringify(prefs);
  if (json.length > 20000) throw new Error('Einstellungen zu groß');
  const current = loadSettings();
  current.prefs = JSON.parse(json);
  writeSettings(current);
  return true;
}

/* ------------------------------------------------------------------ */
/* Capture sources                                                      */
/* ------------------------------------------------------------------ */

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function monitorLabels() {
  const displays = screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const primaryId = screen.getPrimaryDisplay().id;
  const labels = new Map();
  displays.forEach((d, i) => {
    labels.set(String(d.id), {
      number: i + 1,
      name: `Monitor ${i + 1}${d.id === primaryId ? ' · Primär' : ''}`,
      detail: `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}`,
    });
  });
  return labels;
}

const iconCache = new Map();

async function listSources(opts = {}) {
  const types = (Array.isArray(opts.types) ? opts.types : ['screen', 'window']).filter((t) => t === 'screen' || t === 'window');
  if (types.length === 0) return [];
  const thumbs = opts.thumbs !== false;
  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: thumbs ? { width: clamp(opts.width, 120, 480, 256), height: clamp(opts.height, 68, 270, 144) } : { width: 0, height: 0 },
    fetchWindowIcons: opts.icons === true && types.includes('window'),
  });
  const hidden = new Set(
    [mainWindow && !mainWindow.isDestroyed() ? mainWindow.getMediaSourceId() : null, drawOverlay && drawOverlay.mediaSourceId].filter(Boolean)
  );
  const labels = monitorLabels();
  for (const s of sources) sourceDisplayIds.set(s.id, s.display_id || '');

  return sources
    .filter((s) => !hidden.has(s.id) && s.name.trim() !== '' && !s.name.startsWith('ShareToFriends'))
    .map((s) => {
      const isScreen = s.id.startsWith('screen:');
      const label = isScreen ? labels.get(String(s.display_id)) : null;
      if (s.appIcon && !s.appIcon.isEmpty() && !iconCache.has(s.id)) iconCache.set(s.id, s.appIcon.toDataURL());
      return {
        id: s.id,
        name: label ? label.name : s.name,
        detail: label ? label.detail : '',
        order: label ? label.number : 1000,
        type: isScreen ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? '' : 'data:image/jpeg;base64,' + s.thumbnail.toJPEG(60).toString('base64'),
        appIcon: iconCache.get(s.id) || '',
      };
    })
    .sort((a, b) => a.order - b.order);
}

function identifyMonitors() {
  const displays = screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  displays.forEach((d, i) => {
    const win = new BrowserWindow({
      x: d.workArea.x + 24,
      y: d.workArea.y + 24,
      width: 260,
      height: 52,
      frame: false,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#1e1f22',
      webPreferences: { preload: path.join(__dirname, 'remote-ui-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.loadFile(path.join(__dirname, 'remote-ui.html'), {
      query: { mode: 'notice', name: `Monitor ${i + 1}${d.id === screen.getPrimaryDisplay().id ? ' · Primär' : ''}` },
    });
    win.once('ready-to-show', () => win.showInactive());
    setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
    }, 2200);
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                  */
/* ------------------------------------------------------------------ */

function isTrustedUrl(url) {
  return typeof url === 'string' && url.startsWith(TRUSTED_URL_PREFIX);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedUrl(event.senderFrame && event.senderFrame.url)) throw new Error('Untrusted IPC sender');
    return fn(...args);
  });
}

/** Draw events from viewers are validated here before they reach the overlay window. */
const IMAGE_MIMES = new Set(['image/webp', 'image/png', 'image/jpeg']);
const MAX_IMAGE_B64 = 6_000_000;

function cleanDrawEvent(ev) {
  const kinds = ['cursor', 'pen', 'clear', 'clearall', 'off', 'imgdata', 'imgt', 'imgdel'];
  if (ev && ev.k === 'laser') ev = { ...ev, k: 'cursor' }; // clients before 2.0.1 sent "laser"
  if (!ev || typeof ev !== 'object' || !kinds.includes(ev.k)) return null;
  const id = typeof ev.id === 'string' ? ev.id.slice(0, 64) : '';
  if (!id && ev.k !== 'clearall') return null;
  const hue = Number.isFinite(ev.h) ? Math.min(360, Math.max(0, ev.h)) : 200;
  // eslint-disable-next-line no-control-regex
  const name = typeof ev.n === 'string' ? ev.n.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 30) : '';
  const out = { k: ev.k, id, n: name, h: hue };
  if (ev.k === 'cursor' || ev.k === 'pen') {
    if (!Number.isFinite(ev.x) || !Number.isFinite(ev.y)) return null;
    out.x = Math.min(1, Math.max(0, ev.x));
    out.y = Math.min(1, Math.max(0, ev.y));
    out.s = Number.isInteger(ev.s) ? ev.s % 100000 : 0;
    out.perm = ev.perm === true; // permanent strokes stay until cleared
    out.c = DrawStyle.cleanColor(ev.c, DrawStyle.colorFromHue(hue));
    out.w = DrawStyle.cleanSize(ev.w);
    out.t = DrawStyle.cleanTool(ev.t);
  }
  if (ev.k === 'imgdata' || ev.k === 'imgt' || ev.k === 'imgdel') {
    if (typeof ev.i !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(ev.i)) return null;
    out.i = ev.i;
    if (ev.k === 'imgdata') {
      if (!IMAGE_MIMES.has(ev.mime) || typeof ev.data !== 'string' || ev.data.length < 20 || ev.data.length > MAX_IMAGE_B64) return null;
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ev.data)) return null;
      out.mime = ev.mime;
      out.data = ev.data;
    } else if (ev.k === 'imgt') {
      Object.assign(out, DrawStyle.cleanTransform({ x: ev.x, y: ev.y, w: ev.w, rot: ev.rot, cl: ev.cl, ct: ev.ct, cr: ev.cr, cb: ev.cb }));
    }
  }
  return out;
}

function initUpdater() {
  const { Updater } = require('./updater');
  updater = new Updater({
    getWindow: () => mainWindow,
    getConfig: () => {
      const s = loadSettings();
      return { updateUrl: effectiveUpdateUrl(s), autoUpdate: s.autoUpdate !== false };
    },
  });
  updater.start();
}

const updaterStatus = () => (updater ? updater.status : { state: 'idle', currentVersion: app.getVersion() });

function registerIpc() {
  handle('settings:get', () => publicSettings(loadSettings()));
  handle('settings:set', (input) => {
    const saved = saveSettings(input);
    if (updater) {
      updater.start();
      if (saved.autoUpdate !== false) updater.check(false);
    }
    return saved;
  });
  handle('settings:setPrefs', (prefs) => savePrefs(prefs));

  // Secrets (host password, saved friends): encrypted with the Windows user account
  const secrets = new Secrets({ file: path.join(app.getPath('userData'), 'secrets.json'), safeStorage });
  handle('secret:available', () => secrets.isAvailable());
  handle('secret:get', (key) => secrets.get(String(key)));
  handle('secret:set', (key, value) => secrets.set(String(key), value === null ? null : String(value)));
  handle('id:regenerate', () => {
    const s = loadSettings();
    s.id = newId();
    writeSettings(s);
    return s.id;
  });
  handle('sources:list', (opts) => listSources(opts));
  handle('monitors:identify', () => identifyMonitors());
  handle('capture:select', (id) => {
    selectedSourceId = typeof id === 'string' && id.length < 200 ? id : null;
    return true;
  });

  // Remote control, clipboard
  handle('remote:supported', () => remote.supported);
  handle('remote:request', (req) => remote.requestApproval(req || {}));
  handle('remote:end', (reason) => remote.end(typeof reason === 'string' ? reason.slice(0, 100) : 'Beendet'));
  handle('clipboard:token', () => remote.clipboardToken());
  handle('clipboard:read', () => remote.clipboardRead());
  handle('clipboard:write', (payload) => {
    if (IS_DEV) console.log('[clipboard:write]', payload && payload.image ? 'image' : 'text');
    return remote.clipboardWrite(payload || {});
  });
  ipcMain.on('remote:input', (event, msg) => {
    if (isTrustedUrl(event.senderFrame && event.senderFrame.url)) remote.handleInput(msg);
  });
  handle('keyhook:set', (on) => (on === true ? keyHook.enable() : (keyHook.disable(), false)));
  handle('keyhook:supported', () => keyHook.supported);

  // Per-app audio
  handle('appaudio:supported', () => appAudio.supported);
  handle('appaudio:list', () => appAudio.list());
  handle('appaudio:start', (pid) => appAudio.start(pid));
  handle('appaudio:stop', (pid) => appAudio.stop(pid));
  handle('appaudio:stopAll', () => appAudio.stopAll());

  // Drawing overlay on the host screen
  handle('draw:event', (ev) => {
    const clean = cleanDrawEvent(ev);
    if (clean) drawOverlay.send(clean);
    return Boolean(clean);
  });
  handle('draw:close', () => drawOverlay.close());

  handle('updater:get', () => updaterStatus());
  handle('updater:check', async () => (updater ? updater.check(true) : updaterStatus()));
  handle('updater:install', () => (updater ? updater.install() : false));
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dev: IS_DEV,
    startedAt: typeof process.getCreationTime === 'function' ? process.getCreationTime() : null,
  }));
}

function configureSession(ses) {
  // getDisplayMedia() in the renderer is answered with the source chosen in our own picker UI.
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        if (!isTrustedUrl(request.frame && request.frame.url) || !selectedSourceId) return callback({});
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        const chosen = sources.find((s) => s.id === selectedSourceId);
        if (!chosen) return callback({});
        const result = { video: chosen };
        if (request.audioRequested && process.platform === 'win32') result.audio = 'loopback';
        return callback(result);
      } catch (err) {
        console.error('Display media request failed:', err);
        return callback({});
      }
    },
    { useSystemPicker: false }
  );

  // No microphone or camera: only screen capture (display-capture) and fullscreen are ever granted.
  const allowed = new Set(['display-capture', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowed.has(permission) && isTrustedUrl(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => allowed.has(permission) && isTrustedUrl(details.requestingUrl || wc.getURL()));
}

/* ------------------------------------------------------------------ */
/* Window & lifecycle                                                   */
/* ------------------------------------------------------------------ */

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#313338',
    title: 'ShareToFriends',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: isMac ? undefined : { color: '#1e1f22', symbolColor: '#b5bac1', height: 32 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      v8CacheOptions: 'bypassHeatCheck',
      devTools: IS_DEV,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('did-start-navigation', () => keyHook && keyHook.disable());
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV && process.getCreationTime) console.log('[perf] window visible after', Date.now() - process.getCreationTime(), 'ms');
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(INDEX_FILE);
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    createWindow(); // window first: the renderer loads while the native modules below are prepared
    configureSession(session.defaultSession);

    remote = new RemoteController({
      getMainWindow: () => mainWindow,
      getSelectedSource: () => (selectedSourceId ? { id: selectedSourceId, displayId: sourceDisplayIds.get(selectedSourceId) || '' } : null),
    });
    drawOverlay = new DrawOverlay({ getRect: () => remote.streamRect() });
    appAudio = new AppAudio({ getWindow: () => mainWindow });
    keyHook = new KeyHook({
      mode: 'viewer',
      getWindow: () => mainWindow,
      onKey: (ev) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('keyhook:key', ev);
      },
    });
    registerIpc();
    setTimeout(initUpdater, 1500);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    if (remote) remote.end('App beendet');
    if (keyHook) keyHook.disable();
    if (appAudio) appAudio.stopAll();
    if (drawOverlay) drawOverlay.close();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
