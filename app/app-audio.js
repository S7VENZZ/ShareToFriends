'use strict';

/**
 * Per-application audio capture (Windows 10 2004+ / Windows 11) via the StfAudioCapture helper.
 *
 *  - list():  processes that currently own an audio session (for the checkbox list in the mixer)
 *  - start(): spawn one helper per process; its raw PCM (48 kHz, stereo, s16le) is forwarded to the
 *             renderer in ~20 ms batches, where an AudioWorklet plays it into the mixer
 *
 * The renderer decides which apps are captured (whitelist / blacklist); this class only runs them.
 */

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const MAX_CAPTURES = 8;
const KNOWN_TTL_MS = 60_000;
const FLUSH_MS = 20;
const IGNORED = new Set(['audiodg', 'svchost', 'sharetofriends', 'electron']);

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'helper', 'StfAudioCapture.exe')
    : path.join(__dirname, 'helper', 'StfAudioCapture.exe');
}

class AppAudio {
  /** @param {{ getWindow: () => Electron.BrowserWindow | null }} deps */
  constructor({ getWindow }) {
    this.getWindow = getWindow;
    this.captures = new Map(); // pid -> { proc, chunks, timer }
    this.known = new Map(); // pid -> last time it appeared in list()
    this.supported = process.platform === 'win32' && fs.existsSync(helperPath());
  }

  list() {
    if (!this.supported) return Promise.resolve([]);
    return new Promise((resolve) => {
      execFile(helperPath(), ['--list'], { timeout: 6000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        let rows = [];
        try {
          rows = JSON.parse(stdout);
        } catch {
          return resolve([]);
        }
        const now = Date.now();
        const result = [];
        for (const r of rows) {
          if (!Number.isInteger(r.pid) || typeof r.name !== 'string') continue;
          if (IGNORED.has(r.name.toLowerCase())) continue;
          this.known.set(r.pid, now);
          result.push({
            pid: r.pid,
            name: r.name.slice(0, 60),
            title: String(r.title || '').slice(0, 80),
            active: Boolean(r.active),
            peak: Math.min(1, Math.max(0, Number(r.peak) || 0)),
          });
        }
        resolve(result);
      });
    });
  }

  start(pid) {
    if (!this.supported || !Number.isInteger(pid) || pid <= 0) return false;
    if (this.captures.has(pid)) return true;
    const seen = this.known.get(pid);
    if (!seen || Date.now() - seen > KNOWN_TTL_MS) return false; // only processes that list() returned
    if (this.captures.size >= MAX_CAPTURES) return false;

    const proc = spawn(helperPath(), ['--capture', String(pid)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const entry = { proc, chunks: [], rest: Buffer.alloc(0), timer: null };
    this.captures.set(pid, entry);

    const flush = () => {
      if (entry.chunks.length === 0) return;
      // Pipe reads can split a 4-byte stereo frame; only whole frames are sent on.
      const all = Buffer.concat([entry.rest, ...entry.chunks]);
      entry.chunks = [];
      const usable = all.length - (all.length % 4);
      entry.rest = all.subarray(usable);
      if (usable === 0) return;
      const win = this.getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('appaudio:chunk', pid, all.subarray(0, usable));
    };
    entry.timer = setInterval(flush, FLUSH_MS);
    proc.stdout.on('data', (d) => entry.chunks.push(d));
    proc.stderr.on('data', (d) => console.warn(`[appaudio ${pid}]`, String(d).trim()));
    proc.stdin.on('error', () => {});
    proc.on('exit', () => {
      clearInterval(entry.timer);
      if (this.captures.get(pid) === entry) this.captures.delete(pid);
      const win = this.getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('appaudio:ended', pid);
    });
    return true;
  }

  stop(pid) {
    const entry = this.captures.get(pid);
    if (!entry) return;
    try {
      entry.proc.stdin.end(); // the helper exits when stdin closes
    } catch {
      /* already gone */
    }
    setTimeout(() => entry.proc.kill(), 800).unref();
  }

  stopAll() {
    for (const pid of [...this.captures.keys()]) this.stop(pid);
  }
}

module.exports = { AppAudio };
