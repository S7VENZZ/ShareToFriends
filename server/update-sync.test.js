'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { syncOnce, parseLatestYml } = require('./update-sync');

/** A pretend GitHub: the release API plus the asset downloads. */
function fakeGithub() {
  const state = { release: null, files: new Map(), apiStatus: 200 };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/repos/')) {
      res.statusCode = state.apiStatus;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(state.release));
    }
    const file = state.files.get(decodeURIComponent(req.url.slice(1)));
    if (!file) {
      res.statusCode = 404;
      return res.end();
    }
    res.end(file);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      /** Publish version v with an installer whose content is `body`; `badSum` breaks the checksum. */
      state.publish = (v, body = `installer ${v}`, { badSum = false, extra = [] } = {}) => {
        const exe = `ShareToFriends-Setup-${v}.exe`;
        const sum = crypto.createHash('sha512').update(badSum ? 'something else' : body).digest('base64');
        const yml = `version: ${v}\nfiles:\n  - url: ${exe}\n    sha512: ${sum}\n    size: ${body.length}\npath: ${exe}\nsha512: ${sum}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`;
        state.files.set('latest.yml', yml);
        state.files.set(exe, body);
        state.files.set(`${exe}.blockmap`, `blockmap ${v}`);
        state.release = {
          tag_name: `v${v}`,
          assets: [
            ...['latest.yml', exe, `${exe}.blockmap`, ...extra.map((e) => e.name)].map((name) => ({ name, browser_download_url: `${base}/${encodeURIComponent(name)}` })),
          ],
        };
        for (const e of extra) state.files.set(e.name, e.body);
      };
      resolve({ state, base, close: () => server.close() });
    });
  });
}

let pending = Promise.resolve();
function test(name, fn) {
  pending = pending.then(async () => {
    await fn();
    console.log('ok  ' + name);
  });
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stf-sync-'));
const list = (dir) => fs.readdirSync(dir).filter((n) => !n.startsWith('.tmp-')).sort();

test('the first run publishes installer, blockmap and the feed', async () => {
  const gh = await fakeGithub();
  const dir = tmpDir();
  gh.state.publish('2.0.7');
  assert.equal(await syncOnce({ dir, repo: 'o/r', api: gh.base }), 'published');
  assert.deepEqual(list(dir), ['ShareToFriends-Setup-2.0.7.exe', 'ShareToFriends-Setup-2.0.7.exe.blockmap', 'latest.yml']);
  assert.equal(parseLatestYml(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8')).version, '2.0.7');
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('.tmp-')).length, 0, 'no temporary leftovers');
  gh.close();
});

test('nothing is downloaded again while the release is unchanged', async () => {
  const gh = await fakeGithub();
  const dir = tmpDir();
  gh.state.publish('2.0.7');
  await syncOnce({ dir, repo: 'o/r', api: gh.base });
  let installerRequests = 0;
  const counting = (url, opts) => {
    if (String(url).endsWith('.exe')) installerRequests++;
    return fetch(url, opts);
  };
  assert.equal(await syncOnce({ dir, repo: 'o/r', api: gh.base, fetchImpl: counting }), 'up-to-date');
  assert.equal(installerRequests, 0);
  gh.close();
});

test('a new version is published and only the newest two stay', async () => {
  const gh = await fakeGithub();
  const dir = tmpDir();
  for (const v of ['2.0.7', '2.0.8', '2.0.9']) {
    gh.state.publish(v);
    assert.equal(await syncOnce({ dir, repo: 'o/r', api: gh.base, keep: 2 }), 'published');
  }
  assert.deepEqual(list(dir), ['ShareToFriends-Setup-2.0.8.exe', 'ShareToFriends-Setup-2.0.8.exe.blockmap', 'ShareToFriends-Setup-2.0.9.exe', 'ShareToFriends-Setup-2.0.9.exe.blockmap', 'latest.yml']);
  assert.equal(parseLatestYml(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8')).version, '2.0.9');
  gh.close();
});

test('versions are compared as numbers (2.0.10 is newer than 2.0.9)', async () => {
  const gh = await fakeGithub();
  const dir = tmpDir();
  for (const v of ['2.0.9', '2.0.10', '2.0.11']) {
    gh.state.publish(v);
    await syncOnce({ dir, repo: 'o/r', api: gh.base, keep: 2 });
  }
  assert.ok(!list(dir).some((n) => n.includes('2.0.9.')), '2.0.9 was removed');
  assert.ok(list(dir).some((n) => n.includes('2.0.10.')));
  gh.close();
});

test('a wrong checksum is never published and the old version stays', async () => {
  const gh = await fakeGithub();
  const dir = tmpDir();
  gh.state.publish('2.0.7');
  await syncOnce({ dir, repo: 'o/r', api: gh.base });
  gh.state.publish('2.0.8', 'tampered', { badSum: true });
  await assert.rejects(syncOnce({ dir, repo: 'o/r', api: gh.base }), /checksum/);
  assert.equal(parseLatestYml(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8')).version, '2.0.7');
  assert.ok(!list(dir).includes('ShareToFriends-Setup-2.0.8.exe'));
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('.tmp-')).length, 0);
  gh.close();
});

test('GitHub being down changes nothing', async () => {
  const gh = await fakeGithub();
  const dir = tmpDir();
  gh.state.publish('2.0.7');
  await syncOnce({ dir, repo: 'o/r', api: gh.base });
  gh.state.apiStatus = 503;
  await assert.rejects(syncOnce({ dir, repo: 'o/r', api: gh.base }), /release lookup 503/);
  assert.equal(list(dir).length, 3);
  gh.close();
});

test('only the known file names are ever fetched or written (no path tricks)', async () => {
  const gh = await fakeGithub();
  const dir = tmpDir();
  gh.state.publish('2.0.7', 'installer 2.0.7', { extra: [{ name: '../evil.sh', body: 'x' }, { name: 'ShareToFriends-Setup-9.9.9.exe.sh', body: 'x' }, { name: 'notes.txt', body: 'x' }] });
  await syncOnce({ dir, repo: 'o/r', api: gh.base });
  assert.deepEqual(list(dir), ['ShareToFriends-Setup-2.0.7.exe', 'ShareToFriends-Setup-2.0.7.exe.blockmap', 'latest.yml']);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.sh')));
  gh.close();
});

test('a feed that points at a strange file name is refused', async () => {
  const gh = await fakeGithub();
  const dir = tmpDir();
  gh.state.publish('2.0.7');
  gh.state.files.set('latest.yml', 'version: 2.0.7\npath: ../../etc/passwd\nsha512: abc\n');
  await assert.rejects(syncOnce({ dir, repo: 'o/r', api: gh.base }), /not valid/);
  assert.equal(list(dir).length, 0);
  gh.close();
});

test('a release without latest.yml is skipped', async () => {
  const gh = await fakeGithub();
  const dir = tmpDir();
  gh.state.release = { tag_name: 'v1', assets: [] };
  assert.equal(await syncOnce({ dir, repo: 'o/r', api: gh.base }), 'skipped');
  gh.close();
});

pending
  .then(() => console.log('\nall update-sync tests passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
