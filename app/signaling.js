'use strict';

/**
 * Signaling client: keeps this app registered under its ID on the VPS (auto-reconnect with backoff),
 * introduces it to friends (connectTo) and relays handshake messages. No media or secrets pass through.
 */

(function (root) {
  const BACKOFF_S = [1, 2, 3, 5, 8, 13, 20, 30];
  const ICE_REFRESH_MS = 4 * 60 * 60 * 1000;

  class Signaling {
    /**
     * @param {{ getUrl: () => string, id: string,
     *           onState: (state: string, detail?: any) => void,
     *           onIce: (servers: RTCIceServer[]) => void,
     *           onIncoming: (sid: string) => void,
     *           onRelay: (sid: string, data: any) => void,
     *           onBye: (sid: string) => void }} opts
     */
    constructor(opts) {
      this.o = opts;
      this.id = opts.id;
      this.ws = null;
      this.state = 'idle';
      this.attempt = 0;
      this.timer = null;
      this.iceTimer = null;
      this.pending = null; // { resolve, reject, timer }
      this.stopped = true;
    }

    setState(state, detail) {
      this.state = state;
      this.o.onState(state, detail);
    }

    setId(id) {
      this.id = id;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'hello', id }));
    }

    start() {
      this.stopped = false;
      this.open();
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.timer);
      clearInterval(this.iceTimer);
      if (this.ws) this.ws.close();
      this.ws = null;
    }

    /** Re-read the URL (after a settings change) and reconnect immediately. */
    restart() {
      this.stop();
      this.attempt = 0;
      this.start();
    }

    open() {
      clearTimeout(this.timer);
      const url = this.o.getUrl();
      if (!url) {
        this.setState('unconfigured');
        return;
      }
      this.setState('connecting', { attempt: this.attempt });
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        this.setState('offline', { attempt: this.attempt });
        this.scheduleReconnect();
        return;
      }
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', id: this.id }));
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        clearInterval(this.iceTimer);
        if (this.pending) this.failPending(new Error('signal-lost'));
        if (!this.stopped) {
          if (this.state !== 'id-in-use') this.setState('offline', { attempt: this.attempt });
          this.scheduleReconnect();
        }
      };
      ws.onerror = () => {};
    }

    scheduleReconnect() {
      clearTimeout(this.timer);
      const delay = BACKOFF_S[Math.min(this.attempt, BACKOFF_S.length - 1)] * 1000;
      this.attempt++;
      this.timer = setTimeout(() => this.open(), delay);
    }

    onMessage(raw) {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      switch (m.t) {
        case 'hello-ok':
          this.attempt = 0;
          this.setState('ready');
          this.o.onIce(m.ice || []);
          clearInterval(this.iceTimer);
          this.iceTimer = setInterval(() => this.send({ t: 'ice-refresh' }), ICE_REFRESH_MS);
          break;
        case 'ice':
          this.o.onIce(m.ice || []);
          break;
        case 'connected':
          if (this.pending) {
            clearTimeout(this.pending.timer);
            const p = this.pending;
            this.pending = null;
            p.resolve(m.sid);
          }
          break;
        case 'incoming':
          this.o.onIncoming(m.sid);
          break;
        case 'relay':
          this.o.onRelay(m.sid, m.d);
          break;
        case 'bye':
          this.o.onBye(m.sid);
          break;
        case 'error':
          if (m.code === 'id-in-use') {
            this.setState('id-in-use');
          } else if (this.pending) {
            this.failPending(new Error(m.code || 'error'));
          }
          break;
        default:
          break;
      }
    }

    failPending(err) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(err);
    }

    send(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    }

    get ready() {
      return this.state === 'ready';
    }

    /** @returns {Promise<string>} session id */
    connectTo(hostId, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        if (!this.ready) return reject(new Error('signal-offline'));
        if (this.pending) return reject(new Error('busy'));
        const timer = setTimeout(() => this.pending && this.failPending(new Error('timeout')), timeoutMs);
        this.pending = { resolve, reject, timer };
        this.send({ t: 'connect', to: hostId });
      });
    }

    relay(sid, d) {
      this.send({ t: 'relay', sid, d });
    }

    bye(sid) {
      this.send({ t: 'bye', sid });
    }
  }

  root.StfSignaling = Signaling;
})(window);
