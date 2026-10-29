'use strict';

/**
 * Host-side drawing overlay renderer. The animation loop only runs while something is visible.
 *
 *  cursor         the viewer's mouse pointer: a normal white arrow in the standard size, with a small name tag
 *  pen (temp)     strokes that fade away a few seconds after the last point
 *  pen (perm)     strokes that stay until the viewer clears them or the host presses "Desktop leeren"
 *  pictures       images a viewer put on the screen; he can move, scale, rotate and crop them
 *  clear          removes the strokes and pictures of one viewer
 *  clearall       removes everything (host button)
 *
 * Event: { k, id, n, c, w, t, x, y, s, perm } with x/y in 0..1 inside the streamed surface,
 * c = colour (#rrggbb), w = size, t = pencil | felt | marker.
 * Picture events: imgdata { i, mime, data }, imgt { i, x, y, w, rot, cl, ct, cr, cb }, imgdel { i }.
 */

const Style = window.StfDrawStyle;
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

const CURSOR_VISIBLE_MS = 2600; // the viewer's app refreshes the position about once a second while the tool is on
const TEMP_HOLD_MS = 4500;
const TEMP_FADE_MS = 1500;
// Windows' standard arrow, 12 x 19 px at 100 % scaling, tip at (0, 0)
const ARROW = [[0, 0], [0, 16.5], [4.2, 12.6], [7.1, 19.2], [9.7, 18], [6.9, 11.7], [12.2, 11.7]];

const cursors = new Map(); // viewer id -> { x, y, n, last }
const strokes = new Map(); // viewer id + ':' + stroke id -> { pts, c, w, t, last, perm }
const pictures = new Map(); // viewer id + ':' + picture id -> { img, loaded, t }
let running = false;
let width = 0;
let height = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (w !== width || h !== height) {
    width = w;
    height = h;
    canvas.width = w;
    canvas.height = h;
  }
}

function drawStroke(s, alpha) {
  const scale = width / 1920;
  const look = Style.penStyle(s.t, s.w, scale);
  ctx.globalAlpha = alpha * look.alpha;
  ctx.strokeStyle = s.c;
  ctx.lineWidth = look.lineWidth * (s.perm ? 1.1 : 1);
  ctx.lineCap = look.cap;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  s.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0] * width, p[1] * height) : ctx.lineTo(p[0] * width, p[1] * height)));
  if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * width + 0.1, s.pts[0][1] * height);
  ctx.stroke();
}

function drawPicture(p) {
  if (!p.loaded || !p.t) return;
  const g = Style.imageGeometry(p.t, { w: p.img.naturalWidth, h: p.img.naturalHeight }, width, height);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.translate(g.cx, g.cy);
  ctx.rotate(g.rot);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(p.img, g.sx, g.sy, g.sw, g.sh, -g.pw / 2, -g.ph / 2, g.pw, g.ph);
  ctx.restore();
}

function drawCursor(l) {
  const k = window.devicePixelRatio || 1; // standard cursor size = the Windows scaling of this screen
  const x = l.x * width;
  const y = l.y * height;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.beginPath();
  ARROW.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000000';
  ctx.stroke();
  ctx.restore();

  if (l.n) {
    const fs = 12 * k;
    ctx.font = `600 ${fs}px "Segoe UI", sans-serif`;
    const tw = ctx.measureText(l.n).width;
    const bx = x + 13 * k;
    const by = y + 18 * k;
    ctx.fillStyle = 'rgba(17, 18, 20, 0.85)';
    ctx.beginPath();
    ctx.roundRect(bx, by, tw + 12 * k, fs + 8 * k, 6 * k);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(l.n, bx + 6 * k, by + fs + 0.5 * k);
  }
}

function frame(now) {
  resize();
  ctx.clearRect(0, 0, width, height);
  let active = false;

  for (const p of pictures.values()) drawPicture(p);

  for (const [key, s] of strokes) {
    let alpha = 1;
    if (!s.perm) {
      const age = now - s.last;
      if (age > TEMP_HOLD_MS + TEMP_FADE_MS) {
        strokes.delete(key);
        continue;
      }
      alpha = age <= TEMP_HOLD_MS ? 1 : 1 - (age - TEMP_HOLD_MS) / TEMP_FADE_MS;
      active = true;
    }
    drawStroke(s, alpha);
  }

  for (const [id, l] of cursors) {
    if (now - l.last > CURSOR_VISIBLE_MS) {
      cursors.delete(id);
      continue;
    }
    active = true;
    drawCursor(l);
  }

  ctx.globalAlpha = 1;
  // Permanent strokes and pictures are static: draw them once, then stop the loop until something changes.
  if (active) requestAnimationFrame(frame);
  else running = false;
}

function kick() {
  if (running) return;
  running = true;
  requestAnimationFrame(frame);
}

function dropViewer(id) {
  for (const key of [...strokes.keys()]) if (key.startsWith(`${id}:`)) strokes.delete(key);
  for (const key of [...pictures.keys()]) if (key.startsWith(`${id}:`)) pictures.delete(key);
  cursors.delete(id);
}

window.stfDraw.onEvent((ev) => {
  const now = performance.now();
  if (ev.k === 'cursor') {
    cursors.set(ev.id, { x: ev.x, y: ev.y, n: ev.n, last: now });
  } else if (ev.k === 'pen') {
    const key = `${ev.id}:${ev.s}`;
    let s = strokes.get(key);
    if (!s) {
      s = { pts: [], c: Style.cleanColor(ev.c, Style.colorFromHue(ev.h)), w: Style.cleanSize(ev.w), t: Style.cleanTool(ev.t), last: now, perm: ev.perm === true };
      strokes.set(key, s);
    }
    if (s.pts.length < 4000) s.pts.push([ev.x, ev.y]);
    s.last = now;
  } else if (ev.k === 'imgdata') {
    const key = `${ev.id}:${ev.i}`;
    const prev = pictures.get(key);
    const img = new Image();
    const p = { img, loaded: false, t: prev ? prev.t : null };
    img.onload = () => {
      p.loaded = true;
      kick();
    };
    img.src = `data:${ev.mime};base64,${ev.data}`;
    pictures.set(key, p);
  } else if (ev.k === 'imgt') {
    const key = `${ev.id}:${ev.i}`;
    let p = pictures.get(key);
    if (!p) {
      p = { img: new Image(), loaded: false, t: null };
      pictures.set(key, p);
    }
    p.t = Style.cleanTransform(ev);
  } else if (ev.k === 'imgdel') {
    pictures.delete(`${ev.id}:${ev.i}`);
  } else if (ev.k === 'off') {
    cursors.delete(ev.id);
  } else if (ev.k === 'clear') {
    dropViewer(ev.id);
  } else if (ev.k === 'clearall') {
    strokes.clear();
    cursors.clear();
    pictures.clear();
  }
  kick();
});
