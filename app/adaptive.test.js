'use strict';

/** node adaptive.test.js – simulated network traces for the automatic quality controller. */

const assert = require('assert');
const { createController, TIERS, PRESETS, ladderFor, scaleFor } = require('./adaptive');

function run(name, fn) {
  fn();
  console.log('ok ', name);
}

/** feeds `seconds` of samples (1 per second) produced by gen(second) */
function simulate(ctl, startMs, seconds, gen) {
  let last;
  for (let s = 0; s < seconds; s++) last = ctl.update(gen(s), startMs + s * 1000);
  return last;
}

run('idle fast line climbs to 1080p60 and stays there', () => {
  const c = createController();
  const r = simulate(c, 0, 90, () => ({ availableBps: 30e6, rttMs: 18, qualityLimit: 'none' }));
  assert.strictEqual(r.tier.name, '1080p60');
  assert(r.maxBitrate >= 8e6);
});

run('game traffic fills the upload: RTT inflates -> bitrate and tier are cut quickly', () => {
  const c = createController();
  simulate(c, 0, 60, () => ({ availableBps: 30e6, rttMs: 18 }));
  assert.strictEqual(c.tierIndex, 0);
  const before = c.capBps;
  // 10 s of congestion: RTT jumps by +90 ms
  const r = simulate(c, 60_000, 10, () => ({ availableBps: 30e6, rttMs: 108 }));
  assert(r.capBps < before * 0.4, `cap should fall steeply (${before} -> ${r.capBps})`);
  assert(r.tierIndex >= 2, 'ladder must have stepped down to 30 FPS or lower');
});

run('after the congestion ends, quality recovers step by step back to 60 FPS', () => {
  const c = createController();
  simulate(c, 0, 60, () => ({ availableBps: 30e6, rttMs: 18 }));
  simulate(c, 60_000, 10, () => ({ availableBps: 30e6, rttMs: 108 }));
  const low = c.tierIndex;
  const mid = simulate(c, 70_000, 10, () => ({ availableBps: 30e6, rttMs: 18 }));
  assert(mid.tierIndex <= low, 'does not jump up immediately');
  const r = simulate(c, 80_000, 120, () => ({ availableBps: 30e6, rttMs: 18 }));
  assert.strictEqual(r.tier.name, '1080p60', 'recovers to full quality');
  assert(r.tier.fps === 60);
});

run('slow upload (3 Mbit/s available) settles on a 30 FPS tier and never exceeds what is available', () => {
  const c = createController();
  const r = simulate(c, 0, 120, () => ({ availableBps: 3e6, sendBps: 2.8e6, qualityLimit: 'bandwidth', rttMs: 25 }));
  assert(r.capBps <= 3e6 * 0.85 + 1, 'respects headroom');
  assert(r.tier.fps === 30, `expected a 30 FPS tier, got ${r.tier.name}`);
});

run('encoder overload (cpu limit) steps one tier down, then probes up again', () => {
  const c = createController();
  simulate(c, 0, 60, () => ({ availableBps: 30e6, rttMs: 18, qualityLimit: 'none' }));
  assert.strictEqual(c.tierIndex, 0);
  const r = simulate(c, 60_000, 6, () => ({ availableBps: 30e6, rttMs: 18, qualityLimit: 'cpu' }));
  assert(r.tierIndex >= 1, 'stepped down because the encoder cannot keep up');
  const later = simulate(c, 66_000, 90, () => ({ availableBps: 30e6, rttMs: 18, qualityLimit: 'none' }));
  assert.strictEqual(later.tierIndex, 0, 'probes upward after the lock expired');
});

run('quiet picture: a tiny bandwidth estimate (nothing is being sent) must not pin the quality to the bottom', () => {
  const c = createController();
  const r = simulate(c, 0, 120, () => ({ availableBps: 0.3e6, sendBps: 0.02e6, qualityLimit: 'none', rttMs: 18 }));
  assert.strictEqual(r.tier.name, '1080p60', 'the estimate is not a real limit while the encoder is not bandwidth-limited');
});

run('viewer asks for lower quality: the host never exceeds it', () => {
  const c = createController();
  const r = simulate(c, 0, 90, () => ({ availableBps: 30e6, rttMs: 18, maxTierIndex: 2 }));
  assert.strictEqual(r.tier.name, '720p30', 'the cap is the top of the ladder');
});

run('every resolution is available with 60, 30 and 15 FPS', () => {
  for (const h of [1080, 720, 540, 360]) {
    for (const f of [60, 30, 15]) assert.ok(PRESETS[`${h}x${f}`], `${h}p${f}`);
  }
  assert.strictEqual(Object.keys(PRESETS).length, 12);
});

run('a cap starts the ladder at that step and only goes down from there', () => {
  assert.deepStrictEqual(ladderFor(1080, 60).map((t) => t.name), ['1080p60', '720p60', '720p30', '540p30', '360p30', '360p15']);
  assert.deepStrictEqual(ladderFor(1080, 30).map((t) => t.name), ['1080p30', '720p30', '540p30', '360p30', '360p15']);
  assert.deepStrictEqual(ladderFor(1080, 15).map((t) => t.name), ['1080p15', '720p15', '540p15', '360p15']);
  assert.deepStrictEqual(ladderFor(720, 15).map((t) => t.name), ['720p15', '540p15', '360p15']);
  assert.deepStrictEqual(ladderFor(540, 60).map((t) => t.name), ['540p60', '540p30', '360p30', '360p15']);
  assert.deepStrictEqual(ladderFor(360, 60).map((t) => t.name), ['360p60', '360p30', '360p15']);
  for (const h of [1080, 720, 540, 360]) {
    for (const f of [60, 30, 15]) {
      const l = ladderFor(h, f);
      assert.strictEqual(l[0].key, `${h}x${f}`, 'the cap is on top');
      assert.ok(l.every((t) => t.height <= h && t.fps <= f), 'nothing above the cap');
    }
  }
});

run('with plenty of bandwidth each cap is reached and never exceeded', () => {
  for (const [h, f, expect] of [[1080, 30, '1080p30'], [1080, 15, '1080p15'], [720, 60, '720p60'], [720, 15, '720p15'], [540, 60, '540p60'], [360, 30, '360p30']]) {
    const c = createController();
    const r = simulate(c, 0, 120, () => ({ availableBps: 40e6, rttMs: 18, maxHeight: h, maxFps: f }));
    assert.strictEqual(r.tier.name, expect, `${h} / ${f}`);
  }
});

run('a cap that is lowered while streaming takes effect at once', () => {
  const c = createController();
  let r = simulate(c, 0, 90, () => ({ availableBps: 40e6, rttMs: 18 }));
  assert.strictEqual(r.tier.name, '1080p60');
  r = c.update({ availableBps: 40e6, rttMs: 18, maxHeight: 720, maxFps: 30 }, 91_000);
  assert.strictEqual(r.tier.name, '720p30');
});

run('a pinned step can be any resolution / frame rate and holds', () => {
  for (const [h, f] of [[1080, 15], [1080, 30], [720, 15], [540, 60], [360, 60]]) {
    const c = createController();
    let r;
    for (let s = 0; s < 30; s++) r = c.update({ availableBps: 0.5e6, rttMs: s < 5 ? 10 : 250, forceHeight: h, forceFps: f }, s * 1000);
    assert.strictEqual(r.tier.name, `${h}p${f}`);
    assert.strictEqual(r.reason, 'fixed');
  }
});

run('a pinned step is lowered by a viewer cap (per resolution and per frame rate)', () => {
  const c = createController();
  const r = c.update({ availableBps: 30e6, rttMs: 18, forceHeight: 1080, forceFps: 60, maxHeight: 720, maxFps: 30 }, 1000);
  assert.strictEqual(r.tier.name, '720p30');
});

run('streamer pins a tier: it stays put even when the ping guard would cut', () => {
  const c = createController();
  let last;
  for (let s = 0; s < 40; s++) last = c.update({ availableBps: 1e6, rttMs: s < 5 ? 10 : 200, forceTierIndex: 0 }, s * 1000);
  assert.strictEqual(last.tier.name, '1080p60');
  assert.strictEqual(last.reason, 'fixed');
});

run('pinned tier still respects the lower limit a viewer asks for', () => {
  const c = createController();
  const r = c.update({ availableBps: 30e6, rttMs: 18, forceTierIndex: 0, maxTierIndex: 3 }, 1000);
  assert.strictEqual(r.tier.name, '540p30');
});

run('scaleFor maps capture height to the tier', () => {
  assert.strictEqual(scaleFor(1080, TIERS[1]), 1.5);
  assert.strictEqual(scaleFor(720, TIERS[1]), 1);
  assert.strictEqual(scaleFor(540, TIERS[0]), 1);
});

console.log('\nall adaptive tests passed');
