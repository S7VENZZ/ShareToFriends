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
 *
 * Pictures a viewer puts on the streamer's screen are described by a transform
 *   { x, y, w, rot, cl, ct, cr, cb }
 *  x, y = centre and w = displayed width, all as fractions of the streamed surface; rot in radians;
 *  cl/ct/cr/cb = how much of the picture is cropped away on each side (fractions of the original).
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

  /* ---------------------------- pictures ---------------------------- */

  const MAX_CROP = 0.9; // at least 10 % of each axis stays visible
  const clampNum = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

  function cleanTransform(t) {
    const src = t && typeof t === 'object' ? t : {};
    let cl = clampNum(src.cl, 0, MAX_CROP, 0);
    let cr = clampNum(src.cr, 0, MAX_CROP, 0);
    let ct = clampNum(src.ct, 0, MAX_CROP, 0);
    let cb = clampNum(src.cb, 0, MAX_CROP, 0);
    if (cl + cr > MAX_CROP) cr = Math.max(0, MAX_CROP - cl);
    if (ct + cb > MAX_CROP) cb = Math.max(0, MAX_CROP - ct);
    const TWO_PI = Math.PI * 2;
    const rotIn = Number.isFinite(src.rot) ? src.rot : 0;
    const rot = ((((rotIn + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
    return { x: clampNum(src.x, -0.5, 1.5, 0.5), y: clampNum(src.y, -0.5, 1.5, 0.5), w: clampNum(src.w, 0.02, 3, 0.3), rot, cl, ct, cr, cb };
  }

  /**
   * Where a picture sits on a surface of W x H pixels.
   * @param {{ w: number, h: number }} nat natural size of the picture
   * @returns {{ cx: number, cy: number, pw: number, ph: number, rot: number, sx: number, sy: number, sw: number, sh: number }}
   *   centre, displayed size and the source rectangle (cropped part) of the picture
   */
  function imageGeometry(t, nat, W, H) {
    const sw = nat.w * (1 - t.cl - t.cr);
    const sh = nat.h * (1 - t.ct - t.cb);
    const pw = t.w * W;
    return { cx: t.x * W, cy: t.y * H, pw, ph: pw / (sw / sh), rot: t.rot, sx: nat.w * t.cl, sy: nat.h * t.ct, sw, sh };
  }

  /** Surface point -> position inside the displayed picture: u, v in 0..1 (outside = beyond the picture). */
  function toImageSpace(g, px, py) {
    const dx = px - g.cx;
    const dy = py - g.cy;
    const c = Math.cos(-g.rot);
    const s = Math.sin(-g.rot);
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    return { u: lx / g.pw + 0.5, v: ly / g.ph + 0.5, lx, ly };
  }

  /**
   * Crop the displayed picture to the rectangle u0..u1 x v0..v1 (0..1 of what is shown now). The kept part stays
   * exactly where it is on screen and keeps its scale.
   */
  function cropTo(t, nat, u0, v0, u1, v1, W, H, opts) {
    const fw = 1 - t.cl - t.cr;
    const fh = 1 - t.ct - t.cb;
    // with { expand: true } an edge can also move outwards again, back to the uncropped picture
    const lo = opts && opts.expand ? [-t.cl / fw, -t.cr / fw, -t.ct / fh, -t.cb / fh] : [0, 0, 0, 0];
    const a = Math.min(u0, u1);
    const b = Math.max(u0, u1);
    const c = Math.min(v0, v1);
    const d = Math.max(v0, v1);
    const ua = clampNum(a, lo[0], 1, 0);
    const ub = clampNum(b, 0, 1 - lo[1], 1);
    const va = clampNum(c, lo[2], 1, 0);
    const vb = clampNum(d, 0, 1 - lo[3], 1);
    if (ub - ua < 0.05 || vb - va < 0.05) return t; // too small to be intended
    const g = imageGeometry(t, nat, W, H);
    const next = {
      ...t,
      cl: t.cl + ua * fw,
      cr: t.cr + (1 - ub) * fw,
      ct: t.ct + va * fh,
      cb: t.cb + (1 - vb) * fh,
      w: t.w * (ub - ua),
    };
    // the kept part's centre, in the old picture's local pixels, rotated back to the surface
    const ox = ((ua + ub) / 2 - 0.5) * g.pw;
    const oy = ((va + vb) / 2 - 0.5) * g.ph;
    const cs = Math.cos(g.rot);
    const sn = Math.sin(g.rot);
    next.x = (g.cx + ox * cs - oy * sn) / W;
    next.y = (g.cy + ox * sn + oy * cs) / H;
    return cleanTransform(next);
  }

  return { TOOLS, DEFAULTS, MIN_SIZE, MAX_SIZE, cleanColor, cleanSize, cleanTool, penStyle, textOn, colorFromHue, cleanTransform, imageGeometry, toImageSpace, cropTo };
});
