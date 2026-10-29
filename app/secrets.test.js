'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Secrets } = require('./secrets');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stf-secrets-'));
const fake = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s) => Buffer.from(s.split('').reverse().join(''), 'utf8'), // stand-in for DPAPI
  decryptStringAsync: async (b) => ({ result: b.toString('utf8').split('').reverse().join(''), shouldReEncrypt: false }),
};

let pending = Promise.resolve();
function test(name, fn) {
  pending = pending.then(async () => {
    await fn();
    console.log('ok  ' + name);
  });
}

test('values round-trip and are not stored in plain text', async () => {
  const s = new Secrets({ file: path.join(dir, 'a.json'), safeStorage: fake });
  assert.equal(await s.set('hostPassword', 'K7M2QX9P4T'), true);
  assert.equal(await s.get('hostPassword'), 'K7M2QX9P4T');
  assert.ok(!fs.readFileSync(path.join(dir, 'a.json'), 'utf8').includes('K7M2QX9P4T'));
  assert.equal(await new Secrets({ file: path.join(dir, 'a.json'), safeStorage: fake }).get('hostPassword'), 'K7M2QX9P4T', 'survives a restart');
});

test('null deletes, other keys stay', async () => {
  const s = new Secrets({ file: path.join(dir, 'b.json'), safeStorage: fake });
  await s.set('hostPassword', 'abc');
  await s.set('friends', '[1]');
  await s.set('hostPassword', null);
  assert.equal(await s.get('hostPassword'), null);
  assert.equal(await s.get('friends'), '[1]');
});

test('simultaneous writes do not lose each other', async () => {
  const s = new Secrets({ file: path.join(dir, 'g.json'), safeStorage: fake });
  await Promise.all([s.set('hostPassword', 'one'), s.set('friends', 'two')]);
  assert.equal(await s.get('hostPassword'), 'one');
  assert.equal(await s.get('friends'), 'two');
});

test('only known keys; oversized values are refused', async () => {
  const s = new Secrets({ file: path.join(dir, 'c.json'), safeStorage: fake });
  await assert.rejects(s.set('other', 'x'));
  assert.equal(await s.get('other'), null);
  await assert.rejects(s.set('friends', 'x'.repeat(100_001)));
  assert.equal(await s.set('friends', 'ok'), true, 'a refused write does not block the next one');
});

test('without OS encryption nothing is stored', async () => {
  const s = new Secrets({ file: path.join(dir, 'd.json'), safeStorage: { ...fake, isAsyncEncryptionAvailable: async () => false } });
  assert.equal(await s.set('hostPassword', 'secret'), false);
  assert.equal(await s.get('hostPassword'), null);
  assert.ok(!fs.existsSync(path.join(dir, 'd.json')));
});

test('a damaged or foreign file reads as empty', async () => {
  fs.writeFileSync(path.join(dir, 'e.json'), '{not json');
  assert.equal(await new Secrets({ file: path.join(dir, 'e.json'), safeStorage: fake }).get('friends'), null);
  const broken = {
    ...fake,
    decryptStringAsync: async () => {
      throw new Error('other user');
    },
  };
  const s = new Secrets({ file: path.join(dir, 'f.json'), safeStorage: fake });
  await s.set('friends', 'x');
  assert.equal(await new Secrets({ file: path.join(dir, 'f.json'), safeStorage: broken }).get('friends'), null);
});

pending
  .then(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('\nall secrets tests passed');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
