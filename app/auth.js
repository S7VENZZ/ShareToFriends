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
 * Passwords have 10 characters from a 32-letter alphabet (50 bits) – together with PBKDF2 this makes
 * offline guessing from a recorded handshake impractical.
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

  /** Accepts input as typed: lowercase, spaces, dashes. Returns the canonical 10 characters or ''. */
  function normalizePassword(input) {
    const s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length !== 10) return '';
    for (const ch of s) if (!ALPHABET.includes(ch)) return '';
    return s;
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
    formatId,
    normalizeId,
    deriveKey,
    mac,
    verify,
    sessionKey,
  };
});
