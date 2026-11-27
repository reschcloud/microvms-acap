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
    timelineCheckboxes: [],      // { channel, input } for the left gutter
    viewStart: 0,
    viewEnd: 0,
    selStart: null,
    selEnd: null,
    selectMode: false,
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
      audio: false,                // audio track requested
      muteUntilPlaying: false,     // unmute after the next playing event
      lastFrame: null,             // canvas with the last visible frame (pause/snapshot)
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
    $('layoutSelect').value = String(state.layout);
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
    return tile.profile && tile.profile !== 'auto' && state.streamProfiles.some((p) => p.name === tile.profile)
      ? tile.profile
      : autoProfileName();
  }

  function loadTilePreferences(tile) {
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

    updateTileLabel(tile);
    updateTileAudio(tile);
  }

  function wireTile(tile) {
    tile.el.addEventListener('pointerdown', () => setActiveTile(tile));
    tile.video.addEventListener('playing', () => onTilePlaying(tile));

    const chSel = $(tileId(tile, 'tileChannel'));
    chSel.addEventListener('change', () => setTileChannel(tile, chSel.value ? Number(chSel.value) : null));

    const streamSel = $(tileId(tile, 'tileStream'));
    streamSel.addEventListener('change', () => {
      tile.profile = streamSel.value || 'auto';
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
      refreshActiveRecording();
      renderRecordingConfig();
    }
    if (tile.visible) refreshRecordings();
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
    $('layoutSelect').value = String(state.layout);
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
    if (to != null && to < from) return { recs: [], unknown: [], complete: true };
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
      const selected = selectChannel([...seen.values()], channel);
      const raw = container?.getAttribute('numberofrecordings');
      const reported = raw && /^\d+$/.test(raw) ? Number(raw) : null;
      // Only ask for another page when this one was full and the camera reports more.
      const more = rows.length >= PAGE_SIZE && (reported == null || seen.size < reported);
      if (!more) return { ...selected, complete: true };
      // A camera that ignores startatresultnumber must not blank the whole timeline.
      if (seen.size === before || page + 1 >= MAX_PAGES) return { ...selected, complete: false };
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
    if (tile === activeTile()) {
      $('sourceChoices').classList.add('hidden');
      $('sourceChoiceList').replaceChildren();
    }
    return tile.intent;
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
    if (tile === activeTile()) {
      videoMsg(tile, tile.pendingSeek == null ? msg : t('video.seeking'));
    }
    updateModeUi(tile);
  }

  function startPipeline(tile, parameters, offsetSec, retryLive = true) {
    stopPipeline(tile);
    const gen = tile.generation;
    const video = tile.video;
    tile.syncWall = null;
    tile.baseCt = null;
    tile.lastFrame = null;
    setStreamStatus(tile, 'connecting', t('video.connecting'));
    if (!MSL?.Html5VideoPipeline) { setStreamStatus(tile, 'error', t('video.libMissing')); return; }
    const fail = (msg, reconnect = false) => {
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
    tile.streamTimer = setTimeout(() => fail(t('video.timeout')), 15000);

    pipeline.onSync = (ntp) => { if (gen === tile.generation) tile.syncWall = ntp; };
    pipeline.onServerClose = () => {
      if (gen !== tile.generation) return;
      if (tile.mode === 'playback' && tile.pendingSeek == null && tile.rec?.stop != null && Math.abs(currentWall(tile) - tile.rec.stop) < 2000) {
        onRecordingEnded(tile);
      } else {
        fail(t('video.disconnected'), true);
      }
    };
    pipeline.rtsp.onError = (err) => {
      fail(t('video.rtspError', { msg: err.message || err }));
    };
    pipeline.rtsp.onRtcp = (rtcp) => {
      if (gen !== tile.generation) return;
      if (MSL.isRtcpBye(rtcp) && tile.mode === 'playback') onRecordingEnded(tile);
    };

    pipeline.ready
      .then(() => {
        if (gen !== tile.generation) return;
        pipeline.rtsp.play(offsetSec || 0);
        return video.play();
      })
      .catch((err) => {
        fail(t('video.connectFailed', { msg: err?.message || t('video.wsError') }));
      });
  }

  const audioParams = (tile) => (audioEnabled(tile) ? ['audio=1', 'audiocodec=aac'] : ['audio=0']);

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
      setStreamStatus(tile, 'idle', t('tile.empty'));
      return;
    }
    newPlaybackIntent(tile);
    tile.mode = 'live';
    tile.rec = null;
    tile.pausedAt = null;
    startPipeline(tile, liveParameters(tile), 0, retryLive);
  }

  function holdAt(tile, time, msg) {
    stopPipeline(tile);
    tile.mode = 'paused';
    tile.rec = null;
    tile.pausedAt = time;
    setStreamStatus(tile, 'idle', msg);
  }

  function startRecording(tile, rec, time) {
    tile.mode = 'playback';
    tile.rec = rec;
    tile.startWall = time;
    tile.pausedAt = null;
    $('jumpTime').value = toLocalInput(time);
    startPipeline(tile, [`recordingid=${encodeURIComponent(rec.id)}`, ...audioParams(tile)],
      Math.max(0, (time - rec.start) / 1000));
  }

  function offerRecordings(tile, intent, time, choices) {
    holdAt(tile, time, t('video.chooseSource'));
    const list = $('sourceChoiceList');
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
    $('sourceChoiceHint').textContent = t(choices.length > 12 ? 'video.sourceLimited' : 'video.sourceHint');
    $('sourceChoices').classList.remove('hidden');
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
    if (tile === activeTile()) videoMsg(tile, t('video.seeking'));
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
      holdAt(tile, time, t('video.noRecordingFrom', { when: fmtDateTime(time) }));
      return;
    }
    if (rec.start > time) {
      toast(t('toast.jumpTo', { time: fmtTime(rec.start) }));
      time = rec.start;
    }
    startRecording(tile, rec, time);
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
      if (next) startRecording(tile, next, Math.max(next.start, end));
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
      holdAt(tile, time, '');
      return;
    }
    if (tile.mode === 'paused') return;
    const time = currentWall(tile);
    const manual = tile.manualRecording;
    newPlaybackIntent(tile);
    tile.manualRecording = manual;
    tile.video.pause();
    captureTileFrame(tile);
    holdAt(tile, time, '');
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
    for (const tile of visibleTiles()) playAt(time, { tile });
  }

  function skipBackAll(seconds) {
    for (const tile of visibleTiles()) skipBack(seconds, tile);
  }

  function skipForwardAll(seconds) {
    for (const tile of visibleTiles()) {
      playAt((tile.pendingSeek ?? currentWall(tile)) + seconds, { reuseManual: true, tile });
    }
  }

  function togglePauseAll() {
    const tiles = visibleTiles();
    if (!tiles.length) return;
    if (tiles.every((tile) => tile.mode === 'paused' && tile.pendingSeek == null)) {
      tiles.forEach((tile) => resumeTile(tile));
    } else {
      tiles.forEach((tile) => pauseTile(tile));
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
    const label = $(tileId(tile, 'tileLabel'));
    const empty = tile.channel == null;
    tile.el.classList.toggle('empty', empty);
    label.textContent = empty ? t('tile.empty') : channelName(tile.channel);
    label.classList.toggle('hidden', !multiChannel() && state.layoutSize === 1);
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
  }

  let audioUnlocked = false;
  const AAC_MIME = 'audio/mp4; codecs="mp4a.40.2"';

  function audioSupported() {
    return typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported
      || MediaSource.isTypeSupported(AAC_MIME);
  }

  const audioEnabled = (tile) => tile.audio && audioSupported();

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
    btn.title = t(!supported ? 'tile.audio.unavailable' : on ? 'tile.audio.on' : 'tile.audio.off');
    use.setAttribute('href', on ? '#ic-speaker' : '#ic-speaker-off');
  }

  function setTileAudio(tile, on) {
    if (tile.channel == null) return;
    if (on && !audioSupported()) { toast(t('tile.audio.unavailable'), true); return; }
    audioUnlocked = true;
    tile.audio = on;
    tile.muteUntilPlaying = on;
    store.set(`audio.${tile.channel}`, on ? '1' : '0');
    applyTileMuted(tile);
    updateTileAudio(tile);
    if (!tile.visible) return;
    if (on && tile.mode === 'live' && tile.pendingSeek == null) goLive(true, tile);
    else if (on && tile.mode === 'playback') playAt(currentWall(tile), { reuseManual: true, tile });
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
      renderRecordingConfig();
    }
  }

  let announcedMode;
  function updateModeUi(tile = activeTile()) {
    updateTileBadge(tile);
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
    $('liveSep').classList.toggle('hidden', hideLive);
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
  const css = getComputedStyle(document.documentElement);
  const cssVar = (n, d) => css.getPropertyValue(n).trim() || d;
  const COLORS = {
    bg: cssVar('--panel-2', '#1e242c'),
    line: cssVar('--line', '#2a313b'),
    text: cssVar('--muted', '#8a94a3'),
    continuous: cssVar('--continuous', '#3b82f6'),
    triggered: cssVar('--triggered', '#f59e0b'),
    scheduled: cssVar('--scheduled', '#a855f7'),
    other: cssVar('--other', '#60c8bd'),
    sel: cssVar('--sel', 'rgba(255,204,51,.25)'),
    accent: cssVar('--accent', '#ffcc33'),
    live: cssVar('--live', '#e5484d'),
  };
  const TICK_STEPS = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];

  const canvasWidth = () => canvas.clientWidth;
  const xOf = (time) => ((time - state.viewStart) / (state.viewEnd - state.viewStart)) * canvasWidth();
  const tOf = (x) => state.viewStart + (x / canvasWidth()) * (state.viewEnd - state.viewStart);
  const LANE_TOP = 24;
  const LANE_HEIGHT = 30;

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
    return timelineChannels().map((channel) => {
      const data = state.recordingsByChannel.get(channel);
      return {
        channel,
        name: channelName(channel),
        recs: data ? data.recs : [],
        unknown: data ? data.unknown : [],
        complete: data ? data.complete : true,
      };
    });
  }

  const laneGeometry = (index) => ({ y: LANE_TOP + index * LANE_HEIGHT, height: LANE_HEIGHT });
  const timelineHeight = (lanes = timelineLanes()) => LANE_TOP + Math.max(1, lanes.length) * LANE_HEIGHT;

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

  function updateExportCheckboxes() {
    const enabled = selectionActive();
    for (const { channel, input } of state.timelineCheckboxes) {
      input.disabled = !enabled;
      input.checked = exportChecked(channel);
    }
  }

  function renderTimelineLabels(lanes) {
    const box = $('tlLabels');
    box.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tl-label head';
    box.appendChild(head);
    state.timelineCheckboxes = [];
    for (const lane of lanes) {
      const row = document.createElement('label');
      row.className = 'tl-label';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = exportChecked(lane.channel);
      input.disabled = !selectionActive();
      input.title = t('tl.exportChannel');
      input.addEventListener('change', () => {
        state.exportChannels.set(lane.channel, input.checked);
      });
      const name = document.createElement('span');
      name.textContent = lane.name;
      row.appendChild(input);
      row.appendChild(name);
      box.appendChild(row);
      state.timelineCheckboxes.push({ channel: lane.channel, input });
    }
  }

  function timelineRecordingAt(x, y, time) {
    const lanes = timelineLanes();
    const index = Math.floor((y - LANE_TOP) / LANE_HEIGHT);
    if (index < 0 || index >= lanes.length) return null;
    const lane = lanes[index];
    const laneY = LANE_TOP + index * LANE_HEIGHT;
    const containsX = (r) => {
      const pixels = recordingPixels(r);
      return pixels && x >= pixels.left && x < pixels.left + pixels.width;
    };
    // Ambiguous recordings sit as a thin gray strip at the bottom of the lane.
    if (y >= laneY + LANE_HEIGHT - 5) {
      const unknown = lane.unknown.find((r) => containsX(r) && r.start <= time && time < recStop(r));
      if (unknown) return { channel: lane.channel, unknown: true };
    }
    const matches = lane.recs.filter((r) => r.type === 'triggered'
      && containsX(r) && r.start <= time && time < recStop(r));
    return matches.length ? { rec: matches[0], channel: lane.channel } : null;
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
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(xn, 0, W - xn, H);
    }

    const step = TICK_STEPS.find((s) => (W / (span / s)) >= 70) || DAY;
    const tzOffset = new Date(state.viewStart).getTimezoneOffset() * MIN;
    const changesOffset = new Date(state.viewEnd).getTimezoneOffset() * MIN !== tzOffset;
    let tick = Math.ceil((state.viewStart - tzOffset) / step) * step + tzOffset;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (; tick <= state.viewEnd; tick += step) {
      const d = new Date(tick);
      const isMidnight = d.getHours() === 0 && d.getMinutes() === 0;
      // Day boundaries get a thicker, crisper line.
      const x = Math.round(xOf(tick)) + (isMidnight ? 0 : 0.5);
      ctx.strokeStyle = isMidnight ? COLORS.text : COLORS.line;
      ctx.lineWidth = isMidnight ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = COLORS.text;
      const hour = fmtTime(tick, step < MIN * 1.5);
      ctx.fillText(isMidnight ? fmtDate(tick) : changesOffset ? `${hour} ${fmtOffset(tick)}` : hour, x + 3, 4);
    }
    ctx.lineWidth = 1;

    lanes.forEach((lane, index) => {
      const y = LANE_TOP + index * LANE_HEIGHT;
      ctx.strokeStyle = COLORS.line;
      ctx.beginPath();
      ctx.moveTo(0, y + LANE_HEIGHT - 0.5);
      ctx.lineTo(W, y + LANE_HEIGHT - 0.5);
      ctx.stroke();

      const bar = (r, color) => {
        const pixels = recordingPixels(r);
        if (!pixels) return;
        ctx.fillStyle = color;
        ctx.fillRect(pixels.left, y + 2, pixels.width, LANE_HEIGHT - 6);
      };
      // Blue for every recording, then yellow for events so overlaps stay yellow.
      for (const r of lane.recs) if (r.type !== 'triggered') bar(r, COLORS.continuous);
      for (const r of lane.recs) if (r.type === 'triggered') bar(r, COLORS.triggered);

      for (const r of lane.unknown) {
        const x1 = Math.max(0, xOf(r.start));
        const x2 = Math.min(W, xOf(recStop(r)));
        if (x2 <= x1) continue;
        ctx.fillStyle = COLORS.text;
        ctx.fillRect(x1, y + LANE_HEIGHT - 4, Math.max(1, x2 - x1), 2);
      }
    });

    if (state.selStart != null && state.selEnd != null) {
      const x1 = xOf(Math.min(state.selStart, state.selEnd));
      const x2 = xOf(Math.max(state.selStart, state.selEnd));
      ctx.fillStyle = COLORS.sel;
      ctx.fillRect(x1, 0, x2 - x1, H);
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(x1 + 0.5, 0.5, x2 - x1 - 1, H - 1);
    }

    const xp = xOf(currentWall());
    if (xp >= 0 && xp <= W) {
      ctx.strokeStyle = state.mode === 'live' ? COLORS.live : COLORS.accent;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(xp, 16); ctx.lineTo(xp, H); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.moveTo(xp - 5, 14); ctx.lineTo(xp + 5, 14); ctx.lineTo(xp, 20); ctx.fill();
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
    // One request per visible channel; a failing channel does not blank the others.
    const results = await Promise.all(channels.map(async (channel) => {
      try {
        return { channel, ...(await listRecordings(from, to, { channel, signal: request.signal })) };
      } catch (e) {
        return { channel, error: e };
      }
    }));
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
  canvas.addEventListener('pointerdown', (ev) => {
    if (!ev.isPrimary || ev.button !== 0) return;
    canvas.setPointerCapture(ev.pointerId);
    const selecting = state.selectMode || ev.shiftKey;
    drag = { id: ev.pointerId, x0: ev.offsetX, view0: [state.viewStart, state.viewEnd], moved: false, selecting, t0: tOf(ev.offsetX) };
    if (selecting) canvas.classList.add('selecting');
  });
  canvas.addEventListener('pointermove', (ev) => {
    const tip = $('tlTooltip');
    const at = tOf(ev.offsetX);
    tip.textContent = `${fmtDateTime(at)} ${fmtOffset(at)}`;
    tip.style.left = `${ev.offsetX}px`;
    tip.classList.remove('hidden');
    if (drag?.id !== ev.pointerId) return;
    const dx = ev.offsetX - drag.x0;
    if (Math.abs(dx) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.selecting) {
      state.selStart = drag.t0;
      state.selEnd = Math.min(tOf(ev.offsetX), Date.now());
      syncSelectionInputs();
      draw();
    } else {
      const dt = (dx / canvasWidth()) * (drag.view0[1] - drag.view0[0]);
      setView(drag.view0[0] - dt, drag.view0[1] - dt);
    }
  });
  function tileForChannel(channel) {
    return visibleTiles().find((tile) => tile.channel === channel) || activeTile();
  }

  canvas.addEventListener('pointerup', (ev) => {
    if (drag?.id !== ev.pointerId) return;
    const d = drag;
    drag = null;
    canvas.classList.toggle('selecting', state.selectMode);
    if (!d.moved && !d.selecting) {
      const time = Math.round(tOf(ev.offsetX));
      const hit = timelineRecordingAt(ev.offsetX, ev.offsetY, time);
      if (hit?.rec) {
        const tile = tileForChannel(hit.channel);
        setActiveTile(tile);
        newPlaybackIntent(tile);
        const at = Math.max(hit.rec.start, Math.min(time, recStop(hit.rec) - 1));
        startRecording(tile, hit.rec, at);
        for (const other of visibleTiles()) if (other !== tile) playAt(at, { tile: other });
      } else if (hit?.unknown) {
        playAt(time, { preferUnassigned: true, tile: tileForChannel(hit.channel) });
      } else {
        playAtAll(time);
      }
    }
  });
  for (const type of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(type, (ev) => {
    if (drag?.id !== ev.pointerId) return;
    drag = null;
    canvas.classList.toggle('selecting', state.selectMode);
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
    if (!exportAbort) $('expInfo').textContent = t('exp.duration', { d: fmtDuration(b - a) });
    updateExportCheckboxes();
  }

  function selectionFromInputs() {
    const [a, b] = selectedExportRange();
    state.selStart = Number.isFinite(a) && b > a ? a : null;
    state.selEnd = state.selStart == null ? null : b;
    if (!exportAbort) $('expInfo').textContent = !Number.isFinite(a) || !Number.isFinite(b) ? ''
      : b > a ? t('exp.duration', { d: fmtDuration(b - a) }) : t('exp.endBeforeStart');
    updateExportCheckboxes();
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
    if (b - a > 6 * HOUR) toast(t('exp.large', { d: fmtDuration(b - a) }));

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
                  auto: autoDownload, includeAudio, signal: null, clipChannel, label,
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
      $('btnExport').disabled = $('btnClearSel').disabled = false;
    }
  }

  // ------------------------------------------------------------ Network status

  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  function formatBitrate(bps) {
    if (!Number.isFinite(bps) || bps <= 0) return '';
    return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbit/s` : `${Math.round(bps / 1e3)} kbit/s`;
  }

  function totalBitrate() {
    return visibleTiles().reduce((sum, tile) => sum + (Number(tile.pipeline?.bitrate) || 0), 0);
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
      $('deviceName').textContent = [p.ProdShortName || p.ProdNbr, p.SerialNumber].filter(Boolean).join(' · ');
    } catch (e) { /* optional */ }
  }

  async function loadStorage() {
    const sel = $('recDisk');
    const prev = sel.value;
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
      })).filter((d) => d.id);
      state.storageState = 'ready';
      const gb = (kb) => (kb / 1024 / 1024).toFixed(1);
      const parts = state.disks
        .filter((d) => d.status && d.status !== 'disconnected')
        .map((d) => {
          const status = d.status !== 'ok' ? d.status : t(writableDisk(d) ? 'storage.ready' : 'storage.notWritable');
          return `${diskName(d.id)}: ${status}${d.total > 0 ? ' · ' + t('storage.used', { used: gb(d.total - d.free), total: gb(d.total) }) : ''}`;
        });
      $('storageStatus').textContent = parts.length ? `${t('storage.label')}: ${parts.join(' | ')}` : t('storage.none');
    } catch (e) {
      state.disks = null;
      state.storageState = e.status === 401 || e.status === 403 ? 'forbidden' : 'unknown';
      $('storageStatus').textContent = t(state.storageState === 'forbidden' ? 'storage.forbidden' : 'storage.unavailable');
    }
    sel.replaceChildren();
    const targets = (state.disks || []).filter(writableDisk);
    for (const d of targets) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = diskName(d.id);
      sel.appendChild(o);
    }
    const preferred = targets.find((d) => d.id === prev) || targets.find((d) => d.id === 'SD_DISK') || targets[0];
    if (preferred) sel.value = preferred.id;
    renderRecordingConfig();
  }

  // Continuous recording configurations (classic edge storage API)
  const writableDisk = (d) => d.status === 'ok' && !d.locked && !d.readOnly && (!d.full || d.cleanup === 'fifo');
  const diskName = (id) => id === 'SD_DISK' ? t('storage.sd') : (state.disks?.find((d) => d.id === id)?.name || id);
  let recConfigs;
  let configSeq = 0;
  let activeRecording;
  let activeRequest;
  let enablingRecording = false;
  let disablingRecording = false;
  let setupDenied = false;

  /** Channel a config records: "camera=N" in its options, otherwise channel 1. */
  function configChannel(cfg) {
    let options = cfg.options;
    try { if (!options.includes('=')) options = decodeURIComponent(options); } catch (e) { return null; }
    const camera = new URLSearchParams(options).get('camera');
    return camera == null ? 1 : /^\d+$/.test(camera) ? Number(camera) : null;
  }

  async function loadRecordingConfig() {
    const seq = ++configSeq;
    try {
      const doc = await fetchXml('/axis-cgi/record/continuous/listconfiguration.cgi');
      if (seq !== configSeq) return;
      recConfigs = Array.from(xmlElement(doc, 'continuousrecordingconfigurations').getElementsByTagName('continuousrecordingconfiguration'), (c) => ({
        profile: c.getAttribute('profile'),
        disk: c.getAttribute('diskid'),
        options: c.getAttribute('options') || '',
      }));
    } catch (e) {
      if (seq !== configSeq) return;
      recConfigs = null;
    }
    renderRecordingConfig();
  }

  async function refreshActiveRecording() {
    activeRequest?.abort();
    const request = new AbortController();
    activeRequest = request;
    const channel = state.channel;
    if (channel == null) {
      activeRecording = { channel: null, ongoing: [], unknown: false };
      renderRecordingConfig();
      return;
    }
    if (activeRecording?.channel !== channel) activeRecording = undefined;
    renderRecordingConfig();
    try {
      const now = Date.now();
      const result = await listRecordings(now - 5 * MIN, now, { channel, signal: request.signal });
      if (request.signal.aborted) return;
      const ongoing = (r) => r.status === 'recording' && (!r.stop || r.stop > now - MIN);
      activeRecording = { channel, ongoing: result.recs.filter(ongoing), unknown: result.unknown.some(ongoing) };
    } catch (e) {
      if (request.signal.aborted) return;
      activeRecording = { channel, ongoing: [], unknown: true };
    }
    renderRecordingConfig();
  }

  function renderRecordingConfig() {
    const mine = recConfigs?.filter((c) => configChannel(c) === state.channel) || [];
    const ongoing = activeRecording?.channel === state.channel ? activeRecording.ongoing : [];
    const activeDisks = [...new Set(ongoing.map((r) => r.disk).filter(Boolean))].map(diskName).join(', ');
    const connected = state.disks?.filter((d) => d.status !== 'disconnected');
    const writable = connected?.some(writableDisk);
    const sd = connected?.find((d) => d.id === 'SD_DISK');
    const active = ongoing.length > 0;
    const indicator = $('recordingIndicator');
    const key = active ? (activeDisks ? 'rec.activeDisk' : 'rec.active')
      : sd && !writableDisk(sd) ? 'rec.sdNotWritable'
      : !activeRecording ? 'rec.loading'
      : mine.length ? 'rec.configured'
      : activeRecording.unknown ? 'rec.statusUnknown' : 'rec.notRunning';
    const message = t(key, { disks: activeDisks });
    const setup = disablingRecording ? 'rec.disabling'
      : enablingRecording ? 'rec.saving'
      : setupDenied || state.storageState === 'forbidden' ? 'rec.needsRights'
      : state.storageState === 'unknown' ? 'rec.noStorageAccess'
      : connected && connected.length === 0 ? 'rec.setupDisk'
      : connected && !writable ? 'rec.unwritable'
      : recConfigs === null ? 'rec.unavailable'
      : recConfigs === undefined || !activeRecording ? 'rec.loading'
      : mine.length || active || activeRecording.unknown ? key : 'rec.off';
    indicator.classList.toggle('active', active);
    if (indicator.textContent !== message) indicator.textContent = message;
    $('recStatus').textContent = t(setup, { disks: activeDisks });
    const canEnable = Boolean(writable && recConfigs && !mine.length && !active && activeRecording && !activeRecording.unknown && !setupDenied);
    $('recEnableRow').classList.toggle('hidden', !canEnable && !enablingRecording);
    $('btnEnableRec').disabled = $('recDisk').disabled = enablingRecording;
    // A profile can always be removed, even if the channel is currently recording.
    $('recDisableRow').classList.toggle('hidden', !(recConfigs && mine.length) && !disablingRecording);
    $('btnDisableRec').disabled = disablingRecording || enablingRecording;
  }

  async function enableContinuous() {
    if (enablingRecording || setupDenied || !recConfigs || recConfigs.some((c) => configChannel(c) === state.channel)) return;
    if (!activeRecording || activeRecording.channel !== state.channel || activeRecording.unknown || activeRecording.ongoing.length) return;
    const disk = $('recDisk').value;
    if (!state.disks?.some((d) => d.id === disk && writableDisk(d))) { toast(t('rec.noDisk'), true); return; }
    enablingRecording = true;
    renderRecordingConfig();
    try {
      const opts = [];
      if (multiChannel()) opts.push(`camera=${state.channel}`);
      opts.push('videocodec=h264');
      if ($('recAudio').checked) opts.push('audio=1', 'audiocodec=aac');
      const p = new URLSearchParams({ diskid: disk, options: opts.join('&') });
      const doc = await fetchXml(`/axis-cgi/record/continuous/addconfiguration.cgi?${p}`);
      const c = doc.getElementsByTagName('configure')[0];
      if (c && c.getAttribute('result') === 'OK') toast(t('rec.enabled', { profile: c.getAttribute('profile') }));
      else toast(t('rec.error', { msg: c ? c.getAttribute('errormsg') : t('rec.unknownResponse') }), true);
    } catch (e) {
      if (e.status === 401 || e.status === 403) setupDenied = true;
      toast(t('rec.enableFailed', { msg: e.message }), true);
    } finally {
      await loadRecordingConfig();
      enablingRecording = false;
      renderRecordingConfig();
      refreshActiveRecording();
      setTimeout(() => { refreshRecordings(true); refreshActiveRecording(); }, 3000);
    }
  }

  /** Remove the continuous recording profile(s) of the selected channel. */
  async function disableContinuous() {
    if (disablingRecording || !recConfigs) return;
    const mine = recConfigs.filter((c) => configChannel(c) === state.channel);
    const profiles = [...new Set(mine.map((c) => c.profile))].filter((p) => p != null && p !== '');
    if (!profiles.length) { toast(t('rec.disableFailed', { msg: t('rec.unknownResponse') }), true); return; }
    if (!confirm(t('rec.disable.confirm'))) return;
    disablingRecording = true;
    renderRecordingConfig();
    const errors = [];
    try {
      for (const profile of profiles) {
        try {
          const p = new URLSearchParams({ profile });
          const doc = await fetchXml(`/axis-cgi/record/continuous/removeconfiguration.cgi?${p}`);
          const removed = doc.getElementsByTagName('remove')[0];
          if (!removed || removed.getAttribute('result') !== 'OK') {
            errors.push(removed?.getAttribute('errormsg') || t('rec.unknownResponse'));
          }
        } catch (e) {
          if (e.status === 401 || e.status === 403) setupDenied = true;
          errors.push(e.message);
        }
      }
      if (errors.length) toast(t('rec.disableFailed', { msg: errors.join('; ') }), true);
      else toast(t('rec.disabled'));
    } finally {
      await loadRecordingConfig();
      disablingRecording = false;
      renderRecordingConfig();
      refreshActiveRecording();
      setTimeout(() => { refreshRecordings(true); refreshActiveRecording(); }, 3000);
    }
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
  $('btnSnapshot').addEventListener('click', () => {
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
  });
  $('layoutSelect').addEventListener('change', (ev) => {
    const wasLive = visibleTiles().length > 0
      && visibleTiles().every((tile) => tile.mode === 'live' && tile.pendingSeek == null);
    const time = activeTile().pendingSeek ?? currentWall(activeTile());
    state.layout = ev.target.value;
    store.set('layout', state.layout);
    applyLayout();
    if (wasLive) goLiveAll();
    else if (Number.isFinite(time)) playAtAll(time);
    refreshRecordings();
  });

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
  $('btnFitDay').addEventListener('click', () => showDay(startOfDay((state.viewStart + state.viewEnd) / 2)));
  $('jumpForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const time = fromLocalInput($('jumpTime').value);
    if (!Number.isFinite(time) || time > Date.now()) { toast(t('tl.invalidTime'), true); return; }
    if (time < state.viewStart || time >= state.viewEnd) showDay(startOfDay(time));
    playAt(time);
  });
  $('btnSelectMode').addEventListener('click', () => {
    state.selectMode = !state.selectMode;
    $('btnSelectMode').classList.toggle('active', state.selectMode);
    $('btnSelectMode').setAttribute('aria-pressed', String(state.selectMode));
    canvas.classList.toggle('selecting', state.selectMode);
  });

  $('expStart').addEventListener('change', selectionFromInputs);
  $('expEnd').addEventListener('change', selectionFromInputs);
  $('expPwEnable').addEventListener('change', (ev) => $('expPwRow').classList.toggle('hidden', !ev.target.checked));
  $('btnExport').addEventListener('click', () => doExport(...selectedExportRange()));
  $('btnCancelExport').addEventListener('click', () => { if (exportAbort) exportAbort.abort(); });
  $('btnClearSel').addEventListener('click', () => {
    state.selStart = state.selEnd = null;
    dragExportRange = null;
    $('expStart').value = $('expEnd').value = '';
    $('expInfo').textContent = '';
    $('expLinks').innerHTML = '';
    updateExportCheckboxes();
    draw();
  });
  $('btnEnableRec').addEventListener('click', enableContinuous);
  $('btnDisableRec').addEventListener('click', disableContinuous);
  $('recAudio').addEventListener('change', () => store.set('rec.audio', $('recAudio').checked ? '1' : '0'));

  document.querySelectorAll('.lang-switch [data-lang]').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === window.I18N.lang);
    b.addEventListener('click', () => window.I18N.setLang(b.dataset.lang));
  });

  window.addEventListener('resize', resizeCanvas);

  setInterval(() => {
    for (const tile of state.tiles) {
      if (!tile.visible) continue;
      if (tile.channel == null) {
        $(tileId(tile, 'clock')).textContent = '–';
        continue;
      }
      const time = currentWall(tile);
      $(tileId(tile, 'clock')).textContent = fmtDateTime(time);
      // continue past the end of a completed recording
      if (tile.mode === 'playback' && tile.streamStatus === 'playing' && tile.rec?.stop != null && time > tile.rec.stop + 2000) {
        onRecordingEnded(tile);
      }
    }
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

  // ------------------------------------------------------------ Start

  (async () => {
    const now = Date.now();
    loadLayoutPreference();
    $('recAudio').checked = store.get('rec.audio') === '1';
    setView(now - 2 * HOUR, now + 30 * MIN, { fetch: false });
    $('jumpTime').value = toLocalInput(now - MIN);
    resizeCanvas();
    updateModeUi();
    updateBandwidth();
    updatePing();
    loadDeviceInfo();
    loadStorage();
    loadRecordingConfig();
    await Promise.all([loadChannels(), loadStreamProfiles()]);
    document.dispatchEvent(new CustomEvent('microvms:channel', { detail: { channel: activeTile().channel, previous: null } }));
    if (!activeTile().intent) goLiveAll();
    await loadRecordingSources();
    refreshRecordings();
    refreshActiveRecording();
    setInterval(() => { loadRecordingSources().then(() => refreshRecordings(true)); refreshActiveRecording(); }, 30 * 1000);
    setInterval(() => { loadStorage(); loadRecordingConfig(); }, 60 * 1000);
  })();
})();
