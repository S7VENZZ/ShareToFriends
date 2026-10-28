'use strict';

/**
 * Low-level keyboard hooks (WH_KEYBOARD_LL, Windows). Two modes share one native binding:
 *
 *  mode 'viewer' – swallow Windows-reserved shortcuts while remote control is engaged so they are
 *      sent to the remote PC instead of being executed locally. Browsers / Electron cannot do this:
 *      navigator.keyboard.lock() is rejected by Electron, and the Windows key / Alt+Tab never reach
 *      the page. Swallowed: Windows keys, Alt+Tab, Alt+Esc, Alt+F4, Ctrl+Esc. Only active while the
 *      ShareToFriends window is the foreground window.
 *
 *  mode 'kill' – the host's emergency stop. F12 cannot be registered as a global hotkey (Windows
 *      reserves it for debuggers), so a hook watches for a *physical* F12 press while a remote
 *      session is active. The key is swallowed (it does not reach the game) and reported once.
 *      Keys injected by software (including the remote controller itself) are ignored.
 *
 * Ctrl+Alt+Del and Win+L are handled by Windows before any hook and cannot be intercepted.
 */

const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
const WH_KEYBOARD_LL = 13;
const LLKHF_ALTDOWN = 0x20;
const LLKHF_INJECTED = 0x10;

const VK_TAB = 0x09;
const VK_ESCAPE = 0x1b;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;
const VK_F4 = 0x73;
const VK_F12 = 0x7b;
const VK_CONTROL = 0x11;

const CODE_FOR_VK = {
  [VK_LWIN]: 'MetaLeft',
  [VK_RWIN]: 'MetaRight',
  [VK_TAB]: 'Tab',
  [VK_ESCAPE]: 'Escape',
  [VK_F4]: 'F4',
};

/** Native bindings are created once; koffi type names must be unique per process. */
let native = null;
function loadNative() {
  if (native !== null) return native;
  native = false;
  if (process.platform !== 'win32') return native;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const Kbd = koffi.struct('KBDLLHOOKSTRUCT', {
      vkCode: 'uint32', scanCode: 'uint32', flags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
    });
    const Proto = koffi.proto('intptr __stdcall StfHookProc(int nCode, uintptr wParam, void *lParam)');
    native = {
      koffi,
      Kbd,
      Proto,
      setHook: user32.func('void *SetWindowsHookExW(int idHook, StfHookProc *lpfn, void *hmod, uint32 dwThreadId)'),
      unhook: user32.func('bool UnhookWindowsHookEx(void *hhk)'),
      next: user32.func('intptr CallNextHookEx(void *hhk, int nCode, uintptr wParam, void *lParam)'),
      foreground: user32.func('void *GetForegroundWindow()'),
      asyncKey: user32.func('int16 GetAsyncKeyState(int vk)'),
      moduleHandle: kernel32.func('void *GetModuleHandleW(const char16_t *name)'),
    };
  } catch (err) {
    console.error('Keyboard hook unavailable:', err.message);
  }
  return native;
}

class KeyHook {
  /**
   * @param {{ mode?: 'viewer' | 'kill',
   *           getWindow?: () => Electron.BrowserWindow | null,
   *           onKey: (ev: { type: 'down' | 'up', code: string }) => void }} deps
   */
  constructor({ mode = 'viewer', getWindow = () => null, onKey }) {
    this.mode = mode;
    this.getWindow = getWindow;
    this.onKey = onKey;
    this.hook = null;
    this.callback = null;
    this.swallowed = new Set(); // vk codes whose key-down we swallowed (their key-up must be swallowed too)
    // Test mode lets an automated test drive the hook with injected keys and without focus.
    this.testMode = process.env.STF_KEYHOOK_TEST === '1';
    this.supported = Boolean(loadNative());
  }

  get active() {
    return this.hook !== null;
  }

  enable() {
    const n = loadNative();
    if (!n || this.hook) return this.active;
    this.callback = n.koffi.register((nCode, wParam, lParam) => this._proc(nCode, wParam, lParam), n.koffi.pointer(n.Proto));
    this.hook = n.setHook(WH_KEYBOARD_LL, this.callback, n.moduleHandle(null), 0);
    if (!this.hook) {
      n.koffi.unregister(this.callback);
      this.callback = null;
      this.hook = null;
      return false;
    }
    return true;
  }

  disable() {
    const n = loadNative();
    if (!n || !this.hook) return;
    n.unhook(this.hook);
    n.koffi.unregister(this.callback);
    this.hook = null;
    this.callback = null;
    this.swallowed.clear();
  }

  _ourWindowIsForeground() {
    if (this.testMode) return true;
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return false;
    try {
      const n = loadNative();
      const handle = win.getNativeWindowHandle();
      const ours = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
      const fg = n.foreground();
      return fg !== null && BigInt(n.koffi.address(fg)) === ours;
    } catch {
      return false;
    }
  }

  _proc(nCode, wParam, lParam) {
    const n = native;
    // The result must be returned quickly: Windows drops hooks that block for too long.
    if (nCode < 0) return n.next(this.hook, nCode, wParam, lParam);
    try {
      const k = n.koffi.decode(lParam, n.Kbd);
      const down = Number(wParam) === WM_KEYDOWN || Number(wParam) === WM_SYSKEYDOWN;
      const injected = (k.flags & LLKHF_INJECTED) !== 0;
      if (this.mode === 'kill') {
        if (k.vkCode === VK_F12 && (!injected || this.testMode)) {
          if (down && !this.swallowed.has(VK_F12)) this.onKey({ type: 'down', code: 'F12' });
          if (down) this.swallowed.add(VK_F12);
          else this.swallowed.delete(VK_F12);
          return 1;
        }
      } else {
        const code = CODE_FOR_VK[k.vkCode];
        if (code && (!injected || this.testMode) && this._ourWindowIsForeground()) {
          let swallow = false;
          if (!down) {
            swallow = this.swallowed.delete(k.vkCode);
          } else if (k.vkCode === VK_LWIN || k.vkCode === VK_RWIN) {
            swallow = true;
          } else if ((k.flags & LLKHF_ALTDOWN) !== 0 && (k.vkCode === VK_TAB || k.vkCode === VK_ESCAPE || k.vkCode === VK_F4)) {
            swallow = true;
          } else if (k.vkCode === VK_ESCAPE && (n.asyncKey(VK_CONTROL) & 0x8000) !== 0) {
            swallow = true;
          }
          if (swallow) {
            if (down) this.swallowed.add(k.vkCode);
            this.onKey({ type: down ? 'down' : 'up', code });
            return 1;
          }
        }
      }
    } catch (err) {
      console.error('Keyboard hook error:', err.message);
    }
    return n.next(this.hook, nCode, wParam, lParam);
  }
}

module.exports = { KeyHook };
