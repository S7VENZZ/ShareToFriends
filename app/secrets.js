'use strict';

/**
 * Small encrypted store for secrets that must survive a restart: the host password and the saved friends
 * (ID + password). Values are encrypted with Electron's safeStorage (Windows DPAPI: tied to the Windows user
 * account), never written in plain text. Uses the asynchronous safeStorage API.
 */

const fs = require('fs');

const KEYS = new Set(['hostPassword', 'friends']);
const MAX_VALUE = 100_000;

class Secrets {
  /** @param {{ file: string, safeStorage: object }} deps */
  constructor({ file, safeStorage }) {
    this.file = file;
    this.ss = safeStorage;
    this.queue = Promise.resolve(); // writes are read-modify-write: run them one after another
  }

  async isAvailable() {
    try {
      return Boolean(await this.ss.isAsyncEncryptionAvailable());
    } catch {
      return false;
    }
  }

  _read() {
    try {
      const obj = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  /** @returns {Promise<string | null>} */
  async get(key) {
    if (!KEYS.has(key) || !(await this.isAvailable())) return null;
    const b64 = this._read()[key];
    if (typeof b64 !== 'string') return null;
    try {
      const { result } = await this.ss.decryptStringAsync(Buffer.from(b64, 'base64'));
      return result;
    } catch {
      return null; // other Windows user, or the file was copied from another PC
    }
  }

  /** @param {string | null} value null deletes @returns {Promise<boolean>} false when encryption is not available */
  set(key, value) {
    const run = async () => {
      if (!KEYS.has(key)) throw new Error('Unbekannter Schlüssel');
      if (!(await this.isAvailable())) return false;
      if (value !== null && (typeof value !== 'string' || value.length > MAX_VALUE)) throw new Error('Ungültiger Wert');
      const encrypted = value === null ? null : (await this.ss.encryptStringAsync(value)).toString('base64');
      const all = this._read();
      if (encrypted === null) delete all[key];
      else all[key] = encrypted;
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
}

module.exports = { Secrets };
