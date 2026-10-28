'use strict';

/**
 * Peer-to-peer sessions (WebRTC).
 *
 *   HostPeer    one per connected viewer on the sharing PC: authenticates, then sends screen + audio
 *   ViewerPeer  on the watching PC: authenticates against the host, then receives the stream
 *
 * Handshake (all messages travel through the signaling server as opaque relay data):
 *   host   -> viewer  { k:'challenge', nH }
 *   viewer -> host    { k:'auth', nV, name, mac = HMAC(pwKey, "V|nH|nV|name") }
 *   host   -> viewer  { k:'auth-ok', mac = HMAC(pwKey, "H|nH|nV") }  |  { k:'auth-fail' }
 *   then  sessionKey = HMAC(pwKey, "K|nH|nV"); SDP offer/answer and ICE candidates carry
 *   MAC(sessionKey, ...) so that nobody in between can swap the DTLS fingerprints.
 *
 * Data channels: 'ctl' (reliable: control, clipboard, rights) and 'fast' (unreliable: mouse, laser, pen).
 */

(function (root) {
  const A = root.StfAuth;
  const AD = root.StfAdaptive;

  const AUTH_TIMEOUT_MS = 20_000;
  const CONNECT_TIMEOUT_MS = 25_000;

  /* ---------------------------------------------------------------- helpers */

  /** H.264 first (hardware where available), then VP8; the app has no codec setting. */
  function preferVideoCodecs(transceiver) {
    try {
      const caps = RTCRtpSender.getCapabilities('video').codecs;
      const h264 = caps.filter(
        (c) => c.mimeType === 'video/H264' && /packetization-mode=1/.test(c.sdpFmtpLine || '') && /profile-level-id=42/.test(c.sdpFmtpLine || '')
      );
      const vp8 = caps.filter((c) => c.mimeType === 'video/VP8');
      const rest = caps.filter((c) => !h264.includes(c) && !vp8.includes(c));
      transceiver.setCodecPreferences([...h264, ...vp8, ...rest]);
    } catch (err) {
      console.warn('codec preferences not applied', err);
    }
  }

  /** Stereo, 128 kbit/s Opus with in-band FEC for game/music audio. */
  function opusStereo(sdp) {
    const m = /a=rtpmap:(\d+) opus\/48000\/2/.exec(sdp);
    if (!m) return sdp;
    const pt = m[1];
    const extra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=128000;useinbandfec=1';
    const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
    if (re.test(sdp)) return sdp.replace(re, (all, params) => (params.includes('stereo=1') ? all : `a=fmtp:${pt} ${params};${extra}`));
    return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${extra}`);
  }

  function rtcConfig(iceServers) {
    return { iceServers, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 0 };
  }

  function cleanName(name) {
    // eslint-disable-next-line no-control-regex
    return String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32) || 'Unbekannt';
  }

  /** Common part of both peer types: data channels, ICE, authenticated signaling. */
  class PeerBase {
    constructor() {
      this.pc = null;
      this.ctl = null;
      this.fast = null;
      this.sessionKey = null;
      this.pendingIce = [];
      this.closed = false;
    }

    sendCtl(obj) {
      if (this.ctl && this.ctl.readyState === 'open') this.ctl.send(JSON.stringify(obj));
    }

    sendFast(obj) {
      if (this.fast && this.fast.readyState === 'open') this.fast.send(JSON.stringify(obj));
      else this.sendCtl(obj);
    }

    wireChannel(ch) {
      ch.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg && typeof msg === 'object') (ch.label === 'fast' ? this.hooks.onFast : this.hooks.onCtl)(msg);
      };
      ch.onopen = () => {
        if (ch.label === 'ctl') this.onCtlOpen && this.onCtlOpen();
      };
    }

    async signSdp(type, sdp) {
      return A.mac(this.sessionKey, `sdp|${type}|${sdp}`);
    }

    async acceptIce(d) {
      if (!this.sessionKey || typeof d.c !== 'string' || !(await A.verify(this.sessionKey, `ice|${d.c}`, d.mac))) return;
      const cand = JSON.parse(d.c);
      if (!this.pc || !this.pc.remoteDescription) this.pendingIce.push(cand);
      else await this.pc.addIceCandidate(cand).catch(() => {});
    }

    async flushIce() {
      for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
    }

    watchConnection(onFail) {
      this.pc.onconnectionstatechange = () => {
        const s = this.pc.connectionState;
        this.hooks.onState && this.hooks.onState(s);
        if (s === 'failed' || s === 'closed') onFail(s);
      };
    }

    wireIceOut() {
      this.pc.onicecandidate = async (ev) => {
        if (!ev.candidate || !this.sessionKey) return;
        const c = JSON.stringify(ev.candidate.toJSON());
        this.sig.relay(this.sid, { k: 'ice', c, mac: await A.mac(this.sessionKey, `ice|${c}`) });
      };
    }
  }

  /* ---------------------------------------------------------------- host side */

  class HostPeer extends PeerBase {
    /**
     * @param {{ sig, sid, hostId, getBaseKey: () => Promise<CryptoKey>, getIce: () => RTCIceServer[],
     *           getMedia: () => ({ stream: MediaStream, video: MediaStreamTrack, audio: MediaStreamTrack | null, height: number }),
     *           hooks: { onAuthOk, onAuthFail, onState, onCtl, onFast, onClosed, onOpen } }} o
     */
    constructor(o) {
      super();
      Object.assign(this, o);
      this.name = '';
      this.authed = false;
      this.nH = '';
      this.controller = AD.createController();
      this.viewerMaxTier = 0;
      this.videoSender = null;
      this.lastApplied = '';
      this.lastBytes = null;
      this.info = { tier: AD.TIERS[2], rttMs: null, bps: 0, fps: 0, width: 0, height: 0, path: '?', reason: 'start' };
      this.authTimer = setTimeout(() => !this.authed && this.close('auth-timeout'), AUTH_TIMEOUT_MS);
    }

    async start() {
      this.nH = A.b64(A.randomBytes(16));
      this.sig.relay(this.sid, { k: 'challenge', nH: this.nH });
    }

    async onRelay(d) {
      if (!d || typeof d !== 'object' || this.closed) return;
      if (d.k === 'auth' && !this.authed) return this.handleAuth(d);
      if (d.k === 'sdp' && this.authed) return this.handleAnswer(d);
      if (d.k === 'ice' && this.authed) return this.acceptIce(d);
    }

    async handleAuth(d) {
      if (typeof d.nV !== 'string' || typeof d.name !== 'string' || typeof d.mac !== 'string' || d.nV.length > 64 || d.name.length > 64) return;
      const base = await this.getBaseKey();
      if (!(await A.verify(base, `V|${this.nH}|${d.nV}|${d.name}`, d.mac))) {
        this.sig.relay(this.sid, { k: 'auth-fail' });
        this.hooks.onAuthFail(this);
        this.close('auth-fail', false);
        return;
      }
      this.authed = true;
      clearTimeout(this.authTimer);
      this.name = cleanName(d.name);
      this.sessionKey = await A.sessionKey(base, this.nH, d.nV);
      this.sig.relay(this.sid, { k: 'auth-ok', mac: await A.mac(base, `H|${this.nH}|${d.nV}`) });
      this.hooks.onAuthOk(this);
      await this.startRtc();
    }

    async startRtc() {
      const media = this.getMedia();
      if (!media || !media.video) {
        this.sig.relay(this.sid, { k: 'refuse', reason: 'not-sharing' });
        this.close('not-sharing', false);
        return;
      }
      const pc = new RTCPeerConnection(rtcConfig(this.getIce()));
      this.pc = pc;
      this.ctl = pc.createDataChannel('ctl', { ordered: true });
      this.fast = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
      this.wireChannel(this.ctl);
      this.wireChannel(this.fast);
      this.onCtlOpen = () => this.hooks.onOpen && this.hooks.onOpen(this);

      const vTrans = pc.addTransceiver(media.video, { direction: 'sendonly', streams: [media.stream] });
      this.videoSender = vTrans.sender;
      preferVideoCodecs(vTrans);
      if (media.audio) pc.addTransceiver(media.audio, { direction: 'sendonly', streams: [media.stream] });

      this.wireIceOut();
      this.watchConnection((s) => this.close(s === 'failed' ? 'ice-failed' : 'closed'));

      const offer = await pc.createOffer();
      const sdp = opusStereo(offer.sdp);
      await pc.setLocalDescription({ type: 'offer', sdp });
      this.sig.relay(this.sid, { k: 'sdp', type: 'offer', sdp, mac: await this.signSdp('offer', sdp) });
    }

    async handleAnswer(d) {
      if (d.type !== 'answer' || typeof d.sdp !== 'string' || !(await A.verify(this.sessionKey, `sdp|answer|${d.sdp}`, d.mac))) {
        this.close('bad-sdp');
        return;
      }
      await this.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
      await this.flushIce();
    }

    replaceVideo(track) {
      return this.videoSender ? this.videoSender.replaceTrack(track) : Promise.resolve();
    }

    /** One adaptive-control step (call once per second). */
    async tick(sourceHeight) {
      if (!this.pc || this.closed || !this.videoSender) return;
      let out = null;
      let pair = null;
      const cands = new Map();
      const report = await this.pc.getStats();
      report.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
        else if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
        else if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands.set(r.id, r);
      });
      if (!out) return;

      const now = Date.now();
      const rttMs = pair && Number.isFinite(pair.currentRoundTripTime) ? pair.currentRoundTripTime * 1000 : undefined;
      let sendBps = 0;
      if (this.lastBytes) sendBps = ((out.bytesSent - this.lastBytes.bytes) * 8 * 1000) / Math.max(1, out.timestamp - this.lastBytes.ts);
      const decision = this.controller.update(
        { availableBps: pair ? pair.availableOutgoingBitrate : undefined, sendBps, rttMs, qualityLimit: out.qualityLimitationReason, maxTierIndex: this.viewerMaxTier },
        now
      );

      const key = `${decision.tierIndex}:${Math.round(decision.maxBitrate / 250_000)}`;
      if (key !== this.lastApplied) {
        this.lastApplied = key;
        const params = this.videoSender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = decision.maxBitrate;
        params.encodings[0].maxFramerate = decision.tier.fps;
        params.encodings[0].scaleResolutionDownBy = AD.scaleFor(sourceHeight || 1080, decision.tier);
        try {
          params.degradationPreference = 'maintain-framerate';
        } catch {
          /* not supported */
        }
        await this.videoSender.setParameters(params).catch((err) => console.warn('setParameters failed', err));
      }

      let bps = 0;
      if (this.lastBytes) bps = ((out.bytesSent - this.lastBytes.bytes) * 8 * 1000) / Math.max(1, out.timestamp - this.lastBytes.ts);
      this.lastBytes = { bytes: out.bytesSent, ts: out.timestamp };
      const lc = pair && cands.get(pair.localCandidateId);
      const rc = pair && cands.get(pair.remoteCandidateId);
      this.info = {
        tier: decision.tier,
        reason: decision.reason,
        rttMs,
        bps,
        capBps: decision.capBps,
        fps: out.framesPerSecond || 0,
        width: out.frameWidth || 0,
        height: out.frameHeight || 0,
        limit: out.qualityLimitationReason,
        encoder: out.encoderImplementation || '',
        path: lc && rc ? (lc.candidateType === 'relay' || rc.candidateType === 'relay' ? 'relay' : 'direct') : '?',
      };
    }

    close(reason = 'closed', notify = true) {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.authTimer);
      if (notify) this.sig.bye(this.sid);
      try {
        this.pc && this.pc.close();
      } catch {
        /* ignore */
      }
      this.hooks.onClosed(this, reason);
    }
  }

  /* ---------------------------------------------------------------- viewer side */

  class ViewerPeer extends PeerBase {
    /**
     * @param {{ sig, hostId, password, name, getIce: () => RTCIceServer[],
     *           hooks: { onTrack, onCtl, onFast, onClosed, onState } }} o
     */
    constructor(o) {
      super();
      Object.assign(this, o);
      this.sid = null;
      this.waiting = null;
      this.stream = null;
      this.connected = false;
    }

    /** @returns {Promise<void>} resolves when media + control channel are up; rejects with Error(code). */
    async connect() {
      const key = await A.deriveKey(this.password, this.hostId);
      this.baseKey = key;
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (err) {
            this.close(err.message, false);
            reject(err);
          } else {
            resolve();
          }
        };
        const timer = setTimeout(() => finish(new Error('timeout')), CONNECT_TIMEOUT_MS);
        this.finish = finish;
        this.onCtlOpen = () => {
          this.connected = true;
          finish();
        };
        this.sig
          .connectTo(this.hostId)
          .then((sid) => {
            this.sid = sid;
          })
          .catch((err) => finish(err));
      });
    }

    async onRelay(d) {
      if (!d || typeof d !== 'object' || this.closed) return;
      try {
        if (d.k === 'challenge') return await this.handleChallenge(d);
        if (d.k === 'auth-ok') return await this.handleAuthOk(d);
        if (d.k === 'auth-fail') return this.finish && this.finish(new Error('wrong-password'));
        if (d.k === 'refuse') return this.finish && this.finish(new Error(d.reason || 'refused'));
        if (d.k === 'sdp') return await this.handleOffer(d);
        if (d.k === 'ice') return await this.acceptIce(d);
      } catch (err) {
        console.warn('viewer handshake error', err);
        this.finish && this.finish(new Error('handshake'));
      }
    }

    async handleChallenge(d) {
      if (typeof d.nH !== 'string' || d.nH.length > 64) return;
      this.nH = d.nH;
      this.nV = A.b64(A.randomBytes(16));
      const name = cleanName(this.name);
      this.sig.relay(this.sid, { k: 'auth', nV: this.nV, name, mac: await A.mac(this.baseKey, `V|${this.nH}|${this.nV}|${name}`) });
    }

    async handleAuthOk(d) {
      if (!this.nV || !(await A.verify(this.baseKey, `H|${this.nH}|${this.nV}`, d.mac))) {
        this.finish && this.finish(new Error('host-not-verified'));
        return;
      }
      this.sessionKey = await A.sessionKey(this.baseKey, this.nH, this.nV);
    }

    async handleOffer(d) {
      if (!this.sessionKey || d.type !== 'offer' || typeof d.sdp !== 'string' || !(await A.verify(this.sessionKey, `sdp|offer|${d.sdp}`, d.mac))) {
        this.finish && this.finish(new Error('bad-sdp'));
        return;
      }
      const pc = new RTCPeerConnection(rtcConfig(this.getIce()));
      this.pc = pc;
      this.wireIceOut();
      this.watchConnection((s) => this.close(s === 'failed' ? 'ice-failed' : 'closed'));
      pc.ondatachannel = (ev) => {
        if (ev.channel.label === 'ctl') this.ctl = ev.channel;
        else this.fast = ev.channel;
        this.wireChannel(ev.channel);
        if (ev.channel.label === 'ctl' && ev.channel.readyState === 'open') this.onCtlOpen();
      };
      pc.ontrack = (ev) => {
        const lowLatency = (receiver) => {
          try {
            if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
          } catch {
            /* ignore */
          }
        };
        lowLatency(ev.receiver);
        if (!this.stream) {
          this.stream = ev.streams[0] || new MediaStream();
          this.hooks.onTrack(this.stream);
        }
        if (!ev.streams[0]) this.stream.addTrack(ev.track);
      };
      await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      await this.flushIce();
      const answer = await pc.createAnswer();
      const sdp = opusStereo(answer.sdp);
      await pc.setLocalDescription({ type: 'answer', sdp });
      this.sig.relay(this.sid, { k: 'sdp', type: 'answer', sdp, mac: await this.signSdp('answer', sdp) });
    }

    /** Connection statistics for the viewer's overlay. */
    async stats(prev) {
      if (!this.pc) return null;
      let inbound = null;
      let pair = null;
      const cands = new Map();
      const report = await this.pc.getStats();
      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r;
        else if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
        else if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands.set(r.id, r);
      });
      if (!inbound) return null;
      let bps = 0;
      let fps = 0;
      let jitterBufferMs = 0;
      if (prev && inbound.timestamp > prev.timestamp) {
        const dt = (inbound.timestamp - prev.timestamp) / 1000;
        bps = ((inbound.bytesReceived - prev.bytesReceived) * 8) / dt;
        fps = (inbound.framesDecoded - prev.framesDecoded) / dt;
        const emitted = inbound.jitterBufferEmittedCount - prev.jitterBufferEmittedCount;
        if (emitted > 0) jitterBufferMs = ((inbound.jitterBufferDelay - prev.jitterBufferDelay) / emitted) * 1000;
      }
      const lc = pair && cands.get(pair.localCandidateId);
      const rc = pair && cands.get(pair.remoteCandidateId);
      return {
        raw: inbound,
        bps,
        fps,
        jitterBufferMs,
        width: inbound.frameWidth || 0,
        height: inbound.frameHeight || 0,
        dropped: inbound.framesDropped || 0,
        rttMs: pair && Number.isFinite(pair.currentRoundTripTime) ? pair.currentRoundTripTime * 1000 : null,
        path: lc && rc ? (lc.candidateType === 'relay' || rc.candidateType === 'relay' ? 'relay' : 'direct') : '?',
      };
    }

    close(reason = 'closed', notify = true) {
      if (this.closed) return;
      this.closed = true;
      if (notify && this.sid) this.sig.bye(this.sid);
      try {
        this.pc && this.pc.close();
      } catch {
        /* ignore */
      }
      this.hooks.onClosed(this, reason);
    }
  }

  root.StfP2P = { HostPeer, ViewerPeer, opusStereo, cleanName };
})(window);
