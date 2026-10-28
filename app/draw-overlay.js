'use strict';

/**
 * Host-side drawing overlay: a transparent, click-through, always-on-top window exactly over the
 * streamed monitor/window. Laser pointers and pen strokes of the viewers are rendered into it, so
 * the streamer sees them live (and, because it is part of the screen, they are in the stream too).
 */

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const SYNC_MS = 500;

class DrawOverlay {
  /** @param {{ getRect: () => ({ x: number, y: number, width: number, height: number } | null) }} deps */
  constructor({ getRect }) {
    this.getRect = getRect;
    this.win = null;
    this.timer = null;
    this.ready = false;
    this.queue = [];
  }

  get mediaSourceId() {
    return this.win && !this.win.isDestroyed() ? this.win.getMediaSourceId() : null;
  }

  _create() {
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      alwaysOnTop: true,
      title: 'ShareToFriends Overlay',
      webPreferences: {
        preload: path.join(__dirname, 'draw-overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.once('did-finish-load', () => {
      this.ready = true;
      for (const ev of this.queue.splice(0)) win.webContents.send('draw:event', ev);
    });
    win.on('closed', () => {
      this.win = null;
      this.ready = false;
      clearInterval(this.timer);
    });
    win.loadFile(path.join(__dirname, 'draw-overlay.html'));
    this.win = win;
    this.timer = setInterval(() => this.syncBounds(), SYNC_MS);
  }

  syncBounds() {
    if (!this.win || this.win.isDestroyed()) return;
    const rect = this.getRect();
    if (!rect) {
      if (this.win.isVisible()) this.win.hide();
      return;
    }
    const dip = screen.screenToDipRect(null, rect);
    const b = this.win.getBounds();
    if (b.x !== dip.x || b.y !== dip.y || b.width !== dip.width || b.height !== dip.height) this.win.setBounds(dip);
    if (!this.win.isVisible()) this.win.showInactive();
  }

  /** @param {object} ev validated draw event */
  send(ev) {
    if (!this.win || this.win.isDestroyed()) this._create();
    this.syncBounds();
    if (this.ready) this.win.webContents.send('draw:event', ev);
    else this.queue.push(ev);
  }

  close() {
    clearInterval(this.timer);
    this.queue = [];
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = false;
  }
}

module.exports = { DrawOverlay };
