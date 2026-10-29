'use strict';

/**
 * ShareToFriends – renderer.
 *
 *  1 helpers & state          6 host: peers, input, drawing, remote control
 *  2 sidebar (ID, password)   7 viewer: connect, stream bar, drawing, remote control
 *  3 signaling routing        8 shared clipboard
 *  4 source picker            9 auto-update UI
 *  5 audio mixer & apps      10 settings & bootstrap
 *
 * The app has no bitrate, codec, microphone or camera settings: quality is controlled automatically
 * (adaptive.js on top of WebRTC congestion control), audio is application sound only.
 */

(() => {
  const stf = window.stf;
  const A = window.StfAuth;
  const AD = window.StfAdaptive;
  const { HostPeer, ViewerPeer } = window.StfP2P;

  const $ = (id) => document.getElementById(id);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const afterPaint = (fn, delay = 0) => requestAnimationFrame(() => setTimeout(fn, delay));

  /* ================================================================== */
  /* 1. helpers & state                                                  */
  /* ================================================================== */

  const state = {
    settings: null,
    prefs: {},
    info: null,
    myId: '',
    password: '', // canonical form (see auth.js); kept until the streamer renews it
    passwordCustom: false, // true = chosen by the streamer himself
    persist: false, // OS encryption available -> password and friends survive a restart
    friends: [], // [{ id, name, pw, last }] saved connections (viewer side)
    ice: [],
    sig: null,
  };

  function toast(message, kind = '', ms = 5000) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 260);
    }, ms);
  }

  let prefsTimer = null;
  function setPref(key, value) {
    state.prefs[key] = value;
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => stf.savePrefs(state.prefs).catch(() => {}), 400);
  }

  function hueFor(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  const formatBps = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbit/s` : `${Math.round(bps / 1e3)} kbit/s`);
  const errText = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function isBusy() {
    return host.peers.size > 0 || Boolean(viewer.peer && viewer.peer.connected);
  }

  /* ================================================================== */
  /* 2. sidebar                                                          */
  /* ================================================================== */

  function renderIdentity() {
    $('myId').textContent = A.formatId(state.myId);
    $('myPw').textContent = !state.password ? '–' : state.passwordCustom ? state.password : `${state.password.slice(0, 5)}-${state.password.slice(5)}`;
    $('pwHint').textContent = state.persist ? (state.passwordCustom ? 'Dein eigenes Passwort – bleibt gespeichert.' : 'Bleibt gespeichert, bis du ein neues erzeugst (↻) oder eigenes festlegst (✎).') : 'Wird bei jedem Start neu erzeugt.';
    const name = state.settings.displayName || 'Unbenannt';
    $('userName').textContent = name;
    $('userAvatar').textContent = name.slice(0, 1).toUpperCase();
    $('userAvatar').style.background = `hsl(${hueFor(state.myId)} 55% 45%)`;
  }

  function renderHostChip() {
    const chip = $('hostChip');
    chip.classList.remove('live', 'ready');
    let text;
    if (host.active) {
      chip.classList.add('live');
      text = host.peers.size === 0 ? 'Du teilst – wartet auf Zuschauer' : `Du teilst – ${host.peers.size} ${host.peers.size === 1 ? 'Zuschauer' : 'Zuschauer'}`;
    } else if (state.sig && state.sig.ready) {
      chip.classList.add('ready');
      text = 'Bereit – Freunde können sich nach dem Teilen verbinden';
    } else {
      text = 'Nicht mit dem Server verbunden';
    }
    $('hostChipText').textContent = text;
    $('userSub').textContent = state.sig && state.sig.ready ? 'Online' : 'Offline';
  }

  function renderNet(sigState, detail) {
    const dot = $('netDot');
    dot.className = 'net-dot';
    let label;
    switch (sigState) {
      case 'ready': dot.classList.add('on'); label = 'Server verbunden'; break;
      case 'connecting': dot.classList.add('wait'); label = detail && detail.attempt ? `Verbinde … (${detail.attempt})` : 'Verbinde …'; break;
      case 'offline': dot.classList.add('wait'); label = 'Server nicht erreichbar – neuer Versuch …'; break;
      case 'id-in-use': dot.classList.add('off'); label = 'ID bereits aktiv (läuft die App zweimal?)'; break;
      case 'unconfigured': dot.classList.add('off'); label = 'Kein Server eingestellt'; break;
      default: label = '…';
    }
    $('netLabel').textContent = label;
    renderHostChip();
    updateConnectButton();
  }

  function updateConnectButton() {
    const ok = Boolean(A.normalizeId($('peerId').value)) && Boolean(A.normalizePassword($('peerPw').value)) && state.sig && state.sig.ready;
    $('btnConnect').disabled = !ok || viewer.connecting || Boolean(viewer.peer);
  }

  async function copyText(text, what) {
    await stf.clipboardWrite({ text });
    toast(`${what} kopiert.`, 'ok', 2000);
  }

  /** The host password stays until the streamer renews it (↻) or sets his own (✎): friends can save it. */
  function setHostPassword(pw, custom) {
    state.password = pw;
    state.passwordCustom = custom;
    host.baseKey = A.deriveKey(pw, state.myId);
    host.failures = [];
    host.lockUntil = 0;
    setPref('pwCustom', custom);
    renderIdentity();
    if (state.persist) stf.secretSet('hostPassword', pw).catch(() => {});
  }

  function newPassword(reason) {
    setHostPassword(A.normalizePassword(A.generatePassword()), false);
    if (reason) toast(reason, '', 6000);
  }

  async function initHostPassword() {
    try {
      state.persist = await stf.secretAvailable();
    } catch {
      state.persist = false;
    }
    const saved = state.persist ? await stf.secretGet('hostPassword').catch(() => null) : null;
    const pw = saved ? A.normalizePassword(saved) : '';
    if (pw) setHostPassword(pw, state.prefs.pwCustom === true);
    else newPassword();
  }

  function openPasswordDialog() {
    $('pwInput').value = '';
    checkPasswordInput();
    $('pwDialog').showModal();
    $('pwInput').focus();
  }

  function checkPasswordInput() {
    const text = $('pwInput').value;
    const problem = text ? A.customPasswordProblem(text) : '';
    $('pwProblem').textContent = problem || (text ? 'Passt.' : 'Mindestens 10 Zeichen.');
    $('pwProblem').classList.toggle('bad', Boolean(problem));
    $('btnPwSave').disabled = !text || Boolean(problem);
  }

  function bindPasswordDialog() {
    $('btnEditPw').addEventListener('click', openPasswordDialog);
    $('pwInput').addEventListener('input', checkPasswordInput);
    $('btnPwCancel').addEventListener('click', () => $('pwDialog').close());
    $('btnPwRandom').addEventListener('click', () => {
      $('pwInput').value = A.generatePassword();
      checkPasswordInput();
    });
    $('pwForm').addEventListener('submit', () => {
      const pw = A.normalizePassword($('pwInput').value);
      if (!pw || A.customPasswordProblem($('pwInput').value)) return;
      // a typed generated-style password is simply a generated password
      setHostPassword(pw, !/^[A-HJ-NP-Z2-9]{10}$/.test(pw));
      toast('Dein Passwort wurde festgelegt. Freunde können es speichern und sich damit jedes Mal anmelden.', 'ok', 5000);
    });
  }

  /* ---- saved friends (viewer side) ---- */

  function timeAgo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'gerade eben';
    const m = Math.floor(s / 60);
    if (m < 60) return `vor ${m} Min.`;
    const h = Math.floor(m / 60);
    if (h < 24) return `vor ${h} Std.`;
    const d = Math.floor(h / 24);
    return d === 1 ? 'gestern' : `vor ${d} Tagen`;
  }

  async function loadFriends() {
    if (!state.persist) return;
    try {
      const list = JSON.parse((await stf.secretGet('friends')) || '[]');
      state.friends = (Array.isArray(list) ? list : [])
        .filter((f) => f && A.normalizeId(f.id) && A.normalizePassword(f.pw))
        .map((f) => ({ id: A.normalizeId(f.id), name: String(f.name || '').slice(0, 32), pw: A.normalizePassword(f.pw), last: Number(f.last) || 0 }))
        .sort((a, b) => b.last - a.last)
        .slice(0, 20);
    } catch {
      state.friends = [];
    }
  }

  function saveFriends() {
    state.friends.sort((a, b) => b.last - a.last);
    state.friends = state.friends.slice(0, 20);
    if (state.persist) stf.secretSet('friends', JSON.stringify(state.friends)).catch(() => {});
    renderFriends();
  }

  /** Called after a successful connection (and again when the friend's name arrives). */
  function rememberFriend(hostId, password, name) {
    if (!state.persist || !hostId || !password) return;
    const existing = state.friends.find((f) => f.id === hostId);
    if (!existing && !$('chkRemember').checked) return;
    if (existing) {
      existing.pw = password;
      existing.last = Date.now();
      if (name) existing.name = name.slice(0, 32);
    } else {
      state.friends.push({ id: hostId, name: (name || '').slice(0, 32), pw: password, last: Date.now() });
    }
    saveFriends();
  }

  function renderFriends() {
    const card = $('friendsCard');
    const list = $('friendsList');
    list.replaceChildren();
    card.classList.toggle('hidden', !state.persist || state.friends.length === 0);
    const locked = Boolean(viewer.peer || viewer.connecting);
    for (const f of state.friends) {
      const row = document.createElement('div');
      row.className = 'friend-row';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.title = locked ? 'Du bist gerade verbunden' : `Mit ${f.name || A.formatId(f.id)} verbinden`;
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = (f.name || '#').slice(0, 1).toUpperCase();
      av.style.background = `hsl(${hueFor(f.id)} 55% 45%)`;
      const meta = document.createElement('span');
      meta.style.minWidth = '0';
      const nm = document.createElement('div');
      nm.className = 'name';
      nm.textContent = f.name || A.formatId(f.id);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${A.formatId(f.id)} · ${timeAgo(f.last)}`;
      meta.append(nm, sub);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'friend-remove';
      rm.textContent = '×';
      rm.title = 'Aus der Liste entfernen';
      rm.setAttribute('aria-label', `${f.name || A.formatId(f.id)} entfernen`);
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        state.friends = state.friends.filter((x) => x.id !== f.id);
        saveFriends();
      });
      const go = () => !locked && connectSaved(f);
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      });
      row.append(av, meta, rm);
      list.appendChild(row);
    }
  }

  async function connectSaved(f) {
    if (viewer.peer || viewer.connecting || !state.sig || !state.sig.ready) {
      toast('Du bist noch nicht mit dem Server verbunden.', 'error', 3000);
      return;
    }
    $('connectError').classList.add('hidden');
    viewer.creds = { hostId: f.id, password: f.pw };
    viewer.fromSaved = true;
    viewer.leaving = false;
    await openViewerSession(false);
  }

  function bindSidebar() {
    $('btnCopyId').addEventListener('click', () => copyText(state.myId, 'ID'));
    $('btnCopyPw').addEventListener('click', () => copyText($('myPw').textContent, 'Passwort'));
    $('btnNewPw').addEventListener('click', () => newPassword('Neues zufälliges Passwort erzeugt. Gespeicherte Passwörter deiner Freunde passen nicht mehr. Bestehende Verbindungen bleiben bestehen.'));
    bindPasswordDialog();
    $('btnFocusConnect').addEventListener('click', () => $('peerId').focus());
    $('peerId').addEventListener('input', (e) => {
      const digits = e.target.value.replace(/\D/g, '').slice(0, 9);
      e.target.value = digits.replace(/(\d{3})(?=\d)/g, '$1 ');
      updateConnectButton();
    });
    $('peerPw').addEventListener('input', updateConnectButton);
    $('chkRemember').addEventListener('change', () => setPref('rememberPw', $('chkRemember').checked));
    for (const id of ['peerId', 'peerPw']) {
      $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !$('btnConnect').disabled) connectToFriend();
      });
    }
    $('btnConnect').addEventListener('click', connectToFriend);
  }

  /* ================================================================== */
  /* 3. signaling routing                                                */
  /* ================================================================== */

  function startSignaling() {
    state.sig = new window.StfSignaling({
      getUrl: () => state.settings.serverUrl,
      id: state.myId,
      onState: renderNet,
      onIce: (servers) => {
        state.ice = servers;
      },
      onIncoming: (sid) => onIncoming(sid),
      onRelay: (sid, d) => {
        const hp = host.peers.get(sid);
        if (hp) hp.onRelay(d);
        else if (viewer.peer && viewer.peer.sid === sid) viewer.peer.onRelay(d);
      },
      onBye: (sid) => {
        const hp = host.peers.get(sid);
        if (hp) hp.close('bye', false);
        else if (viewer.peer && viewer.peer.sid === sid) viewer.peer.close('host-left', false);
      },
    });
    state.sig.start();
  }

  /* ================================================================== */
  /* 4. source picker                                                    */
  /* ================================================================== */

  const picker = {
    mode: 'start', // start | switch
    type: 'screen',
    sources: { screen: [], window: [] },
    loaded: { screen: false, window: false },
    selected: null,
    busy: false,
  };

  async function refreshPicker(withThumbs = true) {
    if (picker.busy) return;
    picker.busy = true;
    const type = picker.type;
    try {
      if (type === 'screen') {
        picker.sources.screen = await stf.listSources({ types: ['screen'], thumbs: true, width: 256, height: 144 });
        picker.loaded.screen = true;
        renderPicker();
      } else {
        if (!picker.loaded.window) {
          picker.sources.window = await stf.listSources({ types: ['window'], thumbs: false });
          picker.loaded.window = true;
          renderPicker();
        }
        if (withThumbs) {
          picker.sources.window = await stf.listSources({ types: ['window'], thumbs: true, icons: true, width: 256, height: 144 });
          renderPicker();
        }
      }
    } catch (err) {
      toast(`Quellen konnten nicht geladen werden: ${errText(err)}`, 'error');
    } finally {
      picker.busy = false;
    }
  }

  function renderPicker() {
    const grid = $('pickerGrid');
    const query = $('pickerSearch').value.trim().toLowerCase();
    let list = picker.sources[picker.type];
    if (picker.type === 'window' && query) list = list.filter((s) => s.name.toLowerCase().includes(query));
    grid.querySelectorAll('.skeleton, .source-empty').forEach((el) => el.remove());

    if (!picker.loaded[picker.type]) {
      grid.querySelectorAll('.source').forEach((el) => el.remove());
      for (let i = 0; i < 4; i++) {
        const sk = document.createElement('div');
        sk.className = 'skeleton';
        grid.appendChild(sk);
      }
      return;
    }

    const existing = new Map([...grid.querySelectorAll('.source')].map((el) => [el.dataset.id, el]));
    let prev = null;
    for (const src of list) {
      let el = existing.get(src.id);
      if (!el) {
        el = document.createElement('button');
        el.className = 'source';
        el.dataset.id = src.id;
        const thumb = document.createElement('img');
        thumb.className = 'source-thumb empty';
        thumb.alt = '';
        thumb.decoding = 'async';
        const meta = document.createElement('div');
        meta.className = 'source-meta';
        const icon = document.createElement('img');
        icon.className = 'source-icon';
        icon.alt = '';
        const name = document.createElement('span');
        name.className = 'source-name';
        const detail = document.createElement('span');
        detail.className = 'source-detail';
        meta.append(icon, name, detail);
        el.append(thumb, meta);
        el.addEventListener('click', () => onPickSource(el.dataset.id));
        grid.appendChild(el);
      }
      existing.delete(src.id);
      const thumb = el.querySelector('.source-thumb');
      if (src.thumbnail && thumb.dataset.src !== src.thumbnail) {
        thumb.dataset.src = src.thumbnail;
        thumb.src = src.thumbnail;
        thumb.classList.remove('empty');
      }
      const icon = el.querySelector('.source-icon');
      icon.classList.toggle('hidden', !src.appIcon);
      if (src.appIcon && icon.dataset.src !== src.appIcon) {
        icon.dataset.src = src.appIcon;
        icon.src = src.appIcon;
      }
      el.querySelector('.source-name').textContent = src.name;
      el.querySelector('.source-detail').textContent = src.detail || '';
      el.classList.toggle('selected', picker.mode === 'start' && src.id === picker.selected);
      el.classList.toggle('active-source', picker.mode === 'switch' && host.active && src.id === host.sourceId);
      if (prev ? prev.nextElementSibling !== el : grid.firstElementChild !== el) {
        if (prev) prev.after(el);
        else grid.prepend(el);
      }
      prev = el;
    }
    for (const stale of existing.values()) stale.remove();
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'source-empty';
      empty.textContent = picker.type === 'screen' ? 'Keine Monitore gefunden.' : 'Keine Fenster gefunden.';
      grid.appendChild(empty);
    }
  }

  function currentSourceName(id) {
    const all = [...picker.sources.screen, ...picker.sources.window];
    const s = all.find((x) => x.id === id);
    return s ? s.name : 'Bildschirm';
  }

  function openPicker(mode) {
    picker.mode = mode;
    picker.selected = mode === 'switch' ? host.sourceId : null;
    $('pickerTitle').textContent = mode === 'switch' ? 'Quelle sofort wechseln' : 'Was möchtest du teilen?';
    $('btnPickerStart').classList.toggle('hidden', mode === 'switch');
    $('btnPickerStart').disabled = true;
    $('btnPickerAudio').classList.toggle('hidden', mode === 'switch');
    $('pickerAudioNote').textContent = mode === 'switch' ? 'Ein Klick wechselt den Stream in unter einer Sekunde.' : audioSummary();
    renderPicker();
    $('pickerDialog').showModal();
    refreshPicker(picker.type === 'screen');
    refreshPicker(true);
  }

  function setPickerType(type) {
    if (type === picker.type) return;
    picker.type = type;
    $('pickerTabs').dataset.active = type === 'screen' ? '0' : '1';
    $('tabScreens').classList.toggle('active', type === 'screen');
    $('tabWindows').classList.toggle('active', type === 'window');
    $('pickerSearch').classList.toggle('hidden', type !== 'window');
    renderPicker();
    refreshPicker(true);
  }

  async function onPickSource(id) {
    if (picker.mode === 'switch') {
      $('pickerDialog').close();
      await switchSource(id);
      return;
    }
    picker.selected = id;
    $('btnPickerStart').disabled = false;
    renderPicker();
  }

  function bindPicker() {
    $('btnShare').addEventListener('click', () => openPicker('start'));
    $('btnSwitch').addEventListener('click', () => openPicker('switch'));
    $('tabScreens').addEventListener('click', () => setPickerType('screen'));
    $('tabWindows').addEventListener('click', () => setPickerType('window'));
    $('pickerSearch').addEventListener('input', renderPicker);
    $('btnIdentify').addEventListener('click', () => stf.identifyMonitors());
    $('btnPickerCancel').addEventListener('click', () => $('pickerDialog').close());
    $('btnPickerAudio').addEventListener('click', openAudio);
    $('btnPickerStart').addEventListener('click', async () => {
      const id = picker.selected;
      $('pickerDialog').close();
      if (id) await startSharing(id);
    });
  }

  /* ================================================================== */
  /* 5. audio mixer & apps                                               */
  /* ================================================================== */

  // Communication apps are muted by default (blacklist mode) – the user can change it any time.
  const DEFAULT_MUTED_APPS = ['discord', 'teamspeak', 'ts3client_win64', 'ts3client_win32', 'skype', 'teams', 'ms-teams', 'zoom', 'telegram', 'whatsapp'];

  const apps = { supported: false, mode: 'exclude', names: new Set(DEFAULT_MUTED_APPS), list: [], captured: new Map(), timer: null, busy: false };

  function audioSummary() {
    if (apps.mode === 'all') return 'Audio: gesamter Systemton';
    return apps.mode === 'include' ? 'Audio: nur ausgewählte Apps' : 'Audio: alles außer stummgeschalteten Apps (z. B. TeamSpeak, Discord)';
  }

  function renderApps() {
    const box = $('appList');
    const rows = new Map([...box.querySelectorAll('.app-row')].map((el) => [el.dataset.key, el]));
    box.querySelector('.app-empty')?.remove();
    const byName = new Map();
    for (const a of apps.list) {
      const key = a.name.toLowerCase();
      const cur = byName.get(key) || { key, name: a.name, title: a.title, active: false, peak: 0 };
      cur.active = cur.active || a.active;
      cur.peak = Math.max(cur.peak, a.peak);
      if (a.title) cur.title = a.title;
      byName.set(key, cur);
    }
    for (const key of apps.names) if (!byName.has(key)) byName.set(key, { key, name: key, title: '', active: false, peak: 0, missing: true });

    for (const info of byName.values()) {
      let row = rows.get(info.key);
      if (!row) {
        row = document.createElement('label');
        row.className = 'app-row';
        row.dataset.key = info.key;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => {
          if (cb.checked) apps.names.add(info.key);
          else apps.names.delete(info.key);
          setPref('audioNames', [...apps.names]);
          reconcileApps();
        });
        const name = document.createElement('span');
        name.className = 'app-name';
        const dot = document.createElement('span');
        dot.className = 'app-dot';
        const meter = document.createElement('div');
        meter.className = 'meter';
        const fill = document.createElement('div');
        fill.className = 'meter-fill';
        meter.appendChild(fill);
        row.append(cb, name, dot, meter);
        box.appendChild(row);
      }
      rows.delete(info.key);
      row.querySelector('input').checked = apps.names.has(info.key);
      row.querySelector('input').title = apps.mode === 'exclude' ? 'Angehakt = stumm' : 'Angehakt = wird übertragen';
      row.querySelector('.app-name').textContent = info.title ? `${info.name} – ${info.title}` : info.name + (info.missing ? ' (nicht aktiv)' : '');
      row.classList.toggle('active', info.active || info.peak > 0.001);
      row.classList.toggle('idle', !info.active && !(info.peak > 0.001));
    }
    for (const stale of rows.values()) stale.remove();
    if (byName.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'app-empty';
      empty.textContent = 'Keine Anwendung gibt gerade Ton aus. Starte dein Spiel oder Spotify.';
      box.appendChild(empty);
    }
  }

  function wantedApps() {
    if (apps.mode === 'all') return [];
    if (apps.mode === 'include') return apps.list.filter((a) => apps.names.has(a.name.toLowerCase()));
    return apps.list.filter((a) => !apps.names.has(a.name.toLowerCase()) && (a.active || a.peak > 0.001));
  }

  async function reconcileApps() {
    if (apps.busy) return;
    apps.busy = true;
    try {
      const mixer = host.mixer;
      const desired = new Map(host.active && mixer ? wantedApps().map((a) => [a.pid, a.name]) : []);
      for (const pid of [...apps.captured.keys()]) {
        if (!desired.has(pid)) {
          apps.captured.delete(pid);
          mixer && mixer.removeApp(pid);
          stf.appAudioStop(pid);
        }
      }
      for (const [pid, name] of desired) {
        if (apps.captured.has(pid)) continue;
        await mixer.addApp(pid, name);
        if (await stf.appAudioStart(pid)) apps.captured.set(pid, name);
        else mixer.removeApp(pid);
      }
      mixer && mixer.setSystemEnabled(apps.mode === 'all' || !apps.supported);
    } catch (err) {
      console.warn('reconcileApps failed', err);
    } finally {
      apps.busy = false;
    }
  }

  async function pollApps() {
    if (!apps.supported || document.hidden) return;
    if (!host.active && !$('audioDialog').open) return;
    try {
      apps.list = await stf.appAudioList();
      renderApps();
      await reconcileApps();
    } catch (err) {
      console.warn('pollApps failed', err);
    }
  }

  function setAudioMode(mode) {
    apps.mode = mode;
    for (const r of document.querySelectorAll('input[name="audioMode"]')) r.checked = r.value === mode;
    $('appNote').textContent =
      mode === 'exclude'
        ? 'Angehakte Apps bleiben stumm. Alles andere (Spiel, Spotify …) wird übertragen.'
        : mode === 'include'
          ? 'Nur angehakte Apps werden übertragen.'
          : 'Der gesamte Systemton wird übertragen.';
    $('appList').classList.toggle('hidden', mode === 'all');
    setPref('audioMode', mode);
    $('pickerAudioNote').textContent = audioSummary();
    reconcileApps();
  }

  function openAudio() {
    $('audioDialog').showModal();
    renderApps();
    pollApps();
  }

  let meterTimer = null;
  const meterPeak = new Map();
  function startMeters() {
    clearInterval(meterTimer);
    meterTimer = setInterval(() => {
      const mixer = host.mixer;
      if (!mixer || document.hidden || !$('audioDialog').open) return;
      const byName = new Map();
      for (const app of mixer.apps.values()) byName.set(app.name.toLowerCase(), Math.max(byName.get(app.name.toLowerCase()) || 0, mixer.level(app.analyser)));
      for (const row of $('appList').querySelectorAll('.app-row')) {
        const k = row.dataset.key;
        const next = Math.max(byName.get(k) || 0, (meterPeak.get(k) || 0) - 0.05);
        meterPeak.set(k, next);
        row.querySelector('.meter-fill').style.transform = `scaleX(${next.toFixed(3)})`;
      }
      const m = Math.max(mixer.level(mixer.masterAnalyser), (meterPeak.get('#master') || 0) - 0.05);
      meterPeak.set('#master', m);
      $('masterMeter').style.transform = `scaleX(${m.toFixed(3)})`;
    }, 50);
  }

  function bindAudio() {
    for (const r of document.querySelectorAll('input[name="audioMode"]')) r.addEventListener('change', () => r.checked && setAudioMode(r.value));
    $('btnAudio').addEventListener('click', openAudio);
    $('btnAudioClose').addEventListener('click', () => $('audioDialog').close());
    stf.onAppAudio((pid, chunk) => host.mixer && host.mixer.pushApp(pid, chunk));
    stf.onAppAudioEnded((pid) => {
      if (apps.captured.delete(pid) && host.mixer) host.mixer.removeApp(pid);
    });
  }

  /* ================================================================== */
  /* 6. host                                                             */
  /* ================================================================== */

  const host = {
    active: false,
    sourceId: null,
    capture: null, // MediaStream from getDisplayMedia
    video: null,
    mixer: null,
    out: null, // MediaStream sent to every viewer (video + mixed audio)
    height: 1080,
    peers: new Map(), // sid -> HostPeer
    baseKey: null,
    failures: [],
    tickTimer: null,
    allowDraw: true,
    control: null, // { sid, name, clip }
    denyUntil: new Map(),
    maxTier: 0, // quality ceiling chosen by the streamer (0 = automatic, as high as the line allows)
    forceTier: null, // or one pinned tier
    lockUntil: 0, // after too many wrong passwords new logins are blocked until then
    banned: new Map(), // viewers the streamer removed: 'id:123456789' or 'name:xyz' -> until (ms)
  };

  async function captureSource(id) {
    await stf.selectSource(id);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } },
      // raw system audio: voice processing would strip game and music sound
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    });
    const video = stream.getVideoTracks()[0];
    video.contentHint = 'motion';
    return { stream, video };
  }

  async function startSharing(sourceId) {
    if (host.active) return;
    if (!state.sig || !state.sig.ready) {
      toast('Der Server ist nicht erreichbar – Freunde können sich so nicht verbinden.', 'error');
    }
    try {
      const { stream, video } = await captureSource(sourceId);
      host.mixer = new window.StfMixer();
      await host.mixer.resume();
      host.mixer.setSystemStream(new MediaStream(stream.getAudioTracks()));
      host.capture = stream;
      host.video = video;
      host.sourceId = sourceId;
      host.height = video.getSettings().height || 1080;
      host.out = new MediaStream([video, host.mixer.track]);
      host.active = true;
      video.addEventListener('ended', onCaptureEnded);

      $('previewVideo').srcObject = new MediaStream([video]);
      $('shareLabel').textContent = `Du teilst: ${currentSourceName(sourceId)}`;
      showView('host');
      renderHostChip();
      clearInterval(host.tickTimer);
      host.tickTimer = setInterval(hostTick, 1000);
      pollApps();
      reconcileApps();
      toast('Du teilst jetzt. Gib deinen Freunden ID und Passwort.', 'ok');
    } catch (err) {
      toast(`Teilen fehlgeschlagen: ${errText(err)}`, 'error', 8000);
      await stopSharing(false);
    }
  }

  async function onCaptureEnded() {
    toast('Die geteilte Quelle wurde geschlossen.', 'error');
    await stopSharing();
  }

  /** Instant switching: new capture, then replaceTrack on every viewer – no renegotiation, no reconnect. */
  async function switchSource(id) {
    if (!host.active || id === host.sourceId) return;
    const t0 = performance.now();
    try {
      const { stream, video } = await captureSource(id);
      video.addEventListener('ended', onCaptureEnded);
      await Promise.all([...host.peers.values()].map((p) => p.replaceVideo(video)));
      const old = host.capture;
      host.video.removeEventListener('ended', onCaptureEnded);
      host.capture = stream;
      host.video = video;
      host.sourceId = id;
      host.height = video.getSettings().height || 1080;
      host.out.getVideoTracks().forEach((t) => host.out.removeTrack(t));
      host.out.addTrack(video);
      old.getVideoTracks().forEach((t) => t.stop());
      host.mixer.setSystemStream(new MediaStream(stream.getAudioTracks()));
      $('previewVideo').srcObject = new MediaStream([video]);
      $('shareLabel').textContent = `Du teilst: ${currentSourceName(id)}`;
      window.__stfLast = { switchMs: Math.round(performance.now() - t0) };
      for (const p of host.peers.values()) p.sendCtl({ t: 'src', name: currentSourceName(id) });
    } catch (err) {
      toast(`Quellenwechsel fehlgeschlagen: ${errText(err)}`, 'error');
    }
  }

  async function stopSharing(notify = true) {
    if (!host.active && !host.capture) return;
    host.active = false;
    clearInterval(host.tickTimer);
    await stf.remoteEnd('Teilen beendet');
    for (const p of [...host.peers.values()]) p.close('stopped', notify);
    host.peers.clear();
    if (host.video) host.video.removeEventListener('ended', onCaptureEnded);
    host.capture && host.capture.getTracks().forEach((t) => t.stop());
    host.capture = null;
    host.video = null;
    host.out = null;
    host.sourceId = null;
    apps.captured.clear();
    stf.appAudioStopAll();
    if (host.mixer) {
      host.mixer.close().catch(() => {});
      host.mixer = null;
    }
    $('previewVideo').srcObject = null;
    stf.drawClose();
    renderViewerList();
    renderHostChip();
    showView(viewer.peer ? 'viewer' : 'welcome');
    refreshUpdateBanner();
  }

  function onIncoming(sid) {
    if (!host.active || !host.out) {
      state.sig.relay(sid, { k: 'refuse', reason: 'not-sharing' });
      state.sig.bye(sid);
      return;
    }
    if (Date.now() < host.lockUntil) {
      state.sig.relay(sid, { k: 'refuse', reason: 'rate-limit' });
      state.sig.bye(sid);
      return;
    }
    const peer = new HostPeer({
      sig: state.sig,
      sid,
      hostId: state.myId,
      getBaseKey: () => host.baseKey,
      getIce: () => state.ice,
      getMedia: () => (host.active ? { stream: host.out, video: host.video, audio: host.mixer && host.mixer.track, height: host.height } : null),
      hooks: {
        onAuthOk: (p) => {
          host.peers.set(p.sid, p);
          toast(`${p.name} schaut jetzt zu.`, 'ok', 3000);
          renderViewerList();
          renderHostChip();
          refreshUpdateBanner();
        },
        onAuthFail: () => registerAuthFailure(),
        isBanned: (p) => isBannedViewer(p),
        onOpen: (p) => {
          p.sendCtl({ t: 'info', name: state.settings.displayName || 'Host', allowDraw: host.allowDraw, source: currentSourceName(host.sourceId) });
        },
        onCtl: (msg) => onHostMessage(peer, msg),
        onFast: (msg) => onHostMessage(peer, msg),
        onState: () => {},
        onClosed: (p, reason) => {
          const was = host.peers.delete(p.sid);
          if (host.control && host.control.sid === p.sid) stf.remoteEnd('Zuschauer hat die Verbindung getrennt');
          stf.drawEvent({ k: 'clear', id: p.sid });
          if (was) toast(`${p.name || 'Ein Zuschauer'} hat die Verbindung beendet.`, '', 3000);
          renderViewerList();
          renderHostChip();
          refreshUpdateBanner();
        },
      },
    });
    peer.hostMaxTier = host.maxTier;
    peer.hostForceTier = host.forceTier;
    host.peers.set(sid, peer); // routing needs it during the handshake; removed again if auth fails
    peer.start();
    // a handshake that never completes frees its slot
    setTimeout(() => !peer.authed && host.peers.get(sid) === peer && host.peers.delete(sid), 25000);
  }

  function registerAuthFailure() {
    const now = Date.now();
    host.failures = host.failures.filter((t) => now - t < 10 * 60_000);
    host.failures.push(now);
    if (host.failures.length >= 5) {
      // the password stays (friends have saved it): block new logins for a while instead
      host.lockUntil = now + 10 * 60_000;
      host.failures = [];
      toast('Zu viele falsche Passwörter – neue Anmeldungen sind 10 Minuten gesperrt. Dein Passwort bleibt unverändert.', 'error', 8000);
    } else toast('Jemand hat ein falsches Passwort eingegeben.', 'error', 4000);
  }

  const KICK_BAN_MS = 30 * 60_000;

  function banKey(p) {
    return p.vid ? `id:${p.vid}` : `name:${String(p.name).toLowerCase()}`;
  }

  function isBannedViewer(p) {
    const until = host.banned.get(banKey(p)) || 0;
    if (until && until < Date.now()) host.banned.delete(banKey(p));
    return until > Date.now();
  }

  /** Removes a viewer for good (for a while): he is told, does not reconnect by himself and is refused if he tries. */
  function kickViewer(p) {
    host.banned.set(banKey(p), Date.now() + KICK_BAN_MS);
    p.sendCtl({ t: 'kick' });
    toast(`${p.name} wurde entfernt und kann sich 30 Minuten lang nicht wieder verbinden.`, 'ok', 5000);
    setTimeout(() => p.close('kicked'), 400); // let the message go out first
  }

  function renderViewerList() {
    const list = $('viewerList');
    list.replaceChildren();
    const authed = [...host.peers.values()].filter((p) => p.authed);
    $('viewerCount').textContent = String(authed.length);
    $('viewerListEmpty').classList.toggle('hidden', authed.length > 0);
    for (const p of authed) {
      const row = document.createElement('div');
      row.className = 'viewer-row';
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = p.name.slice(0, 1).toUpperCase();
      av.style.background = `hsl(${hueFor(p.sid)} 55% 45%)`;
      const meta = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.dataset.sid = p.sid;
      sub.textContent = 'verbindet …';
      meta.append(name, sub);
      const kick = document.createElement('button');
      kick.className = 'icon-btn';
      kick.title = 'Verbindung trennen';
      kick.innerHTML = '<svg class="icon"><use href="#i-leave"/></svg>';
      kick.addEventListener('click', () => kickViewer(p));
      row.append(av, meta, kick);
      list.appendChild(row);
    }
  }

  /** Streamer quality: "0".."4" = automatic with a ceiling, "f0".."f2" = pinned tier (no ping guard). */
  function applyHostQuality(value, announce) {
    const pinned = typeof value === 'string' && value.startsWith('f');
    const idx = clamp(Math.round(Number(pinned ? value.slice(1) : value) || 0), 0, AD.TIERS.length - 1);
    host.maxTier = pinned ? 0 : idx;
    host.forceTier = pinned ? idx : null;
    setPref('hostQuality', pinned ? `f${idx}` : String(idx));
    $('selHostQuality').value = pinned ? `f${idx}` : String(idx);
    for (const p of host.peers.values()) {
      p.hostMaxTier = host.maxTier;
      p.hostForceTier = host.forceTier;
    }
    if (announce) {
      toast(
        pinned ? `Feste Qualität: ${AD.TIERS[idx].name} – ohne Ping-Schutz` : idx ? `Maximale Qualität: ${AD.TIERS[idx].name}` : 'Qualität: automatisch (so hoch wie deine Leitung erlaubt)',
        'ok',
        3500
      );
    }
  }

  /** One step per second: adaptive quality per viewer + status lines in the sidebar. */
  async function hostTick() {
    if (!host.active) return;
    for (const p of host.peers.values()) {
      if (!p.authed || !p.pc) continue;
      try {
        await p.tick(host.height);
        const sub = document.querySelector(`.viewer-row .sub[data-sid="${p.sid}"]`);
        if (sub) {
          const i = p.info;
          sub.textContent = `${i.path === 'relay' ? 'Relay' : i.path === 'direct' ? 'Direkt' : '…'} · ${i.tier.name} · ${formatBps(i.bps)}${i.rttMs != null ? ` · ${Math.round(i.rttMs)} ms` : ''}`;
        }
      } catch (err) {
        console.warn('tick failed', err);
      }
    }
  }

  /* ---- messages from viewers ---- */

  function onHostMessage(peer, msg) {
    if (msg.d === 1) return onHostDraw(peer, msg);
    switch (msg.t) {
      case 'pref':
        peer.viewerMaxTier = clamp(Math.round(Number(msg.maxTier) || 0), 0, AD.TIERS.length - 1);
        break;
      case 'req':
        handleControlRequest(peer).catch((err) => console.error('control request failed', err));
        break;
      case 'end':
        if (host.control && host.control.sid === peer.sid) stf.remoteEnd('Zuschauer hat die Steuerung beendet');
        break;
      case 'clip-start':
      case 'clip-chunk':
        if (host.control && host.control.sid === peer.sid && host.control.clip) host.control.clip.handle(msg);
        break;
      case 'img-start':
      case 'img-chunk':
        hostPictureChunk(peer, msg);
        break;
      default:
        // kd / ku / md / mu / wh / rel / mm: input; the main process re-validates identity and values
        if (host.control && host.control.sid === peer.sid && ['kd', 'ku', 'md', 'mu', 'wh', 'rel', 'mm'].includes(msg.t)) {
          stf.remoteInput({ ...msg, identity: peer.sid });
        }
    }
  }

  const PICTURE_MIMES = ['image/webp', 'image/png', 'image/jpeg'];
  const PICTURE_ID = /^[A-Za-z0-9]{1,16}$/;

  /** A viewer sends a picture in pieces (reliable channel); when complete it is handed to the overlay window. */
  function hostPictureChunk(peer, msg) {
    if (!host.allowDraw || typeof msg.i !== 'string' || !PICTURE_ID.test(msg.i)) return;
    peer.picIn = peer.picIn || new Map();
    peer.picIds = peer.picIds || new Set();
    if (msg.t === 'img-start') {
      if (!Number.isInteger(msg.n) || msg.n < 1 || msg.n > 200 || peer.picIn.size >= 4 || !PICTURE_MIMES.includes(msg.mime)) return;
      if (peer.picIds.size >= 8 && !peer.picIds.has(msg.i)) return;
      peer.picIn.set(msg.i, { n: msg.n, mime: msg.mime, parts: [], got: 0, size: 0 });
      return;
    }
    const e = peer.picIn.get(msg.i);
    if (!e || typeof msg.d !== 'string' || !Number.isInteger(msg.j) || msg.j < 0 || msg.j >= e.n || e.parts[msg.j] !== undefined) return;
    e.size += msg.d.length;
    if (e.size > 6_000_000) {
      peer.picIn.delete(msg.i);
      return;
    }
    e.parts[msg.j] = msg.d;
    if (++e.got !== e.n) return;
    peer.picIn.delete(msg.i);
    peer.picIds.add(msg.i);
    stf.drawEvent({ k: 'imgdata', id: peer.sid, n: peer.name, i: msg.i, mime: e.mime, data: e.parts.join('') });
  }

  function onHostDraw(peer, msg) {
    if (!host.allowDraw || !['cursor', 'laser', 'pen', 'off', 'clear', 'imgt', 'imgdel'].includes(msg.k)) return;
    if (msg.k === 'imgt' || msg.k === 'imgdel') {
      if (typeof msg.i !== 'string' || !PICTURE_ID.test(msg.i) || !(peer.picIds && peer.picIds.has(msg.i))) return;
      stf.drawEvent({ k: msg.k, id: peer.sid, i: msg.i, x: msg.x, y: msg.y, w: msg.w, rot: msg.rot, cl: msg.cl, ct: msg.ct, cr: msg.cr, cb: msg.cb });
      if (msg.k === 'imgdel') peer.picIds.delete(msg.i);
      return;
    }
    if (msg.k === 'clear' && peer.picIds) peer.picIds.clear();
    stf.drawEvent({ k: msg.k === 'laser' ? 'cursor' : msg.k, id: peer.sid, n: peer.name, h: Number(msg.h) || hueFor(peer.sid), c: msg.c, w: msg.w, t: msg.t, x: msg.x, y: msg.y, s: msg.s, perm: msg.perm === true });
  }

  async function handleControlRequest(peer) {
    const deny = (reason) => peer.sendCtl({ t: 'grant', ok: false, reason });
    if (host.control) return deny('Der Rechner wird gerade von jemand anderem gesteuert.');
    if (Date.now() < (host.denyUntil.get(peer.sid) || 0)) return deny('Bitte warte einen Moment, bevor du erneut anfragst.');
    const result = await stf.remoteRequest({ identity: peer.sid, name: peer.name });
    if (!result.allowed) {
      host.denyUntil.set(peer.sid, Date.now() + 10_000);
      return deny(result.reason);
    }
    if (!host.peers.has(peer.sid)) return stf.remoteEnd('Zuschauer ist nicht mehr verbunden');
    host.control = { sid: peer.sid, name: peer.name, clip: null };
    host.control.clip = new ClipSync((m) => sendBig(peer, m));
    host.control.clip.start();
    $('hostRemoteName').textContent = peer.name;
    $('hostRemoteBanner').classList.remove('hidden');
    peer.sendCtl({ t: 'grant', ok: true });
  }

  function onHostRemoteEnded(info) {
    const c = host.control;
    host.control = null;
    $('hostRemoteBanner').classList.add('hidden');
    if (!c) return;
    c.clip && c.clip.stop();
    const peer = host.peers.get(c.sid);
    peer && peer.sendCtl({ t: 'rev', reason: (info && info.reason) || 'Beendet' });
    toast(`Remote Access beendet (${(info && info.reason) || 'Beendet'}).`);
  }

  function bindHost() {
    $('btnStopShare').addEventListener('click', () => stopSharing());
    $('btnClearAll').addEventListener('click', () => stf.drawEvent({ k: 'clearall', id: 'host' }));
    $('selHostQuality').addEventListener('change', () => {
      applyHostQuality($('selHostQuality').value, true);
    });
    $('chkAllowDraw').addEventListener('change', (e) => {
      host.allowDraw = e.target.checked;
      setPref('allowDraw', host.allowDraw);
      if (!host.allowDraw) stf.drawEvent({ k: 'clearall', id: 'host' });
      for (const p of host.peers.values()) p.sendCtl({ t: 'info', allowDraw: host.allowDraw });
    });
    $('btnHostRemoteEnd').addEventListener('click', () => stf.remoteEnd('Vom Streamer beendet'));
    stf.onRemoteEnded(onHostRemoteEnded);
    stf.onRemoteBlocked(() => toast('Windows blockiert die Eingaben (z. B. Fenster mit Administratorrechten). Starte ShareToFriends als Administrator, um sie zu steuern.', 'error', 10000));
    stf.onRemoteLockBlock(() => {
      const peer = host.control && host.peers.get(host.control.sid);
      peer && peer.sendCtl({ t: 'lock' });
    });
  }

  /* ================================================================== */
  /* 7. viewer                                                           */
  /* ================================================================== */

  const viewer = {
    peer: null,
    creds: null, // { hostId, password } kept in memory for automatic reconnects
    connecting: false,
    leaving: false,
    reconnecting: false,
    info: { name: '', allowDraw: true },
    zoom: 'fit',
    statsTimer: null,
    prevStats: null,
    barTimer: null,
    barHover: false,
  };

  const ERRORS = {
    'wrong-password': 'Falsches Passwort.',
    offline: 'Diese ID ist gerade nicht online. Läuft ShareToFriends bei deinem Freund?',
    'not-sharing': 'Dein Freund teilt gerade nichts. Er muss zuerst „Bildschirm teilen“ klicken.',
    'host-busy': 'Dein Freund hat schon die maximale Zahl an Zuschauern.',
    'rate-limit': 'Zu viele Versuche – bitte kurz warten.',
    kicked: 'Der Streamer hat dich entfernt. Du kannst dich vorerst nicht wieder verbinden.',
    timeout: 'Keine Antwort. Prüfe ID und Internetverbindung.',
    'signal-offline': 'Der Vermittlungs-Server ist nicht erreichbar.',
    'host-not-verified': 'Der Gegenstelle konnte nicht vertraut werden (falsches Passwort oder manipulierte Verbindung).',
    'ice-failed': 'Es konnte keine Verbindung zwischen den PCs aufgebaut werden (Firewall?).',
    'bad-sdp': 'Sicherheitsprüfung der Verbindung fehlgeschlagen.',
  };

  function showView(name) {
    $('welcome').classList.toggle('hidden', name !== 'welcome');
    $('hostView').classList.toggle('hidden', name !== 'host');
    $('viewerView').classList.toggle('hidden', name !== 'viewer');
  }

  async function connectToFriend() {
    const hostId = A.normalizeId($('peerId').value);
    const password = A.normalizePassword($('peerPw').value);
    if (!hostId || !password) return;
    if (hostId === state.myId) {
      $('connectError').textContent = 'Das ist deine eigene ID.';
      $('connectError').classList.remove('hidden');
      return;
    }
    $('connectError').classList.add('hidden');
    viewer.creds = { hostId, password };
    viewer.fromSaved = false;
    viewer.leaving = false;
    await openViewerSession(false);
  }

  async function openViewerSession(isRetry) {
    viewer.connecting = true;
    updateConnectButton();
    $('viewerBusyText').textContent = isRetry ? 'Verbindung unterbrochen – verbinde neu …' : 'Verbinde …';
    $('viewerBusy').classList.remove('gone');
    showView('viewer');
    const peer = new ViewerPeer({
      sig: state.sig,
      hostId: viewer.creds.hostId,
      password: viewer.creds.password,
      name: state.settings.displayName || 'Gast',
      selfId: state.myId,
      getIce: () => state.ice,
      hooks: {
        onTrack: (stream) => {
          $('remoteVideo').srcObject = stream;
          applyVolume();
        },
        onCtl: onViewerMessage,
        onFast: onViewerMessage,
        onState: () => {},
        onClosed: (p, reason) => onViewerClosed(p, reason),
      },
    });
    viewer.peer = peer;
    try {
      await peer.connect();
      viewer.connecting = false;
      viewer.reconnecting = false;
      $('viewerBusy').classList.add('gone');
      $('connectError').classList.add('hidden');
      $('userSub').textContent = 'Online';
      rememberFriend(viewer.creds.hostId, viewer.creds.password, viewer.info.name || '');
      renderFriends();
      applyViewerQuality();
      startViewerStats();
      showBar();
      refreshUpdateBanner();
      updateViewerTools();
    } catch (err) {
      viewer.connecting = false;
      const code = errText(err);
      if (isRetry && !['wrong-password', 'kicked'].includes(code)) throw err; // the retry loop handles it
      const failedId = viewer.creds && viewer.creds.hostId;
      viewer.peer = null;
      viewer.creds = null;
      showView(host.active ? 'host' : 'welcome');
      $('connectError').textContent = ERRORS[code] || `Verbindung fehlgeschlagen (${code}).`;
      if (viewer.fromSaved && failedId && ['wrong-password', 'host-not-verified'].includes(code)) {
        // the saved password no longer fits: let the user type the new one
        $('peerId').value = A.formatId(failedId);
        $('peerPw').value = '';
        $('connectError').textContent = 'Das Passwort hat sich geändert – gib das neue ein.';
        $('peerPw').focus();
      }
      $('connectError').classList.remove('hidden');
      renderFriends();
      updateConnectButton();
    }
  }

  function onViewerClosed(peer, reason) {
    if (viewer.peer !== peer) return;
    clearPictures(); // the streamer's overlay dropped them with the connection
    clearInterval(viewer.statsTimer);
    endControl(null, false);
    drawSetMode(null);
    if (viewer.leaving || !viewer.creds) return;
    if (!peer.connected) return; // initial attempt: openViewerSession reports it
    viewer.peer = null;
    $('viewerBusyText').textContent = 'Verbindung unterbrochen – verbinde neu …';
    $('viewerBusy').classList.remove('gone');
    if (reason === 'stopped' || reason === 'bye' || reason === 'host-left') {
      // the friend stopped sharing on purpose: keep trying for a while, he may start again
    }
    retryViewer();
  }

  /** Automatic reconnect with growing delays (same ID and password, kept only in memory). */
  async function retryViewer() {
    if (viewer.reconnecting) return;
    viewer.reconnecting = true;
    const delays = [1, 2, 3, 5, 8, 13, 20, 30];
    for (let attempt = 1; attempt <= 40 && !viewer.leaving && viewer.creds; attempt++) {
      $('viewerBusyText').textContent = `Verbindung unterbrochen – verbinde neu … (Versuch ${attempt})`;
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)] * 1000);
      if (viewer.leaving || !viewer.creds) break;
      try {
        await openViewerSession(true);
        toast('Verbindung wiederhergestellt.', 'ok');
        viewer.reconnecting = false;
        return;
      } catch (err) {
        viewer.peer && viewer.peer.close('retry', false);
        viewer.peer = null;
      }
    }
    viewer.reconnecting = false;
    if (!viewer.leaving) {
      toast('Wiederverbinden fehlgeschlagen.', 'error');
      leaveViewer();
    }
  }

  function leaveViewer() {
    viewer.leaving = true;
    clearPictures();
    clearInterval(viewer.statsTimer);
    endControl(null, true);
    drawSetMode(null);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (viewer.peer) viewer.peer.close('leave');
    viewer.peer = null;
    viewer.creds = null;
    $('remoteVideo').srcObject = null;
    $('viewStats').classList.add('hidden');
    $('btnStats').setAttribute('aria-pressed', 'false');
    showView(host.active ? 'host' : 'welcome');
    updateConnectButton();
    renderFriends();
    refreshUpdateBanner();
  }

  function onViewerMessage(msg) {
    switch (msg.t) {
      case 'kick':
        // removed by the streamer: leave for good, no automatic reconnect
        viewer.creds = null;
        leaveViewer();
        $('connectError').textContent = ERRORS.kicked;
        $('connectError').classList.remove('hidden');
        toast('Der Streamer hat dich aus dem Stream entfernt.', 'error', 8000);
        break;
      case 'info':
        if (typeof msg.name === 'string') {
          viewer.info.name = msg.name;
          if (viewer.creds) rememberFriend(viewer.creds.hostId, viewer.creds.password, msg.name);
        }
        if (typeof msg.allowDraw === 'boolean') viewer.info.allowDraw = msg.allowDraw;
        updateViewerTools();
        break;
      case 'src':
        showHint(`Der Streamer teilt jetzt: ${String(msg.name || '').slice(0, 60)}`, 3000);
        break;
      case 'grant':
        onGrant(msg);
        break;
      case 'rev':
        if (ctl.state !== 'idle') {
          endControl(null, false);
          toast(`Remote Access beendet: ${msg.reason || 'vom Streamer beendet'}`);
        }
        break;
      case 'lock':
        showHint('Gesperrt: Die Steuerung wirkt nur im geteilten Fenster', 3000);
        break;
      case 'clip-start':
      case 'clip-chunk':
        ctl.clip && ctl.clip.handle(msg);
        break;
      default:
        break;
    }
  }

  function applyViewerQuality() {
    if (viewer.peer) viewer.peer.sendCtl({ t: 'pref', maxTier: Number($('selQuality').value) });
  }

  function applyVolume() {
    const v = $('remoteVideo');
    v.volume = Number($('viewVolume').value) / 100;
    const muted = $('btnMute').getAttribute('aria-pressed') === 'true';
    v.muted = muted;
    $('btnMute').querySelector('use').setAttribute('href', muted ? '#i-vol-off' : '#i-vol');
  }

  function setZoom(mode) {
    viewer.zoom = mode;
    $('viewerWrap').classList.toggle('fill', mode === 'fill');
    $('viewerWrap').classList.toggle('native', mode === '100');
    $('zoomFit').classList.toggle('active', mode === 'fit');
    $('zoomFill').classList.toggle('active', mode === 'fill');
    $('zoom100').classList.toggle('active', mode === '100');
    setPref('zoom', mode);
    drawResize();
  }

  let hintTimer = null;
  function showHint(text, ms = 2500) {
    const el = $('viewHint');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  /* ---- Discord-style floating bar: fades away when idle ---- */

  function showBar() {
    $('streamBar').classList.remove('idle');
    clearTimeout(viewer.barTimer);
    viewer.barTimer = setTimeout(() => {
      if (!viewer.barHover && !ctl.engaged && !draw.mode) $('streamBar').classList.add('idle');
    }, 2800);
  }

  async function startViewerStats() {
    clearInterval(viewer.statsTimer);
    viewer.prevStats = null;
    viewer.statsTimer = setInterval(async () => {
      if (!viewer.peer || !viewer.peer.connected || $('btnStats').getAttribute('aria-pressed') !== 'true' || document.hidden) return;
      const s = await viewer.peer.stats(viewer.prevStats).catch(() => null);
      if (!s) return;
      viewer.prevStats = s.raw;
      $('viewStats').textContent =
        `${s.width}×${s.height} @ ${Math.round(s.fps)} FPS\n${formatBps(s.bps)}  verworfen ${s.dropped}\n` +
        `Ping ${s.rttMs == null ? '–' : Math.round(s.rttMs) + ' ms'}  Puffer ${Math.round(s.jitterBufferMs)} ms\n` +
        `Verbindung: ${s.path === 'relay' ? 'über Relay-Server' : s.path === 'direct' ? 'direkt (P2P)' : '…'}`;
      $('viewStats').classList.remove('hidden');
    }, 1000);
  }

  function bindViewer() {
    $('btnLeave').addEventListener('click', leaveViewer);
    $('viewVolume').addEventListener('input', () => {
      setPref('volume', Number($('viewVolume').value));
      applyVolume();
    });
    $('btnMute').addEventListener('click', () => {
      $('btnMute').setAttribute('aria-pressed', String($('btnMute').getAttribute('aria-pressed') !== 'true'));
      applyVolume();
    });
    $('zoomFit').addEventListener('click', () => setZoom('fit'));
    $('zoomFill').addEventListener('click', () => setZoom('fill'));
    $('zoom100').addEventListener('click', () => setZoom('100'));
    $('selQuality').addEventListener('change', () => {
      setPref('quality', $('selQuality').value);
      applyViewerQuality();
    });
    $('btnStats').addEventListener('click', () => {
      const on = $('btnStats').getAttribute('aria-pressed') !== 'true';
      $('btnStats').setAttribute('aria-pressed', String(on));
      $('viewStats').classList.toggle('hidden', !on);
    });
    $('btnFullscreen').addEventListener('click', toggleFullscreen);
    $('remoteVideo').addEventListener('dblclick', () => !ctl.engaged && !draw.mode && toggleFullscreen());

    const wrap = $('viewerWrap');
    wrap.addEventListener('mousemove', showBar);
    $('streamBar').addEventListener('mouseenter', () => {
      viewer.barHover = true;
      showBar();
    });
    $('streamBar').addEventListener('mouseleave', () => {
      viewer.barHover = false;
      showBar();
    });
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('viewerWrap').requestFullscreen();
    } catch (err) {
      console.warn('fullscreen failed', err);
    }
  }

  /* ---- mouse pointer and drawing (temporary + permanent) ---- */

  const Style = window.StfDrawStyle;
  const draw = {
    mode: null, strokeId: 0, down: false, strokes: [], raf: 0, pending: null, sendTimer: 0, keepTimer: 0, lastPos: null,
    color: Style.DEFAULTS.color, size: Style.DEFAULTS.size, tool: Style.DEFAULTS.tool, W: 0, H: 0, dpr: 1,
  };
  const TEMP_HOLD_MS = 4500;
  const TEMP_FADE_MS = 1500;
  const COLOR_PRESETS = ['#f23f43', '#ff8a1f', '#ffd60a', '#3ba55d', '#00c2ff', '#5865f2', '#c13cff', '#ff5fa2', '#ffffff', '#000000'];

  function canDraw() {
    return Boolean(viewer.peer && viewer.peer.connected && viewer.info.allowDraw && ctl.state !== 'granted');
  }

  function updateViewerTools() {
    const ok = canDraw();
    for (const id of ['btnCursor', 'btnPenTemp', 'btnPenPerm', 'btnImage', 'btnClearMine']) $(id).disabled = !ok;
    const why = !viewer.info.allowDraw ? 'Der Streamer hat das Zeichnen ausgeschaltet' : ctl.state === 'granted' ? 'Nicht während der Fernsteuerung' : 'Noch nicht verbunden';
    $('btnCursor').title = ok ? 'Mauszeiger – dein Freund sieht, wohin du zeigst (M)' : why;
    $('btnControl').disabled = !(viewer.peer && viewer.peer.connected && ctl.state === 'idle');
    $('btnControl').classList.toggle('hidden', ctl.state !== 'idle');
    if (!ok && draw.mode) drawSetMode(null);
  }

  function drawSetMode(mode) {
    if (mode && !canDraw()) mode = null;
    if (draw.mode === 'cursor' && mode !== 'cursor') {
      clearInterval(draw.keepTimer);
      draw.keepTimer = 0;
      draw.lastPos = null;
      sendDraw({ k: 'off' });
    }
    draw.mode = mode;
    if (mode === 'cursor' && !draw.keepTimer) {
      // The host hides a pointer that stopped updating, so repeat the position while the tool is on.
      draw.keepTimer = setInterval(() => draw.lastPos && sendDraw({ k: 'cursor', x: draw.lastPos.x, y: draw.lastPos.y }), 900);
    }
    $('btnCursor').setAttribute('aria-pressed', String(mode === 'cursor'));
    $('btnPenTemp').setAttribute('aria-pressed', String(mode === 'temp'));
    $('btnPenPerm').setAttribute('aria-pressed', String(mode === 'perm'));
    $('btnImage').setAttribute('aria-pressed', String(mode === 'image'));
    $('viewerWrap').classList.toggle('picmode', mode === 'image');
    if (mode !== 'image') {
      pics.sel = null;
      pics.drag = null;
      $('drawCanvas').style.cursor = '';
    }
    $('viewerWrap').classList.toggle('drawing', Boolean(mode));
    $('viewerWrap').classList.toggle('pointing', mode === 'cursor');
    renderDrawPanel();
    showBar(); // keyboard shortcuts must reveal the bar and panel too
    if (mode) showHint(mode === 'image' ? 'Bild – ziehen, Ecken skalieren, oben drehen, Alt + ziehen zuschneiden' : mode === 'cursor' ? 'Mauszeiger – dein Freund sieht jede Bewegung' : mode === 'temp' ? 'Zeichnen (verblasst) – Maustaste gedrückt halten' : 'Zeichnen (bleibt) – mit dem Papierkorb löschen', 3000);
  }

  function sendDraw(msg) {
    if (!viewer.peer || !viewer.peer.connected) return;
    const payload = { d: 1, ...msg, c: draw.color, w: draw.size, t: draw.tool, n: state.settings.displayName || '' };
    if (msg.k === 'clear' || msg.k === 'off') viewer.peer.sendCtl(payload);
    else viewer.peer.sendFast(payload);
  }

  /* ---- drawing options panel: tool, colour (any), size ---- */

  function paintPreview() {
    const c = $('sizePreview');
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const look = Style.penStyle(draw.tool, draw.size, 0.55);
    g.globalAlpha = look.alpha;
    g.strokeStyle = draw.color;
    g.lineWidth = look.lineWidth;
    g.lineCap = look.cap;
    g.lineJoin = 'round';
    g.beginPath();
    for (let x = 12; x <= c.width - 12; x += 4) {
      const y = c.height / 2 + Math.sin(x / 11) * (c.height * 0.2);
      if (x === 12) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }

  function renderDrawPanel() {
    const panel = $('drawPanel');
    const pen = draw.mode === 'temp' || draw.mode === 'perm';
    // the mouse pointer is always the plain white standard pointer: nothing to set
    panel.classList.toggle('hidden', !pen && draw.mode !== 'image');
    $('toolRow').classList.toggle('hidden', !pen);
    $('colorRow').classList.toggle('hidden', !pen);
    $('sizeRow').classList.toggle('hidden', !pen);
    $('imageRow').classList.toggle('hidden', draw.mode !== 'image');
    if (!pen) return;
    for (const b of panel.querySelectorAll('.tool-btn[data-tool]')) b.classList.toggle('active', b.dataset.tool === draw.tool);
    for (const b of $('swatches').children) b.classList.toggle('active', b.dataset.color === draw.color);
    $('colorCustom').value = draw.color;
    $('sizeRange').value = String(draw.size);
    $('sizeLabel').textContent = 'Dicke';
    paintPreview();
  }

  function setDrawOption(key, value) {
    if (key === 'color') draw.color = Style.cleanColor(value, draw.color);
    else if (key === 'size') draw.size = Style.cleanSize(value);
    else if (key === 'tool') draw.tool = Style.cleanTool(value);
    setPref(`draw${key[0].toUpperCase()}${key.slice(1)}`, draw[key]);
    renderDrawPanel();
  }

  function bindDrawPanel() {
    const sw = $('swatches');
    for (const color of COLOR_PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.color = color;
      b.title = color;
      b.style.background = color;
      b.addEventListener('click', () => setDrawOption('color', color));
      sw.appendChild(b);
    }
    for (const b of $('drawPanel').querySelectorAll('.tool-btn[data-tool]')) b.addEventListener('click', () => setDrawOption('tool', b.dataset.tool));
    $('colorCustom').addEventListener('input', (e) => setDrawOption('color', e.target.value));
    $('sizeRange').addEventListener('input', (e) => setDrawOption('size', e.target.value));
    // Keep the panel clear of the bar even when the bar wraps onto two lines.
    new ResizeObserver(() => $('viewerWrap').style.setProperty('--bar-h', `${$('streamBar').offsetHeight}px`)).observe($('streamBar'));
  }

  function contentRect() {
    const v = $('remoteVideo');
    if (!v.videoWidth || !draw.W) return null;
    const scale = viewer.zoom === 'fill' ? Math.max(draw.W / v.videoWidth, draw.H / v.videoHeight) : Math.min(draw.W / v.videoWidth, draw.H / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    return { x: (draw.W - w) / 2, y: (draw.H - h) / 2, w, h };
  }

  function normalizedPoint(e) {
    const rect = contentRect();
    if (!rect) return null;
    const box = $('drawCanvas').getBoundingClientRect();
    const x = (e.clientX - box.left - rect.x) / rect.w;
    const y = (e.clientY - box.top - rect.y) / rect.h;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  }

  function queueDraw(msg) {
    draw.pending = msg;
    if (draw.sendTimer) return;
    draw.sendTimer = setTimeout(() => {
      draw.sendTimer = 0;
      if (draw.pending) sendDraw(draw.pending);
      draw.pending = null;
    }, 20);
  }

  function drawKick() {
    if (!draw.raf) draw.raf = requestAnimationFrame(drawFrame);
  }

  function drawFrame(now) {
    draw.raf = 0;
    const canvas = $('drawCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const rect = contentRect();
    if (!rect) return;
    const dpr = draw.dpr;
    const scale = (rect.w * dpr) / 1920;
    let active = false;
    drawPictures(ctx, rect, dpr);
    draw.strokes = draw.strokes.filter((s) => s.perm || now - s.last < TEMP_HOLD_MS + TEMP_FADE_MS);
    for (const s of draw.strokes) {
      let alpha = 1;
      if (!s.perm) {
        active = true;
        const age = now - s.last;
        alpha = age <= TEMP_HOLD_MS ? 1 : 1 - (age - TEMP_HOLD_MS) / TEMP_FADE_MS;
      }
      const look = Style.penStyle(s.t, s.w, scale);
      ctx.globalAlpha = alpha * look.alpha;
      ctx.strokeStyle = s.c;
      ctx.lineWidth = look.lineWidth * (s.perm ? 1.1 : 1);
      ctx.lineCap = look.cap;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      s.pts.forEach((p, i) => {
        const x = (rect.x + p[0] * rect.w) * dpr;
        const y = (rect.y + p[1] * rect.h) * dpr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (s.pts.length === 1) ctx.lineTo((rect.x + s.pts[0][0] * rect.w) * dpr + 0.1, (rect.y + s.pts[0][1] * rect.h) * dpr);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (active) drawKick();
  }

  function drawResize() {
    const canvas = $('drawCanvas');
    const box = $('viewerWrap').getBoundingClientRect();
    draw.dpr = window.devicePixelRatio || 1;
    draw.W = box.width;
    draw.H = box.height;
    canvas.width = Math.max(1, Math.round(box.width * draw.dpr));
    canvas.height = Math.max(1, Math.round(box.height * draw.dpr));
    drawKick();
  }

  /* ---- pictures on the streamer's screen ---- */

  const pics = { list: [], sel: null, drag: null, seq: 0, pendingId: null, sendTimer: 0 };
  const PIC_MAX_DIM = 1600;
  const PIC_MAX_BYTES = 3_500_000;
  const PIC_MAX_COUNT = 8;
  const HANDLE_R = 11;
  const ROT_OFFSET = 30;

  const picById = (id) => pics.list.find((p) => p.id === id);

  function picGeometry(p, rect) {
    return Style.imageGeometry(p.t, p.nat, rect.w, rect.h);
  }

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function addPictureFile(file) {
    if (!canDraw()) {
      toast('Bilder gehen nur, wenn du verbunden bist und der Streamer Zeichnen erlaubt.', 'error', 4000);
      return;
    }
    if (pics.list.length >= PIC_MAX_COUNT) {
      toast(`Höchstens ${PIC_MAX_COUNT} Bilder gleichzeitig – entferne erst eins.`, 'error', 4000);
      return;
    }
    let bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch {
      toast('Diese Datei konnte nicht als Bild gelesen werden.', 'error', 4000);
      return;
    }
    const scale = Math.min(1, PIC_MAX_DIM / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close();
    let blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/webp', 0.9));
    if (!blob || blob.type !== 'image/webp') blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
    for (let q = 0.8; blob && blob.size > PIC_MAX_BYTES && q > 0.35; q -= 0.15) blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/webp', q));
    if (!blob || blob.size > PIC_MAX_BYTES) {
      toast('Das Bild ist zu groß.', 'error', 4000);
      return;
    }
    const b64 = arrayBufferToBase64(await blob.arrayBuffer());
    const id = `${Date.now().toString(36)}${(pics.seq++).toString(36)}`.slice(-14);
    const rect = contentRect();
    if (!rect) return;
    const aspect = w / h;
    const t = Style.cleanTransform({ x: 0.5, y: 0.5, w: Math.min(0.4, (0.5 * rect.h * aspect) / rect.w), rot: 0 });
    pics.list.push({ id, canvas: cv, nat: { w, h }, t });
    pics.sel = id;
    drawSetMode('image');
    drawKick();
    try {
      await uploadPicture(id, blob.type, b64);
      sendPicTransform(id, true);
    } catch (err) {
      toast(`Bild konnte nicht gesendet werden: ${errText(err)}`, 'error', 5000);
    }
  }

  async function uploadPicture(id, mime, b64) {
    const peer = viewer.peer;
    const n = Math.ceil(b64.length / CLIP_CHUNK);
    await sendBig(peer, { t: 'img-start', i: id, n, mime });
    for (let j = 0; j < n; j++) await sendBig(peer, { t: 'img-chunk', i: id, j, d: b64.slice(j * CLIP_CHUNK, (j + 1) * CLIP_CHUNK) });
  }

  function sendPicTransform(id, reliable) {
    const p = picById(id);
    if (!p || !viewer.peer || !viewer.peer.connected) return;
    const msg = { d: 1, k: 'imgt', i: id, x: p.t.x, y: p.t.y, w: p.t.w, rot: p.t.rot, cl: p.t.cl, ct: p.t.ct, cr: p.t.cr, cb: p.t.cb };
    if (reliable) viewer.peer.sendCtl(msg);
    else viewer.peer.sendFast(msg);
  }

  function queuePicSend(id) {
    pics.pendingId = id;
    if (pics.sendTimer) return;
    pics.sendTimer = setTimeout(() => {
      pics.sendTimer = 0;
      const pending = pics.pendingId;
      pics.pendingId = null;
      if (pending) sendPicTransform(pending, false);
    }, 25);
  }

  function removePicture(id) {
    const i = pics.list.findIndex((p) => p.id === id);
    if (i < 0) return;
    pics.list.splice(i, 1);
    if (pics.sel === id) pics.sel = null;
    if (viewer.peer && viewer.peer.connected) viewer.peer.sendCtl({ d: 1, k: 'imgdel', i: id });
    drawKick();
  }

  function clearPictures() {
    pics.list = [];
    pics.sel = null;
    pics.drag = null;
  }

  /** Pointer in content pixels (relative to the shown picture of the stream). */
  function picPointer(e) {
    const rect = contentRect();
    if (!rect) return null;
    const box = $('drawCanvas').getBoundingClientRect();
    return { rect, x: e.clientX - box.left - rect.x, y: e.clientY - box.top - rect.y };
  }

  function picHit(pt) {
    const sel = picById(pics.sel);
    if (sel) {
      const g = picGeometry(sel, pt.rect);
      const l = Style.toImageSpace(g, pt.x, pt.y);
      if (Math.hypot(l.lx, l.ly + g.ph / 2 + ROT_OFFSET) < HANDLE_R + 3) return { pic: sel, part: 'rot' };
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        if (Math.hypot(l.lx - (sx * g.pw) / 2, l.ly - (sy * g.ph) / 2) < HANDLE_R + 3) return { pic: sel, part: 'corner' };
      }
    }
    for (let i = pics.list.length - 1; i >= 0; i--) {
      const p = pics.list[i];
      const g = picGeometry(p, pt.rect);
      const l = Style.toImageSpace(g, pt.x, pt.y);
      if (Math.abs(l.lx) <= g.pw / 2 && Math.abs(l.ly) <= g.ph / 2) return { pic: p, part: 'body' };
    }
    return null;
  }

  function picPointerDown(e) {
    const pt = picPointer(e);
    if (!pt) return;
    const hit = picHit(pt);
    if (!hit) {
      pics.sel = null;
      drawKick();
      return;
    }
    e.preventDefault();
    $('drawCanvas').setPointerCapture(e.pointerId);
    const p = hit.pic;
    pics.sel = p.id;
    // bring to front
    pics.list.splice(pics.list.indexOf(p), 1);
    pics.list.push(p);
    const g = picGeometry(p, pt.rect);
    if (hit.part === 'body' && e.altKey) {
      const l = Style.toImageSpace(g, pt.x, pt.y);
      pics.drag = { type: 'crop', id: p.id, u0: l.u, v0: l.v, u1: l.u, v1: l.v };
    } else if (hit.part === 'rot') {
      pics.drag = { type: 'rot', id: p.id };
    } else if (hit.part === 'corner') {
      pics.drag = { type: 'scale', id: p.id, d0: Math.max(10, Math.hypot(pt.x - g.cx, pt.y - g.cy)), w0: p.t.w };
    } else {
      pics.drag = { type: 'move', id: p.id, ox: g.cx - pt.x, oy: g.cy - pt.y };
    }
    drawKick();
  }

  function picPointerMove(e) {
    const pt = picPointer(e);
    if (!pt) return;
    const d = pics.drag;
    if (!d) {
      const hit = picHit(pt);
      $('drawCanvas').style.cursor = !hit ? 'default' : hit.part === 'rot' ? 'grab' : hit.part === 'corner' ? 'nwse-resize' : e.altKey ? 'crosshair' : 'move';
      return;
    }
    const p = picById(d.id);
    if (!p) return;
    const g = picGeometry(p, pt.rect);
    if (d.type === 'move') {
      p.t = Style.cleanTransform({ ...p.t, x: (pt.x + d.ox) / pt.rect.w, y: (pt.y + d.oy) / pt.rect.h });
    } else if (d.type === 'scale') {
      const dist = Math.max(10, Math.hypot(pt.x - g.cx, pt.y - g.cy));
      p.t = Style.cleanTransform({ ...p.t, w: d.w0 * (dist / d.d0) });
    } else if (d.type === 'rot') {
      let rot = Math.atan2(pt.y - g.cy, pt.x - g.cx) + Math.PI / 2;
      if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
      p.t = Style.cleanTransform({ ...p.t, rot });
    } else if (d.type === 'crop') {
      const l = Style.toImageSpace(g, pt.x, pt.y);
      d.u1 = Math.min(1, Math.max(0, l.u));
      d.v1 = Math.min(1, Math.max(0, l.v));
    }
    if (d.type !== 'crop') queuePicSend(p.id);
    drawKick();
  }

  function picPointerUp() {
    const d = pics.drag;
    pics.drag = null;
    if (!d) return;
    const p = picById(d.id);
    if (!p) return;
    if (d.type === 'crop') {
      const rect = contentRect();
      if (rect) p.t = Style.cropTo(p.t, p.nat, d.u0, d.v0, d.u1, d.v1, rect.w, rect.h);
    }
    sendPicTransform(p.id, true);
    drawKick();
  }

  /** The picture being edited, drawn locally with its frame and handles (everything else is in the stream anyway). */
  function drawPictures(ctx, rect, dpr) {
    if (draw.mode !== 'image') return;
    for (const p of pics.list) {
      const g = picGeometry(p, rect);
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.translate((rect.x + g.cx) * dpr, (rect.y + g.cy) * dpr);
      ctx.rotate(g.rot);
      ctx.drawImage(p.canvas, g.sx, g.sy, g.sw, g.sh, (-g.pw / 2) * dpr, (-g.ph / 2) * dpr, g.pw * dpr, g.ph * dpr);
      if (p.id === pics.sel) {
        const hw = (g.pw / 2) * dpr;
        const hh = (g.ph / 2) * dpr;
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = '#5865f2';
        ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
        ctx.beginPath();
        ctx.moveTo(0, -hh);
        ctx.lineTo(0, -hh - ROT_OFFSET * dpr);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [0, -hh - ROT_OFFSET * dpr]]) {
          ctx.beginPath();
          ctx.arc(x, y, 6 * dpr, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        const d = pics.drag;
        if (d && d.type === 'crop') {
          const u0 = Math.min(d.u0, d.u1);
          const u1 = Math.max(d.u0, d.u1);
          const v0 = Math.min(d.v0, d.v1);
          const v1 = Math.max(d.v0, d.v1);
          ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
          ctx.fillRect(-hw, -hh, hw * 2, hh * 2);
          ctx.save();
          ctx.beginPath();
          ctx.rect(-hw + u0 * hw * 2, -hh + v0 * hh * 2, (u1 - u0) * hw * 2, (v1 - v0) * hh * 2);
          ctx.clip();
          ctx.drawImage(p.canvas, g.sx, g.sy, g.sw, g.sh, -hw, -hh, hw * 2, hh * 2);
          ctx.restore();
          ctx.setLineDash([6 * dpr, 4 * dpr]);
          ctx.strokeStyle = '#ffffff';
          ctx.strokeRect(-hw + u0 * hw * 2, -hh + v0 * hh * 2, (u1 - u0) * hw * 2, (v1 - v0) * hh * 2);
          ctx.setLineDash([]);
        }
      }
      ctx.restore();
    }
  }

  function bindPictures() {
    const canvas = $('drawCanvas');
    $('btnImage').addEventListener('click', () => {
      if (draw.mode === 'image') {
        drawSetMode(null);
        return;
      }
      drawSetMode('image');
      if (!pics.list.length) $('imgFile').click();
    });
    $('btnImgAdd').addEventListener('click', () => $('imgFile').click());
    $('imgFile').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      for (const f of files.slice(0, PIC_MAX_COUNT)) await addPictureFile(f);
    });
    $('btnImgDelete').addEventListener('click', () => pics.sel && removePicture(pics.sel));
    $('btnImgReset').addEventListener('click', () => {
      const p = picById(pics.sel);
      if (!p) return;
      const rect = contentRect();
      if (!rect) return;
      // back to the full picture, keeping its centre and its width on screen where possible
      const fw = 1 - p.t.cl - p.t.cr;
      p.t = Style.cleanTransform({ ...p.t, cl: 0, cr: 0, ct: 0, cb: 0, w: p.t.w / fw });
      sendPicTransform(p.id, true);
      drawKick();
    });
    canvas.addEventListener('wheel', (e) => {
      const p = picById(pics.sel);
      if (draw.mode !== 'image' || !p) return;
      e.preventDefault();
      p.t = Style.cleanTransform({ ...p.t, w: p.t.w * (e.deltaY < 0 ? 1.06 : 1 / 1.06) });
      queuePicSend(p.id);
      drawKick();
    }, { passive: false });
    // paste (Strg+V) and drag & drop of image files anywhere on the viewer
    window.addEventListener('paste', (e) => {
      if (!viewer.peer || ctl.engaged || ['INPUT', 'TEXTAREA'].includes((e.target && e.target.tagName) || '')) return;
      const file = [...((e.clipboardData && e.clipboardData.files) || [])].find((f) => f.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        addPictureFile(file);
      }
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); // never let the window navigate to a dropped file
      if (!viewer.peer) return;
      for (const f of [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((x) => x.type.startsWith('image/')).slice(0, PIC_MAX_COUNT)) addPictureFile(f);
    });
  }

  function bindDrawing() {
    const canvas = $('drawCanvas');
    new ResizeObserver(drawResize).observe($('viewerWrap'));
    bindDrawPanel();
    bindPictures();
    canvas.addEventListener('pointerdown', (e) => {
      if (draw.mode === 'image') {
        picPointerDown(e);
        return;
      }
      if (draw.mode !== 'temp' && draw.mode !== 'perm') return;
      const p = normalizedPoint(e);
      if (!p) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      draw.down = true;
      draw.strokeId = (draw.strokeId + 1) % 100000;
      draw.strokes.push({ pts: [[p.x, p.y]], last: performance.now(), perm: draw.mode === 'perm', c: draw.color, w: draw.size, t: draw.tool });
      sendDraw({ k: 'pen', x: p.x, y: p.y, s: draw.strokeId, perm: draw.mode === 'perm' });
      drawKick();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (draw.mode === 'image') {
        picPointerMove(e);
        return;
      }
      if (!draw.mode) return;
      const p = normalizedPoint(e);
      if (!p) return;
      const now = performance.now();
      if (draw.mode === 'cursor') {
        draw.lastPos = { x: p.x, y: p.y };
        queueDraw({ k: 'cursor', x: p.x, y: p.y });
      } else if (draw.down) {
        const s = draw.strokes[draw.strokes.length - 1];
        if (s && s.pts.length < 4000) s.pts.push([p.x, p.y]);
        if (s) s.last = now;
        queueDraw({ k: 'pen', x: p.x, y: p.y, s: draw.strokeId, perm: draw.mode === 'perm' });
      }
      drawKick();
    });
    const up = () => {
      draw.down = false;
      if (draw.mode === 'image') picPointerUp();
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => {
      if (draw.mode === 'cursor') {
        draw.lastPos = null;
        sendDraw({ k: 'off' });
      }
    });
    const toggle = (m) => drawSetMode(draw.mode === m ? null : m);
    $('btnImage').dataset.mode = 'image';
    $('btnCursor').addEventListener('click', () => toggle('cursor'));
    $('btnPenTemp').addEventListener('click', () => toggle('temp'));
    $('btnPenPerm').addEventListener('click', () => toggle('perm'));
    $('btnClearMine').addEventListener('click', () => {
      clearPictures();
      draw.strokes = [];
      draw.lastPos = null;
      sendDraw({ k: 'clear' });
      drawKick();
      if (draw.mode === 'cursor') draw.lastPos = null;
    });
    window.addEventListener('keydown', (e) => {
      if (!viewer.peer || ctl.engaged || e.ctrlKey || e.altKey || e.metaKey || ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target && e.target.tagName) || '')) return;
      if (e.code === 'KeyM' || e.code === 'KeyL') toggle('cursor');
      else if (e.code === 'KeyP') toggle('temp');
      else if (e.code === 'KeyO') toggle('perm');
      else if (e.code === 'KeyC') $('btnClearMine').click();
      else if (e.code === 'KeyB') toggle('image');
      else if ((e.code === 'Delete' || e.code === 'Backspace') && draw.mode === 'image' && pics.sel) removePicture(pics.sel);
      else if (e.code === 'KeyF' || e.code === 'F11') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.code === 'Escape' && draw.mode) drawSetMode(null);
    });
  }

  /* ---- remote control (viewer side) ---- */

  const ctl = { state: 'idle', engaged: false, clip: null, timer: null, pendingMove: null, moveTimer: 0, chain: Promise.resolve(), fullscreen: false, hook: false };

  function setControlStatus(text, kind = '') {
    $('controlBar').classList.toggle('hidden', ctl.state === 'idle');
    $('controlStatus').textContent = text;
    $('controlStatus').className = `remote-status ${kind}`;
    $('btnEngage').classList.toggle('hidden', ctl.state !== 'granted' || ctl.engaged);
    $('btnReleaseControl').classList.toggle('hidden', ctl.state === 'idle');
    $('btnReleaseControl').textContent = ctl.state === 'requesting' ? 'Anfrage abbrechen' : 'Zugriff beenden';
  }

  function requestControl() {
    if (!viewer.peer || ctl.state !== 'idle') return;
    drawSetMode(null);
    ctl.state = 'requesting';
    setControlStatus('Warte auf Bestätigung durch den Streamer …', 'warn');
    updateViewerTools();
    viewer.peer.sendCtl({ t: 'req' });
    clearTimeout(ctl.timer);
    ctl.timer = setTimeout(() => {
      if (ctl.state === 'requesting') {
        endControl(null, true);
        toast('Keine Antwort vom Streamer.', 'error');
      }
    }, 45_000);
  }

  function onGrant(msg) {
    clearTimeout(ctl.timer);
    if (ctl.state !== 'requesting') return;
    if (!msg.ok) {
      endControl(null, false);
      toast(msg.reason || 'Zugriff abgelehnt.', 'error', 7000);
      return;
    }
    ctl.state = 'granted';
    setControlStatus('Zugriff erlaubt – klicke auf „Steuerung übernehmen“.', 'ok');
    ctl.clip = new ClipSync((m) => sendBig(viewer.peer, m));
    ctl.clip.start();
    updateViewerTools();
    toast('Der Streamer hat den Zugriff erlaubt.', 'ok');
  }

  function endControl(_reason, notify) {
    if (ctl.state === 'idle') return;
    clearTimeout(ctl.timer);
    if (notify && viewer.peer) viewer.peer.sendCtl({ t: 'end' });
    disengage();
    ctl.clip && ctl.clip.stop();
    ctl.clip = null;
    ctl.state = 'idle';
    setControlStatus('');
    updateViewerTools();
  }

  const KILL_HINT = 'Strg+Alt+Shift+R';

  async function engage() {
    if (ctl.state !== 'granted' || ctl.engaged) return;
    ctl.engaged = true;
    $('viewerWrap').classList.add('controlling');
    $('controlOverlay').classList.remove('hidden');
    $('streamBar').classList.add('idle');
    setControlStatus(`Du steuerst den PC von ${viewer.info.name || 'deinem Freund'}. ${KILL_HINT} gibt Maus & Tastatur frei.`, 'ok');
    window.addEventListener('keydown', onControlKey, true);
    window.addEventListener('keyup', onControlKey, true);
    window.addEventListener('blur', onControlBlur);
    const wrap = $('viewerWrap');
    wrap.addEventListener('mousemove', onControlMove);
    wrap.addEventListener('mousedown', onControlButton);
    wrap.addEventListener('mouseup', onControlButton);
    wrap.addEventListener('wheel', onControlWheel, { passive: false });
    wrap.addEventListener('contextmenu', block);
    try {
      ctl.hook = await stf.keyHook(true);
    } catch {
      ctl.hook = false;
    }
    if (!ctl.hook) toast('Windows-Taste und Alt+Tab können hier nicht abgefangen werden und wirken lokal.', 'error', 6000);
    try {
      if (!document.fullscreenElement) {
        await wrap.requestFullscreen();
        ctl.fullscreen = true;
      }
    } catch {
      /* stays windowed */
    }
  }

  function disengage() {
    if (!ctl.engaged) return;
    ctl.engaged = false;
    $('viewerWrap').classList.remove('controlling');
    $('controlOverlay').classList.add('hidden');
    window.removeEventListener('keydown', onControlKey, true);
    window.removeEventListener('keyup', onControlKey, true);
    window.removeEventListener('blur', onControlBlur);
    const wrap = $('viewerWrap');
    wrap.removeEventListener('mousemove', onControlMove);
    wrap.removeEventListener('mousedown', onControlButton);
    wrap.removeEventListener('mouseup', onControlButton);
    wrap.removeEventListener('wheel', onControlWheel);
    wrap.removeEventListener('contextmenu', block);
    clearTimeout(ctl.moveTimer);
    ctl.moveTimer = 0;
    ctl.pendingMove = null;
    if (viewer.peer && ctl.state === 'granted') viewer.peer.sendCtl({ t: 'rel' });
    if (ctl.hook) stf.keyHook(false);
    ctl.hook = false;
    if (ctl.fullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    ctl.fullscreen = false;
    if (ctl.state === 'granted') setControlStatus('Zugriff erlaubt – Steuerung ist pausiert.', 'ok');
    showBar();
  }

  const block = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  function sendInput(msg, fast = false) {
    if (!viewer.peer || ctl.state !== 'granted') return;
    if (fast) viewer.peer.sendFast(msg);
    else viewer.peer.sendCtl(msg);
  }

  function videoPoint(e) {
    const v = $('remoteVideo');
    if (!v.videoWidth) return null;
    const r = v.getBoundingClientRect();
    const scale = viewer.zoom === 'fill' ? Math.max(r.width / v.videoWidth, r.height / v.videoHeight) : Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const cw = v.videoWidth * scale;
    const ch = v.videoHeight * scale;
    const x = (e.clientX - (r.left + (r.width - cw) / 2)) / cw;
    const y = (e.clientY - (r.top + (r.height - ch) / 2)) / ch;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
  }

  function onControlMove(e) {
    const p = videoPoint(e);
    if (!p || !p.inside) return;
    ctl.pendingMove = p;
    if (ctl.moveTimer) return;
    // a timer, not rAF: rAF stops in occluded windows
    ctl.moveTimer = setTimeout(() => {
      ctl.moveTimer = 0;
      const m = ctl.pendingMove;
      ctl.pendingMove = null;
      if (m) sendInput({ t: 'mm', x: m.x, y: m.y }, true);
    }, 8);
  }

  function onControlButton(e) {
    e.preventDefault();
    const p = videoPoint(e);
    if (!p || (!p.inside && e.type === 'mousedown')) return;
    sendInput({ t: e.type === 'mousedown' ? 'md' : 'mu', b: e.button, x: p.x, y: p.y });
  }

  function onControlWheel(e) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 3 : 1 / 100;
    sendInput({ t: 'wh', dx: e.deltaX * unit, dy: e.deltaY * unit });
  }

  const onControlBlur = () => sendInput({ t: 'rel' });

  function onControlKey(e) {
    if (!ctl.engaged) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'keydown' && e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyR') return disengage();
    if (!e.code || e.code === 'Unidentified') return;
    const down = e.type === 'keydown';
    const flush = down && e.code === 'KeyV' && e.ctrlKey && ctl.clip;
    const msg = { t: down ? 'kd' : 'ku', code: e.code };
    ctl.chain = ctl.chain
      .then(async () => {
        if (flush) await ctl.clip.pollNow();
        sendInput(msg);
      })
      .catch(() => {});
  }

  function bindControl() {
    $('btnControl').addEventListener('click', requestControl);
    $('btnEngage').addEventListener('click', engage);
    $('btnReleaseControl').addEventListener('click', () => endControl(null, true));
    $('remoteVideo').addEventListener('mousedown', () => ctl.state === 'granted' && !ctl.engaged && engage());
    stf.onHookKey((ev) => {
      if (!ctl.engaged || !ev || typeof ev.code !== 'string') return;
      ctl.chain = ctl.chain.then(() => sendInput({ t: ev.type === 'down' ? 'kd' : 'ku', code: ev.code })).catch(() => {});
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && ctl.engaged) ctl.fullscreen = false;
      drawResize();
    });
  }

  /* ================================================================== */
  /* 8. shared clipboard                                                 */
  /* ================================================================== */

  const CLIP_CHUNK = 40_000;

  /** Sends possibly large messages in pieces, waiting while the data channel's buffer is full. */
  async function sendBig(peer, msg) {
    if (!peer || !peer.ctl) return;
    peer.sendCtl(msg);
    while (peer.ctl && peer.ctl.bufferedAmount > 2_000_000) await sleep(20);
  }

  /** Bidirectional clipboard sync (text and images) while a remote-control session is active. */
  class ClipSync {
    constructor(send) {
      this.send = send;
      this.lastToken = null;
      this.lastKey = '';
      this.timer = null;
      this.busy = false;
      this.stopped = false;
      this.incoming = new Map();
      this.chain = Promise.resolve();
    }

    async start() {
      try {
        this.lastToken = await stf.clipboardToken();
      } catch {
        this.lastToken = null;
      }
      if (!this.stopped) this.timer = setInterval(() => this.pollNow(), 400);
    }

    stop() {
      this.stopped = true;
      clearInterval(this.timer);
    }

    async pollNow() {
      if (this.busy || this.stopped) return;
      this.busy = true;
      try {
        const token = await stf.clipboardToken();
        if (token === this.lastToken) return;
        this.lastToken = token;
        const c = await stf.clipboardRead();
        const payload = c.text ? { kind: 'text', data: c.text } : c.image ? { kind: 'image', data: c.image } : null;
        const key = payload ? `${payload.kind}:${payload.data}` : '';
        if (!payload || key === this.lastKey) return;
        this.lastKey = key;
        const json = JSON.stringify(payload);
        const id = Math.random().toString(36).slice(2, 10);
        const n = Math.ceil(json.length / CLIP_CHUNK);
        await this.send({ t: 'clip-start', id, n });
        for (let i = 0; i < n; i++) await this.send({ t: 'clip-chunk', id, i, d: json.slice(i * CLIP_CHUNK, (i + 1) * CLIP_CHUNK) });
      } catch (err) {
        console.warn('clipboard send failed', err);
      } finally {
        this.busy = false;
      }
    }

    handle(msg) {
      if (typeof msg.id !== 'string') return;
      if (msg.t === 'clip-start') {
        if (Number.isInteger(msg.n) && msg.n > 0 && msg.n < 400) this.incoming.set(msg.id, { n: msg.n, parts: [] });
        return;
      }
      const entry = this.incoming.get(msg.id);
      if (!entry || typeof msg.d !== 'string') return;
      entry.parts[msg.i] = msg.d;
      if (entry.parts.filter((x) => x !== undefined).length !== entry.n) return;
      this.incoming.delete(msg.id);
      this.chain = this.chain
        .then(async () => {
          if (this.stopped) return;
          let obj;
          try {
            obj = JSON.parse(entry.parts.join(''));
          } catch {
            return;
          }
          if (!obj || typeof obj.data !== 'string') return;
          this.lastKey = `${obj.kind}:${obj.data}`;
          this.lastToken = await stf.clipboardWrite(obj.kind === 'image' ? { image: obj.data } : { text: obj.data });
        })
        .catch(() => {});
    }
  }

  /* ================================================================== */
  /* 9. auto-update UI                                                   */
  /* ================================================================== */

  const updateUi = { status: { state: 'idle' }, dismissed: '' };

  function updateText(u) {
    switch (u.state) {
      case 'checking': return 'Suche nach Updates …';
      case 'available': return `Version ${u.version} gefunden – wird geladen …`;
      case 'downloading': return `Update wird geladen … ${u.percent || 0} %`;
      case 'downloaded': return state.settings && state.settings.autoUpdate === false ? `Version ${u.version} ist bereit – starte die App neu, um sie zu installieren.` : `Version ${u.version} ist bereit – die App startet gleich von selbst neu.`;
      case 'none': return 'Du hast die neueste Version.';
      case 'error': return `Update-Fehler: ${u.message || 'unbekannt'}`;
      case 'disabled': return u.message || 'Updates sind deaktiviert.';
      default: return u.lastChecked ? 'Du hast die neueste Version.' : 'Noch nicht geprüft.';
    }
  }

  /** The banner only slides in when nothing would be interrupted – never while sharing or watching. */
  function refreshUpdateBanner() {
    const u = updateUi.status;
    $('updateBanner').classList.toggle('show', u.state === 'downloaded' && updateUi.dismissed !== u.version && !isBusy());
    $('updateBannerText').textContent = `Update verfügbar – Version ${u.version || ''} ist bereit`;
    const mini = $('updateMini');
    const dl = u.state === 'downloading' || u.state === 'available';
    mini.classList.toggle('hidden', !dl);
    mini.textContent = dl ? `Update lädt … ${u.percent || 0} %` : '';
  }

  /**
   * A downloaded update restarts the app by itself as soon as nothing is being shared or watched
   * (and the user did not choose "Später" or switch automatic updates off).
   */
  function maybeAutoInstall() {
    const u = updateUi.status;
    if (u.state !== 'downloaded' || state.settings.autoUpdate === false || updateUi.dismissed === u.version || updateUi.installing || isBusy()) return;
    updateUi.installing = true;
    toast(`Version ${u.version} wird installiert – ShareToFriends startet gleich von selbst neu.`, 'ok', 8000);
    setTimeout(() => {
      if (isBusy()) {
        updateUi.installing = false; // someone started sharing in the meantime: try again later
        return;
      }
      stf.updaterInstall();
    }, 6000);
  }

  function renderUpdate(u) {
    const prev = updateUi.status.state;
    updateUi.status = u;
    refreshUpdateInfo();
    refreshUpdateBanner();
    maybeAutoInstall();
    if (u.state === 'downloaded' && prev !== 'downloaded' && isBusy()) toast('Ein Update ist bereit. Die App startet von selbst neu, sobald du nichts mehr teilst oder ansiehst.', 'ok', 6000);
  }

  /* ================================================================== */
  /* 10. settings & bootstrap                                            */
  /* ================================================================== */

  function settingsForm() {
    return { displayName: $('setName').value, serverUrl: $('setServer').value, autoUpdate: $('setAutoUpdate').checked };
  }

  /** Version, last check and status in the settings (also re-read while the dialog is open, so "vor 3 Min." stays true). */
  function refreshUpdateInfo() {
    const u = updateUi.status;
    $('updVersion').textContent = u.currentVersion || (state.info && state.info.version) || '';
    $('updLast').textContent = u.lastChecked ? timeAgo(u.lastChecked) : 'noch nicht';
    $('updateStatusText').textContent = updateText(u);
  }

  function openSettings() {
    const s = state.settings;
    $('setName').value = s.displayName;
    $('setServer').value = s.serverUrl;
    $('setAutoUpdate').checked = s.autoUpdate !== false;
    $('settingsError').classList.add('hidden');
    refreshUpdateInfo();
    $('appVersion').textContent = state.info ? `Version ${state.info.version} · ID ${A.formatId(state.myId)}` : '';
    $('settingsDialog').showModal();
  }

  async function saveSettings(e) {
    e.preventDefault();
    try {
      const before = state.settings.serverUrl;
      state.settings = await stf.saveSettings(settingsForm());
      $('settingsDialog').close();
      renderIdentity();
      if (state.settings.serverUrl !== before) state.sig.restart();
      toast('Einstellungen gespeichert.', 'ok');
    } catch (err) {
      $('settingsError').textContent = errText(err);
      $('settingsError').classList.remove('hidden');
    }
  }

  function bindSettings() {
    $('btnSettings').addEventListener('click', openSettings);
    $('btnCloseSettings').addEventListener('click', () => $('settingsDialog').close());
    $('settingsForm').addEventListener('submit', saveSettings);
    $('userAvatar').parentElement.addEventListener('click', openSettings);
    stf.onUpdaterStatus(renderUpdate);
    stf.updaterGet().then(renderUpdate);
    $('btnUpdateNow').addEventListener('click', () => stf.updaterInstall());
    setInterval(maybeAutoInstall, 15_000); // a friend left, the stream ended: the waiting update can go now
    $('btnUpdateLater').addEventListener('click', () => {
      updateUi.dismissed = updateUi.status.version || '';
      refreshUpdateBanner();
    });
    $('btnCheckUpdate').addEventListener('click', () => stf.updaterCheck());
    // the switch takes effect right away (it only changes the update behaviour, not the other fields of the form)
    $('setAutoUpdate').addEventListener('change', async () => {
      try {
        const s = state.settings;
        state.settings = await stf.saveSettings({ displayName: s.displayName, serverUrl: s.serverUrl, autoUpdate: $('setAutoUpdate').checked });
        toast($('setAutoUpdate').checked ? 'Automatische Updates sind an.' : 'Automatische Updates sind aus – du kannst jederzeit „Jetzt prüfen“ klicken.', 'ok', 3500);
      } catch (err) {
        $('setAutoUpdate').checked = !$('setAutoUpdate').checked;
        toast(errText(err), 'error');
      }
    });
    setInterval(() => $('settingsDialog').open && refreshUpdateInfo(), 20_000);
  }

  async function init() {
    document.body.classList.add(`platform-${stf.platform}`);
    const [settings, info] = await Promise.all([stf.getSettings(), stf.getInfo()]);
    state.settings = settings;
    state.info = info;
    state.prefs = settings.prefs || {};
    state.myId = settings.id;

    if (info.dev) window.__stfDebug = { state, host, viewer, ctl, apps, draw, pics, addPictureFile }; // dev builds only (for the automated tests)
    host.allowDraw = state.prefs.allowDraw !== false;
    $('chkAllowDraw').checked = host.allowDraw;
    applyHostQuality(/^f?[0-4]$/.test(String(state.prefs.hostQuality)) ? String(state.prefs.hostQuality) : '0', false);
    $('viewVolume').value = typeof state.prefs.volume === 'number' ? state.prefs.volume : 100;
    $('selQuality').value = ['0', '1', '2', '3', '4'].includes(state.prefs.quality) ? state.prefs.quality : '0';
    apps.mode = ['all', 'include', 'exclude'].includes(state.prefs.audioMode) ? state.prefs.audioMode : 'exclude';
    if (Array.isArray(state.prefs.audioNames)) apps.names = new Set(state.prefs.audioNames.filter((n) => typeof n === 'string').slice(0, 60));
    draw.color = Style.cleanColor(state.prefs.drawColor);
    draw.size = Style.cleanSize(state.prefs.drawSize);
    draw.tool = Style.cleanTool(state.prefs.drawTool);

    await initHostPassword();
    await loadFriends();
    $('chkRemember').checked = state.prefs.rememberPw !== false;
    $('rememberRow').classList.toggle('hidden', !state.persist);
    renderIdentity();
    renderFriends();
    bindSidebar();
    bindPicker();
    bindAudio();
    bindHost();
    bindViewer();
    bindDrawing();
    bindControl();
    bindSettings();
    setAudioMode(apps.mode);
    setZoom(['fit', 'fill', '100'].includes(state.prefs.zoom) ? state.prefs.zoom : 'fit');
    showView('welcome');
    renderHostChip();
    updateViewerTools();
    startSignaling();
    if (!settings.serverUrl) openSettings();

    window.__stfPerf = { uiReadyMs: Math.round(performance.now()), sinceProcessStartMs: info.startedAt ? Date.now() - info.startedAt : null };

    afterPaint(async () => {
      apps.supported = await stf.appAudioSupported();
      const remoteOk = await stf.remoteSupported();
      if (!remoteOk) $('btnControl').title = 'Fernsteuerung ist nur gegenüber Windows-PCs möglich';
      startMeters();
      clearInterval(apps.timer);
      apps.timer = setInterval(pollApps, 2500);
      window.__stfPerf.fullyLoadedMs = Math.round(performance.now());
    }, 300);
  }

  window.addEventListener('beforeunload', () => {
    stf.remoteEnd('Fenster geschlossen');
    stf.appAudioStopAll();
    for (const p of host.peers.values()) p.close('closed');
    if (viewer.peer) viewer.peer.close('leave');
  });

  init().catch((err) => {
    console.error(err);
    toast(`Start fehlgeschlagen: ${errText(err)}`, 'error', 10000);
  });
})();
