'use strict';

/**
 * Shared look of the drawing tools. Used by the viewer (own strokes) and by the host overlay (everyone's strokes),
 * so both always draw the same thing. Pure functions, no DOM.
 *
 *  pencil  thin, hard line                      (Bleistift)
 *  felt    medium, opaque, round                (Filzstift)
 *  marker  wide, see-through, flat ends         (Textmarker)
 *
 * Sizes are in "pixels of a 1920 px wide picture"; `scale` = actual surface width / 1920.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StfDrawStyle = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TOOLS = ['pencil', 'felt', 'marker'];
  const DEFAULTS = { tool: 'felt', color: '#f23f43', size: 8 };
  const MIN_SIZE = 1;
  const MAX_SIZE = 48;
  const HEX = /^#[0-9a-f]{6}$/i;

  function cleanColor(value, fallback = DEFAULTS.color) {
    return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback;
  }

  function cleanSize(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n * 10) / 10)) : DEFAULTS.size;
  }

  function cleanTool(value) {
    return TOOLS.includes(value) ? value : DEFAULTS.tool;
  }

  /** @returns {{ lineWidth: number, alpha: number, cap: 'round' | 'square' }} in device pixels */
  function penStyle(tool, size, scale) {
    const s = cleanSize(size);
    switch (cleanTool(tool)) {
      case 'pencil':
        return { lineWidth: Math.max(1.5, s * 0.45 * scale), alpha: 0.95, cap: 'round' };
      case 'marker':
        return { lineWidth: Math.max(5, s * 2.4 * scale), alpha: 0.4, cap: 'square' };
      default:
        return { lineWidth: Math.max(2.5, s * scale), alpha: 1, cap: 'round' };
    }
  }

  /** Black or white, whichever reads better on the given background colour. */
  function textOn(hex) {
    const c = cleanColor(hex);
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#111214' : '#ffffff';
  }

  /** Stable fallback colour for peers that send none (older clients). */
  function colorFromHue(h) {
    const hue = (((Number(h) || 0) % 360) + 360) % 360;
    const f = (n) => {
      const k = (n + hue / 30) % 12;
      const a = 0.95 * Math.min(0.6, 1 - 0.6);
      return Math.round(255 * (0.6 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }

  return { TOOLS, DEFAULTS, MIN_SIZE, MAX_SIZE, cleanColor, cleanSize, cleanTool, penStyle, textOn, colorFromHue };
});
