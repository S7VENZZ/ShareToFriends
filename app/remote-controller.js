'use strict';

/**
 * Main-process side of the remote-control feature.
 *
 * Security model:
 *  - Nothing is injected until the *local user* has clicked "Erlauben" in a native always-on-top
 *    prompt window that is owned by this (trusted) process – the renderer cannot approve by itself.
 *  - While a session is active a non-closable "Remote Access aktiv" banner stays on top of every
 *    window (including games) with a "Zugriff sofort beenden" button.
 *  - Kill switch: pressing F12 (or Ctrl+Alt+Shift+Q) on the host ends the session immediately and
 *    shows a short notice on the host screen. F12 is never forwarded from the controlling side.
 *  - Window lock: when a window is streamed, mouse clicks/wheel only reach that application (same
 *    process) and keystrokes are only injected while it is the foreground window. ShareToFriends'
 *    own windows are never controllable. When a monitor is streamed, input stays on that monitor.
 *  - Input is only accepted for the identity that was approved (identity is assigned by the
 *    LiveKit server from the signed token, so it cannot be spoofed by other participants).
 */

const path = require('path');
const crypto = require('crypto');
const { BrowserWindow, ipcMain, screen, globalShortcut, clipboard, nativeImage, shell, ClipboardItem } = require('electron');
const { RemoteInput } = require('./remote-input');
const { KeyHook } = require('./key-hook');

const PROMPT_TIMEOUT_S = 30;
const KILL_SHORTCUTS = ['CommandOrControl+Alt+Shift+Q'];
const MAX_CLIPBOARD_TEXT = 2 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE = 8 * 1024 * 1024;
const NOTICE_MS = 3200;

function sanitizeName(name) {
  // eslint-disable-next-line no-control-regex
  return String(name || 'Unbekannt').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Unbekannt';
}

class RemoteController {
  /**
   * @param {{ getMainWindow: () => Electron.BrowserWindow | null,
   *           getSelectedSource: () => ({ id: string, displayId: string } | null) }} deps
   */
  constructor({ getMainWindow, getSelectedSource }) {
    this.getMainWindow = getMainWindow;
    this.getSelectedSource = getSelectedSource;
    this.input = new RemoteInput();
    this.session = null; // { identity, name }
    this.promptWin = null;
    this.bannerWin = null;
    this.noticeWin = null;
    this.pendingPrompt = null; // { resolve, timer }
    this.rectCache = { at: 0, id: '', rect: null };
    this.lastPx = null; // last injected cursor position in physical pixels
    this.lastLockNotice = 0;
    // F12 cannot be a global hotkey on Windows (reserved for debuggers): watch for it with a keyboard hook.
    this.killHook = new KeyHook({ mode: 'kill', onKey: () => setImmediate(() => this.end('Notaus (F12)')) });

    ipcMain.on('remote-ui:decide', (event, allow) => {
      if (this.promptWin && event.sender === this.promptWin.webContents) this._settlePrompt(allow === true);
    });
    ipcMain.on('remote-ui:end', (event) => {
      if (this.bannerWin && event.sender === this.bannerWin.webContents) this.end('Lokal beendet');
    });
  }

  get supported() {
    return this.input.supported;
  }

  /** Physical rectangle of whatever is currently streamed, plus the window handle if it is a window. */
  _target() {
    const source = this.getSelectedSource();
    if (!source) return null;
    if (source.id.startsWith('window:')) return { kind: 'window', hwnd: Number(source.id.split(':')[1]) };
    return { kind: 'screen', displayId: source.displayId };
  }

  /* ------------------------------ consent ------------------------------ */

  /** @returns {Promise<{ allowed: boolean, reason?: string }>} */
  async requestApproval({ identity, name }) {
    if (!this.supported) {
      return { allowed: false, reason: 'Fernsteuerung wird auf diesem Betriebssystem nicht unterstützt (nur Windows).' };
    }
    if (typeof identity !== 'string' || !identity || identity.length > 128) {
      return { allowed: false, reason: 'Ungültige Anfrage' };
    }
    if (this.session || this.pendingPrompt) {
      return { allowed: false, reason: 'Der Streamer wird gerade von jemand anderem gesteuert oder gefragt.' };
    }

    const displayName = sanitizeName(name);
    const allowed = await this._showPrompt(displayName);
    if (!allowed) return { allowed: false, reason: 'Der Streamer hat den Zugriff abgelehnt.' };

    this.session = { identity, name: displayName };
    this.lastPx = null;
    this._showBanner(displayName);
    this._focusTarget();
    this.killHook.enable();
    for (const accel of KILL_SHORTCUTS) {
      try {
        globalShortcut.register(accel, () => this.end('Notaus (Tastenkürzel)'));
      } catch (err) {
        console.error(`Could not register ${accel}:`, err.message);
      }
    }
    return { allowed: true };
  }

  _focusTarget() {
    const target = this._target();
    if (target && target.kind === 'window') this.input.focusWindow(target.hwnd);
  }

  _showPrompt(displayName) {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 460,
        height: 220,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        backgroundColor: '#1e1f22',
        webPreferences: {
          preload: path.join(__dirname, 'remote-ui-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          devTools: false,
        },
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      win.on('closed', () => {
        // Only react if this is still the active prompt (a destroyed older one may close late).
        if (this.promptWin === win) {
          this.promptWin = null;
          this._settlePrompt(false);
        }
      });

      this.promptWin = win;
      const timer = setTimeout(() => this._settlePrompt(false), PROMPT_TIMEOUT_S * 1000);
      this.pendingPrompt = { resolve, timer };

      win.loadFile(path.join(__dirname, 'remote-ui.html'), {
        query: { mode: 'prompt', name: displayName, timeout: String(PROMPT_TIMEOUT_S) },
      });
      win.once('ready-to-show', () => {
        // Inactive show: never steals keystrokes from a running game; it is clicked on purpose.
        win.showInactive();
        win.moveTop();
        shell.beep();
      });
    });
  }

  _settlePrompt(allowed) {
    const pending = this.pendingPrompt;
    if (!pending) return;
    this.pendingPrompt = null;
    clearTimeout(pending.timer);
    const win = this.promptWin;
    this.promptWin = null;
    if (win && !win.isDestroyed()) win.destroy();
    pending.resolve(allowed);
  }

  _showBanner(displayName) {
    const area = screen.getPrimaryDisplay().workArea;
    const width = 480;
    const win = new BrowserWindow({
      width,
      height: 44,
      x: Math.round(area.x + (area.width - width) / 2),
      y: area.y + 6,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#da373c',
      webPreferences: {
        preload: path.join(__dirname, 'remote-ui-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.loadFile(path.join(__dirname, 'remote-ui.html'), { query: { mode: 'banner', name: displayName } });
    win.once('ready-to-show', () => win.showInactive());
    this.bannerWin = win;
  }

  /** Short, non-interactive message on the host screen (kill switch, lock notices …). */
  showNotice(text) {
    if (this.noticeWin && !this.noticeWin.isDestroyed()) this.noticeWin.destroy();
    const area = screen.getPrimaryDisplay().workArea;
    const width = 420;
    const win = new BrowserWindow({
      width,
      height: 52,
      x: Math.round(area.x + (area.width - width) / 2),
      y: area.y + 60,
      frame: false,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#1e1f22',
      webPreferences: {
        preload: path.join(__dirname, 'remote-ui-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.loadFile(path.join(__dirname, 'remote-ui.html'), { query: { mode: 'notice', name: sanitizeName(text) } });
    win.once('ready-to-show', () => win.showInactive());
    const timer = setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
    }, NOTICE_MS);
    win.on('closed', () => clearTimeout(timer));
    this.noticeWin = win;
  }

  /* ------------------------------ session end ------------------------------ */

  end(reason = 'Beendet') {
    const hadSession = Boolean(this.session);
    this.session = null;
    this.input.releaseAll();
    this._settlePrompt(false);
    // Disabled from a timer: end() may be running inside the hook callback itself.
    setImmediate(() => this.killHook.disable());

    for (const accel of KILL_SHORTCUTS) {
      try {
        globalShortcut.unregister(accel);
      } catch {
        /* not registered */
      }
    }

    if (this.bannerWin && !this.bannerWin.isDestroyed()) {
      this.bannerWin.setClosable(true);
      this.bannerWin.destroy();
    }
    this.bannerWin = null;

    if (hadSession) {
      if (reason !== 'App beendet') this.showNotice(`Remote-Steuerung beendet – ${reason}`);
      const main = this.getMainWindow();
      if (main && !main.isDestroyed()) main.webContents.send('remote:ended', { reason });
    }
    return hadSession;
  }

  /* ------------------------------ input ------------------------------ */

  _targetRect() {
    const source = this.getSelectedSource();
    if (!source) return null;

    const now = Date.now();
    if (this.rectCache.id === source.id && now - this.rectCache.at < 100 && this.rectCache.rect) {
      return this.rectCache.rect;
    }

    let rect = null;
    if (source.id.startsWith('window:')) {
      rect = this.input.windowRect(Number(source.id.split(':')[1]));
    } else {
      const displays = screen.getAllDisplays();
      const display =
        displays.find((d) => String(d.id) === String(source.displayId)) || screen.getPrimaryDisplay();
      // Display bounds are in DIPs; SendInput needs physical pixels.
      const physical = screen.dipToScreenRect(null, display.bounds);
      rect = { x: physical.x, y: physical.y, width: physical.width, height: physical.height };
    }
    this.rectCache = { at: now, id: source.id, rect };
    return rect;
  }

  /** Physical rectangle of the streamed surface (used by the draw overlay as well). */
  streamRect() {
    return this._targetRect();
  }

  _moveTo(nx, ny) {
    const rect = this._targetRect();
    if (!rect) return false;
    const x = Math.round(rect.x + Math.min(1, Math.max(0, nx)) * (rect.width - 1));
    const y = Math.round(rect.y + Math.min(1, Math.max(0, ny)) * (rect.height - 1));
    this.lastPx = { x, y };
    return this.input.moveTo(x, y);
  }

  _notifyLock() {
    const now = Date.now();
    if (now - this.lastLockNotice < 1500) return;
    this.lastLockNotice = now;
    const main = this.getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send('remote:lock-block');
  }

  /** May a click / wheel at the current cursor position be injected? */
  _pointerAllowed() {
    if (!this.lastPx) return false;
    const owner = this.input.pidAtPoint(this.lastPx.x, this.lastPx.y);
    if (!owner || owner === process.pid) return false; // never control ShareToFriends itself
    const target = this._target();
    if (target && target.kind === 'window') return owner === this.input.windowPid(target.hwnd);
    return true;
  }

  /** May a keystroke be injected right now? */
  _keyboardAllowed() {
    const fg = this.input.foregroundPid();
    if (!fg || fg === process.pid) return false;
    const target = this._target();
    if (target && target.kind === 'window') return fg === this.input.windowPid(target.hwnd);
    return true;
  }

  /** @param {{ identity: string, t: string }} msg */
  handleInput(msg) {
    if (!this.session || !msg || typeof msg !== 'object' || msg.identity !== this.session.identity) return;
    const num = (v, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);

    switch (msg.t) {
      case 'mm': {
        const nx = num(msg.x, 0, 1);
        const ny = num(msg.y, 0, 1);
        if (nx !== null && ny !== null) this._moveTo(nx, ny);
        break;
      }
      case 'md':
      case 'mu': {
        const nx = num(msg.x, 0, 1);
        const ny = num(msg.y, 0, 1);
        if (nx !== null && ny !== null) this._moveTo(nx, ny);
        if (!Number.isInteger(msg.b) || msg.b < 0 || msg.b > 4) break;
        // A release is only injected for a press that was injected, so a button can never stay stuck.
        if (msg.t === 'mu') {
          if (this.input.downButtons.has(msg.b)) this.input.button(msg.b, false);
        } else if (this._pointerAllowed()) {
          this.input.button(msg.b, true);
        } else {
          this._notifyLock();
        }
        break;
      }
      case 'wh': {
        const dx = num(msg.dx, -50, 50);
        const dy = num(msg.dy, -50, 50);
        if (dx === null || dy === null) break;
        if (this._pointerAllowed()) this.input.wheel(dx, dy);
        else this._notifyLock();
        break;
      }
      case 'kd':
      case 'ku':
        if (typeof msg.code !== 'string' || msg.code === 'F12') break; // F12 is the host's kill switch
        if (msg.t === 'ku') {
          if (this.input.downKeys.has(msg.code)) this.input.key(msg.code, false);
        } else if (this._keyboardAllowed()) {
          this.input.key(msg.code, true);
        } else {
          this._notifyLock();
        }
        break;
      case 'rel':
        this.input.releaseAll();
        break;
      default:
        break;
    }

    // Windows silently drops input aimed at elevated windows; tell the user once.
    if (this.input.failures === 8) {
      const main = this.getMainWindow();
      if (main && !main.isDestroyed()) main.webContents.send('remote:blocked');
    }
  }

  /* ------------------------------ clipboard ------------------------------ */

  /**
   * Cheap token that changes whenever the system clipboard content changes.
   * Electron 45's clipboard API is asynchronous and ClipboardItem based.
   */
  async clipboardToken() {
    const seq = this.input.clipboardSequence();
    if (seq !== null) return String(seq);
    const hash = crypto.createHash('md5');
    hash.update(await clipboard.readText().catch(() => ''));
    hash.update(await clipboard.has('image/png').then((v) => (v ? 'img' : ''), () => ''));
    return hash.digest('hex');
  }

  async clipboardRead() {
    const token = await this.clipboardToken();
    const text = await clipboard.readText().catch(() => '');
    if (text) {
      return { token, text: text.length <= MAX_CLIPBOARD_TEXT ? text : '', image: '' };
    }
    try {
      const items = await clipboard.read();
      for (const item of items) {
        if (!item.types.includes('image/png')) continue;
        const blob = await item.getType('image/png');
        if (blob.size <= MAX_CLIPBOARD_IMAGE) {
          return { token, text: '', image: Buffer.from(await blob.arrayBuffer()).toString('base64') };
        }
      }
    } catch { /* clipboard busy or unreadable: treat as empty */ }
    return { token, text: '', image: '' };
  }

  /** @returns {Promise<string>} token after the write, so the caller can ignore its own change */
  async clipboardWrite({ text, image }) {
    try {
      if (typeof image === 'string' && image.length > 0 && image.length <= MAX_CLIPBOARD_IMAGE * 1.4) {
        const png = nativeImage.createFromBuffer(Buffer.from(image, 'base64')).toPNG();
        if (png.length > 0) {
          await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
        }
      } else if (typeof text === 'string' && text.length <= MAX_CLIPBOARD_TEXT) {
        await clipboard.writeText(text);
      }
    } catch { /* clipboard locked by another process: next change retries */ }
    return this.clipboardToken();
  }
}

module.exports = { RemoteController };
