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
 *  2. FRAME-RATE FIRST LADDER: the bitrate ceiling maps to a resolution/FPS step. The ladder keeps
 *     60 FPS as long as possible and gives up resolution first (like Discord): 1080p60 -> 720p60 ->
 *     720p30 -> 540p30 -> 360p30 -> 360p15. Encoder overload ("cpu" limit) steps one step down for a
 *     while, then probes upwards again.
 *
 * Choosing a quality: every resolution (1080p, 720p, 540p, 360p) is available with 60, 30 or 15 FPS.
 *  - a CAP ("at most 1080p30") starts the ladder at that step and only goes down from there
 *  - a PINNED step is held, no automatic changes and no ping guard
 * Both the streamer and each viewer can set a cap; the lower one wins (per resolution and per frame rate).
 *
 * Pure logic, no browser APIs: it is unit-tested in Node (adaptive.test.js).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StfAdaptive = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const HEIGHTS = [1080, 720, 540, 360];
  const FPS = [60, 30, 15];
  // approximate bitrate a step needs to look good
  const MIN_BPS = {
    '1080x60': 8.0e6, '1080x30': 5.0e6, '1080x15': 3.0e6,
    '720x60': 4.0e6, '720x30': 2.2e6, '720x15': 1.2e6,
    '540x60': 2.4e6, '540x30': 1.2e6, '540x15': 0.7e6,
    '360x60': 1.2e6, '360x30': 0.6e6, '360x15': 0.2e6,
  };

  /** All 12 steps, keyed like "1080x60". */
  const PRESETS = {};
  for (const height of HEIGHTS) {
    for (const fps of FPS) PRESETS[`${height}x${fps}`] = { key: `${height}x${fps}`, name: `${height}p${fps}`, height, fps, minBps: MIN_BPS[`${height}x${fps}`] };
  }

  /** The automatic ladder without any cap (frame-rate first). */
  const TIERS = ['1080x60', '720x60', '720x30', '540x30', '360x30', '360x15'].map((k) => PRESETS[k]);

  function clampPreset(height, fps) {
    const h = HEIGHTS.find((x) => x <= height) || HEIGHTS[HEIGHTS.length - 1];
    const f = FPS.find((x) => x <= fps) || FPS[FPS.length - 1];
    return PRESETS[`${h}x${f}`];
  }

  /**
   * The ladder for a cap: the cap itself on top, then every step of the standard ladder that is lower
   * and still within the cap.
   * @returns {Array<{key,name,height,fps,minBps}>}
   */
  function ladderFor(capHeight = 1080, capFps = 60) {
    const top = clampPreset(capHeight, capFps);
    if (top.fps === 15) return HEIGHTS.filter((h) => h <= top.height).map((h) => PRESETS[`${h}x15`]); // 15 FPS: only resolution can give
    const ladder = [top];
    for (const t of TIERS) {
      if (t.height <= top.height && t.fps <= top.fps && t.minBps < top.minBps) ladder.push(t);
    }
    return ladder;
  }

  const DEFAULTS = {
    startBps: 5.0e6,
    hardMaxBps: 14e6,
    minBps: 0.25e6,
    headroom: 0.85, // use at most 85 % of what the congestion controller says is available
    tierFit: 0.92, // a step needs this share of its minimum bitrate available
    rttWindowMs: 60_000,
    bloatMinMs: 25, // inflation that counts as congestion (or 50 % of the base RTT, whichever is larger)
    cutFactor: 0.75,
    growFactor: 1.1,
    calmBeforeGrowMs: 6_000,
    upStableMs: 8_000, // minimum time between increases
    cpuSamples: 3,
    cpuLockMs: 30_000,
  };

  /** Old callers pass indices into the standard ladder; new ones pass heights / frame rates. */
  function capFromSample(sample) {
    let h = Number.isFinite(sample.maxHeight) ? sample.maxHeight : 1080;
    let f = Number.isFinite(sample.maxFps) ? sample.maxFps : 60;
    if (Number.isInteger(sample.maxTierIndex) && sample.maxTierIndex > 0) {
      const t = TIERS[Math.min(TIERS.length - 1, sample.maxTierIndex)];
      h = Math.min(h, t.height);
      f = Math.min(f, t.fps);
    }
    return [h, f];
  }

  function createController(options = {}) {
    const o = { ...DEFAULTS, ...options };
    const rtts = []; // { t, v }
    let cap = o.startBps;
    let tierKey = '720x30'; // start conservatively, then climb
    let lastTierChange = -Infinity;
    let calmSince = null;
    let badStreak = 0;
    let cpuStreak = 0;
    let cpuFloorKey = null;
    let cpuUntil = -Infinity;
    let lastCutAt = -Infinity;
    let lastIndex = 0;

    function baseRtt(now, current) {
      rtts.push({ t: now, v: current });
      while (rtts.length && now - rtts[0].t > o.rttWindowMs) rtts.shift();
      let min = Infinity;
      for (const r of rtts) if (r.v < min) min = r.v;
      return min;
    }

    /**
     * @param {{ availableBps?: number, sendBps?: number, rttMs?: number, qualityLimit?: string,
     *           maxHeight?: number, maxFps?: number, maxTierIndex?: number,
     *           forceHeight?: number, forceFps?: number, forceTierIndex?: number }} sample
     *   maxHeight / maxFps: limit asked for by the viewer or the streamer (the lower one of both is passed in)
     *   forceHeight + forceFps: the streamer pins one step; skips the automatic control
     *   maxTierIndex / forceTierIndex: older form, index into the standard ladder (TIERS)
     * @param {number} now milliseconds
     */
    function update(sample, now) {
      const [capH, capF] = capFromSample(sample);
      const ladder = ladderFor(capH, capF);

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
      let curIdx = ladder.findIndex((t) => t.key === tierKey);
      if (curIdx < 0) curIdx = 0; // the cap changed: start from its top
      if (cpuStreak >= o.cpuSamples) {
        cpuStreak = 0;
        cpuFloorKey = ladder[Math.min(ladder.length - 1, curIdx + 1)].key;
        cpuUntil = now + o.cpuLockMs;
        reason = 'encoder-load';
      }

      // --- fixed step chosen by the streamer: no automatic changes (and no ping guard); limits of viewers still apply ---
      let forceH = Number.isFinite(sample.forceHeight) ? sample.forceHeight : null;
      let forceF = Number.isFinite(sample.forceFps) ? sample.forceFps : null;
      if (forceH === null && Number.isInteger(sample.forceTierIndex) && sample.forceTierIndex >= 0) {
        const t = TIERS[Math.min(TIERS.length - 1, sample.forceTierIndex)];
        forceH = t.height;
        forceF = t.fps;
      }
      if (forceH !== null && forceF !== null) {
        const pinned = clampPreset(Math.min(forceH, capH), Math.min(forceF, capF));
        if (pinned.key !== tierKey) lastTierChange = now;
        tierKey = pinned.key;
        return {
          tierIndex: Math.max(0, ladder.findIndex((t) => t.key === pinned.key)),
          tier: pinned,
          maxBitrate: Math.round(Math.min(o.hardMaxBps, pinned.minBps * 1.8)),
          capBps: Math.round(cap),
          reason: 'fixed',
        };
      }

      // --- step from the bitrate ceiling -------------------------------------------------------
      let wanted = ladder.length - 1;
      for (let i = 0; i < ladder.length; i++) {
        if (cap * o.tierFit >= ladder[i].minBps) {
          wanted = i;
          break;
        }
      }
      if (now < cpuUntil && cpuFloorKey) {
        const floor = ladder.findIndex((t) => t.key === cpuFloorKey);
        if (floor >= 0) wanted = Math.max(wanted, floor);
      }

      let idx = curIdx;
      if (wanted > idx) {
        idx = wanted; // quality goes down immediately
        lastTierChange = now;
      } else if (wanted < idx && now - lastTierChange >= o.upStableMs) {
        idx -= 1; // ... and up one step at a time
        lastTierChange = now;
      }
      tierKey = ladder[idx].key;
      lastIndex = idx;

      const tier = ladder[idx];
      return {
        tierIndex: idx,
        tier,
        maxBitrate: Math.round(Math.min(cap, tier.minBps * 1.8)),
        capBps: Math.round(cap),
        reason,
      };
    }

    return {
      update,
      get capBps() { return cap; },
      get tierIndex() { return lastIndex; },
      get tier() { return PRESETS[tierKey]; },
    };
  }

  /** scaleResolutionDownBy for a capture of the given height so that it fits the step. */
  function scaleFor(sourceHeight, tier) {
    return sourceHeight > tier.height ? Math.round((sourceHeight / tier.height) * 100) / 100 : 1;
  }

  return { TIERS, PRESETS, HEIGHTS, FPS, DEFAULTS, createController, ladderFor, clampPreset, scaleFor };
});
