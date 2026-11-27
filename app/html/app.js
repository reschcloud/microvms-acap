/*
 * Micro VMS – web UI for Axis cameras (ACAP)
 *
 * Live:      RTSP over WebSocket (/rtsp-over-websocket) -> MSE, via media-stream-library
 * Playback:  same pipeline with recordingid + npt offset
 * Timeline:  /axis-cgi/record/list.cgi
 * Export:    /axis-cgi/record/export/exportrecording.cgi (Matroska, optional ZIP/AES-256)
 * Channels:  Properties.Image.NbrOfViews + Image.I#.Name/Enabled  -> RTSP/HTTP param camera=N
 * Streams:   /axis-cgi/streamprofile.cgi (list)                   -> RTSP param streamprofile=…
 *
 * All requests go to the camera's own origin, so the browser's existing
 * camera login is reused automatically.
 */
(() => {
  'use strict';

  const MSL = window.mediaStreamLibrary;
  const { t } = window.I18N;
  const $ = (id) => document.getElementById(id);

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const LIVE_THRESHOLD = 5000;   // click closer than 5 s to "now" => live
  const SKIP = 30 * 1000;
  const SKIP_SHORT = 5 * 1000;
  const PAGE_SIZE = 5000;   // one request covers a normal day; larger ranges page below
  const MAX_PAGES = 10;
  const STORE = 'minivms.';       // preserve preferences on the same camera origin

  const state = {
    layout: 'auto',              // 'auto' | 1 | 2 | 4 | 6
    layoutSize: 1,               // resolved tile count
    tiles: [],                   // one pipeline controller per tile slot
    active: 0,
    mode: 'live',                // 'live' | 'playback' | 'paused'
    pipeline: null,
    generation: 0,               // guards against callbacks of old pipelines
    streamStatus: 'connecting',
    pendingSeek: null,
    manualRecording: null,
    rec: null,                   // recording currently playing
    startWall: 0,                // requested start time (ms)
    syncWall: null,              // NTP time of first frame (onSync)
    baseCt: null,                // video.currentTime at first frame (fallback)
    pausedAt: null,
    recordings: [],              // recordings of the selected channel
    recordingsByChannel: new Map(),
    unassignedRecordings: [],
    exportChannels: new Map(),   // channel -> export checkbox
    exportBoxes: [],             // { channel, input }: export checkboxes beside the lanes
    recordingNow: new Map(),     // channel -> the camera records it right now
    device: {},                  // model, serial, firmware, hostname, ipv4[], ipv6[]
    selectMode: false,           // export mode: dragging the timeline selects a range
    theater: false,
    zoomReturn: null,            // saved multi-view state while a tile is zoomed to 1-up
    viewStart: 0,
    viewEnd: 0,
    selStart: null,
    selEnd: null,
    disks: null,
    storageState: 'loading',
    channelCount: 1,
    channels: [{ camera: 1, name: t('channel.default', { n: 1 }) }],
    channel: 1,                  // VAPIX camera number (1-based)
    sourceCatalog: [],
    streamProfiles: [],
  };

  // ---------------------------------------------------------------- Tiles

  /**
   * Per-tile pipeline state. Six slots exist in the DOM; only state.layoutSize
   * of them are visible. Playback, retries and seeks stay identical per tile.
   */
  function createTile(index, channel = null) {
    return {
      id: index,
      el: $(`tile${index}`),
      video: $(index === 0 ? 'video' : `video${index + 1}`),
      channel,
      channelTouched: false,
      visible: index === 0,
      profile: 'auto',             // 'auto' or a stream profile name
      resolution: '',              // optional resolution override
      autoFallback: false,         // auto profile failed once -> camera default
      audio: false,                // audio track requested
      audioFailed: false,          // audio caused an RTSP error; retried muted
      muteUntilPlaying: false,     // unmute after the next playing event
      lastFrame: null,             // canvas with the last visible frame (pause/snapshot)
      picker: null,                // immediate channel chooser for empty tiles
      sourceChoices: null,         // { intent, time, choices } for an ambiguous lookup
      waitingFor: null,            // next recording to start when the shared clock reaches it
      noRecording: false,          // held at a time without footage
      pipeline: null,
      generation: 0,
      intent: null,
      endingIntent: null,
      streamTimer: null,
      streamStatus: 'connecting',
      pendingSeek: null,
      manualRecording: null,
      rec: null,
      mode: 'live',
      startWall: 0,
      syncWall: null,
      baseCt: null,
      pausedAt: null,
    };
  }

  const activeTile = () => state.tiles[state.active] || state.tiles[0];
  const visibleTiles = () => state.tiles.filter((tile) => tile.visible && tile.channel != null);
  const tileId = (tile, name) => (tile.id === 0 ? name : name + (tile.id + 1));

  for (let i = 0; i < 6; i++) state.tiles.push(createTile(i, i === 0 ? 1 : null));

  // Transitional accessors: existing call sites and tests read the active
  // tile as state.*. The real state lives in state.tiles[state.active].
  for (const key of ['channel', 'pipeline', 'generation', 'intent', 'endingIntent',
    'streamTimer', 'streamStatus', 'pendingSeek', 'manualRecording', 'rec', 'mode',
    'startWall', 'syncWall', 'baseCt', 'pausedAt']) {
    Object.defineProperty(state, key, {
      configurable: true,
      enumerable: true,
      get: () => activeTile()[key],
      set: (value) => { activeTile()[key] = value; },
    });
  }

  // ---------------------------------------------------------------- Utils

  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
  const recStop = (r) => r.stop ?? (r.status === 'recording' ? Date.now() : r.start);
  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const shiftDay = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
  const store = {
    get(k) { try { return localStorage.getItem(STORE + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(STORE + k, v); } catch (e) { /* ignore */ } },
  };

  function fmtTime(ms, withSeconds = true) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? ':' + pad(d.getSeconds()) : ''}`;
  }
  function fmtDate(ms) {
    const d = new Date(ms);
    return window.I18N.lang === 'de'
      ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const fmtDateTime = (ms) => `${fmtDate(ms)} ${fmtTime(ms)}`;
  function fmtOffset(ms) {
    const offset = -new Date(ms).getTimezoneOffset();
    return `UTC${offset >= 0 ? '+' : '−'}${pad(Math.trunc(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  }
  function fmtStamp(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  function toLocalInput(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function toDateInput(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const fromLocalInput = (s) => (s ? new Date(s).getTime() : NaN);
  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h} h ${pad(m)} min` : `${m} min ${pad(s % 60)} s`;
  }
  function fmtBytes(n) {
    if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
    return `${(n / 1024 ** 2).toFixed(1)} MB`;
  }

  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 6000 : 3000);
  }

  function videoMsg(tile, msg) {
    const el = $(tileId(tile, 'videoMsg'));
    if (!msg) { el.classList.add('hidden'); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  async function fetchText(url, opts) {
    let signal = opts?.signal;
    if (AbortSignal.timeout && (!signal || AbortSignal.any)) {
      const timeout = AbortSignal.timeout(12000);
      signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    }
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...opts, signal });
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} (${url.split('?')[0]})`), { status: res.status });
    return res.text();
  }

  async function fetchXml(url, opts) {
    const text = await fetchText(url, opts);
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error(t('err.xml'));
    return doc;
  }

  function xmlElement(doc, name) {
    const el = doc.getElementsByTagName(name)[0];
    if (!el) throw new Error(t('err.xml'));
    return el;
  }

  async function fetchParams(group) {
    const text = await fetchText(`/axis-cgi/param.cgi?action=list&group=${encodeURIComponent(group)}`);
    const out = {};
    text.split(/\r?\n/).forEach((l) => {
      const i = l.indexOf('=');
      if (i > 0 && !/^#|^Error/i.test(l)) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    });
    return out;
  }

  function download(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || '';   // always set, otherwise the browser navigates away
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ------------------------------------------------------------ Channels & streams

  const multiChannel = () => state.channelCount > 1;

  function autoLayoutSize() {
    const n = state.channels.length || state.channelCount || 1;
    return n <= 1 ? 1 : n === 2 ? 2 : n <= 4 ? 4 : 6;
  }

  const resolvedLayout = () => (state.layout === 'auto' ? autoLayoutSize() : Number(state.layout) || 1);

  const channelOptionText = (c) =>
    multiChannel() && c.name !== t('channel.default', { n: c.camera }) ? `${c.camera}: ${c.name}` : c.name;

  function loadLayoutPreference() {
    const saved = store.get('layout');
    if (['auto', '1', '2', '4', '6'].includes(saved)) state.layout = saved;
  }

  function syncLayoutControls() {
    const select = $('layoutSelect');
    if (select) select.value = String(state.layout);
    document.querySelectorAll?.('#layoutSeg [data-layout]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.layout === String(state.layout)));
    });
  }

  function applyLayout() {
    const size = resolvedLayout();
    state.layoutSize = size;
    $('videoGrid').className = `video-grid layout-${size}`;

    for (const tile of state.tiles) {
      const visible = tile.id < size;
      if (tile.visible && !visible) {
        tile.intent?.abort();
        stopPipeline(tile);
      }
      tile.visible = visible;
      tile.el.classList.toggle('hidden', !visible);
      if (!visible) continue;
      if (!tile.channelTouched) {
        const next = state.channels[tile.id] ? state.channels[tile.id].camera : null;
        if (next !== tile.channel) {
          tile.channel = next;
          loadTilePreferences(tile);
        }
      } else if (tile.channel != null && !state.channels.some((c) => c.camera === tile.channel)) {
        tile.channel = null;
        tile.channelTouched = false;
      }
    }

    const active = state.tiles[state.active];
    if (!active || !active.visible) {
      setActiveTile(state.tiles.find((tile) => tile.visible) || state.tiles[0]);
    }
    state.tiles.forEach((tile) => {
      tile.el.classList.toggle('active', tile.id === state.active);
      renderTileMenu(tile);
    });
    syncLayoutControls();
    renderPager();
    updateAllTileUi();
    updateModeUi(activeTile());
    resizeCanvas();
  }

  // ------------------------------------------------------------ Stream profiles

  function profileParam(profile, key) {
    try { return new URLSearchParams(profile.parameters || '').get(key); } catch (e) { return null; }
  }

  function profilePixels(profile) {
    const m = /^(\d+)x(\d+)$/i.exec(profileParam(profile, 'resolution') || '');
    return m ? Number(m[1]) * Number(m[2]) : null;
  }

  function profileBitrate(profile) {
    const n = Number(profileParam(profile, 'bitrate'));
    return Number.isFinite(n) ? n : 0;
  }

  /** Profiles with a usable resolution, smallest first. */
  function rankedProfiles() {
    return state.streamProfiles
      .map((profile, index) => ({ profile, index, pixels: profilePixels(profile), bitrate: profileBitrate(profile) }))
      .filter((p) => p.pixels != null)
      .sort((a, b) => a.pixels - b.pixels || a.bitrate - b.bitrate || a.index - b.index);
  }

  /** Single view gets the largest resolvable profile, multi view the smallest. */
  function autoProfileName() {
    const ranked = rankedProfiles();
    if (!ranked.length) return '';
    return (state.layoutSize > 1 ? ranked[0] : ranked[ranked.length - 1]).profile.name;
  }

  function effectiveProfile(tile) {
    if (tile.profile && tile.profile !== 'auto' && state.streamProfiles.some((p) => p.name === tile.profile)) {
      return tile.profile;
    }
    return tile.autoFallback ? '' : autoProfileName();
  }

  function loadTilePreferences(tile) {
    tile.autoFallback = false;
    tile.audioFailed = false;
    tile.profile = 'auto';
    tile.resolution = '';
    if (tile.channel == null) return;
    const savedProfile = store.get(`stream.${tile.channel}`);
    if (savedProfile && (savedProfile === 'auto' || state.streamProfiles.some((p) => p.name === savedProfile))) {
      tile.profile = savedProfile;
    }
    tile.resolution = store.get(`resolution.${tile.channel}`) || '';
    tile.audio = store.get(`audio.${tile.channel}`) === '1';
    tile.muteUntilPlaying = tile.audio;
    applyTileMuted(tile);
  }

  function saveTilePreferences(tile) {
    if (tile.channel == null) return;
    store.set(`stream.${tile.channel}`, tile.profile || 'auto');
    store.set(`resolution.${tile.channel}`, tile.resolution || '');
  }

  function renderTileMenu(tile) {
    const chSel = $(tileId(tile, 'tileChannel'));
    chSel.replaceChildren();
    if (state.layoutSize > 1) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = t('tile.empty');
      chSel.appendChild(empty);
    }
    for (const c of state.channels) {
      const o = document.createElement('option');
      o.value = String(c.camera);
      o.textContent = channelOptionText(c);
      chSel.appendChild(o);
    }
    chSel.value = tile.channel == null ? '' : String(tile.channel);

    const streamSel = $(tileId(tile, 'tileStream'));
    streamSel.replaceChildren();
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = autoProfileName()
      ? `${t('tile.stream.auto')} – ${autoProfileName()}`
      : t('tile.stream.auto');
    streamSel.appendChild(auto);
    for (const p of state.streamProfiles) {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.name;
      o.title = [p.description, p.parameters, profilePixels(p) == null ? t('tile.stream.unknown') : '']
        .filter(Boolean).join(' – ');
      streamSel.appendChild(o);
    }
    streamSel.value = tile.profile && tile.profile !== 'auto' ? tile.profile : '';
    streamSel.disabled = !state.streamProfiles.length || tile.channel == null;

    const resSel = $(tileId(tile, 'tileResolution'));
    resSel.value = tile.resolution || '';
    resSel.disabled = tile.channel == null;
    const resRow = $(tileId(tile, 'tileResolutionRow'));
    if (resRow) resRow.classList.toggle('hidden', state.streamProfiles.length > 0);

    updateTileLabel(tile);
    updateTileAudio(tile);
  }

  function ensureChannelPicker(tile) {
    if (tile.picker) return tile.picker;
    const picker = document.createElement('div');
    picker.id = tileId(tile, 'tileChannelPicker');
    picker.className = 'channel-picker hidden';
    picker.setAttribute('role', 'listbox');
    picker.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    tile.el.appendChild(picker);
    tile.picker = picker;
    return picker;
  }

  function hideChannelPicker(tile) {
    tile.picker?.classList.add('hidden');
  }

  function openChannelPicker(tile) {
    if (!tile || !tile.visible) return;
    setActiveTile(tile);
    for (const other of state.tiles) if (other !== tile) hideChannelPicker(other);
    const picker = ensureChannelPicker(tile);
    picker.replaceChildren();
    const title = document.createElement('div');
    title.className = 'channel-picker-title';
    title.textContent = t('tile.pickChannel');
    picker.appendChild(title);

    const addChoice = (camera, text) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'channel-choice';
      button.value = camera == null ? '' : String(camera);
      button.textContent = text;
      if (camera === tile.channel) button.classList.add('active');
      button.addEventListener('click', (ev) => {
        ev?.stopPropagation?.();
        hideChannelPicker(tile);
        setTileChannel(tile, camera);
      });
      picker.appendChild(button);
    };

    for (const channel of state.channels) addChoice(channel.camera, channelOptionText(channel));
    if (state.layoutSize > 1) addChoice(null, t('tile.empty'));
    picker.classList.remove('hidden');
  }

  function saveChannels() {
    return state.tiles.map((tile) => tile.channel);
  }

  function toggleTileZoom(tile) {
    if (!tile || tile.channel == null) return;
    if (state.zoomReturn) {
      const saved = state.zoomReturn;
      state.zoomReturn = null;
      const shared = sharedTime(activeTile());
      saved.channels.forEach((channel, index) => {
        const target = state.tiles[index];
        if (!target) return;
        if (target.channel !== channel) clearTileVideo(target);
        target.channel = channel;
        target.channelTouched = true;
        loadTilePreferences(target);
      });
      state.layout = saved.layout;
      state.active = saved.active;
      applyLayout();
      const target = state.tiles[saved.active] || state.tiles[0];
      if (target?.visible) setActiveTile(target);
      restoreSharedTime(shared);
      return;
    }
    if (state.layoutSize <= 1) return;

    const shared = sharedTime(tile);
    const manual = tile.manualRecording;
    state.zoomReturn = {
      layout: state.layout,
      active: tile.id,
      channels: saveChannels(),
    };
    const first = state.tiles[0];
    const replaced = first !== tile || first.channel !== tile.channel;
    state.layout = '1';
    if (replaced) clearTileVideo(first);
    first.channel = tile.channel;
    first.channelTouched = true;
    first.manualRecording = manual;
    loadTilePreferences(first);
    state.active = 0;
    applyLayout();
    setActiveTile(first);
    if (!replaced) return;
    if (shared.live) goLive(true, first);
    else if (shared.paused) {
      holdAt(first, shared.time, '', { checkFootage: false });
      verifyPausedFootage(first, shared.time);
    } else playAt(shared.time, { tile: first, reuseManual: true, clearOldStream: true });
  }

  function wireTile(tile) {
    tile.el.addEventListener('pointerdown', () => setActiveTile(tile));
    tile.el.addEventListener('dblclick', (ev) => {
      if (ev?.target?.closest?.('button, summary, details, select, input, .channel-picker')) return;
      toggleTileZoom(tile);
    });
    tile.video.addEventListener('playing', () => onTilePlaying(tile));
    for (const type of ['loadeddata', 'timeupdate']) {
      tile.video.addEventListener(type, () => {
        if (tile.pipeline && tile.streamStatus !== 'playing' && !tile.video.paused) onTilePlaying(tile);
      });
    }

    const chSel = $(tileId(tile, 'tileChannel'));
    chSel.addEventListener('change', () => setTileChannel(tile, chSel.value ? Number(chSel.value) : null));

    const streamSel = $(tileId(tile, 'tileStream'));
    streamSel.addEventListener('change', () => {
      tile.profile = streamSel.value || 'auto';
      tile.autoFallback = false;
      saveTilePreferences(tile);
      renderTileMenu(tile);
      restartTileIfLive(tile);
    });

    const resSel = $(tileId(tile, 'tileResolution'));
    resSel.addEventListener('change', () => {
      tile.resolution = resSel.value || '';
      saveTilePreferences(tile);
      renderTileMenu(tile);
      restartTileIfLive(tile);
    });

    const audioBtn = $(tileId(tile, 'tileAudio'));
    audioBtn.addEventListener('click', () => setTileAudio(tile, !tile.audio));
    const emptyCta = $(tileId(tile, 'tileEmptyCta'));
    emptyCta.addEventListener('click', (ev) => {
      ev?.stopPropagation?.();
      openChannelPicker(tile);
    });
    updateTileAudio(tile);
    applyTileMuted(tile);
  }

  function restartTileIfLive(tile) {
    if (!tile.visible || tile.channel == null) return;
    if (tile.mode === 'live' && tile.pendingSeek == null) goLive(true, tile);
  }

  function setTileChannel(tile, cam) {
    if (cam != null && !state.channels.some((c) => c.camera === cam) && !(cam >= 1 && cam <= state.channelCount)) return;
    if (cam === tile.channel) { renderTileMenu(tile); return; }
    const wall = tile.pendingSeek ?? currentWall(tile);
    const wasLive = tile.mode === 'live' && tile.pendingSeek == null;
    const prev = tile.channel;
    tile.channel = cam;
    tile.channelTouched = true;
    hideChannelPicker(tile);
    loadTilePreferences(tile);
    renderTileMenu(tile);
    if (tile === activeTile() && cam != null) store.set('channel', String(cam));

    if (cam == null) {
      tile.intent?.abort();
      stopPipeline(tile);
      tile.mode = 'paused';
      tile.rec = null;
      tile.pausedAt = wall;
      setStreamStatus(tile, 'idle', t('tile.empty'));
    } else if (wasLive) {
      goLive(true, tile);
    } else {
      playAt(wall, { clearOldStream: true, tile });
    }

    updateAllTileUi();
    updateModeUi(activeTile());
    if (tile === activeTile()) {
      document.dispatchEvent(new CustomEvent('microvms:channel', { detail: { channel: cam, previous: prev } }));
      state.recordings = [];
      state.unassignedRecordings = [];
      draw();
    }
    if (tile.visible) {
      refreshRecordings();
      refreshActiveRecording();   // every visible channel shows its own recording dot
    }
  }

  /** Legacy entry point: change the channel of the active tile. */
  function setChannel(cam) {
    setTileChannel(activeTile(), cam);
  }

  /**
   * Video channels (multi-sensor cameras, encoders, view areas, quad views).
   * Image.I<n> corresponds to camera=<n+1>.
   */
  async function loadChannels() {
    let count = 1;
    try {
      const p = await fetchParams('Properties.Image.NbrOfViews');
      count = parseInt(p['root.Properties.Image.NbrOfViews'] || p['Properties.Image.NbrOfViews'], 10) || 1;
    } catch (e) { /* single channel */ }

    const channels = [];
    let names = {};
    try { names = await fetchParams('Image'); } catch (e) { /* names optional */ }
    const get = (i, key) => names[`root.Image.I${i}.${key}`] ?? names[`Image.I${i}.${key}`];
    for (let i = 0; i < count; i++) {
      if ((get(i, 'Enabled') || 'yes').toLowerCase() === 'no') continue;
      const name = get(i, 'Name');
      channels.push({ camera: i + 1, name: name || t('channel.default', { n: i + 1 }) });
    }
    if (!channels.length) channels.push({ camera: 1, name: t('channel.default', { n: 1 }) });
    state.channels = channels;
    state.channelCount = Math.max(1, count);

    applyLayout();
    const saved = parseInt(store.get('channel'), 10);
    const wanted = channels.some((c) => c.camera === saved) ? saved : channels[0].camera;
    const target = state.tiles.find((tile) => tile.visible && tile.channel === wanted);
    if (target) setActiveTile(target);
    syncLayoutControls();
  }

  async function loadStreamProfiles() {
    try {
      const res = await fetch('/axis-cgi/streamprofile.cgi', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiVersion: '1.0', method: 'list', params: { streamProfileName: [] } }),
      });
      if (!res.ok) return;
      const j = await res.json();
      const list = j.data && j.data.streamProfile;
      state.streamProfiles = Array.isArray(list) ? list : [];
    } catch (e) { state.streamProfiles = []; }
    for (const tile of state.tiles) {
      loadTilePreferences(tile);
      renderTileMenu(tile);
    }
  }

  const channelName = (cam = state.channel) => (state.channels.find((c) => c.camera === cam) || {}).name || t('channel.default', { n: cam });


  // ------------------------------------------------------------ VAPIX recordings

  function recordingType(el) {
    const type = (el.getAttribute('recordingtype') || '').trim().toLowerCase();
    if (type === 'continuous' || type === 'scheduled') return type;
    if (type === 'triggered' || type === 'event') return 'triggered';
    // A missing type with an explicit event trigger is not a continuous recording.
    // eventid alone is not evidence: continuous profiles may have arbitrary event IDs.
    const trigger = (el.getAttribute('eventtrigger') || '').trim();
    return !type && trigger && !/^(?:none|false|0)$/i.test(trigger) ? 'triggered' : 'other';
  }

  function parseRecordings(container) {
    return Array.from(container.getElementsByTagName('recording')).map((el) => {
      const video = el.getElementsByTagName('video')[0];
      const source = (el.getAttribute('source') || video?.getAttribute('source') || '').trim();
      const id = el.getAttribute('recordingid');
      const start = Date.parse(el.getAttribute('starttime'));
      const end = el.getAttribute('stoptime');
      const stop = end ? Date.parse(end) : null;
      const status = el.getAttribute('recordingstatus') || '';
      if (!id || !Number.isFinite(start) || (stop != null && (!Number.isFinite(stop) || stop < start))) {
        throw new Error(t('err.xml'));
      }
      return {
        id,
        disk: el.getAttribute('diskid'),
        start, stop, status, source,
        type: recordingType(el),
        hasAudio: Boolean(el.getElementsByTagName('audio')[0]),
      };
    });
  }

  async function loadRecordingSources() {
    if (!multiChannel()) return;
    try {
      const doc = await fetchXml('/axis-cgi/record/list.cgi?listentity=source');
      state.sourceCatalog = Array.from(xmlElement(doc, 'sources').getElementsByTagName('source'), (el) => el.textContent.trim());
    } catch (e) { /* some cameras don't report source identifiers */ }
  }

  function selectChannel(rows, channel) {
    const count = state.channelCount;
    const evidence = new Set([...state.sourceCatalog, ...rows.map((r) => r.source)]);
    const zero = evidence.has('0');
    const one = evidence.has(String(count));
    // A device that knows only one numbered source records just one channel: the first enabled one.
    const numbered = [...evidence].filter((s) => /^\d+$/.test(s));
    const sole = numbered.length === 1 && state.sourceCatalog.includes(numbered[0]) ? numbered[0] : null;
    const recs = [], unknown = [];
    for (const r of rows) {
      if (/^quad$/i.test(r.source)) continue; // not one of the numbered channels
      if (!multiChannel()) { recs.push(r); continue; }
      const n = /^\d+$/.test(r.source) ? Number(r.source) : NaN;
      const mapped = zero !== one ? n + (zero ? 1 : 0) : r.source === sole ? state.channels[0].camera : NaN;
      if (mapped >= 1 && mapped <= count) {
        if (mapped === channel) recs.push(r);
      } else if (!Number.isFinite(n) || n > count || n === channel || n + 1 === channel) {
        unknown.push(r);
      }
    }
    return { recs, unknown };
  }

  async function listRecordings(from, to, { channel = state.channel, signal } = {}) {
    const { rows, complete } = await listRecordingRows(from, to, { signal });
    return { ...selectChannel(rows, channel), complete };
  }

  /** All recordings in a range, every source (paged); the channel split is selectChannel's job. */
  async function listRecordingRows(from, to, { signal } = {}) {
    if (to != null && to < from) return { rows: [], complete: true };
    const p = new URLSearchParams({ starttime: isoUtc(from), sortorder: 'ascending', maxnumberofresults: String(PAGE_SIZE) });
    if (to != null) p.set('stoptime', isoUtc(to));
    const seen = new Map();
    for (let page = 0; ; page++) {
      signal?.throwIfAborted();
      // Axis pages with the index of the first result; IDs deduplicate an overlapping boundary.
      if (page) p.set('startatresultnumber', String(seen.size));
      const doc = await fetchXml(`/axis-cgi/record/list.cgi?${p}`, { signal });
      const container = doc.getElementsByTagName('recordings')[0];
      const rows = parseRecordings(doc);
      const before = seen.size;
      for (const r of rows) seen.set(`${r.disk}/${r.id}`, r);
      const raw = container?.getAttribute('numberofrecordings');
      const reported = raw && /^\d+$/.test(raw) ? Number(raw) : null;
      // Only ask for another page when this one was full and the camera reports more.
      const more = rows.length >= PAGE_SIZE && (reported == null || seen.size < reported);
      if (!more) return { rows: [...seen.values()], complete: true };
      // A camera that ignores startatresultnumber must not blank the whole timeline.
      if (seen.size === before || page + 1 >= MAX_PAGES) return { rows: [...seen.values()], complete: false };
    }
  }

  async function findRecordingAtOrAfter(time, options, exclude) {
    const p = new URLSearchParams({ starttime: isoUtc(time), sortorder: 'ascending', maxnumberofresults: '200' });
    const doc = await fetchXml(`/axis-cgi/record/list.cgi?${p}`, { signal: options.signal });
    const different = (r) => !exclude || r.id !== exclude.id || r.disk !== exclude.disk;
    const overlaps = (r) => different(r) && r.start <= time && time < recStop(r);
    const { recs, unknown } = selectChannel(parseRecordings(doc), options.channel);
    const containing = recs.filter(overlaps);
    const choices = unknown.filter(overlaps);
    if (options.preferUnassigned && choices.length) return { choices };
    if (containing.length) return { rec: containing.find((r) => r.type === 'continuous') || containing[0] };
    if (choices.length) return { choices };
    const later = (r) => different(r) && r.start > time && r.start <= Date.now() && recStop(r) > r.start;
    const next = recs.find(later);
    const earlier = unknown.filter((r) => later(r) && (!next || r.start <= next.start));
    return earlier.length ? { choices: earlier } : { rec: next };
  }

  // ------------------------------------------------------------ Pipeline

  function newPlaybackIntent(tile = activeTile()) {
    tile.intent?.abort();
    tile.intent = new AbortController();
    tile.pendingSeek = null;
    tile.manualRecording = null;
    tile.waitingFor = null;
    if (tile.sourceChoices) {
      tile.sourceChoices = null;
      if (tile === activeTile()) renderSourceChoices();
    }
    return tile.intent;
  }

  /** The source list belongs to one tile; the sidebar card shows the active tile's list. */
  function renderSourceChoices() {
    const tile = activeTile();
    const list = $('sourceChoiceList');
    list.replaceChildren();
    const offer = tile.sourceChoices;
    $('sourceChoices').classList.toggle('hidden', !offer);
    if (!offer) return;
    const { intent, time, choices } = offer;
    for (const [i, rec] of choices.slice(0, 12).entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = t('video.sourceChoice', {
        n: i + 1, when: fmtDateTime(rec.start), source: rec.source || t('video.sourceMissing'),
      });
      button.addEventListener('click', () => {
        if (!isCurrentIntent(intent, tile)) return;
        newPlaybackIntent(tile);
        tile.manualRecording = rec;
        startRecording(tile, rec, Math.max(rec.start, time));
      });
      list.appendChild(button);
    }
    const hint = t(choices.length > 12 ? 'video.sourceLimited' : 'video.sourceHint');
    $('sourceChoiceHint').textContent = state.layoutSize > 1 ? `${channelName(tile.channel)}: ${hint}` : hint;
  }

  const isCurrentIntent = (intent, tile = activeTile()) =>
    tile.intent === intent && !intent.signal.aborted;

  function stopPipeline(tile = activeTile()) {
    tile.generation++;
    clearTimeout(tile.streamTimer);
    tile.streamTimer = null;
    if (tile.pipeline) {
      try { tile.pipeline.close(); } catch (e) { /* ignore */ }
      tile.pipeline = null;
    }
  }

  function setStreamStatus(tile, status, msg = '') {
    tile.streamStatus = status;
    videoMsg(tile, tile.pendingSeek == null ? msg : t('video.seeking'));
    updateModeUi(tile);
  }

  function startPipeline(tile, parameters, offsetSec, retryLive = true) {
    stopPipeline(tile);
    const gen = tile.generation;
    const video = tile.video;
    tile.syncWall = null;
    tile.baseCt = null;
    tile.lastFrame = null;
    tile.noRecording = false;
    tile.el.classList.remove('no-recording');
    setStreamStatus(tile, 'connecting', t('video.connecting'));
    if (!MSL?.Html5VideoPipeline) { setStreamStatus(tile, 'error', t('video.libMissing')); return; }
    const requestedAudio = parameters.includes('audio=1');
    const fail = (msg, { reconnect = false, rejected = false } = {}) => {
      if (gen !== tile.generation) return;
      const lastWall = currentWall(tile);
      stopPipeline(tile);
      if (reconnect && (retryLive || tile.streamStatus === 'playing') && tile.mode === 'live' && tile.pendingSeek == null) {
        setStreamStatus(tile, 'connecting', t('video.reconnect'));
        const intent = tile.intent;
        const closedGen = tile.generation;
        tile.streamTimer = setTimeout(() => {
          if (tile.generation === closedGen && isCurrentIntent(intent, tile)) goLive(false, tile);
        }, 2000);
      } else if (rejected && requestedAudio && !tile.audioFailed && tile.pendingSeek == null) {
        // Only an RTSP rejection can be caused by audio (e.g. unsupported AAC); a timeout
        // or a broken connection is not. Retry once without audio for this session; the
        // saved preference stays, so the next visit tries audio again.
        tile.audioFailed = true;
        tile.audio = false;
        tile.muteUntilPlaying = false;
        applyTileMuted(tile);
        updateTileAudio(tile);
        toast(t('tile.audio.failed'), true);
        if (tile.mode === 'live') goLive(false, tile);
        else if (tile.mode === 'playback') playAt(lastWall, { tile, reuseManual: true });
      } else if (tile.mode === 'live' && tile.pendingSeek == null && !tile.autoFallback
        && (!tile.profile || tile.profile === 'auto') && autoProfileName()) {
        // The automatically chosen profile may not be playable here: retry once with the camera default.
        tile.autoFallback = true;
        goLive(false, tile);
      } else {
        if (tile.mode === 'playback') {
          tile.startWall = lastWall;
          tile.syncWall = tile.baseCt = null;
        }
        setStreamStatus(tile, 'error', msg);
      }
    };
    let pipeline;
    try {
      pipeline = new MSL.Html5VideoPipeline({
        ws: {},                      // default: ws(s)://<camera>/rtsp-over-websocket
        rtsp: { parameters },        // rtsp://<camera>/axis-media/media.amp?...
        mediaElement: video,
      });
      tile.pipeline = pipeline;
    } catch (err) {
      fail(t('video.connectFailed', { msg: err.message }));
      return;
    }
    tile.streamTimer = setTimeout(() => {
      if (video.readyState >= 2 && !video.paused) { onTilePlaying(tile); return; }
      fail(t('video.timeout'));
    }, 15000);

    pipeline.onSync = (ntp) => { if (gen === tile.generation) tile.syncWall = ntp; };
    pipeline.onServerClose = () => {
      if (gen !== tile.generation) return;
      if (tile.mode === 'playback' && tile.pendingSeek == null && tile.rec?.stop != null && Math.abs(currentWall(tile) - tile.rec.stop) < 2000) {
        onRecordingEnded(tile);
      } else {
        fail(t('video.disconnected'), { reconnect: true });
      }
    };
    pipeline.rtsp.onError = (err) => {
      fail(t('video.rtspError', { msg: err.message || err }), { rejected: true });
    };
    pipeline.rtsp.onRtcp = (rtcp) => {
      if (gen !== tile.generation) return;
      if (MSL.isRtcpBye(rtcp) && tile.mode === 'playback') onRecordingEnded(tile);
    };

    pipeline.ready
      .then(() => {
        if (gen !== tile.generation) {
          try { pipeline.close(); } catch (e) { /* ignore */ }
          return;
        }
        pipeline.rtsp.play(offsetSec || 0);
        return video.play();
      })
      .catch((err) => {
        fail(t('video.connectFailed', { msg: err?.message || t('video.wsError') }));
      });
  }

  /** A recording without an audio track is requested without audio. */
  const audioParams = (tile, rec = null) => (audioEnabled(tile) && rec?.hasAudio !== false
    ? ['audio=1', 'audiocodec=aac'] : ['audio=0']);

  function liveParameters(tile = activeTile()) {
    const params = [`camera=${tile.channel}`];
    const profile = effectiveProfile(tile);
    // Profile first, explicit values after it override it ("last value wins")
    if (profile) params.push(`streamprofile=${encodeURIComponent(profile)}`);
    params.push('videocodec=h264', ...audioParams(tile));
    if (tile.resolution) params.push(`resolution=${tile.resolution}`);
    return params;
  }

  function goLive(retryLive = true, tile = activeTile()) {
    if (tile.channel == null) {
      stopPipeline(tile);
      tile.mode = 'paused';
      tile.rec = null;
      tile.noRecording = false;
      tile.el.classList.remove('no-recording');
      setStreamStatus(tile, 'idle', t('tile.empty'));
      return;
    }
    newPlaybackIntent(tile);
    tile.mode = 'live';
    tile.rec = null;
    tile.pausedAt = null;
    startPipeline(tile, liveParameters(tile), 0, retryLive);
  }

  function footageAt(channel, time) {
    const data = state.recordingsByChannel.get(channel);
    if (!data || !data.complete) return null;
    if (time < state.viewStart || time >= state.viewEnd) return null;
    return data.recs.some((rec) => rec.start <= time && time < recStop(rec));
  }

  function markNoRecording(tile, on) {
    tile.noRecording = on;
    tile.el.classList.toggle('no-recording', on);
    if (on) videoMsg(tile, t('video.noRecording'));
  }

  function holdAt(tile, time, msg, { checkFootage = true } = {}) {
    stopPipeline(tile);
    tile.mode = 'paused';
    tile.rec = null;
    tile.pausedAt = time;
    markNoRecording(tile, checkFootage && footageAt(tile.channel, time) === false);
    setStreamStatus(tile, 'idle', tile.noRecording ? t('video.noRecording') : msg);
  }

  /** A manual pause must not warn just because the local cache has a gap. */
  async function verifyPausedFootage(tile, time) {
    try {
      const result = await findRecordingAtOrAfter(time, { channel: tile.channel });
      if (tile.mode !== 'paused' || tile.pausedAt !== time) return;
      const has = Boolean(result.rec || result.choices?.length);
      markNoRecording(tile, !has);
      if (has) videoMsg(tile, '');
    } catch (e) { /* keep the held frame without a false warning */ }
  }

  function startRecording(tile, rec, time) {
    tile.mode = 'playback';
    tile.rec = rec;
    tile.startWall = time;
    tile.pausedAt = null;
    startPipeline(tile, [`recordingid=${encodeURIComponent(rec.id)}`, ...audioParams(tile, rec)],
      Math.max(0, (time - rec.start) / 1000));
  }

  function offerRecordings(tile, intent, time, choices) {
    holdAt(tile, time, t('video.chooseSource'), { checkFootage: false });
    tile.sourceChoices = { intent, time, choices };
    if (tile === activeTile()) renderSourceChoices();
  }

  async function playAt(time, { clearOldStream = false, reuseManual = false, preferUnassigned = false, tile = activeTile() } = {}) {
    if (!Number.isFinite(time)) return;
    const manual = reuseManual ? tile.manualRecording : null;
    if (manual && manual.start <= time && time < recStop(manual)) {
      newPlaybackIntent(tile);
      tile.manualRecording = manual;
      startRecording(tile, manual, time);
      return;
    }
    if (time >= Date.now() - LIVE_THRESHOLD) { goLive(true, tile); return; }
    const intent = newPlaybackIntent(tile);
    const channel = tile.channel;
    if (clearOldStream) stopPipeline(tile);
    tile.pendingSeek = time;
    videoMsg(tile, t('video.seeking'));
    updateModeUi(tile);
    let result;
    try {
      result = await findRecordingAtOrAfter(time, { channel, signal: intent.signal, preferUnassigned });
    } catch (e) {
      if (!isCurrentIntent(intent, tile)) return;
      tile.pendingSeek = null;
      holdAt(tile, time, t('toast.recListFailed', { msg: e.message }));
      return;
    }
    if (!isCurrentIntent(intent, tile)) return;
    tile.pendingSeek = null;
    if (result.choices) { offerRecordings(tile, intent, time, result.choices); return; }
    const { rec } = result;
    if (!rec) {
      holdAt(tile, time, t('video.noRecording'), { checkFootage: false });
      markNoRecording(tile, true);
      videoMsg(tile, t('video.noRecording'));
      return;
    }
    startRecording(tile, rec, Math.max(time, rec.start));
  }

  async function onRecordingEnded(tile = activeTile()) {
    const intent = tile.intent;
    const rec = tile.rec;
    if (!rec || tile.mode !== 'playback' || tile.pendingSeek != null || tile.endingIntent === intent) return;
    const end = rec.stop ?? currentWall(tile);
    if (tile.manualRecording) { holdAt(tile, end, t('video.endOfRecording')); return; }
    tile.endingIntent = intent;
    const channel = tile.channel;
    try {
      const { rec: next, choices } = await findRecordingAtOrAfter(end, { channel, signal: intent.signal }, rec);
      if (!isCurrentIntent(intent, tile)) return;
      // In a multi-view the others keep the shared time: wait for the next recording
      // instead of jumping ahead of them.
      if (next && next.start > end + 2000 && sharedClockRunning(tile)) waitForFootage(tile, end, next);
      else if (next) startRecording(tile, next, Math.max(next.start, end));
      else if (choices) offerRecordings(tile, intent, end, choices);
      else holdAt(tile, end, t('video.endOfRecording'));
    } catch (e) {
      if (isCurrentIntent(intent, tile)) holdAt(tile, end, t('toast.recListFailed', { msg: e.message }));
    } finally {
      if (tile.endingIntent === intent) tile.endingIntent = null;
    }
  }

  /** Point in time currently shown (wall clock, ms). */
  function currentWall(tile = activeTile()) {
    if (tile.mode === 'live') return Date.now();
    if (tile.mode === 'paused') return tile.pausedAt != null ? tile.pausedAt : Date.now();
    const ct = tile.video.currentTime || 0;
    // onSync gives the NTP time of media time 0; sanity check in case the
    // device does not send the original time for playback.
    if (tile.syncWall != null && Math.abs(tile.syncWall - tile.startWall) < 5 * MIN) {
      return tile.syncWall + ct * 1000;
    }
    if (tile.baseCt == null) return tile.startWall;
    return tile.startWall + (ct - tile.baseCt) * 1000;
  }

  function onTilePlaying(tile) {
    if (!tile.pipeline) return;
    clearTimeout(tile.streamTimer);
    tile.streamTimer = null;
    tile.muteUntilPlaying = false;
    applyTileMuted(tile);
    if (tile.baseCt == null) tile.baseCt = tile.video.currentTime || 0;
    setStreamStatus(tile, 'playing');
  }

  /**
   * Jump back from the time currently on screen. From live view the target
   * must be clearly before "now", otherwise playAt() would just go live again.
   */
  function skipBack(seconds, tile = activeTile()) {
    const live = tile.mode === 'live' && tile.pendingSeek == null;
    const from = tile.pendingSeek ?? currentWall(tile);
    const target = from - seconds;
    playAt(live ? Math.min(target, Date.now() - LIVE_THRESHOLD - 1000) : target,
      { reuseManual: true, tile });
  }

  function pauseTile(tile = activeTile()) {
    if (!tile.visible || tile.channel == null) return;
    if (tile.pendingSeek != null) {
      const time = tile.pendingSeek;
      newPlaybackIntent(tile);
      holdAt(tile, time, '', { checkFootage: false });
      verifyPausedFootage(tile, time);
      return;
    }
    if (tile.mode === 'paused') return;
    const time = currentWall(tile);
    const manual = tile.manualRecording;
    newPlaybackIntent(tile);
    tile.manualRecording = manual;
    tile.video.pause();
    captureTileFrame(tile);
    holdAt(tile, time, '', { checkFootage: false });
    verifyPausedFootage(tile, time);
  }

  function resumeTile(tile = activeTile()) {
    if (!tile.visible || tile.channel == null || tile.mode !== 'paused') return;
    if (tile.pausedAt != null) playAt(tile.pausedAt, { reuseManual: true, tile });
    else goLive(true, tile);
  }

  function togglePause(tile = activeTile()) {
    if (tile.mode === 'paused') resumeTile(tile);
    else pauseTile(tile);
  }

  function goLiveAll() {
    for (const tile of visibleTiles()) goLive(true, tile);
  }

  function playAtAll(time) {
    if (!Number.isFinite(time)) return;
    seekTogether(visibleTiles(), time);
  }

  /**
   * One shared wall clock (ADR 0006): every tile looks up its own footage, but
   * the clock jumps to the EARLIEST footage of any tile. Tiles without footage
   * at that moment hold and start by themselves when the clock reaches their
   * next recording (followSharedClock).
   */
  async function seekTogether(tiles, time) {
    if (tiles.length <= 1 || time >= Date.now() - LIVE_THRESHOLD) {
      tiles.forEach((tile) => playAt(time, { tile }));
      return;
    }
    const intents = tiles.map((tile) => {
      const intent = newPlaybackIntent(tile);
      tile.pendingSeek = time;
      videoMsg(tile, t('video.seeking'));
      updateModeUi(tile);
      return intent;
    });
    const results = await Promise.all(tiles.map((tile, i) => findRecordingAtOrAfter(time, {
      channel: tile.channel, signal: intents[i].signal,
    }).catch((error) => ({ error }))));
    const current = tiles.filter((tile, i) => isCurrentIntent(intents[i], tile));
    if (!current.length) return;

    const starts = results.map((r, i) => (r.rec && current.includes(tiles[i]) ? Math.max(time, r.rec.start) : null))
      .filter((start) => start != null);
    const target = starts.length ? Math.min(...starts) : time;

    tiles.forEach((tile, i) => {
      if (!current.includes(tile)) return;
      const { rec, choices, error } = results[i];
      tile.pendingSeek = null;
      if (error) holdAt(tile, time, t('toast.recListFailed', { msg: error.message }));
      else if (choices) offerRecordings(tile, intents[i], time, choices);
      else if (rec && rec.start <= target && target < recStop(rec)) startRecording(tile, rec, target);
      else waitForFootage(tile, target, rec);
    });
  }

  /** Hold a tile without footage; it starts when the shared clock reaches `next`. */
  function waitForFootage(tile, time, next) {
    holdAt(tile, time, t('video.noRecording'), { checkFootage: false });
    markNoRecording(tile, true);
    videoMsg(tile, t('video.noRecording'));
    tile.waitingFor = next && next.start > time ? next : null;
  }

  /** Called by the clock tick: start waiting tiles once the shared clock reaches their footage. */
  function followSharedClock() {
    const waiting = visibleTiles().filter((tile) => tile.waitingFor && tile.mode === 'paused');
    if (!waiting.length) return;
    const leader = visibleTiles().find((tile) => tile.mode === 'playback'
      && tile.streamStatus === 'playing' && tile.pendingSeek == null);
    if (!leader) return;
    const clock = currentWall(leader);
    for (const tile of waiting) {
      const rec = tile.waitingFor;
      if (clock < rec.start) continue;
      newPlaybackIntent(tile);
      if (clock < recStop(rec)) startRecording(tile, rec, clock);
      else playAt(clock, { tile });       // passed it already: look up again
    }
  }

  /** Another tile is playing recorded footage, so this one must not run ahead alone. */
  const sharedClockRunning = (tile) => visibleTiles().some((other) => other !== tile
    && other.mode === 'playback' && other.streamStatus === 'playing');

  /** Time of the shared clock: a tile that shows footage, not one that waits for it. */
  function sharedClockTime(tiles = visibleTiles()) {
    const leader = tiles.find((tile) => !tile.waitingFor && tile.mode === 'playback')
      || tiles.find((tile) => !tile.waitingFor) || activeTile();
    return leader.pendingSeek ?? currentWall(leader);
  }

  /** Several tiles on recorded footage (none live, none on a manual pick) step together. */
  function stepsTogether(tiles) {
    return tiles.length > 1 && tiles.every((tile) => !tile.manualRecording
      && !(tile.mode === 'live' && tile.pendingSeek == null));
  }

  function skipBackAll(seconds) {
    const tiles = visibleTiles();
    if (stepsTogether(tiles)) { playAtAll(sharedClockTime(tiles) - seconds); return; }
    for (const tile of tiles) skipBack(seconds, tile);
  }

  function skipForwardAll(seconds) {
    const tiles = visibleTiles();
    if (stepsTogether(tiles)) { playAtAll(sharedClockTime(tiles) + seconds); return; }
    for (const tile of tiles) {
      // Live is already "now": skipping forward would only reconnect the stream.
      if (tile.mode === 'live' && tile.pendingSeek == null) continue;
      playAt((tile.pendingSeek ?? currentWall(tile)) + seconds, { reuseManual: true, tile });
    }
  }

  /** Shared time state of the visible tiles, kept across layout changes and zoom. */
  function sharedTime(tile = activeTile()) {
    const tiles = visibleTiles();
    const all = (fn) => tiles.length > 0 && tiles.every((t) => t.pendingSeek == null && fn(t));
    return {
      live: all((t) => t.mode === 'live'),
      paused: all((t) => t.mode === 'paused'),
      time: tile.waitingFor ? sharedClockTime(tiles) : (tile.pendingSeek ?? currentWall(tile)),
    };
  }

  function holdAllAt(time) {
    for (const tile of visibleTiles()) {
      newPlaybackIntent(tile);
      holdAt(tile, time, '', { checkFootage: false });
      verifyPausedFootage(tile, time);
    }
  }

  function restoreSharedTime(shared) {
    if (shared.live) goLiveAll();
    else if (shared.paused && Number.isFinite(shared.time)) holdAllAt(shared.time);
    else if (Number.isFinite(shared.time)) playAtAll(shared.time);
  }

  /** A tile that now shows another channel must not keep the old channel's picture. */
  function clearTileVideo(tile) {
    stopPipeline(tile);
    tile.lastFrame = null;
    tile.video.removeAttribute?.('src');
    tile.video.load?.();
  }

  function togglePauseAll() {
    const tiles = visibleTiles();
    if (!tiles.length) return;
    if (tiles.every((tile) => tile.mode === 'paused' && tile.pendingSeek == null)) {
      const at = tiles[0].pausedAt;
      const together = tiles.length > 1 && at != null
        && tiles.every((tile) => tile.pausedAt === at && !tile.manualRecording);
      if (together) playAtAll(at);       // resume on the shared clock
      else tiles.forEach((tile) => resumeTile(tile));
    } else {
      const clock = sharedClockTime(tiles);
      tiles.forEach((tile) => pauseTile(tile));
      // A tile waiting for footage pauses at the shared time, not at its old hold time.
      for (const tile of tiles) {
        if (!tile.waitingFor) continue;
        tile.waitingFor = null;
        tile.pausedAt = clock;
      }
    }
  }

  function retryPlaybackAll() {
    for (const tile of visibleTiles()) {
      if (tile.mode === 'playback' && tile.streamStatus === 'error' && tile.pendingSeek == null) {
        playAt(currentWall(tile), { reuseManual: true, tile });
      }
    }
  }

  function updateTileLabel(tile) {
    const empty = tile.channel == null;
    tile.el.classList.toggle('empty', empty);
    $(tileId(tile, 'tileName')).textContent = empty ? t('tile.empty') : channelName(tile.channel);
    const cta = $(tileId(tile, 'tileEmptyCta'));
    if (cta) cta.classList.toggle('hidden', !empty);
  }

  function updateTileBadge(tile) {
    const badge = $(tileId(tile, 'modeBadge'));
    let key;
    if (tile.channel == null) {
      key = 'empty';
    } else {
      const seeking = tile.pendingSeek != null;
      const live = tile.mode === 'live' && !seeking;
      const playing = tile.streamStatus === 'playing';
      const paused = tile.mode === 'paused' && !seeking;
      key = seeking ? 'seeking' : paused ? 'paused' : !playing ? tile.streamStatus : tile.mode;
    }
    badge.className = `badge ${key}`;
    badge.textContent = t(`badge.${key}`);
    tile.el.setAttribute('data-state', key);
    tile.el.classList.toggle('recording', key === 'live' && state.recordingNow.get(tile.channel) === true);
  }

  let audioUnlocked = false;
  const AAC_MIME = 'audio/mp4; codecs="mp4a.40.2"';

  function audioSupported() {
    return typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported
      || MediaSource.isTypeSupported(AAC_MIME);
  }

  const audioEnabled = (tile) => tile.audio && !tile.audioFailed && audioSupported();

  function applyTileMuted(tile) {
    tile.video.muted = !audioEnabled(tile) || !audioUnlocked || tile.muteUntilPlaying;
  }

  function updateTileAudio(tile) {
    const btn = $(tileId(tile, 'tileAudio'));
    const use = $(tileId(tile, 'tileAudioIcon'));
    const supported = audioSupported();
    const on = audioEnabled(tile);
    btn.disabled = tile.channel == null || !supported;
    btn.classList.toggle('audio-on', on);
    btn.setAttribute('aria-pressed', String(on));
    const label = t(!supported ? 'tile.audio.unavailable' : on ? 'tile.audio.on' : 'tile.audio.off');
    btn.setAttribute('data-tip', label);
    btn.setAttribute('aria-label', label);
    use.setAttribute('href', on ? '#ic-speaker' : '#ic-speaker-off');
  }

  /** First user gesture: browsers allow unmuted playback from now on. */
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    state.tiles.forEach(applyTileMuted);
  }

  function setTileAudio(tile, on) {
    if (tile.channel == null) return;
    if (on && !audioSupported()) { toast(t('tile.audio.unavailable'), true); return; }
    audioUnlocked = true;
    if (on) tile.audioFailed = false;
    tile.audio = on;
    tile.muteUntilPlaying = on;
    store.set(`audio.${tile.channel}`, on ? '1' : '0');
    applyTileMuted(tile);
    updateTileAudio(tile);
    if (!tile.visible) return;
    if (on && tile.mode === 'live' && tile.pendingSeek == null) goLive(true, tile);
    else if (on && tile.mode === 'playback') playAt(currentWall(tile), { reuseManual: true, tile });
  }

  function renderPager() {
    const visible = state.tiles.filter((tile) => tile.visible);
    $('tilePager').classList.toggle('hidden', visible.length < 2);
    const index = Math.max(0, visible.indexOf(activeTile()));
    $('pagerDots').textContent = `${index + 1} / ${Math.max(1, visible.length)}`;
  }

  function stepPager(delta) {
    const visible = state.tiles.filter((tile) => tile.visible);
    if (!visible.length) return;
    const index = Math.max(0, visible.indexOf(activeTile()));
    setActiveTile(visible[(index + delta + visible.length) % visible.length]);
  }

  function updateAllTileUi() {
    for (const tile of state.tiles) {
      updateTileLabel(tile);
      updateTileBadge(tile);
      updateTileAudio(tile);
    }
  }

  function setActiveTile(tile) {
    if (!tile || !tile.visible) return;
    const prev = activeTile().channel;
    const changed = state.active !== tile.id || prev !== tile.channel;
    state.active = tile.id;
    state.tiles.forEach((t) => t.el.classList.toggle('active', t === tile));
    renderPager();
    renderSourceChoices();
    updateModeUi(tile);
    if (!changed) return;
    if (tile.channel != null) store.set('channel', String(tile.channel));
    document.dispatchEvent(new CustomEvent('microvms:channel', { detail: { channel: tile.channel, previous: prev } }));
    const data = tile.channel == null ? null : state.recordingsByChannel.get(tile.channel);
    state.recordings = data ? data.recs : [];
    state.unassignedRecordings = data ? data.unknown : [];
    draw();
    if (tile.channel != null) {
      if (!data) refreshRecordings();
      refreshActiveRecording();
    }
  }

  let announcedMode;
  function updateModeUi(tile = activeTile()) {
    updateTileBadge(tile);
    syncTimelineMode();
    if (tile !== activeTile()) return;
    const tiles = visibleTiles();
    const seeking = tile.pendingSeek != null;
    const live = tile.mode === 'live' && !seeking;
    const playing = tile.streamStatus === 'playing';
    const allLive = tiles.length > 0 && tiles.every((t) => t.mode === 'live' && t.pendingSeek == null);
    const allPlaying = allLive && tiles.every((t) => t.streamStatus === 'playing');
    const allPaused = tiles.length > 0 && tiles.every((t) => t.mode === 'paused' && t.pendingSeek == null);
    $('manualSourceInfo').textContent = tile.manualRecording ? t('video.manualSource') : '';
    $('manualSourceInfo').classList.toggle('hidden', !tile.manualRecording);
    $('pauseIcon').setAttribute('href', allPaused ? '#ic-play' : '#ic-pause');
    $('btnFwd').disabled = allLive;
    const canSnapshot = tile.channel != null
      && ((live && playing) || (tile.mode === 'playback' && playing) || tile.lastFrame != null);
    $('btnSnapshot').disabled = !canSnapshot;
    $('btnRetryPlayback').classList.toggle('hidden', seeking || tile.mode !== 'playback' || tile.streamStatus !== 'error');
    const lb = $('btnLive');
    // Only offer the button when it can do something: leave playback or retry live video.
    const hideLive = allLive && allPlaying;
    lb.disabled = false;
    lb.classList.toggle('hidden', hideLive);
    $('liveLabel').textContent = allLive ? t(allPlaying ? 'live.btn' : 'live.retry') : t('live.back');
    const mode = live && !playing ? tile.streamStatus : seeking ? 'seeking' : tile.mode;
    if (mode !== announcedMode) {
      announcedMode = mode;
      document.dispatchEvent(new CustomEvent('microvms:mode', { detail: { mode } }));
    }
  }

  // ------------------------------------------------------------ Timeline

  const canvas = $('timeline');
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);   // live: follows the theme
  const cssVar = (n, d) => css.getPropertyValue(n).trim() || d;
  const COLORS = {};
  /** The canvas cannot use CSS variables directly: re-read them after a theme change. */
  function readColors() {
    Object.assign(COLORS, {
      bg: cssVar('--tl-bg', '#1e242c'),
      line: cssVar('--line', '#2a313b'),
      text: cssVar('--muted', '#8a94a3'),
      future: cssVar('--tl-future', 'rgba(0,0,0,0.35)'),
      continuous: cssVar('--continuous', '#3b82f6'),
      triggered: cssVar('--triggered', '#f59e0b'),
      scheduled: cssVar('--scheduled', '#a855f7'),
      other: cssVar('--other', '#60c8bd'),
      sel: cssVar('--export-sel', 'rgba(255,214,10,.22)'),
      exportEdge: cssVar('--export', '#ffd60a'),
      accent: cssVar('--accent', '#ffcc33'),
      live: cssVar('--live', '#e5484d'),
      font: cssVar('--font', 'system-ui, sans-serif'),
    });
  }
  readColors();
  const TICK_STEPS = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];

  const canvasWidth = () => canvas.clientWidth;
  const xOf = (time) => ((time - state.viewStart) / (state.viewEnd - state.viewStart)) * canvasWidth();
  const tOf = (x) => state.viewStart + (x / canvasWidth()) * (state.viewEnd - state.viewStart);
  // Keep in sync with .tl-label / .tl-label.head in style.css.
  const LANE_TOP = 28;
  const LANE_HEIGHT = 36;
  const FONT_PX = 15;           // the one text size of the UI, also on the canvas
  const TICK_MIN_PX = 96;       // room for a date label at that size

  /** Unique visible channels in tile order (duplicate tiles share one lane). */
  function timelineChannels() {
    const seen = new Set();
    const out = [];
    for (const tile of visibleTiles()) {
      if (tile.channel == null || seen.has(tile.channel)) continue;
      seen.add(tile.channel);
      out.push(tile.channel);
    }
    return out;
  }

  function timelineLanes() {
    const lanes = timelineChannels().map((channel) => {
      const data = state.recordingsByChannel.get(channel);
      return {
        channel,
        name: channelName(channel),
        recs: data ? data.recs : [],
        unknown: data ? data.unknown : [],
        complete: data ? data.complete : true,
      };
    });
    let shown = lanes;
    if (state.theater) {
      const active = activeTile().channel;
      const focused = lanes.filter((lane) => lane.channel === active);
      if (focused.length) shown = focused;
    }
    if (!timelineCompact()) return shown;
    // Live: one slim lane with the footage of every visible channel.
    return [{
      channel: null,
      name: '',
      recs: shown.flatMap((lane) => lane.recs),
      unknown: shown.flatMap((lane) => lane.unknown),
      complete: shown.every((lane) => lane.complete),
      sources: shown,
    }];
  }

  /**
   * The timeline folds itself: collapsed while every tile is live, expanded in
   * the archive (playback, pause, seek) and while exporting.
   */
  function timelineCompact() {
    if (state.selectMode) return false;
    const tiles = visibleTiles();
    return tiles.every((tile) => tile.mode === 'live' && tile.pendingSeek == null);
  }

  let compactShown = null;
  function syncTimelineMode() {
    const compact = timelineCompact();
    if (compact === compactShown) return;
    compactShown = compact;
    document.body?.classList?.toggle?.('timeline-compact', compact);
    resizeCanvas();
  }

  const COMPACT_LANE = 20;
  const laneHeight = () => (timelineCompact() ? COMPACT_LANE : LANE_HEIGHT);
  const laneGeometry = (index) => ({ y: LANE_TOP + index * laneHeight(), height: laneHeight() });
  const timelineHeight = (lanes = timelineLanes()) => LANE_TOP + Math.max(1, lanes.length) * laneHeight();

  function recordingPixels(rec) {
    const end = recStop(rec);
    if (end <= state.viewStart || rec.start >= state.viewEnd || end <= rec.start) return null;
    const left = Math.max(0, xOf(rec.start));
    const length = Math.min(canvasWidth(), xOf(end)) - left;
    return { left, width: Math.max(1, length) };
  }

  function exportChecked(channel) {
    if (!state.exportChannels.has(channel)) state.exportChannels.set(channel, true);
    return state.exportChannels.get(channel);
  }

  const selectionActive = () => state.selStart != null && state.selEnd != null
    && Math.max(state.selStart, state.selEnd) > Math.min(state.selStart, state.selEnd);

  function renderTimelineLabels(lanes) {
    const box = $('tlLabels');
    box.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tl-label head';
    box.appendChild(head);
    state.exportBoxes = [];
    const boxes = state.selectMode && lanes.length > 1;
    for (const lane of lanes) {
      const row = document.createElement(boxes ? 'label' : 'div');
      row.className = 'tl-label';
      if (boxes) {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = exportChecked(lane.channel);
        input.addEventListener('change', () => {
          state.exportChannels.set(lane.channel, input.checked);
          renderSelectionBar();
        });
        row.appendChild(input);
        state.exportBoxes.push({ channel: lane.channel, input });
      }
      const name = document.createElement('span');
      name.textContent = lane.name;
      row.appendChild(name);
      box.appendChild(row);
    }
  }

  const LONG_EXPORT = HOUR;         // footage (duration x channels) that earns a warning
  const SELECT_MIN = 1000;          // the export frame never collapses below one second

  /**
   * Export is a mode: "Export" turns on range selection, the same button then reads
   * "Export selection" and becomes active once a range is drawn.
   */
  function renderSelectionBar() {
    const bar = $('selectionBar');
    const active = selectionActive();
    if (active) state.selectMode = true;
    const mode = state.selectMode;
    bar.classList.toggle('hidden', !mode);
    $('btnExportLabel').textContent = t(mode ? 'exp.saveSelection' : 'exp.mode');
    const warning = $('selWarn');
    warning.classList.add('hidden');
    if (!active) {
      $('selRange').textContent = mode ? t('exp.selectHint') : '';
      $('btnExport').disabled = mode || Boolean(exportAbort);
      return;
    }
    const a = Math.min(state.selStart, state.selEnd);
    const b = Math.max(state.selStart, state.selEnd);
    $('selRange').textContent = `${fmtDateTime(a)} – ${fmtTime(b)} · ${fmtDuration(b - a)}`;

    const channels = timelineChannels().filter((channel) => exportChecked(channel));
    const footage = (b - a) * channels.length;
    if (footage > LONG_EXPORT) {
      warning.textContent = t('exp.long', { d: fmtDuration(footage) });
      warning.classList.remove('hidden');
    }
    $('btnExport').disabled = Boolean(exportAbort) || !channels.length;
  }

  /**
   * "Export" opens a frame from one minute before to one minute after the playhead
   * (never past now); its edges and body can be dragged. Leaving drops the frame.
   */
  function setSelectMode(on) {
    state.selectMode = on;
    if (on && !selectionActive()) {
      const now = Date.now();
      const at = Math.min(Math.round(activeTile().waitingFor ? sharedClockTime() : currentWall()), now);
      state.selStart = at - MIN;
      state.selEnd = Math.min(at + MIN, now);
      // Zoom so that the frame is wide enough to grab its edges.
      setView(at - 5 * MIN, at + 5 * MIN);
      syncSelectionInputs();
    }
    if (!on && selectionActive()) clearSelection();
    syncTimelineMode();
    resizeCanvas();               // labels gain or lose their export checkboxes
  }

  /** The toolbar button: first turn on the range selection, then export the range. */
  function exportButton() {
    if (!state.selectMode) setSelectMode(true);
    else if (selectionActive() && !exportAbort) doExport(...selectedExportRange());
  }

  function timelineRecordingAt(x, y, time) {
    const lanes = timelineLanes();
    const laneH = laneHeight();
    const index = Math.floor((y - LANE_TOP) / laneH);
    if (index < 0 || index >= lanes.length) return null;
    const lane = lanes[index];
    const laneY = LANE_TOP + index * laneH;
    const containsX = (r) => {
      const pixels = recordingPixels(r);
      return pixels && x >= pixels.left && x < pixels.left + pixels.width;
    };
    const at = (r) => containsX(r) && r.start <= time && time < recStop(r);
    // The collapsed lane merges every channel: look through each one.
    for (const source of lane.sources || [lane]) {
      // Ambiguous recordings sit as a thin gray strip at the bottom of the lane.
      if (y >= laneY + laneH - 5 && source.unknown.some(at)) return { channel: source.channel, unknown: true };
      const rec = source.recs.find((r) => r.type === 'triggered' && at(r));
      if (rec) return { rec, channel: source.channel };
    }
    return null;
  }

  function resizeCanvas() {
    const lanes = timelineLanes();
    const height = timelineHeight(lanes);
    canvas.style.height = `${height}px`;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderTimelineLabels(lanes);
    renderSelectionBar();
    draw();
  }

  function draw() {
    const W = canvas.clientWidth;
    const lanes = timelineLanes();
    const H = timelineHeight(lanes);
    const span = state.viewEnd - state.viewStart;
    const now = Date.now();

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    if (now < state.viewEnd) {                         // shade the future
      const xn = Math.max(0, xOf(now));
      ctx.fillStyle = COLORS.future;
      ctx.fillRect(xn, 0, W - xn, H);
    }

    const step = TICK_STEPS.find((s) => (W / (span / s)) >= TICK_MIN_PX) || DAY;
    const tzOffset = new Date(state.viewStart).getTimezoneOffset() * MIN;
    const changesOffset = new Date(state.viewEnd).getTimezoneOffset() * MIN !== tzOffset;
    let tick = Math.ceil((state.viewStart - tzOffset) / step) * step + tzOffset;
    ctx.font = `${FONT_PX}px ${COLORS.font}`;
    ctx.textBaseline = 'top';
    for (; tick <= state.viewEnd; tick += step) {
      const d = new Date(tick);
      const isMidnight = d.getHours() === 0 && d.getMinutes() === 0;
      // Day boundaries get a thicker, crisper line.
      const x = Math.round(xOf(tick)) + (isMidnight ? 0 : 0.5);
      ctx.strokeStyle = isMidnight ? COLORS.text : COLORS.line;
      ctx.lineWidth = isMidnight ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x, LANE_TOP - 6); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = COLORS.text;
      const hour = fmtTime(tick, step < MIN * 1.5);
      ctx.fillText(isMidnight ? fmtDate(tick) : changesOffset ? `${hour} ${fmtOffset(tick)}` : hour, x + 4, 4);
    }
    ctx.lineWidth = 1;

    const laneH = laneHeight();
    const inset = laneH > 24 ? 6 : 4;
    lanes.forEach((lane, index) => {
      const y = LANE_TOP + index * laneH;
      ctx.strokeStyle = COLORS.line;
      ctx.beginPath();
      ctx.moveTo(0, y + laneH - 0.5);
      ctx.lineTo(W, y + laneH - 0.5);
      ctx.stroke();

      const bar = (r, color) => {
        const pixels = recordingPixels(r);
        if (!pixels) return;
        ctx.fillStyle = color;
        ctx.fillRect(pixels.left, y + inset, pixels.width, laneH - 2 * inset - 2);
      };
      // Blue for every recording, then yellow for events so overlaps stay yellow.
      for (const r of lane.recs) if (r.type !== 'triggered') bar(r, COLORS.continuous);
      for (const r of lane.recs) if (r.type === 'triggered') bar(r, COLORS.triggered);

      for (const r of lane.unknown) {
        const x1 = Math.max(0, xOf(r.start));
        const x2 = Math.min(W, xOf(recStop(r)));
        if (x2 <= x1) continue;
        ctx.fillStyle = COLORS.text;
        ctx.fillRect(x1, y + laneH - 4, Math.max(1, x2 - x1), 2);
      }
    });

    if (state.selStart != null && state.selEnd != null) {
      const x1 = xOf(Math.min(state.selStart, state.selEnd));
      const x2 = xOf(Math.max(state.selStart, state.selEnd));
      ctx.fillStyle = COLORS.sel;
      ctx.fillRect(x1, 0, x2 - x1, H);
      // Thick edges are the handles for resizing the frame.
      ctx.fillStyle = COLORS.exportEdge;
      ctx.fillRect(x1 - 2, 0, 4, H);
      ctx.fillRect(x2 - 2, 0, 4, H);
      ctx.fillRect(x1, 0, x2 - x1, 2);
      ctx.fillRect(x1, H - 2, x2 - x1, 2);
    }

    const xp = xOf(activeTile().waitingFor ? sharedClockTime() : currentWall());
    if (xp >= 0 && xp <= W) {
      ctx.strokeStyle = state.mode === 'live' ? COLORS.live : COLORS.accent;
      ctx.lineWidth = 2;
      const top = LANE_TOP - 8;
      ctx.beginPath(); ctx.moveTo(xp, top); ctx.lineTo(xp, H); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.moveTo(xp - 6, top - 2); ctx.lineTo(xp + 6, top - 2); ctx.lineTo(xp, top + 5); ctx.fill();
    }
  }

  function setView(start, end, { fetch = true } = {}) {
    const span = Math.min(Math.max(end - start, MIN), 7 * DAY);
    const center = (start + end) / 2;
    state.viewStart = Math.round(center - span / 2);
    state.viewEnd = Math.round(center + span / 2);
    $('dayPicker').value = toDateInput((state.viewStart + state.viewEnd) / 2);
    draw();
    if (fetch) scheduleFetch();
  }

  const showDay = (dayStart) => setView(dayStart, shiftDay(dayStart, 1));
  const stepDay = (n) => showDay(shiftDay(startOfDay((state.viewStart + state.viewEnd) / 2), n));

  function zoom(factor, anchorT) {
    const a = anchorT != null ? anchorT : (state.viewStart + state.viewEnd) / 2;
    setView(a - (a - state.viewStart) * factor, a + (state.viewEnd - a) * factor);
  }

  let fetchTimer = null;
  let timelineRequest = null;
  const timelineStatus = (msg) => {
    const el = $('timelineStatus');
    if (el.textContent !== msg) el.textContent = msg;
    el.classList.toggle('hidden', !msg);
  };
  /** The channel label and export checkbox sit left of every timeline lane. */
  function scheduleFetch() {
    clearTimeout(fetchTimer);
    timelineRequest?.abort();
    timelineStatus(t('tl.loading'));
    fetchTimer = setTimeout(() => refreshRecordings(), 250);
  }

  async function refreshRecordings(background = false) {
    clearTimeout(fetchTimer);
    timelineRequest?.abort();
    const request = new AbortController();
    timelineRequest = request;
    const { viewStart, viewEnd } = state;
    const channels = timelineChannels();
    if (!channels.length) {
      state.recordingsByChannel.clear();
      state.recordings = [];
      state.unassignedRecordings = [];
      timelineStatus(t('tile.empty'));
      resizeCanvas();
      return;
    }
    const margin = (viewEnd - viewStart) * 0.5;
    if (!background) timelineStatus(t('tl.loading'));
    const from = viewStart - margin;
    const to = Math.min(viewEnd + margin, Date.now());
    // The camera lists every source in one answer: one request, split per channel.
    let results;
    try {
      const { rows, complete } = await listRecordingRows(from, to, { signal: request.signal });
      results = channels.map((channel) => ({ channel, ...selectChannel(rows, channel), complete }));
    } catch (e) {
      results = channels.map((channel) => ({ channel, error: e }));
    }
    if (request.signal.aborted) return;
    const map = new Map();
    let failed = null;
    let incomplete = false;
    let anyVisible = false;
    let unknownVisible = false;
    const visible = (r) => r.start < viewEnd && recStop(r) > viewStart;
    for (const result of results) {
      if (result.error) { failed = failed || result.error; continue; }
      map.set(result.channel, { recs: result.recs, unknown: result.unknown, complete: result.complete });
      if (!result.complete) incomplete = true;
      if (result.recs.some(visible)) anyVisible = true;
      if (result.unknown.some(visible)) unknownVisible = true;
    }
    state.recordingsByChannel = map;
    const active = map.get(state.channel);
    state.recordings = active ? active.recs : [];
    state.unassignedRecordings = active ? active.unknown : [];
    timelineStatus(incomplete ? t('tl.partial')
      : unknownVisible ? t('tl.unknown')
      : anyVisible ? ''
      : failed ? t('toast.timeline', { msg: failed.message })
      : t('tl.empty'));
    updateAudioOption();
    resizeCanvas();
  }

  function updateAudioOption() {
    const recs = [...state.recordingsByChannel.values()].flatMap((data) => data.recs);
    const none = recs.length > 0 && !recs.some((rec) => rec.hasAudio);
    $('expAudioHint').classList.toggle('hidden', !none);
  }

  function frameCanvas(video) {
    if (!video.videoWidth || !video.videoHeight) return null;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c;
  }

  function captureTileFrame(tile) {
    const frame = frameCanvas(tile.video);
    if (frame) tile.lastFrame = frame;
  }

  function snapshotFromTile(tile) {
    const frame = (tile.mode === 'paused' && tile.lastFrame)
      ? tile.lastFrame
      : (frameCanvas(tile.video) || tile.lastFrame);
    if (!frame) { toast(t('ctl.snapshot.none'), true); return; }
    const at = currentWall(tile);
    const suffix = multiChannel() ? `_ch${tile.channel}` : '';
    const name = `snapshot${suffix}_${fmtStamp(at)}.jpg`;
    const url = frame.toBlob
      ? null
      : frame.toDataURL('image/jpeg', 0.95);
    if (url) { download(url, name); return; }
    frame.toBlob((blob) => {
      const objectUrl = URL.createObjectURL(blob);
      download(objectUrl, name);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60 * 1000);
    }, 'image/jpeg', 0.95);
  }

  let drag = null;
  const EDGE_PX = 10;

  /** Which part of the export frame is under x: 'start' / 'end' edge, 'move' body, or null. */
  function frameHit(x) {
    if (!state.selectMode || !selectionActive()) return null;
    const a = xOf(Math.min(state.selStart, state.selEnd));
    const b = xOf(Math.max(state.selStart, state.selEnd));
    const da = Math.abs(x - a), db = Math.abs(x - b);
    // On a narrow frame both edges are in reach: take the nearer one.
    if (Math.min(da, db) <= EDGE_PX) return da < db ? 'start' : 'end';
    return x > a && x < b ? 'move' : null;
  }

  function editFrame(part, range0, dt) {
    let [a, b] = range0;
    if (part === 'start') a = Math.min(a + dt, b - SELECT_MIN);
    else if (part === 'end') b = Math.max(b + dt, a + SELECT_MIN);
    else { a += dt; b += dt; }
    const now = Date.now();           // no footage in the future
    if (b > now) {
      if (part === 'move') a -= b - now;
      b = now;
      a = Math.min(a, b - SELECT_MIN);
    }
    state.selStart = Math.round(a);
    state.selEnd = Math.round(b);
    syncSelectionInputs();
    draw();
  }

  const FRAME_CURSORS = { start: 'ew-resize', end: 'ew-resize', move: 'move' };

  canvas.addEventListener('pointerdown', (ev) => {
    if (!ev.isPrimary || ev.button !== 0) return;
    canvas.setPointerCapture(ev.pointerId);
    const part = frameHit(ev.offsetX);
    drag = {
      id: ev.pointerId, x0: ev.offsetX, view0: [state.viewStart, state.viewEnd],
      moved: false, mode: part || 'pan',
      frame0: [Math.min(state.selStart, state.selEnd), Math.max(state.selStart, state.selEnd)],
    };
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drag) canvas.style.cursor = FRAME_CURSORS[frameHit(ev.offsetX)] || 'grab';
    const tip = $('tlTooltip');
    const at = tOf(ev.offsetX);
    tip.textContent = `${fmtDateTime(at)} ${fmtOffset(at)}`;
    tip.style.left = `${ev.offsetX}px`;
    tip.classList.remove('hidden');
    if (drag?.id !== ev.pointerId) return;
    const dx = ev.offsetX - drag.x0;
    if (Math.abs(dx) > 3) drag.moved = true;
    if (!drag.moved) return;
    const dt = (dx / canvasWidth()) * (drag.view0[1] - drag.view0[0]);
    if (drag.mode === 'pan') setView(drag.view0[0] - dt, drag.view0[1] - dt);
    else editFrame(drag.mode, drag.frame0, dt);
  });
  function tileForChannel(channel) {
    return visibleTiles().find((tile) => tile.channel === channel) || activeTile();
  }

  canvas.addEventListener('pointerup', (ev) => {
    if (drag?.id !== ev.pointerId) return;
    const d = drag;
    drag = null;
    if (d.moved) return;
    const time = Math.round(tOf(ev.offsetX));
    const hit = timelineRecordingAt(ev.offsetX, ev.offsetY, time);
    if (hit?.rec) {
      const tile = tileForChannel(hit.channel);
      setActiveTile(tile);
      newPlaybackIntent(tile);
      const at = Math.max(hit.rec.start, Math.min(time, recStop(hit.rec) - 1));
      startRecording(tile, hit.rec, at);
      // The clicked event fixes the shared time; the others follow without jumping ahead.
      const others = visibleTiles().filter((other) => other !== tile);
      if (others.length) seekTogether(others, at);
    } else if (hit?.unknown) {
      playAt(time, { preferUnassigned: true, tile: tileForChannel(hit.channel) });
    } else {
      playAtAll(time);
    }
  });
  for (const type of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(type, (ev) => {
    if (drag?.id !== ev.pointerId) return;
    drag = null;
  });
  canvas.addEventListener('pointerleave', () => $('tlTooltip').classList.add('hidden'));
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    zoom(ev.deltaY > 0 ? 1.25 : 0.8, tOf(ev.offsetX));
  }, { passive: false });

  // ------------------------------------------------------------ Export

  function syncSelectionInputs() {
    if (state.selStart == null || state.selEnd == null) return;
    const a = Math.min(state.selStart, state.selEnd);
    const b = Math.max(state.selStart, state.selEnd);
    $('expStart').value = toLocalInput(a);
    $('expEnd').value = toLocalInput(b);
    dragExportRange = { a, b, startInput: $('expStart').value, endInput: $('expEnd').value };
    renderSelectionBar();
  }

  function selectionFromInputs() {
    const [a, b] = selectedExportRange();
    state.selStart = Number.isFinite(a) && b > a ? a : null;
    state.selEnd = state.selStart == null ? null : b;
    if (!exportAbort) $('expInfo').textContent = Number.isFinite(a) && Number.isFinite(b) && b <= a
      ? t('exp.endBeforeStart') : '';
    renderSelectionBar();
    draw();
  }

  function clearSelection() {
    state.selStart = state.selEnd = null;
    dragExportRange = null;
    $('expStart').value = $('expEnd').value = '';
    $('expInfo').textContent = '';
    renderSelectionBar();
    draw();
  }

  // A timeline selection is absolute, even during the repeated local hour in autumn.
  let dragExportRange = null;
  function selectedExportRange() {
    const startInput = $('expStart').value;
    const endInput = $('expEnd').value;
    return [
      dragExportRange?.startInput === startInput ? dragExportRange.a : fromLocalInput(startInput),
      dragExportRange?.endInput === endInput ? dragExportRange.b : fromLocalInput(endInput),
    ];
  }

  let exportAbort = null;

  function exportUrl(c, name, pw) {
    const p = new URLSearchParams({
      schemaversion: '1',
      recordingid: c.r.id,
      diskid: c.r.disk,
      exportformat: 'matroska',
      starttime: isoUtc(c.s),
      stoptime: isoUtc(c.e),
      filename: name,
    });
    if (pw) { p.set('password', pw); p.set('encryptionformat', 'zip-aes256'); }
    return `/axis-cgi/record/export/exportrecording.cgi?${p}`;
  }

  /** Every part as its own download (fallback / password). */
  async function exportSeparate(chosen, base, pw, { auto = true, includeAudio = true, signal, clipChannel, label = '' } = {}) {
    const list = $('expLinks');
    if (!pw && !includeAudio) {
      // No camera-side audio filter: remux each part in the browser and drop
      // the audio track (no transcoding).
      for (let i = 0; i < chosen.length; i++) {
        const suffix = chosen.length === 1 ? '' : `_${pad(i + 1, String(chosen.length).length)}`;
        await exportMerged([chosen[i]], `${base}${suffix}`, signal, clipChannel, {
          auto: auto && i === 0, includeAudio: false, label,
        });
      }
      return;
    }
    chosen.forEach((c, i) => {
      const suffix = chosen.length === 1 ? '' : `_${pad(i + 1, String(chosen.length).length)}`;
      const url = exportUrl(c, `${base}_${fmtStamp(c.s)}${suffix}`, pw);
      const li = document.createElement('li');
      const link = document.createElement(pw ? 'button' : 'a');
      if (pw) link.addEventListener('click', () => download(url, ''));
      else { link.href = url; link.download = ''; }
      link.textContent = [label, `${fmtDateTime(c.s)} – ${fmtTime(c.e)} (${fmtDuration(c.e - c.s)})`]
        .filter(Boolean).join(' · ');
      li.appendChild(link);
      list.appendChild(li);
      if (auto && i === 0) download(url, ''); // further parts are explicit links; browsers can block download bursts
    });
  }

  /** Load parts one after another and merge them into ONE .mkv in the browser. */
  async function exportMerged(chosen, base, signal, clipChannel, { auto = true, includeAudio = true, label = '' } = {}) {
    const a = chosen[0].s;
    const sources = chosen.map((c, i) => async () => {
      const res = await fetch(exportUrl(c, `${base}_part${i + 1}`, null), { credentials: 'same-origin', signal });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !res.body || /xml|html|json|text\/plain/i.test(type)) {
        await res.body?.cancel();
        throw new Error(t('exp.partFailed', { n: i + 1, status: res.status }));
      }
      return res.body;
    });
    const titleParts = [$('deviceName').textContent || 'Axis'];
    if (clipChannel) titleParts.push(clipChannel);
    const result = await window.MkvConcat.concat(sources, {
      includeAudio,
      // A cropped camera export can start at a preceding keyframe, so don't assert its actual DateUTC.
      startTimeMs: a === chosen[0].r.start ? a : undefined,
      title: titleParts.join(' – '),
      onProgress: ({ part, parts, bytes }) => {
        $('expInfo').textContent = [label, t('exp.loading', { part, parts, bytes: fmtBytes(bytes) })]
          .filter(Boolean).join(' · ');
      },
    });
    signal?.throwIfAborted();
    const url = URL.createObjectURL(result.blob);
    const name = `${base}_${fmtStamp(a)}.mkv`;
    if (auto) download(url, name);
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = url; link.download = name;
    link.textContent = [label, `${name} (${fmtBytes(result.blob.size)}, ${fmtDuration(result.durationMs)})`]
      .filter(Boolean).join(' · ');
    li.appendChild(link);
    $('expLinks').appendChild(li);
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    $('expInfo').textContent = [label, t('exp.done', { n: chosen.length })].filter(Boolean).join(' · ');
  }

  function planExport(recs, a, b) {
    const nonOverlapping = (rows) => {
      let end = a;
      const parts = [];
      for (const r of rows) {
        const s = Math.max(end, r.start), e = Math.min(b, recStop(r));
        if (e > s) { parts.push({ r, s, e }); end = e; }
      }
      return parts;
    };
    const sorted = recs.slice().sort((x, y) => x.start - y.start);
    const continuous = nonOverlapping(sorted.filter((r) => r.type === 'continuous'));
    const other = nonOverlapping(sorted.filter((r) => r.type !== 'continuous'));
    const parts = [...continuous];
    let i = 0;
    for (const { r, s, e } of other) {
      let start = s;
      while (i < continuous.length && continuous[i].e <= start) i++;
      while (i < continuous.length && continuous[i].s < e) {
        const cut = continuous[i];
        if (cut.s > start) parts.push({ r, s: start, e: cut.s });
        start = Math.max(start, cut.e);
        if (start >= e) break;
        i++;
      }
      if (start < e) parts.push({ r, s: start, e });
    }
    return parts.sort((x, y) => x.s - y.s);
  }

  async function doExport(a, requestedEnd) {
    if (exportAbort) return;
    const b = Math.min(requestedEnd, Date.now());
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) { toast(t('exp.invalidRange'), true); return; }

    const usePw = $('expPwEnable').checked;
    const pw = usePw ? $('expPw').value : null;
    if (usePw && !pw) { toast(t('exp.needPassword'), true); return; }
    const mergeRequested = $('expMerge').checked;
    const includeAudio = $('expAudio').checked !== false;
    const manual = state.manualRecording;
    let channels;
    if (manual) {
      channels = state.channel != null ? [state.channel] : [];
      if (!channels.length) { toast(t('tile.empty'), true); return; }
    } else {
      channels = timelineChannels().filter((channel) => exportChecked(channel));
      if (!channels.length) { toast(t('exp.noChannels'), true); return; }
    }
    if (usePw && !includeAudio) { toast(t('exp.audio.zip'), true); return; }

    const name = ($('expName').value.trim() || 'export').replace(/[^\w.-]+/g, '_');
    const request = new AbortController();
    const { signal } = request;
    exportAbort = request;
    $('btnExport').disabled = $('btnClearSel').disabled = true;
    $('btnCancelExport').classList.remove('hidden');
    $('expInfo').textContent = t('exp.checking');
    $('expLinks').innerHTML = '';
    let autoDownload = true;
    const outcomes = [];
    try {
      for (let i = 0; i < channels.length; i++) {
        const channel = channels[i];
        const single = channels.length === 1;
        const label = single ? '' : channelName(channel);
        try {
          if (!single) {
            $('expInfo').textContent = t('exp.channelProgress', {
              i: i + 1, n: channels.length, msg: t('exp.checking'),
            });
          }
          const data = manual
            ? { recs: [manual], unknown: [], complete: true }
            : await listRecordings(a, b, { channel, signal });
          signal.throwIfAborted();
          if (!data.complete) throw new Error(t('err.incomplete'));
          const overlaps = (r) => r.start < b && recStop(r) > a;
          if (data.unknown.some(overlaps)) throw new Error(t('err.source'));
          const chosen = planExport(data.recs.filter(overlaps), a, b);
          if (!chosen.length) { outcomes.push({ channel, none: true }); continue; }
          if (chosen.some(({ r }) => !r.disk)) throw new Error(t('err.xml'));
          const merge = mergeRequested && !usePw && chosen.length > 1;
          const gaps = b - a - chosen.reduce((ms, c) => ms + c.e - c.s, 0);
          const gapNote = gaps > 0 ? t('exp.gaps', { d: gaps < 1000 ? '< 1 s' : fmtDuration(gaps) }) : '';
          const base = manual ? `${name}_recording`
            : channels.length > 1 ? `${name}_ch${channel}` : name;
          const clipChannel = manual ? t('video.manualSource') : multiChannel() ? channelName(channel) : null;

          if (!merge) {
            await exportSeparate(chosen, base, pw, {
              auto: autoDownload, includeAudio, signal, clipChannel, label,
            });
            autoDownload = false;
            if (single) {
              $('expInfo').textContent = [t(chosen.length > 1 ? 'exp.parts' : 'exp.started', { n: chosen.length }), gapNote]
                .filter(Boolean).join(' ');
            }
          } else {
            try {
              await exportMerged(chosen, base, signal, clipChannel, { auto: autoDownload, includeAudio, label });
              autoDownload = false;
            } catch (e) {
              if (e instanceof window.MkvConcat.MkvConcatIncompatibleError) {
                await exportSeparate(chosen, base, null, {
                  auto: autoDownload, includeAudio, signal, clipChannel, label,
                });
                autoDownload = false;
                $('expInfo').textContent = t('exp.incompatible', { n: chosen.length });
              } else {
                throw e;
              }
            }
          }
          outcomes.push({ channel, chosen });
        } catch (e) {
          if (signal.aborted) throw e;
          outcomes.push({ channel, error: e });
          if (single) throw e;
        }
      }
      signal.throwIfAborted();
      if (channels.length > 1) {
        const failed = outcomes.filter((o) => o.error);
        const done = outcomes.filter((o) => o.chosen);
        $('expInfo').textContent = failed.length
          ? failed.map((o) => t('exp.channelFailed', { name: channelName(o.channel), msg: o.error.message })).join(' · ')
          : done.length ? t('exp.channelDone', { n: done.length }) : t('exp.none');
      }
    } catch (e) {
      $('expInfo').textContent = signal.aborted ? t('exp.aborted') : t('exp.failed', { msg: e.message });
    } finally {
      request.abort();
      exportAbort = null;
      $('btnCancelExport').classList.add('hidden');
      $('btnClearSel').disabled = false;
      renderSelectionBar();
    }
  }

  // ------------------------------------------------------------ Network status

  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  function formatBitrate(bps) {
    if (!Number.isFinite(bps) || bps <= 0) return '';
    return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbit/s` : `${Math.round(bps / 1e3)} kbit/s`;
  }

  /** media-stream-library reports one bitrate per track (video, audio). */
  function pipelineBitrate(pipeline) {
    const value = pipeline?.bitrate;
    const values = Array.isArray(value) ? value : [value];
    return values.reduce((sum, v) => sum + (Number(v) || 0), 0);
  }

  function totalBitrate() {
    return visibleTiles().reduce((sum, tile) => sum + pipelineBitrate(tile.pipeline), 0);
  }

  function updateBandwidth() {
    const total = totalBitrate();
    $('netRate').textContent = total > 0
      ? t('net.rate', { rate: formatBitrate(total) })
      : t('net.rate.none');
  }

  async function pingOnce(method) {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(3000)
      : undefined;
    const start = nowMs();
    const res = await fetch(`ping.txt?t=${Date.now()}`, {
      method, cache: 'no-store', credentials: 'same-origin', signal,
    });
    if (!res.ok) throw new Error(`${method} ${res.status}`);
    return Math.max(0, Math.round(nowMs() - start));
  }

  async function updatePing() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const el = $('netPing');
    try {
      el.textContent = t('net.ping', { ms: await pingOnce('HEAD') });
    } catch (e) {
      try {
        el.textContent = t('net.ping', { ms: await pingOnce('GET') });
      } catch (err) {
        el.textContent = t('net.ping.none');
      }
    }
  }

  // ------------------------------------------------------------ Status

  async function loadDeviceInfo() {
    try {
      const res = await fetch('/axis-cgi/basicdeviceinfo.cgi', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiVersion: '1.0', method: 'getAllUnrestrictedProperties' }),
      });
      const j = await res.json();
      const p = (j.data && j.data.propertyList) || {};
      // deviceName also titles merged exports.
      $('deviceName').textContent = [p.ProdShortName || p.ProdNbr, p.SerialNumber].filter(Boolean).join(' · ');
      Object.assign(state.device, {
        model: p.ProdFullName || p.ProdShortName || p.ProdNbr || '',
        serial: p.SerialNumber || '',
        firmware: p.Version || '',
      });
    } catch (e) { /* optional */ }
    renderDeviceInfo();
    await loadNetworkInfo();
  }

  const unique = (list) => [...new Set(list.filter(Boolean))];

  /**
   * Addresses for the settings sheet. The network API may need operator rights;
   * then the Network parameters, and at least the address this browser uses.
   */
  async function loadNetworkInfo() {
    let ipv4 = [], ipv6 = [], hostname = '';
    try {
      const res = await fetch('/axis-cgi/network_settings.cgi', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiVersion: '1.0', method: 'getNetworkInfo' }),
      });
      if (res.ok) {
        const data = (await res.json())?.data || {};
        hostname = data.system?.hostname?.hostname || '';
        for (const device of data.devices || []) {
          ipv4.push(...(device.IPv4?.addresses || []).map((a) => a.address));
          ipv6.push(...(device.IPv6?.addresses || []).map((a) => a.address));
        }
      }
    } catch (e) { /* try the parameters */ }
    if (!ipv4.length && !ipv6.length) {
      try {
        const p = await fetchParams('Network');
        ipv4.push(p['root.Network.eth0.IPAddress'] || p['root.Network.IPAddress']);
        ipv6.push(...(p['root.Network.eth0.IPv6.IPAddresses'] || '').split(/[\s,]+/));
        hostname = hostname || p['root.Network.HostName'] || '';
      } catch (e) { /* not readable for this user */ }
    }
    const host = (typeof location !== 'undefined' && location.hostname) || '';
    if (!ipv4.length && /^\d+\.\d+\.\d+\.\d+$/.test(host)) ipv4.push(host);
    if (!ipv6.filter(Boolean).length && host.includes(':')) ipv6.push(host.replace(/^\[|\]$/g, ''));
    Object.assign(state.device, { ipv4: unique(ipv4), ipv6: unique(ipv6), hostname });
    renderDeviceInfo();
  }

  function renderDeviceInfo() {
    const d = state.device;
    const box = $('deviceInfo');
    box.replaceChildren();
    for (const [key, value] of [
      ['device.model', d.model], ['device.serial', d.serial], ['device.firmware', d.firmware],
      ['device.hostname', d.hostname], ['device.ipv4', d.ipv4?.join('\n')], ['device.ipv6', d.ipv6?.join('\n')],
    ]) {
      if (!value) continue;
      const term = document.createElement('dt');
      term.textContent = t(key);
      const detail = document.createElement('dd');
      detail.textContent = value;
      box.appendChild(term);
      box.appendChild(detail);
    }
  }

  function renderStorageMeter() {
    const nameEl = $('storageDiskName');
    const usedEl = $('storageUsed');
    const fill = $('storageFill');
    const lock = $('storageLock');
    const lockIcon = $('storageLockIcon');
    const disk = state.disks?.find((d) => d.id === 'SD_DISK')
      || state.disks?.find((d) => d.status === 'ok')
      || state.disks?.[0];
    $('storageBar')?.classList.toggle('hidden', !disk);
    if (!disk) {
      nameEl.textContent = t('storage.none');
      usedEl.textContent = '';
      fill.style.width = '0%';
      fill.classList.remove('warn', 'critical');
      lock.classList.add('hidden');
      return;
    }
    const total = Number.isFinite(disk.total) ? disk.total : 0;
    const free = Number.isFinite(disk.free) ? disk.free : 0;
    const pct = total > 0 ? Math.max(0, Math.min(100, ((total - free) / total) * 100)) : 0;
    nameEl.textContent = diskName(disk.id);
    usedEl.textContent = total > 0 ? t('storage.used', {
      used: ((total - free) / 1024 / 1024).toFixed(1),
      total: (total / 1024 / 1024).toFixed(1),
    }) : '';
    fill.style.width = `${pct.toFixed(1)}%`;
    fill.classList.toggle('warn', pct >= 85 && pct < 95);
    fill.classList.toggle('critical', pct >= 95);
    const known = disk.encryptionKnown;
    lock.classList.toggle('hidden', !known);
    lock.classList.toggle('encrypted', known && disk.encrypted);
    lock.classList.toggle('unencrypted', known && !disk.encrypted);
    lockIcon.setAttribute('href', disk.encrypted ? '#ic-lock' : '#ic-lock-open');
    const lockText = t(disk.encrypted ? 'storage.encrypted' : 'storage.unencrypted');
    lock.setAttribute('aria-label', lockText);
    lock.setAttribute('data-tip', lockText);
    lock.title = lockText;
  }

  async function loadStorage() {
    try {
      const doc = await fetchXml('/axis-cgi/disks/list.cgi?diskid=all');
      state.disks = Array.from(xmlElement(doc, 'disks').getElementsByTagName('disk'), (d) => ({
        id: d.getAttribute('diskid'),
        name: d.getAttribute('name'),
        status: (d.getAttribute('status') || '').toLowerCase(),
        total: Number(d.getAttribute('totalsize')),   // kB
        free: Number(d.getAttribute('freesize')),     // kB
        locked: /^(yes|true)$/i.test(d.getAttribute('locked') || ''),
        readOnly: /^(yes|true)$/i.test(d.getAttribute('readonly') || ''),
        full: /^(yes|true)$/i.test(d.getAttribute('full') || ''),
        cleanup: d.getAttribute('cleanuppolicy'),
        encrypted: /^(yes|true)$/i.test(d.getAttribute('diskencrypted') || ''),
        encryptionKnown: d.getAttribute('diskencrypted') != null
          || d.getAttribute('diskencryptionenabled') != null,
        encryptionEnabled: /^(yes|true)$/i.test(
          d.getAttribute('diskencryptionenabled') || d.getAttribute('encryptionenabled') || ''),
      })).filter((d) => d.id);
      state.storageState = 'ready';
      const gb = (kb) => (kb / 1024 / 1024).toFixed(1);
      const connected = state.disks.filter((d) => d.status && d.status !== 'disconnected');
      const statusOf = (d) => (d.status !== 'ok' ? d.status : t(writableDisk(d) ? 'storage.ready' : 'storage.notWritable'));
      // The meter above already names the main disk and its usage: here only its state,
      // and a short line for each further disk.
      $('storageStatus').textContent = connected.length === 1 ? statusOf(connected[0])
        : connected.map((d) => `${diskName(d.id)}: ${statusOf(d)}${d.total > 0
          ? ' · ' + t('storage.used', { used: gb(d.total - d.free), total: gb(d.total) }) : ''}`).join(' · ');
    } catch (e) {
      state.disks = null;
      state.storageState = e.status === 401 || e.status === 403 ? 'forbidden' : 'unknown';
      const text = t(state.storageState === 'forbidden' ? 'storage.forbidden' : 'storage.unavailable');
      $('storageStatus').textContent = text;
    }
    renderStorageMeter();
  }

  const writableDisk = (d) => d.status === 'ok' && !d.locked && !d.readOnly && (!d.full || d.cleanup === 'fifo');
  const diskName = (id) => id === 'SD_DISK' ? t('storage.sd') : (state.disks?.find((d) => d.id === id)?.name || id);
  let activeRecording;
  let activeRequest;

  async function refreshActiveRecording() {
    activeRequest?.abort();
    const request = new AbortController();
    activeRequest = request;
    const channel = state.channel;
    // The active channel feeds the status chip; every visible channel gets its tile dot.
    const channels = [...new Set([channel, ...timelineChannels()].filter((c) => c != null))];
    if (channel == null) activeRecording = { channel: null, ongoing: [], unknown: false };
    else if (activeRecording?.channel !== channel) activeRecording = undefined;
    updateRecordingIndicator();
    if (!channels.length) return;
    try {
      const now = Date.now();
      const { rows } = await listRecordingRows(now - 5 * MIN, now, { signal: request.signal });
      if (request.signal.aborted) return;
      const ongoing = (r) => r.status === 'recording' && (!r.stop || r.stop > now - MIN);
      for (const c of channels) {
        const { recs, unknown } = selectChannel(rows, c);
        const running = recs.filter(ongoing);
        state.recordingNow.set(c, running.length > 0);
        if (c === channel) activeRecording = { channel, ongoing: running, unknown: unknown.some(ongoing) };
      }
    } catch (e) {
      if (request.signal.aborted) return;
      channels.forEach((c) => state.recordingNow.delete(c));
      if (channel != null) activeRecording = { channel, ongoing: [], unknown: true };
    }
    updateRecordingIndicator();
    updateAllTileUi();
  }

  function updateRecordingIndicator() {
    const indicator = $('recordingIndicator');
    if (!indicator) return;
    const ongoing = activeRecording?.channel === state.channel ? activeRecording.ongoing : [];
    const active = ongoing.length > 0;
    const activeDisks = [...new Set(ongoing.map((r) => r.disk).filter(Boolean))].map(diskName).join(', ');
    const key = !activeRecording ? 'rec.loading'
      : activeRecording.unknown ? 'rec.statusUnknown'
      : active ? (activeDisks ? 'rec.activeDisk' : 'rec.active')
      : 'rec.notRunning';
    const message = t(key, { disks: activeDisks });
    indicator.classList.toggle('active', active);
    if (indicator.textContent !== message) indicator.textContent = message;
  }

  // ------------------------------------------------------------ Wiring

  $('btnLive').addEventListener('click', () => {
    goLiveAll();
    const now = Date.now();
    if (now < state.viewStart || now > state.viewEnd) showDay(startOfDay(now));
  });
  $('btnPause').addEventListener('click', togglePauseAll);
  $('btnBack').addEventListener('click', () => skipBackAll(SKIP));
  $('btnBack5').addEventListener('click', () => skipBackAll(SKIP_SHORT));
  $('btnFwd').addEventListener('click', () => skipForwardAll(SKIP));
  $('btnRetryPlayback').addEventListener('click', retryPlaybackAll);
  function takeSnapshot() {
    const tile = activeTile();
    if (tile.channel == null) return;
    if (tile.mode === 'live' && tile.pendingSeek == null && tile.streamStatus === 'playing') {
      const p = new URLSearchParams({ camera: String(tile.channel) });
      if (tile.resolution) p.set('resolution', tile.resolution);
      const suffix = multiChannel() ? `_ch${tile.channel}` : '';
      download(`/axis-cgi/jpg/image.cgi?${p}`, `snapshot${suffix}_${fmtStamp(Date.now())}.jpg`);
      return;
    }
    snapshotFromTile(tile);
  }

  $('btnSnapshot').addEventListener('click', takeSnapshot);
  function setLayout(value) {
    // The current layout again: nothing to do (no reconnect, no lost pause).
    if (String(value) === String(state.layout) && !state.zoomReturn) return;
    state.zoomReturn = null;
    const shared = sharedTime(activeTile());
    state.layout = value;
    store.set('layout', state.layout);
    applyLayout();
    restoreSharedTime(shared);
    refreshRecordings();
    refreshActiveRecording();
  }

  $('layoutSelect').addEventListener('change', (ev) => setLayout(ev.target.value));
  document.querySelectorAll?.('#layoutSeg [data-layout]').forEach((button) => {
    button.addEventListener('click', () => setLayout(button.dataset.layout));
  });

  function setInspector(open) {
    const panel = $('inspector');
    document.body?.classList?.toggle?.('inspector-open', open);
    panel.classList.toggle('open', open);
    panel.setAttribute('aria-hidden', String(!open));
    $('btnInspector').setAttribute('aria-expanded', String(open));
    $('statusChip').setAttribute('aria-expanded', String(open));
    store.set('inspector', open ? '1' : '0');
  }

  const toggleInspector = () => setInspector(!$('inspector').classList.contains('open'));
  $('btnInspector').addEventListener('click', toggleInspector);
  $('statusChip').addEventListener('click', toggleInspector);
  $('btnInspectorClose').addEventListener('click', () => setInspector(false));
  document.addEventListener?.('pointerdown', (ev) => {
    if (ev.target.closest?.('.channel-picker')) return;
    state.tiles.forEach((tile) => hideChannelPicker(tile));
  });
  // Settings are secondary: the sheet stays closed until it is asked for.
  setInspector(store.get('inspector') === '1');

  // ------------------------------------------------------------ Theme

  const THEMES = ['system', 'light', 'dark'];
  const lightQuery = window.matchMedia?.('(prefers-color-scheme: light)');
  const themePreference = () => (THEMES.includes(store.get('theme')) ? store.get('theme') : 'system');

  /** "system" follows the operating system; the head script sets the first value before paint. */
  function applyTheme() {
    const pref = themePreference();
    const resolved = pref === 'system' ? (lightQuery?.matches ? 'light' : 'dark') : pref;
    if (document.documentElement) document.documentElement.dataset.theme = resolved;
    document.querySelectorAll?.('#themeSeg [data-theme-pref]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.themePref === pref));
    });
    readColors();
    if (state.viewEnd > state.viewStart) draw();
  }

  function setTheme(pref) {
    store.set('theme', THEMES.includes(pref) ? pref : 'system');
    applyTheme();
  }

  document.querySelectorAll?.('#themeSeg [data-theme-pref]').forEach((button) => {
    button.addEventListener('click', () => setTheme(button.dataset.themePref));
  });
  lightQuery?.addEventListener?.('change', () => { if (themePreference() === 'system') applyTheme(); });
  applyTheme();

  // ------------------------------------------------------------ Help and theater

  const bodyClass = (name, on) => document.body?.classList?.toggle?.(name, on);

  function openHelp() {
    const dialog = $('helpDialog');
    if (dialog.showModal) dialog.showModal();
    else dialog.classList.remove('hidden');
  }

  function closeHelp() {
    const dialog = $('helpDialog');
    if (dialog.close) dialog.close();
    else dialog.classList.add('hidden');
  }

  let theaterIdleTimer = null;

  function resetTheaterIdle() {
    clearTimeout(theaterIdleTimer);
    bodyClass('theater-idle', false);
    if (!state.theater) return;
    theaterIdleTimer = setTimeout(() => {
      const focused = document.activeElement;
      if (focused?.closest?.('.controls, .timeline-panel, .inspector, .app-menu, .help-dialog')) return;
      bodyClass('theater-idle', true);
    }, 2500);
  }

  function setTheater(on) {
    state.theater = on;
    bodyClass('theater', on);
    $('btnTheater').setAttribute('aria-pressed', String(on));
    if (on) {
      setInspector(false);
      const promise = document.documentElement?.requestFullscreen?.();
      promise?.catch?.(() => {});
      resetTheaterIdle();
      toast(t('theater.esc'));
    } else {
      const promise = document.exitFullscreen?.();
      promise?.catch?.(() => {});
      clearTimeout(theaterIdleTimer);
      bodyClass('theater-idle', false);
    }
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
    raf(resizeCanvas);
    updateModeUi();
  }

  $('pagerPrev').addEventListener('click', () => stepPager(-1));
  $('pagerNext').addEventListener('click', () => stepPager(1));
  $('btnTheater').addEventListener('click', () => setTheater(!state.theater));
  $('btnHelp').addEventListener('click', openHelp);
  $('btnHelpClose').addEventListener('click', closeHelp);
  document.addEventListener?.('fullscreenchange', () => {
    if (!document.fullscreenElement && state.theater) setTheater(false);
    else { const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0); raf(() => resizeCanvas()); }
  });
  document.addEventListener?.('pointermove', resetTheaterIdle, { passive: true });

  // ------------------------------------------------------------ Shortcuts

  const SHORTCUT_TIPS = {
    btnPause: 'Space', btnLive: 'L', btnBack: 'Shift+←', btnBack5: '←',
    btnFwd: '→', btnSnapshot: 'S', btnHelp: '?',
  };

  function resolveShortcut(ev, context = {}) {
    const key = ev.key;
    if (context.typing || context.dialog || ev.altKey || ev.ctrlKey || ev.metaKey) return null;
    if (key === ' ' && context.button) return null;
    if (key === ' ') return 'pause';
    if (key === 'Escape') return 'escape';
    if (key === '?' || (key === '/' && ev.shiftKey)) return 'help';
    if (key === 'l' || key === 'L') return 'live';
    if (key === 'f' || key === 'F') return 'theater';
    if (key === 's' || key === 'S') return 'snapshot';
    if (key === 'e' || key === 'E') return context.exporting ? null : 'export';
    if (key === 'a' || key === 'A') return 'layout:auto';
    if (key === 't' || key === 'T') return 'today';
    if (key === 'ArrowLeft') return ev.shiftKey ? 'back30' : 'back5';
    if (key === 'ArrowRight') return ev.shiftKey ? 'forward30' : 'forward5';
    if (key === '+' || key === '=') return 'zoomIn';
    if (key === '-') return 'zoomOut';
    if (/^[1246]$/.test(key)) return `layout:${key}`;
    return null;
  }

  function handleEscape() {
    const pickerOpen = state.tiles.some((tile) => tile.picker && !tile.picker.classList.contains('hidden'));
    if (pickerOpen) { state.tiles.forEach((tile) => hideChannelPicker(tile)); return; }
    if ($('helpDialog')?.open) { closeHelp(); return; }
    if ($('inspector').classList.contains('open')) { setInspector(false); return; }
    if (state.selectMode) { setSelectMode(false); return; }
    if (state.theater) { setTheater(false); }
  }

  document.addEventListener?.('keydown', (ev) => {
    if (ev.defaultPrevented) return;
    const target = ev.target;
    const typing = Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'))
      || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '');
    const action = resolveShortcut(ev, {
      typing,
      button: target?.tagName === 'BUTTON' || target?.tagName === 'SUMMARY',
      dialog: Boolean($('helpDialog')?.open),
      selection: selectionActive(),
      exporting: Boolean(exportAbort),
    });
    if (!action) return;
    if (action === 'escape') { ev.preventDefault(); handleEscape(); return; }
    if (action === 'help') { ev.preventDefault(); openHelp(); return; }
    ev.preventDefault();
    resetTheaterIdle();
    switch (action) {
      case 'pause': togglePauseAll(); break;
      case 'live': goLiveAll(); break;
      case 'back5': skipBackAll(SKIP_SHORT); break;
      case 'back30': skipBackAll(SKIP); break;
      case 'forward5': skipForwardAll(SKIP_SHORT); break;
      case 'forward30': skipForwardAll(SKIP); break;
      case 'snapshot': takeSnapshot(); break;
      case 'export': exportButton(); break;
      case 'theater': setTheater(!state.theater); break;
      case 'today': showDay(startOfDay(Date.now())); break;
      case 'zoomIn': zoom(0.8, currentWall()); break;
      case 'zoomOut': zoom(1.25, currentWall()); break;
      default:
        if (action.startsWith('layout:')) setLayout(action.slice(7));
    }
  });

  // ------------------------------------------------------------ Tooltips

  let tipTimer = null;

  function hideTip() {
    clearTimeout(tipTimer);
    $('tooltip').classList.add('hidden');
  }

  function showTip(element) {
    const base = element.dataset.tip || (element.dataset.i18nTitle ? t(element.dataset.i18nTitle) : '');
    if (!base) return;
    const shortcut = SHORTCUT_TIPS[element.id];
    const tip = $('tooltip');
    tip.textContent = shortcut ? `${base} · ${shortcut}` : base;
    tip.classList.remove('hidden');
    const rect = element.getBoundingClientRect();
    const width = tip.offsetWidth || 0;
    const height = tip.offsetHeight || 0;
    let left = rect.left + rect.width / 2;
    left = Math.max(8 + width / 2, Math.min(window.innerWidth - 8 - width / 2, left));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = rect.top - height - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }

  function tipTarget(node) {
    return node?.closest?.('[data-tip]');
  }

  document.addEventListener?.('pointerover', (ev) => {
    const target = tipTarget(ev.target);
    if (!target) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(target), 380);
  });
  document.addEventListener?.('pointerout', (ev) => {
    if (tipTarget(ev.target)) hideTip();
  });
  document.addEventListener?.('focusin', (ev) => {
    const target = tipTarget(ev.target);
    if (target) showTip(target);
  });
  document.addEventListener?.('focusout', hideTip);
  document.addEventListener?.('pointerdown', hideTip, { capture: true });

  $('dayPicker').addEventListener('change', (ev) => {
    if (!ev.target.value) return;
    const [y, m, d] = ev.target.value.split('-').map(Number);
    showDay(new Date(y, m - 1, d).getTime());
  });
  $('btnPrevDay').addEventListener('click', () => stepDay(-1));
  $('btnNextDay').addEventListener('click', () => stepDay(1));
  $('btnToday').addEventListener('click', () => showDay(startOfDay(Date.now())));
  $('btnZoomIn').addEventListener('click', () => zoom(0.5, state.mode === 'live' ? null : currentWall()));
  $('btnZoomOut').addEventListener('click', () => zoom(2));

  $('expStart').addEventListener('change', selectionFromInputs);
  $('expEnd').addEventListener('change', selectionFromInputs);
  $('expPwEnable').addEventListener('change', (ev) => $('expPwRow').classList.toggle('hidden', !ev.target.checked));
  $('btnExport').addEventListener('click', exportButton);
  $('btnCancelExport').addEventListener('click', () => { if (exportAbort) exportAbort.abort(); });
  $('btnClearSel').addEventListener('click', () => setSelectMode(false));


  document.querySelectorAll('.lang-switch [data-lang]').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === window.I18N.lang);
    b.addEventListener('click', () => { saveSessionSnapshot(); window.I18N.setLang(b.dataset.lang); });
  });

  window.addEventListener('resize', resizeCanvas);

  setInterval(() => {
    for (const tile of state.tiles) {
      if (!tile.visible) continue;
      if (tile.channel == null) {
        $(tileId(tile, 'clock')).textContent = '–';
        continue;
      }
      // A tile waiting for footage shows the shared clock, not its old hold time.
      const time = tile.waitingFor ? sharedClockTime() : currentWall(tile);
      $(tileId(tile, 'clock')).textContent = fmtDateTime(time);
      // continue past the end of a completed recording
      if (tile.mode === 'playback' && tile.streamStatus === 'playing' && tile.rec?.stop != null && time > tile.rec.stop + 2000) {
        onRecordingEnded(tile);
      }
    }
    followSharedClock();
    if (!drag) draw();
  }, 250);

  document.addEventListener?.('pointerdown', unlockAudio, { capture: true });
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') updatePing();
  });
  setInterval(updateBandwidth, 1000);
  setInterval(updatePing, 5000);
  for (const tile of state.tiles) wireTile(tile);
  updateAllTileUi();

  // Interface for add-on modules (ptz.js)
  window.MicroVms = {
    toast,
    mode: () => announcedMode,
    channel: () => activeTile().channel,
    activeVideo: () => activeTile().video,
    videos: () => state.tiles.map((tile) => tile.video),
  };

  function saveSessionSnapshot() {
    try {
      sessionStorage.setItem('minivms.session', JSON.stringify({
        layout: state.layout,
        viewStart: state.viewStart,
        viewEnd: state.viewEnd,
        selStart: state.selStart,
        selEnd: state.selEnd,
        active: state.active,
        channels: state.tiles.map((tile) => tile.channel),
      }));
    } catch (e) { /* ignore */ }
  }

  function readSessionSnapshot() {
    try {
      return JSON.parse(sessionStorage.getItem('minivms.session') || 'null');
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------ Start

  (async () => {
    const now = Date.now();
    const session = readSessionSnapshot();
    loadLayoutPreference();
    if (session && ['auto', '1', '2', '4', '6'].includes(session.layout)) state.layout = session.layout;
    const viewStart = Number.isFinite(session?.viewStart) ? session.viewStart : now - 2 * HOUR;
    const viewEnd = Number.isFinite(session?.viewEnd) ? session.viewEnd : now + 30 * MIN;
    setView(viewStart, viewEnd, { fetch: false });
    resizeCanvas();
    updateModeUi();
    updateBandwidth();
    updatePing();
    loadDeviceInfo();
    loadStorage();
    await Promise.all([loadChannels(), loadStreamProfiles()]);
    if (session && Array.isArray(session.channels)) {
      session.channels.forEach((camera, index) => {
        const tile = state.tiles[index];
        // null is a deliberately emptied slot and must stay empty.
        if (tile && (camera === null || state.channels.some((c) => c.camera === camera))) {
          tile.channel = camera;
          tile.channelTouched = true;
          loadTilePreferences(tile);
        }
      });
      state.tiles.forEach((tile) => renderTileMenu(tile));
      const active = state.tiles[session.active];
      if (active && active.visible) setActiveTile(active);
      if (Number.isFinite(session.selStart) && Number.isFinite(session.selEnd) && session.selEnd > session.selStart) {
        state.selStart = session.selStart;
        state.selEnd = session.selEnd;
        syncSelectionInputs();
      }
    }
    document.dispatchEvent(new CustomEvent('microvms:channel', { detail: { channel: activeTile().channel, previous: null } }));
    if (!activeTile().intent) goLiveAll();
    await loadRecordingSources();
    refreshRecordings();
    refreshActiveRecording();
    setInterval(() => { loadRecordingSources().then(() => refreshRecordings(true)); refreshActiveRecording(); }, 30 * 1000);
    setInterval(() => { loadStorage(); }, 60 * 1000);
  })();
})();
