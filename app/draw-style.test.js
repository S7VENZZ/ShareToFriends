'use strict';

const assert = require('node:assert/strict');
const S = require('./draw-style');

function test(name, fn) {
  fn();
  console.log('ok  ' + name);
}

test('colours are validated', () => {
  assert.equal(S.cleanColor('#FFAA00'), '#ffaa00');
  assert.equal(S.cleanColor('red'), S.DEFAULTS.color);
  assert.equal(S.cleanColor('#12345'), S.DEFAULTS.color);
  assert.equal(S.cleanColor('url(javascript:1)'), S.DEFAULTS.color);
  assert.equal(S.cleanColor(undefined, '#000000'), '#000000');
});

test('sizes are clamped', () => {
  assert.equal(S.cleanSize(0), S.MIN_SIZE);
  assert.equal(S.cleanSize(9999), S.MAX_SIZE);
  assert.equal(S.cleanSize('abc'), S.DEFAULTS.size);
  assert.equal(S.cleanSize(12.34), 12.3);
});

test('unknown tools fall back to the felt-tip', () => {
  assert.equal(S.cleanTool('marker'), 'marker');
  assert.equal(S.cleanTool('laser'), 'felt');
});

test('the three pens look different', () => {
  const pencil = S.penStyle('pencil', 10, 1);
  const felt = S.penStyle('felt', 10, 1);
  const marker = S.penStyle('marker', 10, 1);
  assert.ok(pencil.lineWidth < felt.lineWidth && felt.lineWidth < marker.lineWidth);
  assert.equal(felt.alpha, 1);
  assert.ok(marker.alpha < 0.5, 'marker is see-through');
  assert.equal(marker.cap, 'square');
});

test('lines scale with the picture and never vanish', () => {
  assert.ok(S.penStyle('felt', 8, 2).lineWidth > S.penStyle('felt', 8, 1).lineWidth);
  assert.ok(S.penStyle('pencil', 1, 0.1).lineWidth >= 1.5);
});

test('label text colour contrasts with the background', () => {
  assert.equal(S.textOn('#ffffff'), '#111214');
  assert.equal(S.textOn('#000000'), '#ffffff');
  assert.equal(S.textOn('#f23f43'), '#ffffff');
  assert.equal(S.textOn('#ffe14d'), '#111214');
});

test('hue fallback gives a valid colour', () => {
  for (const h of [0, 120, 200, 359, 720, -40, NaN]) assert.match(S.colorFromHue(h), /^#[0-9a-f]{6}$/);
});

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('picture transforms are validated', () => {
  const t = S.cleanTransform({ x: 'a', y: 9, w: 0, rot: 7, cl: 0.7, cr: 0.7, ct: -1, cb: 2 });
  assert.equal(t.x, 0.5);
  assert.equal(t.y, 1.5);
  assert.equal(t.w, 0.02);
  assert.ok(t.rot >= -Math.PI && t.rot <= Math.PI);
  assert.ok(t.cl + t.cr <= 0.9 + 1e-9, 'at least 10 % stays visible');
  assert.equal(t.ct, 0);
  assert.equal(t.cb, 0.9);
  assert.deepEqual(S.cleanTransform(null), { x: 0.5, y: 0.5, w: 0.3, rot: 0, cl: 0, ct: 0, cr: 0, cb: 0 });
});

test('geometry keeps the picture aspect ratio, also when cropped', () => {
  const nat = { w: 800, h: 400 };
  const g = S.imageGeometry({ x: 0.5, y: 0.5, w: 0.5, rot: 0, cl: 0, ct: 0, cr: 0, cb: 0 }, nat, 1000, 600);
  near(g.pw, 500);
  near(g.ph, 250);
  const c = S.imageGeometry({ x: 0.5, y: 0.5, w: 0.5, rot: 0, cl: 0.25, ct: 0, cr: 0.25, cb: 0 }, nat, 1000, 600);
  near(c.sw, 400);
  near(c.pw / c.ph, 400 / 400);
});

test('toImageSpace is the inverse of the picture placement, also rotated', () => {
  const nat = { w: 400, h: 300 };
  const t = S.cleanTransform({ x: 0.4, y: 0.6, w: 0.3, rot: 0.7 });
  const g = S.imageGeometry(t, nat, 1000, 800);
  const centre = S.toImageSpace(g, g.cx, g.cy);
  near(centre.u, 0.5);
  near(centre.v, 0.5);
  // the top-right corner of the displayed picture
  const cos = Math.cos(g.rot);
  const sin = Math.sin(g.rot);
  const cornerX = g.cx + (g.pw / 2) * cos - (-g.ph / 2) * sin;
  const cornerY = g.cy + (g.pw / 2) * sin + (-g.ph / 2) * cos;
  const corner = S.toImageSpace(g, cornerX, cornerY);
  near(corner.u, 1);
  near(corner.v, 0);
});

test('cropping keeps the kept part where it is, at the same size', () => {
  const nat = { w: 400, h: 300 };
  const W = 1000;
  const H = 800;
  for (const rot of [0, 0.6, -1.2]) {
    const t = S.cleanTransform({ x: 0.5, y: 0.5, w: 0.4, rot });
    const g = S.imageGeometry(t, nat, W, H);
    const n = S.cropTo(t, nat, 0.25, 0.1, 0.75, 0.6, W, H);
    const g2 = S.imageGeometry(n, nat, W, H);
    near(g2.pw, g.pw * 0.5, 1e-6);
    near(g2.ph, g.ph * 0.5, 1e-6);
    // the point that was the centre of the selection is now the picture's centre
    const was = S.toImageSpace(g, g2.cx, g2.cy);
    near(was.u, 0.5, 1e-6);
    near(was.v, 0.35, 1e-6);
    // corner of the selection stays on the same screen position
    const cosA = Math.cos(rot);
    const sinA = Math.sin(rot);
    const selTL = { x: g.cx + (0.25 - 0.5) * g.pw * cosA - (0.1 - 0.5) * g.ph * sinA, y: g.cy + (0.25 - 0.5) * g.pw * sinA + (0.1 - 0.5) * g.ph * cosA };
    const nowTL = { x: g2.cx + (-g2.pw / 2) * cosA - (-g2.ph / 2) * sinA, y: g2.cy + (-g2.pw / 2) * sinA + (-g2.ph / 2) * cosA };
    near(nowTL.x, selTL.x, 1e-6);
    near(nowTL.y, selTL.y, 1e-6);
  }
});

test('cropping twice accumulates, tiny selections are ignored', () => {
  const nat = { w: 400, h: 300 };
  const t = S.cleanTransform({ x: 0.5, y: 0.5, w: 0.4 });
  const once = S.cropTo(t, nat, 0, 0, 0.5, 1, 1000, 800);
  near(once.cr, 0.5);
  const twice = S.cropTo(once, nat, 0, 0, 0.5, 1, 1000, 800);
  near(twice.cr, 0.75);
  assert.equal(S.cropTo(t, nat, 0.5, 0.5, 0.52, 0.52, 1000, 800), t);
});

test('crop edges can be dragged back out (uncrop), but never beyond the original picture', () => {
  const nat = { w: 400, h: 300 };
  const W = 1000;
  const H = 800;
  const t0 = S.cleanTransform({ x: 0.5, y: 0.5, w: 0.4, rot: 0.4 });
  const cropped = S.cropTo(t0, nat, 0.5, 0, 1, 1, W, H); // left half cut away
  near(cropped.cl, 0.5);
  // drag the left edge back out by one full displayed width: restores the original picture exactly
  const back = S.cropTo(cropped, nat, -1, 0, 1, 1, W, H, { expand: true });
  near(back.cl, 0, 1e-9);
  near(back.w, t0.w, 1e-9);
  near(back.x, t0.x, 1e-9);
  near(back.y, t0.y, 1e-9);
  // dragging further out does not go past the original
  const more = S.cropTo(cropped, nat, -5, 0, 1, 1, W, H, { expand: true });
  near(more.cl, 0, 1e-9);
  // without the expand option the edge stops at the current border (old behaviour)
  const stay = S.cropTo(cropped, nat, -1, 0, 1, 1, W, H);
  near(stay.cl, 0.5, 1e-9);
});

test('a single edge: only that side changes', () => {
  const nat = { w: 400, h: 300 };
  const t0 = S.cleanTransform({ x: 0.5, y: 0.5, w: 0.4 });
  const n = S.cropTo(t0, nat, 0, 0, 1, 0.6, 1000, 800, { expand: true }); // bottom edge up to 60 %
  near(n.cb, 0.4);
  near(n.cl, 0);
  near(n.cr, 0);
  near(n.ct, 0);
});

console.log('\nall draw-style tests passed');
