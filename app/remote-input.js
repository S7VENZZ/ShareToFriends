'use strict';

/**
 * Native input injection for the remote-control feature (Windows, via user32!SendInput and koffi).
 *
 * Keyboard events are injected as hardware *scan codes* (layout independent, understood by games
 * and DirectInput applications). The Windows key and the context-menu key use virtual keys because
 * they are not reliably delivered as scan codes.
 *
 * Limits imposed by Windows (not by this app):
 *  - Ctrl+Alt+Del and Win+L are handled by the OS and cannot be injected.
 *  - Windows running with higher integrity (UAC prompts, apps "as administrator") ignore input from
 *    a non-elevated process (UIPI). Start ShareToFriends as administrator to control those, too.
 */

const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_XDOWN = 0x0080;
const MOUSEEVENTF_XUP = 0x0100;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

/** KeyboardEvent.code -> { sc: scan code, ext: extended (E0) flag } or { vk, ext } */
const KEYS = {
  Escape: { sc: 0x01 },
  Digit1: { sc: 0x02 }, Digit2: { sc: 0x03 }, Digit3: { sc: 0x04 }, Digit4: { sc: 0x05 },
  Digit5: { sc: 0x06 }, Digit6: { sc: 0x07 }, Digit7: { sc: 0x08 }, Digit8: { sc: 0x09 },
  Digit9: { sc: 0x0a }, Digit0: { sc: 0x0b },
  Minus: { sc: 0x0c }, Equal: { sc: 0x0d }, Backspace: { sc: 0x0e }, Tab: { sc: 0x0f },
  KeyQ: { sc: 0x10 }, KeyW: { sc: 0x11 }, KeyE: { sc: 0x12 }, KeyR: { sc: 0x13 }, KeyT: { sc: 0x14 },
  KeyY: { sc: 0x15 }, KeyU: { sc: 0x16 }, KeyI: { sc: 0x17 }, KeyO: { sc: 0x18 }, KeyP: { sc: 0x19 },
  BracketLeft: { sc: 0x1a }, BracketRight: { sc: 0x1b }, Enter: { sc: 0x1c }, ControlLeft: { sc: 0x1d },
  KeyA: { sc: 0x1e }, KeyS: { sc: 0x1f }, KeyD: { sc: 0x20 }, KeyF: { sc: 0x21 }, KeyG: { sc: 0x22 },
  KeyH: { sc: 0x23 }, KeyJ: { sc: 0x24 }, KeyK: { sc: 0x25 }, KeyL: { sc: 0x26 },
  Semicolon: { sc: 0x27 }, Quote: { sc: 0x28 }, Backquote: { sc: 0x29 }, ShiftLeft: { sc: 0x2a },
  Backslash: { sc: 0x2b },
  KeyZ: { sc: 0x2c }, KeyX: { sc: 0x2d }, KeyC: { sc: 0x2e }, KeyV: { sc: 0x2f }, KeyB: { sc: 0x30 },
  KeyN: { sc: 0x31 }, KeyM: { sc: 0x32 },
  Comma: { sc: 0x33 }, Period: { sc: 0x34 }, Slash: { sc: 0x35 }, ShiftRight: { sc: 0x36 },
  NumpadMultiply: { sc: 0x37 }, AltLeft: { sc: 0x38 }, Space: { sc: 0x39 }, CapsLock: { sc: 0x3a },
  F1: { sc: 0x3b }, F2: { sc: 0x3c }, F3: { sc: 0x3d }, F4: { sc: 0x3e }, F5: { sc: 0x3f },
  F6: { sc: 0x40 }, F7: { sc: 0x41 }, F8: { sc: 0x42 }, F9: { sc: 0x43 }, F10: { sc: 0x44 },
  NumLock: { sc: 0x45 }, ScrollLock: { sc: 0x46 },
  Numpad7: { sc: 0x47 }, Numpad8: { sc: 0x48 }, Numpad9: { sc: 0x49 }, NumpadSubtract: { sc: 0x4a },
  Numpad4: { sc: 0x4b }, Numpad5: { sc: 0x4c }, Numpad6: { sc: 0x4d }, NumpadAdd: { sc: 0x4e },
  Numpad1: { sc: 0x4f }, Numpad2: { sc: 0x50 }, Numpad3: { sc: 0x51 }, Numpad0: { sc: 0x52 },
  NumpadDecimal: { sc: 0x53 }, IntlBackslash: { sc: 0x56 }, F11: { sc: 0x57 }, F12: { sc: 0x58 },
  // Extended (E0-prefixed) keys
  NumpadEnter: { sc: 0x1c, ext: true }, ControlRight: { sc: 0x1d, ext: true },
  NumpadDivide: { sc: 0x35, ext: true }, PrintScreen: { sc: 0x37, ext: true },
  AltRight: { sc: 0x38, ext: true }, Home: { sc: 0x47, ext: true }, ArrowUp: { sc: 0x48, ext: true },
  PageUp: { sc: 0x49, ext: true }, ArrowLeft: { sc: 0x4b, ext: true }, ArrowRight: { sc: 0x4d, ext: true },
  End: { sc: 0x4f, ext: true }, ArrowDown: { sc: 0x50, ext: true }, PageDown: { sc: 0x51, ext: true },
  Insert: { sc: 0x52, ext: true }, Delete: { sc: 0x53, ext: true },
  // Keys sent as virtual keys
  MetaLeft: { vk: 0x5b, ext: true }, MetaRight: { vk: 0x5c, ext: true },
  ContextMenu: { vk: 0x5d, ext: true }, Pause: { vk: 0x13 },
};

const MOUSE_BUTTONS = {
  0: { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP, data: 0 },
  1: { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP, data: 0 },
  2: { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP, data: 0 },
  3: { down: MOUSEEVENTF_XDOWN, up: MOUSEEVENTF_XUP, data: 1 }, // XBUTTON1 (back)
  4: { down: MOUSEEVENTF_XDOWN, up: MOUSEEVENTF_XUP, data: 2 }, // XBUTTON2 (forward)
};

class RemoteInput {
  constructor() {
    this.supported = false;
    this.downKeys = new Set();
    this.downButtons = new Set();
    this.failures = 0;

    if (process.platform !== 'win32') return;
    try {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');

      const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
        dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
      });
      const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
        wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
      });
      const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT });
      const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });
      const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });

      this._inputSize = koffi.sizeof(INPUT);
      this._sendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
      this._getSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
      this._getWindowRect = user32.func('bool __stdcall GetWindowRect(intptr hWnd, _Out_ RECT *lpRect)');
      this._isWindow = user32.func('bool __stdcall IsWindow(intptr hWnd)');
      this._isIconic = user32.func('bool __stdcall IsIconic(intptr hWnd)');
      this._getClipboardSeq = user32.func('uint32 __stdcall GetClipboardSequenceNumber()');
      this._RECT = RECT;

      // Window-lock helpers
      const STF_POINT = koffi.struct('STF_POINT', { x: 'int32', y: 'int32' });
      this._windowFromPoint = user32.func('intptr __stdcall WindowFromPoint(STF_POINT pt)');
      this._getAncestor = user32.func('intptr __stdcall GetAncestor(intptr hwnd, uint32 flags)');
      this._getWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)');
      this._getForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()');
      this._setForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr hwnd)');
      this._showWindow = user32.func('bool __stdcall ShowWindow(intptr hwnd, int cmd)');
      this.supported = true;
    } catch (err) {
      console.error('Remote input unavailable:', err.message);
    }
  }

  /** Process id that owns a window (0 if unknown). */
  windowPid(hwnd) {
    if (!this.supported || !hwnd) return 0;
    const out = [0];
    this._getWindowThreadProcessId(hwnd, out);
    return out[0] >>> 0;
  }

  /** Process id of the top-level window under a physical screen point (0 if none). */
  pidAtPoint(px, py) {
    if (!this.supported) return 0;
    const hwnd = this._windowFromPoint({ x: Math.round(px), y: Math.round(py) });
    if (!hwnd) return 0;
    const root = this._getAncestor(hwnd, 2) || hwnd; // GA_ROOT
    return this.windowPid(root);
  }

  /** Process id of the foreground window (0 if none). */
  foregroundPid() {
    return this.supported ? this.windowPid(this._getForegroundWindow()) : 0;
  }

  /** Restore (if minimised) and bring a window to the front. Best effort. */
  focusWindow(hwnd) {
    if (!this.supported || !hwnd) return false;
    if (this._isIconic(hwnd)) this._showWindow(hwnd, 9); // SW_RESTORE
    return this._setForegroundWindow(hwnd);
  }

  /** Windows clipboard change counter (cheap change detection), or null. */
  clipboardSequence() {
    return this.supported ? this._getClipboardSeq() : null;
  }

  /** Window rectangle in physical screen pixels, or null if the window is gone/minimised. */
  windowRect(hwnd) {
    if (!this.supported || !Number.isSafeInteger(hwnd) || hwnd <= 0) return null;
    if (!this._isWindow(hwnd) || this._isIconic(hwnd)) return null;
    const rect = {};
    if (!this._getWindowRect(hwnd, rect)) return null;
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    return width > 0 && height > 0 ? { x: rect.left, y: rect.top, width, height } : null;
  }

  _send(input) {
    const sent = this._sendInput(1, [input], this._inputSize);
    if (sent === 1) {
      this.failures = 0;
      return true;
    }
    this.failures += 1;
    return false;
  }

  /** Move the cursor to physical screen pixel coordinates (multi-monitor aware). */
  moveTo(px, py) {
    if (!this.supported) return false;
    const vx = this._getSystemMetrics(SM_XVIRTUALSCREEN);
    const vy = this._getSystemMetrics(SM_YVIRTUALSCREEN);
    const vw = this._getSystemMetrics(SM_CXVIRTUALSCREEN);
    const vh = this._getSystemMetrics(SM_CYVIRTUALSCREEN);
    if (vw < 2 || vh < 2) return false;
    const ax = Math.round(((px - vx) * 65535) / (vw - 1));
    const ay = Math.round(((py - vy) * 65535) / (vh - 1));
    return this._send({
      type: INPUT_MOUSE,
      u: {
        mi: {
          dx: Math.min(65535, Math.max(0, ax)),
          dy: Math.min(65535, Math.max(0, ay)),
          mouseData: 0,
          dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
          time: 0,
          dwExtraInfo: 0,
        },
      },
    });
  }

  button(button, down) {
    const def = MOUSE_BUTTONS[button];
    if (!this.supported || !def) return false;
    if (down) this.downButtons.add(button);
    else this.downButtons.delete(button);
    return this._send({
      type: INPUT_MOUSE,
      u: { mi: { dx: 0, dy: 0, mouseData: def.data, dwFlags: down ? def.down : def.up, time: 0, dwExtraInfo: 0 } },
    });
  }

  /** deltaX / deltaY in "notches" (1 = one wheel click). Positive deltaY scrolls down. */
  wheel(deltaX, deltaY) {
    if (!this.supported) return false;
    let ok = true;
    const send = (flags, amount) => {
      // mouseData is a DWORD that carries a signed value.
      const data = Math.round(amount * 120) >>> 0;
      ok = this._send({
        type: INPUT_MOUSE,
        u: { mi: { dx: 0, dy: 0, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
      }) && ok;
    };
    if (deltaY) send(MOUSEEVENTF_WHEEL, -deltaY);
    if (deltaX) send(MOUSEEVENTF_HWHEEL, deltaX);
    return ok;
  }

  static isKnownKey(code) {
    return Object.prototype.hasOwnProperty.call(KEYS, code);
  }

  key(code, down) {
    if (!this.supported || !RemoteInput.isKnownKey(code)) return false;
    const def = KEYS[code];
    if (down) this.downKeys.add(code);
    else this.downKeys.delete(code);

    let flags = down ? 0 : KEYEVENTF_KEYUP;
    if (def.ext) flags |= KEYEVENTF_EXTENDEDKEY;
    let wVk = 0;
    let wScan = 0;
    if (def.vk) {
      wVk = def.vk;
    } else {
      wScan = def.sc;
      flags |= KEYEVENTF_SCANCODE;
    }
    return this._send({
      type: INPUT_KEYBOARD,
      u: { ki: { wVk, wScan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    });
  }

  /** Release every key and button that is still held down (called when access ends). */
  releaseAll() {
    for (const code of [...this.downKeys]) this.key(code, false);
    for (const button of [...this.downButtons]) this.button(button, false);
    this.downKeys.clear();
    this.downButtons.clear();
  }
}

module.exports = { RemoteInput };
