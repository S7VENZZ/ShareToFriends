'use strict';

/** node auth.test.js */

const assert = require('assert');
const A = require('./auth');

(async () => {
  const pw = A.generatePassword();
  assert(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(pw), 'password format ' + pw);
  assert.strictEqual(A.normalizePassword(pw.toLowerCase().replace('-', ' ')), pw.replace('-', ''));
  assert.strictEqual(A.normalizePassword('too short'), '');
  assert.strictEqual(A.normalizePassword('  Mein-Geheimes Passwort 42  '), 'Mein-Geheimes Passwort 42', 'a self-chosen password is kept as typed');
  assert.strictEqual(A.normalizePassword('x'.repeat(65)), '');
  assert.strictEqual(A.customPasswordProblem('kurz'), 'Mindestens 10 Zeichen.');
  assert.ok(A.customPasswordProblem('aaaaaaaaaaaa'), 'repeated characters are rejected');
  assert.ok(A.customPasswordProblem('1234567890'), 'digits only is rejected');
  assert.strictEqual(A.customPasswordProblem('Sommer-Urlaub-2026'), '');
  assert.strictEqual(A.normalizeId('123 456 789'), '123456789');
  assert.strictEqual(A.normalizeId('12345'), '');
  assert.strictEqual(A.formatId('123456789'), '123 456 789');
  console.log('ok  password / ID formatting and normalisation');

  const canonical = A.normalizePassword(pw);
  const t0 = Date.now();
  const hostKey = await A.deriveKey(canonical, '111222333');
  const viewerKey = await A.deriveKey(canonical, '111222333');
  console.log(`ok  PBKDF2 key derivation (${Math.round((Date.now() - t0) / 2)} ms each)`);

  const nH = A.b64(A.randomBytes(16));
  const nV = A.b64(A.randomBytes(16));
  const viewerMac = await A.mac(viewerKey, `V|${nH}|${nV}|Max`);
  assert(await A.verify(hostKey, `V|${nH}|${nV}|Max`, viewerMac), 'host accepts the correct password');
  assert(!(await A.verify(hostKey, `V|${nH}|${nV}|Eve`, viewerMac)), 'a changed name invalidates the MAC');

  const wrongKey = await A.deriveKey(A.normalizePassword(A.generatePassword()), '111222333');
  const wrongMac = await A.mac(wrongKey, `V|${nH}|${nV}|Max`);
  assert(!(await A.verify(hostKey, `V|${nH}|${nV}|Max`, wrongMac)), 'host rejects a wrong password');
  console.log('ok  wrong password and tampered name are rejected');

  const otherHostKey = await A.deriveKey(canonical, '999888777');
  const otherMac = await A.mac(otherHostKey, `V|${nH}|${nV}|Max`);
  assert(!(await A.verify(hostKey, `V|${nH}|${nV}|Max`, otherMac)), 'the key is bound to the host ID');
  console.log('ok  the derived key is bound to the host ID (salt)');

  const sk1 = await A.sessionKey(hostKey, nH, nV);
  const sk2 = await A.sessionKey(viewerKey, nH, nV);
  const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n';
  const m = await A.mac(sk1, `sdp|offer|${sdp}`);
  assert(await A.verify(sk2, `sdp|offer|${sdp}`, m), 'both sides derive the same session key');
  assert(!(await A.verify(sk2, `sdp|offer|${sdp.replace('AA:BB', 'CC:DD')}`, m)), 'a swapped DTLS fingerprint is detected');
  const sk3 = await A.sessionKey(hostKey, nH, A.b64(A.randomBytes(16)));
  assert(!(await A.verify(sk3, `sdp|offer|${sdp}`, m)), 'a different handshake yields a different session key');
  console.log('ok  session key authenticates the SDP; a swapped fingerprint (MITM) is detected');

  console.log('\nall auth tests passed');
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
