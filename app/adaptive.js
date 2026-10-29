'use strict';

/**
 * Fully automatic quality control – there are no bitrate or codec settings in the app.
 *
 * WebRTC's own congestion control (Google Congestion Control, delay-based) already runs inside the
 * browser and reports `availableOutgoingBitrate`. This controller sits on top of it and adds two things
 * a screen-sharing game streamer needs:
 *
 *  1. PING GUARD (bufferbloat): when the stream fills the home router's upload queue, the round-trip time
 *     rises – and so does the game's ping. The controller watches RTT relative to the lowest RTT seen
 *     recently; if it inflates, the bitrate ceiling is cut by 25 % within seconds, and is raised again
 *     slowly (+10 % per second) only after the line has been calm for a while.
 *  2. FRAME-RATE FIRST LADDER: the bitrate ceiling maps to a resolution/FPS tier. The ladder keeps
 *     60 FPS as long as possible and gives up resolution first (like Discord): 1080p60 -> 720p60 ->
 *     720p30 -> 540p30 -> 360p30 -> 360p15. Encoder overload ("cpu" limit) steps one tier down for a
 *     while, then probes upwards again.
 *
 * Pure logic, no browser APIs: it is unit-tested in Node (adaptive.test.js).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StfAdaptive = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TIERS = [
    { name: '1080p60', height: 1080, fps: 60, minBps: 8.0e6 },
    { name: '720p60', height: 720, fps: 60, minBps: 4.0e6 },
    { name: '720p30', height: 720, fps: 30, minBps: 2.2e6 },
    { name: '540p30', height: 540, fps: 30, minBps: 1.2e6 },
    { name: '360p30', height: 360, fps: 30, minBps: 0.6e6 },
    { name: '360p15', height: 360, fps: 15, minBps: 0.2e6 },
  ];

  const DEFAULTS = {
    startBps: 5.0e6,
    hardMaxBps: 14e6,
    minBps: 0.25e6,
    headroom: 0.85, // use at most 85 % of what the congestion controller says is available
    tierFit: 0.92, // a tier needs this share of its minimum bitrate available
    rttWindowMs: 60_000,
    bloatMinMs: 25, // inflation that counts as congestion (or 50 % of the base RTT, whichever is larger)
    cutFactor: 0.75,
    growFactor: 1.1,
    calmBeforeGrowMs: 6_000,
    upStableMs: 8_000, // minimum time between tier increases
    cpuSamples: 3,
    cpuLockMs: 30_000,
  };

  function createController(options = {}) {
    const o = { ...DEFAULTS, ...options };
    const rtts = []; // { t, v }
    let cap = o.startBps;
    let tierIndex = 2; // start conservatively (720p30), then climb
    let lastTierChange = -Infinity;
    let calmSince = null;
    let badStreak = 0;
    let cpuStreak = 0;
    let cpuFloor = 0;
    let cpuUntil = -Infinity;
    let lastCutAt = -Infinity;

    function baseRtt(now, current) {
      rtts.push({ t: now, v: current });
      while (rtts.length && now - rtts[0].t > o.rttWindowMs) rtts.shift();
      let min = Infinity;
      for (const r of rtts) if (r.v < min) min = r.v;
      return min;
    }

    /**
     * @param {{ availableBps?: number, rttMs?: number, qualityLimit?: string, maxTierIndex?: number }} sample
     *   maxTierIndex: quality limit asked for by the viewer or the streamer (higher index = lower quality), 0 = no limit
     *   forceTierIndex: the streamer pins one tier (0 = 1080p60 ...); skips the automatic control
     * @param {number} now milliseconds
     */
    function update(sample, now) {
      const available = Number.isFinite(sample.availableBps) && sample.availableBps > 0 ? sample.availableBps : null;
      // WebRTC only raises its estimate while we actually send data. With a quiet picture the estimate stays
      // tiny without being a real limit, so it only counts when the encoder is held back by bandwidth or we
      // already use most of it.
      const sending = Number.isFinite(sample.sendBps) ? sample.sendBps : 0;
      const estimateBinds = available !== null && (sample.qualityLimit === 'bandwidth' || sending >= available * 0.6);
      const ceiling = Math.min(o.hardMaxBps, estimateBinds ? available * o.headroom : o.hardMaxBps);
      let reason = 'stable';

      // --- ping guard -------------------------------------------------------------------------
      if (Number.isFinite(sample.rttMs) && sample.rttMs > 0) {
        const base = baseRtt(now, sample.rttMs);
        const bloat = sample.rttMs - base;
        const threshold = Math.max(o.bloatMinMs, base * 0.5);
        if (bloat > threshold) {
          badStreak++;
          calmSince = null;
          if (badStreak >= 2 && now - lastCutAt >= 1500) {
            cap = Math.max(o.minBps, cap * o.cutFactor);
            lastCutAt = now;
            badStreak = 0;
            reason = 'ping-guard';
          }
        } else {
          badStreak = 0;
          if (bloat < threshold * 0.4) {
            if (calmSince === null) calmSince = now;
            if (now - calmSince >= o.calmBeforeGrowMs) cap = Math.min(ceiling, cap * o.growFactor);
          } else {
            calmSince = null;
          }
        }
      }
      if (cap > ceiling) {
        cap = Math.max(o.minBps, ceiling);
        reason = reason === 'stable' ? 'bandwidth' : reason;
      }

      // --- encoder overload -------------------------------------------------------------------
      if (sample.qualityLimit === 'cpu') cpuStreak++;
      else cpuStreak = 0;
      if (cpuStreak >= o.cpuSamples) {
        cpuStreak = 0;
        cpuFloor = Math.min(TIERS.length - 1, tierIndex + 1);
        cpuUntil = now + o.cpuLockMs;
        reason = 'encoder-load';
      }

      // --- fixed quality chosen by the streamer: no automatic steps (and no ping guard), viewer limits still apply ---
      if (Number.isInteger(sample.forceTierIndex) && sample.forceTierIndex >= 0) {
        const forced = Math.max(Math.min(TIERS.length - 1, sample.forceTierIndex), Math.min(TIERS.length - 1, sample.maxTierIndex || 0));
        if (forced !== tierIndex) lastTierChange = now;
        tierIndex = forced;
        const t = TIERS[forced];
        return { tierIndex, tier: t, maxBitrate: Math.round(Math.min(o.hardMaxBps, t.minBps * 1.8)), capBps: Math.round(cap), reason: 'fixed' };
      }

      // --- tier from the bitrate ceiling -------------------------------------------------------
      let wanted = TIERS.length - 1;
      for (let i = 0; i < TIERS.length; i++) {
        if (cap * o.tierFit >= TIERS[i].minBps) {
          wanted = i;
          break;
        }
      }
      if (now < cpuUntil) wanted = Math.max(wanted, cpuFloor);
      wanted = Math.max(wanted, Math.min(TIERS.length - 1, sample.maxTierIndex || 0));

      if (wanted > tierIndex) {
        tierIndex = wanted; // quality goes down immediately
        lastTierChange = now;
      } else if (wanted < tierIndex && now - lastTierChange >= o.upStableMs) {
        tierIndex -= 1; // ... and up one step at a time
        lastTierChange = now;
      }

      const tier = TIERS[tierIndex];
      return {
        tierIndex,
        tier,
        maxBitrate: Math.round(Math.min(cap, tier.minBps * 1.8)),
        capBps: Math.round(cap),
        reason,
      };
    }

    return { update, get capBps() { return cap; }, get tierIndex() { return tierIndex; } };
  }

  /** scaleResolutionDownBy for a capture of the given height so that it fits the tier. */
  function scaleFor(sourceHeight, tier) {
    return sourceHeight > tier.height ? Math.round((sourceHeight / tier.height) * 100) / 100 : 1;
  }

  return { TIERS, DEFAULTS, createController, scaleFor };
});
