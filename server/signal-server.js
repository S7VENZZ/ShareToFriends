'use strict';

/**
 * ShareToFriends signaling server (runs on a small VPS).
 *
 * It only introduces two peers to each other and relays their handshake messages. The stream itself
 * flows directly between the PCs (WebRTC). The server never learns passwords: authentication is a
 * challenge/response done end-to-end between the apps, and the SDP is MAC-protected with a key derived
 * from the password, so even this server cannot read or tamper with a session.
 *
 *   client -> server                               server -> client
 *   { t:'hello', id }                              { t:'hello-ok', ice } | { t:'error', code }
 *   { t:'connect', to }                            { t:'connected', sid } | { t:'error', code:'offline' }
 *                                                  { t:'incoming', sid }               (to the host)
 *   { t:'relay', sid, d }                          { t:'relay', sid, d }               (to the other peer)
 *   { t:'bye', sid }                               { t:'bye', sid }
 *   { t:'ice-refresh' }                            { t:'ice', ice }
 *
 * `ice` carries STUN/TURN servers; TURN credentials are short-lived (coturn "use-auth-secret").
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const TURN_HOST = process.env.TURN_HOST || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_STATIC_USER = process.env.TURN_STATIC_USER || ''; // test/dev only
const TURN_STATIC_PASS = process.env.TURN_STATIC_PASS || '';
const TURN_PORT = Number(process.env.TURN_PORT || 3478);
const TURN_TTL_S = 6 * 3600;

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SESSIONS_PER_HOST = 8;
const MAX_CONNECTIONS_PER_IP = 24;
const CONNECT_ATTEMPTS_PER_MIN = 30;
const HELLOS_PER_MIN = 20;
const MESSAGES_PER_SECOND = 60;
const ID_PATTERN = /^\d{9}$/;

/** id -> ws of the host */
const hosts = new Map();
/** sid -> { host: ws, viewer: ws } */
const sessions = new Map();
const perIp = new Map(); // ip -> { conns, attempts: number[], hellos: number[] }

function ipState(ip) {
  let s = perIp.get(ip);
  if (!s) {
    s = { conns: 0, attempts: [], hellos: [] };
    perIp.set(ip, s);
  }
  return s;
}

function allow(list, limit, windowMs = 60_000) {
  const now = Date.now();
  while (list.length && now - list[0] > windowMs) list.shift();
  if (list.length >= limit) return false;
  list.push(now);
  return true;
}

function iceServers() {
  const servers = [];
  if (TURN_HOST) servers.push({ urls: [`stun:${TURN_HOST}:${TURN_PORT}`] });
  else servers.push({ urls: ['stun:stun.l.google.com:19302'] });

  if (TURN_HOST && TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:${crypto.randomBytes(4).toString('hex')}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    servers.push({
      urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`],
      username,
      credential,
    });
  } else if (TURN_HOST && TURN_STATIC_USER) {
    servers.push({
      urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`],
      username: TURN_STATIC_USER,
      credential: TURN_STATIC_PASS,
    });
  }
  return servers;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function endSession(sid, notify) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  s.host.sessions.delete(sid);
  s.viewer.sessions.delete(sid);
  if (notify) send(notify === s.host ? s.viewer : s.host, { t: 'bye', sid });
}

function cleanup(ws) {
  for (const sid of [...ws.sessions]) endSession(sid, ws);
  if (ws.hostId && hosts.get(ws.hostId) === ws) hosts.delete(ws.hostId);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hosts: hosts.size, sessions: sessions.size }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Behind Caddy the real client address is in X-Forwarded-For.
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.socket.remoteAddress || 'unknown';
  const st = ipState(ip);
  if (st.conns >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1008, 'too many connections');
    return;
  }
  st.conns++;

  ws.alive = true;
  ws.sessions = new Set();
  ws.hostId = null;
  ws.msgTimes = [];
  ws.on('pong', () => (ws.alive = true));

  ws.on('message', (raw) => {
    if (!allow(ws.msgTimes, MESSAGES_PER_SECOND * 5, 5000)) {
      ws.close(1008, 'rate limit');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'hello': {
        if (!allow(st.hellos, HELLOS_PER_MIN)) return send(ws, { t: 'error', code: 'rate-limit' });
        if (ws.hostId) return;
        if (typeof msg.id !== 'string' || !ID_PATTERN.test(msg.id)) return send(ws, { t: 'error', code: 'bad-id' });
        const existing = hosts.get(msg.id);
        if (existing && existing.alive && existing !== ws) return send(ws, { t: 'error', code: 'id-in-use' });
        ws.hostId = msg.id;
        hosts.set(msg.id, ws);
        send(ws, { t: 'hello-ok', ice: iceServers() });
        break;
      }
      case 'ice-refresh':
        send(ws, { t: 'ice', ice: iceServers() });
        break;
      case 'connect': {
        if (!allow(st.attempts, CONNECT_ATTEMPTS_PER_MIN)) return send(ws, { t: 'error', code: 'rate-limit' });
        if (typeof msg.to !== 'string' || !ID_PATTERN.test(msg.to)) return send(ws, { t: 'error', code: 'bad-id' });
        const host = hosts.get(msg.to);
        if (!host || host === ws) return send(ws, { t: 'error', code: 'offline' });
        if (host.sessions.size >= MAX_SESSIONS_PER_HOST) return send(ws, { t: 'error', code: 'host-busy' });
        const sid = crypto.randomBytes(8).toString('hex');
        sessions.set(sid, { host, viewer: ws });
        host.sessions.add(sid);
        ws.sessions.add(sid);
        send(ws, { t: 'connected', sid });
        send(host, { t: 'incoming', sid });
        break;
      }
      case 'relay': {
        const s = sessions.get(msg.sid);
        if (!s || (s.host !== ws && s.viewer !== ws)) return;
        if (msg.d === undefined || JSON.stringify(msg.d).length > MAX_MESSAGE_BYTES - 512) return;
        send(s.host === ws ? s.viewer : s.host, { t: 'relay', sid: msg.sid, d: msg.d });
        break;
      }
      case 'bye':
        endSession(msg.sid, ws);
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    st.conns = Math.max(0, st.conns - 1);
    cleanup(ws);
  });
  ws.on('error', () => {});
});

// Drop dead connections (e.g. a PC that lost power) so its ID becomes free again.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25_000);
heartbeat.unref();

setInterval(() => {
  for (const [ip, s] of perIp) if (s.conns === 0 && s.attempts.length === 0 && s.hellos.length === 0) perIp.delete(ip);
}, 5 * 60_000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`ShareToFriends signaling listening on :${PORT} (path /ws)`));
}

module.exports = { server, wss };
