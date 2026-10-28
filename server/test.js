'use strict';

/** Self-test for the signaling server: node test.js */

const assert = require('assert');
const WebSocket = require('ws');
const { server } = require('./signal-server');

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const w = waiters.findIndex((x) => x.test(m));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m);
    else inbox.push(m);
  });
  return {
    ws,
    open: () => new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    next: (test = () => true, ms = 2000) =>
      new Promise((resolve, reject) => {
        const i = inbox.findIndex(test);
        if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
        const timer = setTimeout(() => reject(new Error('timeout waiting for message')), ms);
        waiters.push({ test, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      }),
  };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const host = client(port);
  await host.open();
  host.send({ t: 'hello', id: '123456789' });
  const ok = await host.next((m) => m.t === 'hello-ok');
  assert(Array.isArray(ok.ice) && ok.ice.length >= 1, 'ice servers delivered');
  console.log('ok  host registers with an ID and receives ICE servers');

  const dup = client(port);
  await dup.open();
  dup.send({ t: 'hello', id: '123456789' });
  assert.strictEqual((await dup.next()).code, 'id-in-use');
  console.log('ok  a second client cannot take an active ID');

  const bad = client(port);
  await bad.open();
  bad.send({ t: 'hello', id: 'abc' });
  assert.strictEqual((await bad.next()).code, 'bad-id');
  console.log('ok  malformed IDs are rejected');

  const viewer = client(port);
  await viewer.open();
  viewer.send({ t: 'connect', to: '987654321' });
  assert.strictEqual((await viewer.next()).code, 'offline');
  console.log('ok  connecting to an unknown ID reports "offline"');

  viewer.send({ t: 'connect', to: '123456789' });
  const connected = await viewer.next((m) => m.t === 'connected');
  const incoming = await host.next((m) => m.t === 'incoming');
  assert.strictEqual(connected.sid, incoming.sid);
  console.log('ok  viewer connects to host by ID; both get the same session id');

  const sid = connected.sid;
  host.send({ t: 'relay', sid, d: { k: 'challenge', n: 'abc' } });
  assert.deepStrictEqual((await viewer.next((m) => m.t === 'relay')).d, { k: 'challenge', n: 'abc' });
  viewer.send({ t: 'relay', sid, d: { k: 'auth', mac: 'xyz' } });
  assert.deepStrictEqual((await host.next((m) => m.t === 'relay')).d, { k: 'auth', mac: 'xyz' });
  console.log('ok  handshake messages are relayed in both directions');

  const stranger = client(port);
  await stranger.open();
  stranger.send({ t: 'relay', sid, d: { k: 'evil' } });
  await new Promise((r) => setTimeout(r, 200));
  let leaked = false;
  try {
    await Promise.race([host.next((m) => m.t === 'relay', 300).then(() => { leaked = true; }), viewer.next((m) => m.t === 'relay', 300).then(() => { leaked = true; })]);
  } catch {
    /* expected: nothing arrives */
  }
  assert(!leaked, 'a third party must not be able to inject into a session');
  console.log('ok  third parties cannot inject into a session');

  viewer.send({ t: 'bye', sid });
  assert.strictEqual((await host.next((m) => m.t === 'bye')).sid, sid);
  console.log('ok  bye ends the session for the other side');

  host.ws.close();
  await new Promise((r) => setTimeout(r, 200));
  const again = client(port);
  await again.open();
  again.send({ t: 'hello', id: '123456789' });
  assert.strictEqual((await again.next()).t, 'hello-ok');
  console.log('ok  an ID is free again after its owner disconnects');

  // rate limit on connect attempts
  const spam = client(port);
  await spam.open();
  let limited = false;
  for (let i = 0; i < 40; i++) spam.send({ t: 'connect', to: '555555555' });
  for (let i = 0; i < 40; i++) {
    try {
      const m = await spam.next(() => true, 300);
      if (m.code === 'rate-limit') limited = true;
    } catch {
      break;
    }
  }
  assert(limited, 'connect attempts are rate limited');
  console.log('ok  connect attempts are rate limited (anti ID-scanning)');

  console.log('\nall signaling tests passed');
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
