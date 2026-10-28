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

console.log('\nall draw-style tests passed');
