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
    unassignedRecordings: [],
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

  function videoMsg(msg) {
    const el = $('videoMsg');
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

    const saved = parseInt(store.get('channel'), 10);
    state.channel = channels.some((c) => c.camera === saved) ? saved : channels[0].camera;

    const sel = $('channel');
    sel.replaceChildren();
    for (const c of channels) {
      const o = document.createElement('option');
      o.value = String(c.camera);
      o.textContent = channels.length > 1 && c.name !== t('channel.default', { n: c.camera }) ? `${c.camera}: ${c.name}` : c.name;
      sel.appendChild(o);
    }
    sel.value = String(state.channel);
    sel.disabled = channels.length < 2;
    $('channelLabel').textContent = t('ctl.views', { n: state.channelCount });
    $('channelWrap').classList.toggle('hidden', !multiChannel());
  }

  const multiChannel = () => state.channelCount > 1;
  const channelName = (cam = state.channel) => (state.channels.find((c) => c.camera === cam) || {}).name || t('channel.default', { n: cam });

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
      state.streamProfiles = (j.data && j.data.streamProfile) || [];
    } catch (e) { state.streamProfiles = []; }
    const sel = $('streamProfile');
    while (sel.options.length > 1) sel.remove(1);
    for (const p of state.streamProfiles) {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.name;
      o.title = [p.description, p.parameters].filter(Boolean).join(' – ');
      sel.appendChild(o);
    }
    const saved = store.get('streamprofile');
    if (saved && state.streamProfiles.some((p) => p.name === saved)) sel.value = saved;
    $('streamWrap').classList.toggle('hidden', !state.streamProfiles.length);
  }

  function setChannel(cam) {
    if (cam === state.channel) return;
    const wall = state.pendingSeek ?? currentWall();
    const wasLive = state.mode === 'live' && state.pendingSeek == null;
    const prev = state.channel;
    state.channel = cam;
    store.set('channel', String(cam));
    document.dispatchEvent(new CustomEvent('microvms:channel', { detail: { channel: cam, previous: prev } }));
    state.recordings = [];
    state.unassignedRecordings = [];
    draw();
    refreshRecordings();
    refreshActiveRecording();
    renderRecordingConfig();
    if (wasLive) goLive();
    else playAt(wall, { clearOldStream: true });
  }

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

  let playbackIntent = null;
  let endingIntent = null;
  let streamTimer = null;

  function newPlaybackIntent() {
    playbackIntent?.abort();
    playbackIntent = new AbortController();
    state.pendingSeek = null;
    state.manualRecording = null;
    $('sourceChoices').classList.add('hidden');
    $('sourceChoiceList').replaceChildren();
    return playbackIntent;
  }

  const isCurrentIntent = (intent) => playbackIntent === intent && !intent.signal.aborted;

  function stopPipeline() {
    state.generation++;
    clearTimeout(streamTimer);
    if (state.pipeline) {
      try { state.pipeline.close(); } catch (e) { /* ignore */ }
      state.pipeline = null;
    }
  }

  function setStreamStatus(status, msg = '') {
    state.streamStatus = status;
    videoMsg(state.pendingSeek == null ? msg : t('video.seeking'));
    updateModeUi();
  }

  function startPipeline(parameters, offsetSec, retryLive = true) {
    stopPipeline();
    const gen = state.generation;
    const video = $('video');
    state.syncWall = null;
    state.baseCt = null;
    setStreamStatus('connecting', t('video.connecting'));
    if (!MSL?.Html5VideoPipeline) { setStreamStatus('error', t('video.libMissing')); return; }
    const fail = (msg, reconnect = false) => {
      if (gen !== state.generation) return;
      const lastWall = currentWall();
      stopPipeline();
      if (reconnect && (retryLive || state.streamStatus === 'playing') && state.mode === 'live' && state.pendingSeek == null) {
        setStreamStatus('connecting', t('video.reconnect'));
        const intent = playbackIntent;
        const closedGen = state.generation;
        streamTimer = setTimeout(() => {
          if (state.generation === closedGen && isCurrentIntent(intent)) goLive(false);
        }, 2000);
      } else {
        if (state.mode === 'playback') {
          state.startWall = lastWall;
          state.syncWall = state.baseCt = null;
        }
        setStreamStatus('error', msg);
      }
    };
    let pipeline;
    try {
      pipeline = new MSL.Html5VideoPipeline({
        ws: {},                      // default: ws(s)://<camera>/rtsp-over-websocket
        rtsp: { parameters },        // rtsp://<camera>/axis-media/media.amp?...
        mediaElement: video,
      });
      state.pipeline = pipeline;
    } catch (err) {
      fail(t('video.connectFailed', { msg: err.message }));
      return;
    }
    streamTimer = setTimeout(() => fail(t('video.timeout')), 15000);

    pipeline.onSync = (ntp) => { if (gen === state.generation) state.syncWall = ntp; };
    pipeline.onServerClose = () => {
      if (gen !== state.generation) return;
      if (state.mode === 'playback' && state.pendingSeek == null && state.rec?.stop != null && Math.abs(currentWall() - state.rec.stop) < 2000) {
        onRecordingEnded();
      } else {
        fail(t('video.disconnected'), true);
      }
    };
    pipeline.rtsp.onError = (err) => {
      fail(t('video.rtspError', { msg: err.message || err }));
    };
    pipeline.rtsp.onRtcp = (rtcp) => {
      if (gen !== state.generation) return;
      if (MSL.isRtcpBye(rtcp) && state.mode === 'playback') onRecordingEnded();
    };

    pipeline.ready
      .then(() => {
        if (gen !== state.generation) return;
        pipeline.rtsp.play(offsetSec || 0);
        return video.play();
      })
      .catch((err) => {
        fail(t('video.connectFailed', { msg: err?.message || t('video.wsError') }));
      });
  }

  function liveParameters() {
    const params = [`camera=${state.channel}`];
    const profile = $('streamProfile').value;
    // Profile first, explicit values after it override it ("last value wins")
    if (profile) params.push(`streamprofile=${encodeURIComponent(profile)}`);
    params.push('videocodec=h264', 'audio=0');
    const res = $('resolution').value;
    if (res) params.push(`resolution=${res}`);
    return params;
  }

  function goLive(retryLive = true) {
    newPlaybackIntent();
    state.mode = 'live';
    state.rec = null;
    state.pausedAt = null;
    startPipeline(liveParameters(), 0, retryLive);
  }

  function holdAt(time, msg) {
    stopPipeline();
    state.mode = 'paused';
    state.rec = null;
    state.pausedAt = time;
    setStreamStatus('idle', msg);
  }

  function startRecording(rec, time) {
    state.mode = 'playback';
    state.rec = rec;
    state.startWall = time;
    state.pausedAt = null;
    $('jumpTime').value = toLocalInput(time);
    startPipeline([`recordingid=${encodeURIComponent(rec.id)}`, 'audio=0'], Math.max(0, (time - rec.start) / 1000));
  }

  function offerRecordings(intent, time, choices) {
    holdAt(time, t('video.chooseSource'));
    const list = $('sourceChoiceList');
    for (const [i, rec] of choices.slice(0, 12).entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = t('video.sourceChoice', {
        n: i + 1, when: fmtDateTime(rec.start), source: rec.source || t('video.sourceMissing'),
      });
      button.addEventListener('click', () => {
        if (!isCurrentIntent(intent)) return;
        newPlaybackIntent();
        state.manualRecording = rec;
        startRecording(rec, Math.max(rec.start, time));
      });
      list.appendChild(button);
    }
    $('sourceChoiceHint').textContent = t(choices.length > 12 ? 'video.sourceLimited' : 'video.sourceHint');
    $('sourceChoices').classList.remove('hidden');
  }

  async function playAt(time, { clearOldStream = false, reuseManual = false, preferUnassigned = false } = {}) {
    if (!Number.isFinite(time)) return;
    const manual = reuseManual ? state.manualRecording : null;
    if (manual && manual.start <= time && time < recStop(manual)) {
      newPlaybackIntent();
      state.manualRecording = manual;
      startRecording(manual, time);
      return;
    }
    if (time >= Date.now() - LIVE_THRESHOLD) { goLive(); return; }
    const intent = newPlaybackIntent();
    const channel = state.channel;
    if (clearOldStream) stopPipeline();
    state.pendingSeek = time;
    videoMsg(t('video.seeking'));
    updateModeUi();
    let result;
    try {
      result = await findRecordingAtOrAfter(time, { channel, signal: intent.signal, preferUnassigned });
    } catch (e) {
      if (!isCurrentIntent(intent)) return;
      state.pendingSeek = null;
      holdAt(time, t('toast.recListFailed', { msg: e.message }));
      return;
    }
    if (!isCurrentIntent(intent)) return;
    state.pendingSeek = null;
    if (result.choices) { offerRecordings(intent, time, result.choices); return; }
    const { rec } = result;
    if (!rec) {
      holdAt(time, t('video.noRecordingFrom', { when: fmtDateTime(time) }));
      return;
    }
    if (rec.start > time) {
      toast(t('toast.jumpTo', { time: fmtTime(rec.start) }));
      time = rec.start;
    }
    startRecording(rec, time);
  }

  async function onRecordingEnded() {
    const intent = playbackIntent;
    const rec = state.rec;
    if (!rec || state.mode !== 'playback' || state.pendingSeek != null || endingIntent === intent) return;
    const end = rec.stop ?? currentWall();
    if (state.manualRecording) { holdAt(end, t('video.endOfRecording')); return; }
    endingIntent = intent;
    const channel = state.channel;
    try {
      const { rec: next, choices } = await findRecordingAtOrAfter(end, { channel, signal: intent.signal }, rec);
      if (!isCurrentIntent(intent)) return;
      if (next) startRecording(next, Math.max(next.start, end));
      else if (choices) offerRecordings(intent, end, choices);
      else holdAt(end, t('video.endOfRecording'));
    } catch (e) {
      if (isCurrentIntent(intent)) holdAt(end, t('toast.recListFailed', { msg: e.message }));
    } finally {
      if (endingIntent === intent) endingIntent = null;
    }
  }

  /** Point in time currently shown (wall clock, ms). */
  function currentWall() {
    if (state.mode === 'live') return Date.now();
    if (state.mode === 'paused') return state.pausedAt != null ? state.pausedAt : Date.now();
    const ct = $('video').currentTime || 0;
    // onSync gives the NTP time of media time 0; sanity check in case the
    // device does not send the original time for playback.
    if (state.syncWall != null && Math.abs(state.syncWall - state.startWall) < 5 * MIN) {
      return state.syncWall + ct * 1000;
    }
    if (state.baseCt == null) return state.startWall;
    return state.startWall + (ct - state.baseCt) * 1000;
  }

  $('video').addEventListener('playing', () => {
    if (!state.pipeline) return;
    clearTimeout(streamTimer);
    if (state.baseCt == null) state.baseCt = $('video').currentTime || 0;
    setStreamStatus('playing');
  });

  /**
   * Jump back from the time currently on screen. From live view the target
   * must be clearly before "now", otherwise playAt() would just go live again.
   */
  function skipBack(seconds) {
    const live = state.mode === 'live' && state.pendingSeek == null;
    const from = state.pendingSeek ?? currentWall();
    const target = from - seconds;
    playAt(live ? Math.min(target, Date.now() - LIVE_THRESHOLD - 1000) : target, { reuseManual: true });
  }

  function togglePause() {
    if (state.pendingSeek != null) {
      const time = state.pendingSeek;
      newPlaybackIntent();
      holdAt(time, '');
      return;
    }
    if (state.mode === 'paused') {
      if (state.pausedAt != null) playAt(state.pausedAt, { reuseManual: true }); else goLive();
      return;
    }
    const time = currentWall();
    const manual = state.manualRecording;
    newPlaybackIntent();
    state.manualRecording = manual;
    $('video').pause();
    holdAt(time, '');
  }

  let announcedMode;
  function updateModeUi() {
    const seeking = state.pendingSeek != null;
    const live = state.mode === 'live' && !seeking;
    const playing = state.streamStatus === 'playing';
    const paused = state.mode === 'paused' && !seeking;
    const key = seeking ? 'seeking' : paused ? 'paused' : !playing ? state.streamStatus : state.mode;
    const badge = $('modeBadge');
    badge.className = `badge ${key}`;
    badge.textContent = t(`badge.${key}`);
    $('manualSourceInfo').textContent = state.manualRecording ? t('video.manualSource') : '';
    $('manualSourceInfo').classList.toggle('hidden', !state.manualRecording);
    $('pauseIcon').setAttribute('href', paused ? '#ic-play' : '#ic-pause');
    $('btnFwd').disabled = live;
    $('btnSnapshot').disabled = !live || !playing;
    $('btnRetryPlayback').classList.toggle('hidden', seeking || state.mode !== 'playback' || state.streamStatus !== 'error');
    const lb = $('btnLive');
    lb.disabled = live && playing;
    lb.classList.toggle('is-live', lb.disabled);
    $('liveLabel').textContent = live ? t(playing ? 'live.btn' : 'live.retry') : t('live.back');
    const mode = live && !playing ? state.streamStatus : seeking ? 'seeking' : state.mode;
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
  const TIMELINE_TYPES = ['continuous', 'triggered', 'scheduled', 'other'];

  function trackGeometry(type) {
    const top = 25;
    const laneHeight = (canvas.clientHeight - top - 14) / TIMELINE_TYPES.length;
    return { y: top + TIMELINE_TYPES.indexOf(type) * laneHeight, height: laneHeight };
  }

  function recordingPixels(rec) {
    const end = recStop(rec);
    if (end <= state.viewStart || rec.start >= state.viewEnd || end <= rec.start) return null;
    const left = Math.max(0, xOf(rec.start));
    const length = Math.min(canvasWidth(), xOf(end)) - left;
    return { left, width: Math.max(rec.type === 'continuous' ? 1 : 4, length) };
  }

  function timelineRecordingAt(x, y, time) {
    const type = TIMELINE_TYPES.find((kind) => {
      const lane = trackGeometry(kind);
      return y >= lane.y && y < lane.y + lane.height;
    });
    if (!type || type === 'continuous') return null; // ordinary timeline seek prefers continuous footage
    const matches = state.recordings.filter((r) => {
      if (r.type !== type) return false;
      const pixels = recordingPixels(r);
      return pixels && x >= pixels.left && x < pixels.left + pixels.width;
    });
    return matches.find((r) => r.start <= time && time < recStop(r)) || matches[0] || null;
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
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
      const x = Math.round(xOf(tick)) + 0.5;
      const d = new Date(tick);
      const isMidnight = d.getHours() === 0 && d.getMinutes() === 0;
      ctx.strokeStyle = isMidnight ? COLORS.text : COLORS.line;
      ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = COLORS.text;
      const hour = fmtTime(tick, step < MIN * 1.5);
      ctx.fillText(isMidnight ? fmtDate(tick) : changesOffset ? `${hour} ${fmtOffset(tick)}` : hour, x + 3, 4);
    }

    for (const r of state.unassignedRecordings) {
      const x1 = Math.max(0, xOf(r.start));
      const x2 = Math.min(W, xOf(recStop(r)));
      if (x2 <= x1) continue;
      ctx.fillStyle = COLORS.text;
      ctx.fillRect(x1, H - 12, Math.max(1, x2 - x1), 3);
    }
    for (const r of state.recordings) {
      const pixels = recordingPixels(r);
      if (!pixels) continue;
      const lane = trackGeometry(r.type);
      ctx.fillStyle = COLORS[r.type];
      ctx.fillRect(pixels.left, lane.y + 1, pixels.width, lane.height - 3);
    }

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
  const timelineStatus = (msg) => { if ($('timelineStatus').textContent !== msg) $('timelineStatus').textContent = msg; };
  function showTimelineCounts(rows = []) {
    const events = rows.filter((r) => r.type === 'triggered').length;
    const other = rows.some((r) => r.type === 'other');
    const label = rows.length ? t('tl.eventCount', { n: events }) : '';
    if ($('timelineEvents').textContent !== label) $('timelineEvents').textContent = label;
    $('otherSwatch').classList.toggle('hidden', !other);
    $('otherLegend').classList.toggle('hidden', !other);
  }
  function scheduleFetch() {
    clearTimeout(fetchTimer);
    timelineRequest?.abort();
    timelineStatus(t('tl.loading'));
    showTimelineCounts();
    fetchTimer = setTimeout(() => refreshRecordings(), 250);
  }

  async function refreshRecordings(background = false) {
    clearTimeout(fetchTimer);
    timelineRequest?.abort();
    const request = new AbortController();
    timelineRequest = request;
    const { viewStart, viewEnd, channel } = state;
    const margin = (viewEnd - viewStart) * 0.5;
    if (!background) { timelineStatus(t('tl.loading')); showTimelineCounts(); }
    try {
      const { recs, unknown, complete } = await listRecordings(viewStart - margin, Math.min(viewEnd + margin, Date.now()), { channel, signal: request.signal });
      if (request.signal.aborted) return;
      const visible = (r) => r.start < viewEnd && recStop(r) > viewStart;
      state.recordings = recs;
      state.unassignedRecordings = unknown;
      showTimelineCounts(recs.filter(visible));
      timelineStatus(!complete ? t('tl.partial')
        : unknown.some(visible) ? t('tl.unknown')
        : recs.some(visible) ? '' : t('tl.empty'));
      draw();
    } catch (e) {
      if (!request.signal.aborted) {
        timelineStatus(t('toast.timeline', { msg: e.message }));
        showTimelineCounts();
      }
    }
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
  canvas.addEventListener('pointerup', (ev) => {
    if (drag?.id !== ev.pointerId) return;
    const d = drag;
    drag = null;
    canvas.classList.toggle('selecting', state.selectMode);
    if (!d.moved && !d.selecting) {
      const time = Math.round(tOf(ev.offsetX));
      const rec = timelineRecordingAt(ev.offsetX, ev.offsetY, time);
      if (rec) {
        newPlaybackIntent();
        startRecording(rec, Math.max(rec.start, Math.min(time, recStop(rec) - 1)));
      } else {
        playAt(time, { preferUnassigned: ev.offsetY >= canvas.clientHeight - 14 });
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
  }

  function selectionFromInputs() {
    const [a, b] = selectedExportRange();
    state.selStart = Number.isFinite(a) && b > a ? a : null;
    state.selEnd = state.selStart == null ? null : b;
    if (!exportAbort) $('expInfo').textContent = !Number.isFinite(a) || !Number.isFinite(b) ? ''
      : b > a ? t('exp.duration', { d: fmtDuration(b - a) }) : t('exp.endBeforeStart');
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
  function exportSeparate(chosen, base, pw) {
    const list = $('expLinks');
    list.innerHTML = '';
    chosen.forEach((c, i) => {
      const suffix = chosen.length === 1 ? '' : `_${pad(i + 1, String(chosen.length).length)}`;
      const url = exportUrl(c, `${base}_${fmtStamp(c.s)}${suffix}`, pw);
      const li = document.createElement('li');
      const link = document.createElement(pw ? 'button' : 'a');
      if (pw) link.addEventListener('click', () => download(url, ''));
      else { link.href = url; link.download = ''; }
      link.textContent = `${fmtDateTime(c.s)} – ${fmtTime(c.e)} (${fmtDuration(c.e - c.s)})`;
      li.appendChild(link);
      list.appendChild(li);
      if (i === 0) download(url, ''); // further parts are explicit links; browsers can block download bursts
    });
  }

  /** Load parts one after another and merge them into ONE .mkv in the browser. */
  async function exportMerged(chosen, base, signal, clipChannel) {
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
      // A cropped camera export can start at a preceding keyframe, so don't assert its actual DateUTC.
      startTimeMs: a === chosen[0].r.start ? a : undefined,
      title: titleParts.join(' – '),
      onProgress: ({ part, parts, bytes }) => {
        $('expInfo').textContent = t('exp.loading', { part, parts, bytes: fmtBytes(bytes) });
      },
    });
    signal.throwIfAborted();
    const url = URL.createObjectURL(result.blob);
    const name = `${base}_${fmtStamp(a)}.mkv`;
    download(url, name);
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = url; link.download = name;
    link.textContent = `${name} (${fmtBytes(result.blob.size)}, ${fmtDuration(result.durationMs)})`;
    li.appendChild(link);
    $('expLinks').appendChild(li);
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    $('expInfo').textContent = t('exp.done', { n: chosen.length });
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
    const channel = state.channel;
    const manual = state.manualRecording;
    const clipChannel = manual ? t('video.manualSource') : multiChannel() ? channelName(channel) : null;
    const name = ($('expName').value.trim() || 'export').replace(/[^\w.-]+/g, '_');
    const base = manual ? `${name}_recording` : clipChannel ? `${name}_ch${channel}` : name;
    const request = new AbortController();
    const { signal } = request;
    exportAbort = request;
    $('btnExport').disabled = $('btnClearSel').disabled = true;
    $('btnCancelExport').classList.remove('hidden');
    $('expInfo').textContent = t('exp.checking');
    try {
      const { recs, unknown, complete } = manual ? { recs: [manual], unknown: [], complete: true } : await listRecordings(a, b, { channel, signal });
      signal.throwIfAborted();
      if (!complete) throw new Error(t('err.incomplete'));
      const overlaps = (r) => r.start < b && recStop(r) > a;
      if (unknown.some(overlaps)) throw new Error(t('err.source'));
      const chosen = planExport(recs.filter(overlaps), a, b);
      if (!chosen.length) { $('expInfo').textContent = t(manual ? 'exp.manualOutside' : 'exp.none'); return; }
      if (chosen.some(({ r }) => !r.disk)) throw new Error(t('err.xml'));
      const merge = mergeRequested && !usePw && chosen.length > 1;
      const gaps = b - a - chosen.reduce((ms, c) => ms + c.e - c.s, 0);
      if (b - a > 6 * HOUR) toast(t('exp.large', { d: fmtDuration(b - a) }));
      const gapNote = gaps > 0 ? t('exp.gaps', { d: gaps < 1000 ? '< 1 s' : fmtDuration(gaps) }) : '';
      $('expLinks').innerHTML = '';

      if (!merge) {
        exportSeparate(chosen, base, pw);
        $('expInfo').textContent = [t(chosen.length > 1 ? 'exp.parts' : 'exp.started', { n: chosen.length }), gapNote]
          .filter(Boolean).join(' ');
        return;
      }
      try {
        await exportMerged(chosen, base, signal, clipChannel);
      } catch (e) {
        if (e instanceof window.MkvConcat.MkvConcatIncompatibleError) {
          request.abort(); // also release the current part's streaming response
          exportSeparate(chosen, base, null);
          $('expInfo').textContent = t('exp.incompatible', { n: chosen.length });
          return;
        }
        throw e;
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
      const opts = multiChannel() ? `camera=${state.channel}&videocodec=h264` : 'videocodec=h264';
      const p = new URLSearchParams({ diskid: disk, options: opts });
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
    goLive();
    const now = Date.now();
    if (now < state.viewStart || now > state.viewEnd) showDay(startOfDay(now));
  });
  $('btnPause').addEventListener('click', togglePause);
  $('btnBack').addEventListener('click', () => skipBack(SKIP));
  $('btnBack5').addEventListener('click', () => skipBack(SKIP_SHORT));
  $('btnFwd').addEventListener('click', () => playAt((state.pendingSeek ?? currentWall()) + SKIP, { reuseManual: true }));
  $('btnRetryPlayback').addEventListener('click', () => playAt(currentWall(), { reuseManual: true }));
  $('btnSnapshot').addEventListener('click', () => {
    if (state.mode !== 'live' || state.pendingSeek != null || state.streamStatus !== 'playing') return;
    const p = new URLSearchParams({ camera: String(state.channel) });
    const res = $('resolution').value;
    if (res) p.set('resolution', res);
    const suffix = multiChannel() ? `_ch${state.channel}` : '';
    download(`/axis-cgi/jpg/image.cgi?${p}`, `snapshot${suffix}_${fmtStamp(Date.now())}.jpg`);
  });
  $('resolution').addEventListener('change', () => { if (state.mode === 'live' && state.pendingSeek == null) goLive(); });
  $('streamProfile').addEventListener('change', () => {
    store.set('streamprofile', $('streamProfile').value);
    if (state.mode === 'live' && state.pendingSeek == null) goLive();
  });
  $('channel').addEventListener('change', (ev) => setChannel(Number(ev.target.value)));

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
    draw();
  });
  $('btnEnableRec').addEventListener('click', enableContinuous);
  $('btnDisableRec').addEventListener('click', disableContinuous);

  document.querySelectorAll('.lang-switch [data-lang]').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === window.I18N.lang);
    b.addEventListener('click', () => window.I18N.setLang(b.dataset.lang));
  });

  window.addEventListener('resize', resizeCanvas);

  setInterval(() => {
    const time = currentWall();
    $('clock').textContent = fmtDateTime(time);
    // continue past the end of a completed recording
    if (state.mode === 'playback' && state.streamStatus === 'playing' && state.rec?.stop != null && time > state.rec.stop + 2000) {
      onRecordingEnded();
    }
    if (!drag) draw();
  }, 250);

  // Interface for add-on modules (ptz.js)
  window.MicroVms = { toast, mode: () => announcedMode, channel: () => state.channel };

  // ------------------------------------------------------------ Start

  (async () => {
    const now = Date.now();
    setView(now - 2 * HOUR, now + 30 * MIN, { fetch: false });
    $('jumpTime').value = toLocalInput(now - MIN);
    resizeCanvas();
    updateModeUi();
    loadDeviceInfo();
    loadStorage();
    loadRecordingConfig();
    await Promise.all([loadChannels(), loadStreamProfiles()]);
    document.dispatchEvent(new CustomEvent('microvms:channel', { detail: { channel: state.channel, previous: null } }));
    if (!playbackIntent) goLive();
    await loadRecordingSources();
    refreshRecordings();
    refreshActiveRecording();
    setInterval(() => { loadRecordingSources().then(() => refreshRecordings(true)); refreshActiveRecording(); }, 30 * 1000);
    setInterval(() => { loadStorage(); loadRecordingConfig(); }, 60 * 1000);
  })();
})();
