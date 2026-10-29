'use strict';

/**
 * ID/password authentication primitives (Web Crypto; also runs in Node for tests).
 *
 * Nothing secret ever reaches the signaling server:
 *  - the password is stretched with PBKDF2-SHA256 (600 000 rounds, salt = host ID) into an HMAC key
 *  - host and viewer prove knowledge of that key with HMACs over fresh random nonces (mutual authentication)
 *  - a session key derived from both nonces authenticates the WebRTC SDP, so the server (or anyone on the
 *    path) cannot swap the DTLS fingerprints and read or alter the stream
 *
 * Generated passwords have 10 characters from a 32-letter alphabet (50 bits) – together with PBKDF2 this makes
 * offline guessing from a recorded handshake impractical. A streamer may pick his own (10-64 characters);
 * its strength is then up to him.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(globalThis.crypto);
  else root.StfAuth = factory(root.crypto);
})(typeof self !== 'undefined' ? self : this, function (webcrypto) {
  const subtle = webcrypto.subtle;
  const enc = new TextEncoder();
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  const PBKDF2_ROUNDS = 600_000;

  function b64(bytes) {
    let s = '';
    const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  }

  function unb64(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    return webcrypto.getRandomValues(new Uint8Array(n));
  }

  /** "K7M2Q-X9P4T" */
  function generatePassword() {
    const bytes = randomBytes(10);
    let s = '';
    for (let i = 0; i < 10; i++) {
      s += ALPHABET[bytes[i] % 32]; // 256 % 32 == 0 -> no modulo bias
      if (i === 4) s += '-';
    }
    return s;
  }

  const MIN_CUSTOM = 10;
  const MAX_CUSTOM = 64;

  /**
   * Canonical form of a password, identical on both sides.
   *  - generated style ("K7M2Q-X9P4T", typed in any case, with spaces or dashes) -> the 10 plain characters
   *  - a password the streamer chose himself (10-64 characters) -> exactly as typed (only trimmed)
   * Returns '' when the input cannot be a password.
   */
  function normalizePassword(input) {
    const raw = String(input || '').trim();
    const compact = raw.toUpperCase().replace(/[\s-]/g, '');
    if (compact.length === 10 && [...compact].every((ch) => ALPHABET.includes(ch))) return compact;
    return raw.length >= MIN_CUSTOM && raw.length <= MAX_CUSTOM ? raw : '';
  }

  /** Why a self-chosen password is not acceptable ('' = fine). */
  function customPasswordProblem(input) {
    const raw = String(input || '').trim();
    if (raw.length < MIN_CUSTOM) return `Mindestens ${MIN_CUSTOM} Zeichen.`;
    if (raw.length > MAX_CUSTOM) return `Höchstens ${MAX_CUSTOM} Zeichen.`;
    if (new Set(raw).size < 5) return 'Zu einfach – nutze mehr verschiedene Zeichen.';
    if (/^\d+$/.test(raw)) return 'Nur Ziffern sind zu leicht zu erraten.';
    return '';
  }

  function formatId(id) {
    return String(id).replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3');
  }

  function normalizeId(input) {
    const s = String(input || '').replace(/\D/g, '');
    return /^\d{9}$/.test(s) ? s : '';
  }

  /** @returns {Promise<CryptoKey>} HMAC key derived from the password; salt binds it to this host ID. */
  async function deriveKey(password, hostId) {
    const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`stf1:${hostId}`), iterations: PBKDF2_ROUNDS },
      base,
      256
    );
    return subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }

  async function mac(key, text) {
    return b64(await subtle.sign('HMAC', key, enc.encode(text)));
  }

  async function verify(key, text, macB64) {
    try {
      return await subtle.verify('HMAC', key, unb64(macB64), enc.encode(text));
    } catch {
      return false;
    }
  }

  /** Per-session key from the password key and both nonces; used to authenticate SDP and ICE. */
  async function sessionKey(baseKey, nonceHost, nonceViewer) {
    const raw = await subtle.sign('HMAC', baseKey, enc.encode(`K|${nonceHost}|${nonceViewer}`));
    return subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }

  return {
    ALPHABET,
    PBKDF2_ROUNDS,
    b64,
    unb64,
    randomBytes,
    generatePassword,
    normalizePassword,
    customPasswordProblem,
    formatId,
    normalizeId,
    deriveKey,
    mac,
    verify,
    sessionKey,
  };
});
