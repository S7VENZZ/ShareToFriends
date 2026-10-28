'use strict';

/**
 * Auto-update (electron-updater, generic provider).
 *
 * The feed URL is a user setting, so any static HTTPS host works: your own server, the Caddy
 * container from server/docker-compose.yml (https://<domain>/updates) or GitHub releases
 * (https://github.com/<owner>/<repo>/releases/latest/download).
 *
 * Security: update metadata and installers are only accepted over HTTPS (loopback excepted for
 * local testing). electron-updater additionally verifies the SHA-512 of the downloaded installer
 * against latest.yml, and the Windows signature if the app is code-signed.
 */

const { app } = require('electron');
const { normalizeUpdateUrl } = require('./update-url');

/** @type {import('electron-updater').AppUpdater} */
let autoUpdater = null;

const FIRST_CHECK_DELAY_MS = 8_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
class Updater {
  /**
   * @param {{ getWindow: () => Electron.BrowserWindow | null,
   *           getConfig: () => { updateUrl: string, autoUpdate: boolean } }} deps
   */
  constructor({ getWindow, getConfig }) {
    this.getWindow = getWindow;
    this.getConfig = getConfig;
    this.status = { state: 'idle', currentVersion: app.getVersion() };
    this.timer = null;
    this.checking = false;
    this.configured = false;

    // Loaded here (not at startup) because electron-updater is a sizeable module.
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = console;
    // Lets the update flow be exercised from an unpackaged checkout (used by the test-suite only).
    if (process.env.STF_FORCE_DEV_UPDATE === '1') autoUpdater.forceDevUpdateConfig = true;

    autoUpdater.on('checking-for-update', () => this._set({ state: 'checking' }));
    autoUpdater.on('update-available', (info) =>
      this._set({ state: 'available', version: info.version, notes: this._notes(info) })
    );
    autoUpdater.on('update-not-available', () => this._set({ state: 'none' }));
    autoUpdater.on('download-progress', (p) =>
      this._set({
        state: 'downloading',
        percent: Math.round(p.percent),
        bytesPerSecond: Math.round(p.bytesPerSecond),
      })
    );
    autoUpdater.on('update-downloaded', (info) =>
      this._set({ state: 'downloaded', version: info.version, notes: this._notes(info) })
    );
    autoUpdater.on('error', (err) => this._set({ state: 'error', message: String((err && err.message) || err).slice(0, 300) }));
  }

  _notes(info) {
    const n = info.releaseNotes;
    if (typeof n === 'string') return n.slice(0, 2000);
    if (Array.isArray(n)) return n.map((x) => x.note || '').join('\n').slice(0, 2000);
    return '';
  }

  _set(patch) {
    const keep = { currentVersion: app.getVersion() };
    if (patch.state === 'downloading' || patch.state === 'available' || patch.state === 'downloaded') {
      keep.version = this.status.version;
      keep.notes = this.status.notes;
    }
    this.status = { ...keep, ...patch };
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('updater:status', this.status);
  }

  /** (Re)start the periodic check according to the current settings. */
  start() {
    clearInterval(this.timer);
    clearTimeout(this.firstTimer);
    const { autoUpdate } = this.getConfig();
    if (!autoUpdate) return;
    this.firstTimer = setTimeout(() => this.check(false), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => this.check(false), CHECK_INTERVAL_MS);
  }

  async check(manual) {
    if (this.checking) return this.status;
    if (this.status.state === 'downloaded') return this.status;

    if (!app.isPackaged && process.env.STF_FORCE_DEV_UPDATE !== '1') {
      this._set({ state: 'disabled', message: 'Updates sind nur in der installierten Version aktiv.' });
      return this.status;
    }

    let url;
    try {
      url = normalizeUpdateUrl(this.getConfig().updateUrl);
    } catch (err) {
      this._set({ state: 'error', message: err.message });
      return this.status;
    }
    if (!url) {
      this._set({ state: 'disabled', message: 'Keine Update-URL gesetzt (Einstellungen → Updates).' });
      return this.status;
    }

    this.checking = true;
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url });
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // Background checks fail quietly (offline, server down); manual checks show the error.
      if (manual) this._set({ state: 'error', message: String((err && err.message) || err).slice(0, 300) });
      else this._set({ state: 'idle' });
    } finally {
      this.checking = false;
    }
    return this.status;
  }

  install() {
    if (this.status.state !== 'downloaded') return false;
    // Silent install (no wizard) and start the new version afterwards.
    autoUpdater.quitAndInstall(true, true);
    return true;
  }
}

module.exports = { Updater };
