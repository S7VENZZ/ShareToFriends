'use strict';

/**
 * Update mirror: keeps ./updates (served by Caddy at https://<domain>/updates) in sync with the newest release.
 *
 * The installers are built by GitHub Actions and attached to the release there. This script fetches the
 * newest release, checks the SHA-512 of the installer against latest.yml and only then publishes it:
 *   1. installer + blockmap are moved into place
 *   2. latest.yml LAST, so a client never sees a feed that points at a file that is not there yet
 * Installed apps only ever talk to this server, never to GitHub.
 *
 * Only the newest KEEP versions stay on disk. Failures (GitHub down, bad checksum ...) leave the current
 * files untouched and are retried at the next interval.
 *
 * No dependencies (Node 22: fetch, crypto).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const NAME_RE = /^ShareToFriends-Setup-(\d+)\.(\d+)\.(\d+)\.exe(\.blockmap)?$/;
const MAX_INSTALLER_BYTES = 600 * 1024 * 1024;

function log(...args) {
  console.log(new Date().toISOString(), '[update-sync]', ...args);
}

const compareVersions = (a, b) => a.v.reduce((acc, x, i) => acc || x - b.v[i], 0);

/** Files in dir that belong to a version: [{ name, v: [maj, min, patch] }] */
function versionedFiles(dir) {
  return fs
    .readdirSync(dir)
    .map((name) => {
      const m = NAME_RE.exec(name);
      return m ? { name, v: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
    })
    .filter(Boolean);
}

/** @returns {{ version: string, path: string, sha512: string } | null} from the text of a latest.yml */
function parseLatestYml(text) {
  const version = /^version:\s*(\S+)/m.exec(text);
  const file = /^path:\s*(\S+)/m.exec(text);
  const sha = /^sha512:\s*(\S+)/m.exec(text);
  return version && file && sha ? { version: version[1], path: file[1], sha512: sha[1] } : null;
}

async function sha512OfFile(file) {
  const hash = crypto.createHash('sha512');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('base64');
}

async function download(url, dest, fetchImpl, maxBytes) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'stf-update-sync' }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${res.status} ${url}`);
  let size = 0;
  const limiter = new (require('stream').Transform)({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      cb(size > maxBytes ? new Error('file too large') : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(dest));
  return size;
}

/**
 * One round. Returns what happened: 'up-to-date' | 'published' | 'skipped'.
 * @param {{ dir: string, repo: string, api?: string, keep?: number, token?: string, fetchImpl?: typeof fetch }} o
 */
async function syncOnce(o) {
  const fetchImpl = o.fetchImpl || fetch;
  const api = o.api || 'https://api.github.com';
  const keep = Math.max(1, o.keep || 2);
  fs.mkdirSync(o.dir, { recursive: true });

  const headers = { 'User-Agent': 'stf-update-sync', Accept: 'application/vnd.github+json' };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  const res = await fetchImpl(`${api}/repos/${o.repo}/releases/latest`, { headers });
  if (!res.ok) throw new Error(`release lookup ${res.status}`);
  const release = await res.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];

  const byName = new Map();
  for (const a of assets) {
    if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue;
    if (a.name === 'latest.yml' || NAME_RE.test(a.name)) byName.set(a.name, a.browser_download_url); // nothing else is ever fetched
  }
  const ymlUrl = byName.get('latest.yml');
  if (!ymlUrl) {
    log('latest release has no latest.yml – skipped');
    return 'skipped';
  }

  const tmp = fs.mkdtempSync(path.join(o.dir, '.tmp-'));
  try {
    const ymlFile = path.join(tmp, 'latest.yml');
    await download(ymlUrl, ymlFile, fetchImpl, 64 * 1024);
    const meta = parseLatestYml(fs.readFileSync(ymlFile, 'utf8'));
    if (!meta || !NAME_RE.test(meta.path) || meta.path.endsWith('.blockmap')) throw new Error('latest.yml is not valid');

    // already published?
    const current = path.join(o.dir, 'latest.yml');
    if (fs.existsSync(current) && fs.existsSync(path.join(o.dir, meta.path))) {
      const have = parseLatestYml(fs.readFileSync(current, 'utf8'));
      if (have && have.version === meta.version && have.sha512 === meta.sha512) return 'up-to-date';
    }

    const exeUrl = byName.get(meta.path);
    if (!exeUrl) throw new Error(`release has no ${meta.path}`);
    const exeFile = path.join(tmp, meta.path);
    await download(exeUrl, exeFile, fetchImpl, MAX_INSTALLER_BYTES);
    const actual = await sha512OfFile(exeFile);
    if (actual !== meta.sha512) throw new Error(`checksum of ${meta.path} does not match latest.yml – not published`);

    const mapName = `${meta.path}.blockmap`;
    const mapUrl = byName.get(mapName);
    if (mapUrl) await download(mapUrl, path.join(tmp, mapName), fetchImpl, 64 * 1024 * 1024);

    // publish: files first, the feed last
    fs.renameSync(exeFile, path.join(o.dir, meta.path));
    if (mapUrl) fs.renameSync(path.join(tmp, mapName), path.join(o.dir, mapName));
    fs.renameSync(ymlFile, current);
    log(`published ${meta.version}`);

    // keep only the newest versions
    const versions = [...new Map(versionedFiles(o.dir).map((f) => [f.v.join('.'), f])).values()].sort((a, b) => compareVersions(b, a));
    const stale = new Set(versions.slice(keep).map((f) => f.v.join('.')));
    for (const f of versionedFiles(o.dir)) {
      if (stale.has(f.v.join('.'))) {
        fs.rmSync(path.join(o.dir, f.name), { force: true });
        log('removed old file', f.name);
      }
    }
    return 'published';
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const o = {
    dir: process.env.UPDATES_DIR || '/srv/updates',
    repo: process.env.GITHUB_REPO || 'S7VENZZ/ShareToFriends',
    api: process.env.GITHUB_API || 'https://api.github.com',
    keep: Number(process.env.KEEP_VERSIONS || 2),
    token: process.env.GITHUB_TOKEN || '',
  };
  const everyMs = Math.max(1, Number(process.env.INTERVAL_MIN || 5)) * 60_000;
  log(`mirroring ${o.repo} into ${o.dir} every ${everyMs / 60_000} min`);
  let stop = false;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => (stop = true, process.exit(0)));
  while (!stop) {
    try {
      const r = await syncOnce(o);
      if (r !== 'up-to-date') log('result:', r);
    } catch (err) {
      log('failed, keeping the current files:', err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

if (require.main === module) main();

module.exports = { syncOnce, parseLatestYml, versionedFiles };
