'use strict';

/* Renderer for the two small always-on-top windows: consent prompt and "Remote Access aktiv" banner. */

const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const name = params.get('name') || 'Unbekannt';

if (mode === 'prompt') {
  document.getElementById('prompt').classList.remove('hidden');
  document.getElementById('promptName').textContent = name;

  const countdown = document.getElementById('promptCountdown');
  let left = Number(params.get('timeout')) || 30;
  countdown.textContent = String(left);
  setInterval(() => {
    left = Math.max(0, left - 1);
    countdown.textContent = String(left);
  }, 1000);

  document.getElementById('btnAllow').addEventListener('click', () => window.stfRemoteUi.decide(true));
  document.getElementById('btnDeny').addEventListener('click', () => window.stfRemoteUi.decide(false));
} else if (mode === 'notice') {
  document.getElementById('notice').classList.remove('hidden');
  document.getElementById('noticeText').textContent = name;
} else if (mode === 'banner') {
  document.getElementById('banner').classList.remove('hidden');
  document.getElementById('bannerName').textContent = name;
  document.getElementById('btnEnd').addEventListener('click', () => window.stfRemoteUi.endNow());
}
