'use strict';

/**
 * Update feed URL rules. Kept free of heavy imports so the main process can validate settings
 * without loading electron-updater.
 *
 *  - https:// only (http:// is accepted for loopback hosts, for local testing)
 *  - shorthand github:owner/repo -> https://github.com/owner/repo/releases/latest/download
 */

/** Where installed apps look for new versions unless the user sets another URL in the settings. */
const DEFAULT_UPDATE_SOURCE = 'github:jpdoering02-stack/ShareToFriends';

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

module.exports = { normalizeUpdateUrl, DEFAULT_UPDATE_SOURCE };
