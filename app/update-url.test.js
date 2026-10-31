'use strict';

const assert = require('node:assert/strict');
const { normalizeUpdateUrl, updateUrlFromServer, resolveServerUrl, FIXED_SERVER_URL, DEFAULT_UPDATE_SOURCE } = require('./update-url');

function test(name, fn) {
  fn();
  console.log('ok  ' + name);
}

test('the update feed is derived from the signaling server address', () => {
  assert.equal(updateUrlFromServer('wss://stf.s7venz.cloud/ws'), 'https://stf.s7venz.cloud/updates');
  assert.equal(updateUrlFromServer('wss://example.org:8443/ws'), 'https://example.org:8443/updates');
});

test('no usable server address -> no derived feed', () => {
  assert.equal(updateUrlFromServer(''), '');
  assert.equal(updateUrlFromServer(undefined), '');
  assert.equal(updateUrlFromServer('ws://127.0.0.1:8787/ws'), '', 'plain ws never gives an https feed');
  assert.equal(updateUrlFromServer('not a url'), '');
});

test('the built-in default is an https feed on the project server', () => {
  assert.equal(normalizeUpdateUrl(DEFAULT_UPDATE_SOURCE), 'https://stf.s7venz.cloud/updates');
});

test('only https feeds are accepted (loopback may use http for tests)', () => {
  assert.throws(() => normalizeUpdateUrl('http://example.org/updates'));
  assert.equal(normalizeUpdateUrl('http://127.0.0.1:9000/u/'), 'http://127.0.0.1:9000/u');
  assert.equal(normalizeUpdateUrl('github:o/r'), 'https://github.com/o/r/releases/latest/download');
});

test('the signaling server is fixed in an installed app, whatever is set', () => {
  assert.equal(FIXED_SERVER_URL, 'wss://stf.s7venz.cloud/ws');
  assert.equal(resolveServerUrl(true, undefined), FIXED_SERVER_URL);
  assert.equal(resolveServerUrl(true, 'ws://127.0.0.1:8787/ws'), FIXED_SERVER_URL, 'the environment cannot change it in a packaged app');
  assert.equal(resolveServerUrl(true, 'wss://evil.example/ws'), FIXED_SERVER_URL);
});

test('only a development checkout may use a local test server', () => {
  assert.equal(resolveServerUrl(false, 'ws://127.0.0.1:8787/ws'), 'ws://127.0.0.1:8787/ws');
  assert.equal(resolveServerUrl(false, 'ws://localhost:9/ws'), 'ws://localhost:9/ws');
  assert.equal(resolveServerUrl(false, 'wss://evil.example/ws'), FIXED_SERVER_URL, 'never a foreign host');
  assert.equal(resolveServerUrl(false, 'ws://127.0.0.1.evil.example/ws'), FIXED_SERVER_URL, 'not a look-alike host');
  assert.equal(resolveServerUrl(false, ''), FIXED_SERVER_URL);
});

console.log('\nall update-url tests passed');
