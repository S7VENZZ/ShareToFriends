'use strict';

/**
 * Update feed URL rules. Kept free of heavy imports so the main process can validate settings
 * without loading electron-updater.
 *
 *  - https:// only (http:// is accepted for loopback hosts, for local testing)
 *  - shorthand github:owner/repo -> https://github.com/owner/repo/releases/latest/download (still understood, no longer used by default)
 */

/** The signaling server every installation uses. Fixed: it cannot be changed or even seen in the app. */
const FIXED_SERVER_URL = 'wss://stf.s7venz.cloud/ws';

/**
 * Which signaling server to use. Installed (packaged) apps always use the fixed one; only an unpackaged
 * development checkout may point at a local server through STF_SERVER_URL (for the automated tests).
 */
function resolveServerUrl(isPackaged, envValue) {
  if (!isPackaged && typeof envValue === 'string' && /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/.test(envValue.trim())) return envValue.trim();
  return FIXED_SERVER_URL;
}

/** The update server of the project; used when the signaling server address does not give one. */
const DEFAULT_UPDATE_SOURCE = 'https://stf.s7venz.cloud/updates';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** @returns {string} normalised URL without trailing slash, or '' if empty. Throws on invalid input. */
function normalizeUpdateUrl(raw) {
  const str = typeof raw === 'string' ? raw.trim().slice(0, 300) : '';
  if (!str) return '';

  const gh = /^github:([\w.-]+)\/([\w.-]+)$/i.exec(str);
  if (gh) return `https://github.com/${gh[1]}/${gh[2]}/releases/latest/download`;

  let url;
  try {
    url = new URL(str);
  } catch {
    throw new Error(`Ungültige Update-URL: ${str}`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Die Update-URL muss mit https:// beginnen (http:// nur für localhost).');
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * Updates are served by the same server as the signaling: wss://stf.example.com/ws -> https://stf.example.com/updates.
 * @returns {string} '' when the address is not a wss:// URL
 */
function updateUrlFromServer(serverUrl) {
  try {
    const u = new URL(String(serverUrl || ''));
    if (u.protocol === 'wss:' && u.hostname) return `https://${u.host}/updates`;
  } catch {
    /* no server address yet */
  }
  return '';
}

module.exports = { normalizeUpdateUrl, updateUrlFromServer, resolveServerUrl, FIXED_SERVER_URL, DEFAULT_UPDATE_SOURCE };
