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
  const STORE = 'minivms.';       // preserve preferences on the same camera origin

  const state = {
    mode: 'live',                // 'live' | 'playback' | 'paused'
    pipeline: null,
    generation: 0,               // guards against callbacks of old pipelines
    rec: null,                   // recording currently playing
    startWall: 0,                // requested start time (ms)
    syncWall: null,              // NTP time of first frame (onSync)
    baseCt: null,                // video.currentTime at first frame (fallback)
    pausedAt: null,
    recordings: [],              // recordings of the selected channel
    viewStart: 0,
    viewEnd: 0,
    selStart: null,
    selEnd: null,
    selectMode: false,
    disks: [],
    ending: false,
    channels: [{ camera: 1, name: t('channel.default', { n: 1 }) }],
    channel: 1,                  // VAPIX camera number (1-based)
    sourceZeroBased: false,      // recordings' "source" attribute 0-based?
    streamProfiles: [],
  };

  // ---------------------------------------------------------------- Utils

  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const parseTime = (s) => (s ? Date.parse(s) : null);
  const recStop = (r) => (r.stop != null ? r.stop : Date.now());
  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
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
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    const res = await fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opts));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url.split('?')[0]})`);
    return res.text();
  }

  async function fetchXml(url) {
    const text = await fetchText(url);
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error(t('err.xml'));
    return doc;
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

    const saved = parseInt(store.get('channel'), 10);
    state.channel = channels.some((c) => c.camera === saved) ? saved : channels[0].camera;

    const sel = $('channel');
    sel.innerHTML = '';
    for (const c of channels) {
      const o = document.createElement('option');
      o.value = String(c.camera);
      o.textContent = channels.length > 1 && c.name !== t('channel.default', { n: c.camera }) ? `${c.camera}: ${c.name}` : c.name;
      sel.appendChild(o);
    }
    sel.value = String(state.channel);
    $('channelWrap').classList.toggle('hidden', channels.length < 2);
  }

  const multiChannel = () => state.channels.length > 1;
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
    const wall = currentWall();
    const prev = state.channel;
    state.channel = cam;
    store.set('channel', String(cam));
    document.dispatchEvent(new CustomEvent('microvms:channel', { detail: { channel: cam, previous: prev } }));
    state.recordings = [];
    draw();
    refreshRecordings();
    renderRecordingConfig();
    if (state.mode === 'live') goLive();
    else playAt(wall);      // same point in time on the other channel
  }

  // ------------------------------------------------------------ VAPIX recordings

  function parseRecordings(doc) {
    return Array.from(doc.getElementsByTagName('recording')).map((el) => {
      const video = el.getElementsByTagName('video')[0];
      const src = el.getAttribute('source') || (video && video.getAttribute('source'));
      return {
        id: el.getAttribute('recordingid'),
        disk: el.getAttribute('diskid'),
        start: parseTime(el.getAttribute('starttime')),
        stop: parseTime(el.getAttribute('stoptime')),
        type: el.getAttribute('recordingtype') || 'continuous',
        status: el.getAttribute('recordingstatus') || '',
        source: src != null && src !== '' ? Number(src) : null,
      };
    }).filter((r) => r.id && r.start != null);
  }

  /** Does the recording belong to the selected channel? */
  function onChannel(r) {
    if (!multiChannel() || r.source == null || isNaN(r.source)) return true;
    return (state.sourceZeroBased ? r.source + 1 : r.source) === state.channel;
  }

  function learnSourceBase(recs) {
    // Firmware reports "source" either as camera number (1-based) or as Image.I# index (0-based)
    if (recs.some((r) => r.source === 0)) state.sourceZeroBased = true;
  }

  async function listRecordings(from, to, max = 5000) {
    const p = new URLSearchParams({
      starttime: isoUtc(from),
      stoptime: isoUtc(to),
      sortorder: 'ascending',
      maxnumberofresults: String(max),
    });
    const recs = parseRecordings(await fetchXml(`/axis-cgi/record/list.cgi?${p}`));
    learnSourceBase(recs);
    return recs.filter(onChannel);
  }

  async function findRecordingAtOrAfter(time) {
    const p = new URLSearchParams({ starttime: isoUtc(time), sortorder: 'ascending', maxnumberofresults: String(20 * state.channels.length) });
    const all = parseRecordings(await fetchXml(`/axis-cgi/record/list.cgi?${p}`));
    learnSourceBase(all);
    const recs = all.filter(onChannel).sort((a, b) => a.start - b.start);
    // Prefer the recording containing the time; on overlap (continuous + event) the continuous one.
    const containing = recs.filter((r) => r.start <= time && time < recStop(r));
    if (containing.length) return containing.find((r) => r.type === 'continuous') || containing[0];
    return recs.find((r) => r.start > time) || null;
  }

  // ------------------------------------------------------------ Pipeline

  function stopPipeline() {
    state.generation++;
    if (state.pipeline) {
      try { state.pipeline.close(); } catch (e) { /* ignore */ }
      state.pipeline = null;
    }
  }

  function startPipeline(parameters, offsetSec) {
    stopPipeline();
    const gen = state.generation;
    const video = $('video');
    state.syncWall = null;
    state.baseCt = null;

    const pipeline = new MSL.Html5VideoPipeline({
      ws: {},                        // default: ws(s)://<camera>/rtsp-over-websocket
      rtsp: { parameters },          // rtsp://<camera>/axis-media/media.amp?...
      mediaElement: video,
    });
    state.pipeline = pipeline;

    pipeline.onSync = (ntp) => { if (gen === state.generation) state.syncWall = ntp; };
    pipeline.onServerClose = () => {
      if (gen !== state.generation) return;
      if (state.mode === 'live') {
        videoMsg(t('video.reconnect'));
        setTimeout(() => { if (gen === state.generation) goLive(); }, 2000);
      }
    };
    pipeline.rtsp.onError = (err) => {
      if (gen !== state.generation) return;
      videoMsg(t('video.rtspError', { msg: err.message || err }));
    };
    pipeline.rtsp.onRtcp = (rtcp) => {
      if (gen !== state.generation) return;
      if (MSL.isRtcpBye(rtcp) && state.mode === 'playback') onRecordingEnded();
    };

    pipeline.ready
      .then(() => {
        if (gen !== state.generation) return;
        pipeline.rtsp.play(offsetSec || 0);
        video.play().catch(() => { /* muted autoplay should work */ });
      })
      .catch((err) => {
        if (gen !== state.generation) return;
        videoMsg(t('video.connectFailed', { msg: err && err.message ? err.message : t('video.wsError') }));
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

  function goLive() {
    state.mode = 'live';
    state.rec = null;
    state.pausedAt = null;
    videoMsg('');
    startPipeline(liveParameters(), 0);
    updateModeUi();
  }

  async function playAt(time) {
    if (time >= Date.now() - LIVE_THRESHOLD) { goLive(); return; }
    let rec;
    try {
      rec = await findRecordingAtOrAfter(time);
    } catch (e) {
      toast(t('toast.recListFailed', { msg: e.message }), true);
      return;
    }
    if (!rec) {
      stopPipeline();
      state.mode = 'paused';
      state.pausedAt = time;
      updateModeUi();
      videoMsg(t('video.noRecordingFrom', { when: fmtDateTime(time) }));
      return;
    }
    if (rec.start > time) {
      toast(t('toast.jumpTo', { time: fmtTime(rec.start) }));
      time = rec.start;
    }
    const offset = Math.max(0, (time - rec.start) / 1000);
    state.mode = 'playback';
    state.rec = rec;
    state.startWall = time;
    state.pausedAt = null;
    videoMsg('');
    startPipeline([`recordingid=${encodeURIComponent(rec.id)}`, 'audio=0'], offset);
    updateModeUi();
  }

  async function onRecordingEnded() {
    if (state.ending) return;
    state.ending = true;
    try { await handleRecordingEnd(); } finally { state.ending = false; }
  }

  async function handleRecordingEnd() {
    const end = state.rec ? recStop(state.rec) : currentWall();
    try {
      const next = await findRecordingAtOrAfter(end + 1000);
      if (next && (!state.rec || next.id !== state.rec.id)) {
        await playAt(Math.max(next.start, end));
        return;
      }
    } catch (e) { /* ignore */ }
    stopPipeline();
    state.mode = 'paused';
    state.pausedAt = end;
    updateModeUi();
    videoMsg(t('video.endOfRecording'));
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
    if (state.baseCt == null) state.baseCt = $('video').currentTime || 0;
  });

  function togglePause() {
    if (state.mode === 'paused') {
      if (state.pausedAt != null) playAt(state.pausedAt); else goLive();
      return;
    }
    const time = currentWall();
    stopPipeline();
    $('video').pause();
    state.mode = 'paused';
    state.pausedAt = time;
    updateModeUi();
  }

  function updateModeUi() {
    const live = state.mode === 'live';
    const badge = $('modeBadge');
    badge.className = 'badge ' + (live ? 'live' : 'playback');
    badge.textContent = live ? t('badge.live') : state.mode === 'paused' ? t('badge.paused') : t('badge.playback');
    $('btnPause').textContent = state.mode === 'paused' ? '▶' : '⏸';
    $('btnFwd').disabled = live;
    const lb = $('btnLive');
    lb.disabled = live;
    lb.classList.toggle('is-live', live);
    lb.textContent = live ? t('live.btn') : t('live.back');
    document.dispatchEvent(new CustomEvent('microvms:mode', { detail: { mode: state.mode } }));
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
    sel: cssVar('--sel', 'rgba(255,204,51,.25)'),
    accent: cssVar('--accent', '#ffcc33'),
    live: cssVar('--live', '#e5484d'),
  };
  const TICK_STEPS = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];

  const canvasWidth = () => canvas.clientWidth;
  const xOf = (time) => ((time - state.viewStart) / (state.viewEnd - state.viewStart)) * canvasWidth();
  const tOf = (x) => state.viewStart + (x / canvasWidth()) * (state.viewEnd - state.viewStart);

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
    const trackTop = 26;
    const trackH = H - trackTop - 14;
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
      ctx.fillText(isMidnight ? fmtDate(tick) : fmtTime(tick, step < MIN * 1.5), x + 3, 4);
    }

    for (const r of state.recordings) {
      const x1 = Math.max(0, xOf(r.start));
      const x2 = Math.min(W, xOf(recStop(r)));
      if (x2 < 0 || x1 > W) continue;
      ctx.fillStyle = COLORS[r.type] || COLORS.continuous;
      if (r.type === 'continuous') ctx.fillRect(x1, trackTop, Math.max(1, x2 - x1), trackH);
      else ctx.fillRect(x1, trackTop, Math.max(2, x2 - x1), Math.round(trackH * 0.4));
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

  const showDay = (dayStart) => setView(dayStart, dayStart + DAY);

  function zoom(factor, anchorT) {
    const a = anchorT != null ? anchorT : (state.viewStart + state.viewEnd) / 2;
    setView(a - (a - state.viewStart) * factor, a + (state.viewEnd - a) * factor);
  }

  let fetchTimer = null;
  let fetchSeq = 0;
  function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(refreshRecordings, 250);
  }

  async function refreshRecordings() {
    const seq = ++fetchSeq;
    const margin = (state.viewEnd - state.viewStart) * 0.5;
    try {
      const recs = await listRecordings(state.viewStart - margin, Math.min(state.viewEnd + margin, Date.now() + HOUR));
      if (seq !== fetchSeq) return;
      state.recordings = recs;
      draw();
    } catch (e) {
      if (seq === fetchSeq) toast(t('toast.timeline', { msg: e.message }), true);
    }
  }

  let drag = null;
  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    const selecting = state.selectMode || ev.shiftKey;
    drag = { x0: ev.offsetX, view0: [state.viewStart, state.viewEnd], moved: false, selecting, t0: tOf(ev.offsetX) };
    if (selecting) canvas.classList.add('selecting');
  });
  canvas.addEventListener('pointermove', (ev) => {
    const tip = $('tlTooltip');
    tip.textContent = fmtDateTime(tOf(ev.offsetX));
    tip.style.left = `${ev.offsetX}px`;
    tip.classList.remove('hidden');
    if (!drag) return;
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
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.classList.toggle('selecting', state.selectMode);
    if (!d.moved && !d.selecting) playAt(tOf(ev.offsetX));
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
    $('expInfo').textContent = t('exp.duration', { d: fmtDuration(b - a) });
  }

  function selectionFromInputs() {
    const a = fromLocalInput($('expStart').value);
    const b = fromLocalInput($('expEnd').value);
    if (!isNaN(a) && !isNaN(b)) {
      state.selStart = a; state.selEnd = b;
      $('expInfo').textContent = b > a ? t('exp.duration', { d: fmtDuration(b - a) }) : t('exp.endBeforeStart');
      draw();
    }
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
      const url = exportUrl(c, `${base}_${fmtStamp(c.s)}`, pw);
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = url;
      link.download = '';
      link.textContent = `${fmtDateTime(c.s)} – ${fmtTime(c.e)} (${fmtDuration(c.e - c.s)})`;
      li.appendChild(link);
      list.appendChild(li);
      setTimeout(() => download(url, ''), i * 1500);   // staggered: browsers block bursts
    });
  }

  /** Load parts one after another and merge them into ONE .mkv in the browser. */
  async function exportMerged(chosen, base, a) {
    exportAbort = new AbortController();
    const signal = exportAbort.signal;
    $('btnCancelExport').classList.remove('hidden');
    const sources = chosen.map((c, i) => async () => {
      const res = await fetch(exportUrl(c, `${base}_part${i + 1}`, null), { credentials: 'same-origin', signal });
      if (!res.ok || !res.body) throw new Error(t('exp.partFailed', { n: i + 1, status: res.status }));
      return res.body;
    });
    try {
      const titleParts = [$('deviceName').textContent || 'Axis'];
      if (multiChannel()) titleParts.push(channelName());
      titleParts.push(fmtDateTime(a));
      const result = await window.MkvConcat.concat(sources, {
        startTimeMs: a,
        title: titleParts.join(' – '),
        onProgress: ({ part, parts, bytes }) => {
          $('expInfo').textContent = t('exp.loading', { part, parts, bytes: fmtBytes(bytes) });
        },
      });
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
    } finally {
      exportAbort = null;
      $('btnCancelExport').classList.add('hidden');
    }
  }

  async function doExport() {
    const a = fromLocalInput($('expStart').value);
    const b = Math.min(fromLocalInput($('expEnd').value), Date.now());
    if (isNaN(a) || isNaN(b) || b <= a) { toast(t('exp.invalidRange'), true); return; }
    if (b - a > 6 * HOUR && !confirm(t('exp.confirmLarge', { d: fmtDuration(b - a) }))) return;

    const usePw = $('expPwEnable').checked;
    const pw = $('expPw').value;
    if (usePw && !pw) { toast(t('exp.needPassword'), true); return; }

    $('btnExport').disabled = true;
    $('expLinks').innerHTML = '';
    try {
      const recs = (await listRecordings(a, b))
        .filter((r) => r.start < b && recStop(r) > a)
        .sort((x, y) => (x.type === 'continuous' ? -1 : 1) - (y.type === 'continuous' ? -1 : 1) || x.start - y.start);

      // Non-overlapping segments: each recording only contributes what is not covered yet.
      const chosen = [];
      for (const r of recs) {
        let segs = [{ s: Math.max(a, r.start), e: Math.min(b, recStop(r)) }];
        for (const c of chosen) {
          segs = segs.flatMap((g) => {
            if (c.e <= g.s || c.s >= g.e) return [g];
            const out = [];
            if (c.s > g.s) out.push({ s: g.s, e: c.s });
            if (c.e < g.e) out.push({ s: c.e, e: g.e });
            return out;
          });
        }
        segs.filter((g) => g.e - g.s >= 1000).forEach((g) => chosen.push({ r, s: g.s, e: g.e }));
      }
      chosen.sort((x, y) => x.s - y.s);

      if (!chosen.length) { $('expInfo').textContent = t('exp.none'); return; }

      let base = ($('expName').value.trim() || 'export').replace(/[^\w.-]+/g, '_');
      if (multiChannel()) base += `_ch${state.channel}`;
      const merge = $('expMerge').checked && chosen.length > 1;

      if (!merge) {
        exportSeparate(chosen, base, usePw ? pw : null);
        $('expInfo').textContent = chosen.length > 1 ? t('exp.parts', { n: chosen.length }) : t('exp.started');
        return;
      }
      if (usePw) {
        exportSeparate(chosen, base, pw);
        $('expInfo').textContent = t('exp.pwNoMerge', { n: chosen.length });
        return;
      }
      try {
        await exportMerged(chosen, base, a);
      } catch (e) {
        if (e.name === 'AbortError') { $('expInfo').textContent = t('exp.aborted'); return; }
        if (e instanceof window.MkvConcat.MkvConcatIncompatibleError) {
          exportSeparate(chosen, base, null);
          $('expInfo').textContent = t('exp.incompatible', { n: chosen.length });
          return;
        }
        throw e;
      }
    } catch (e) {
      toast(t('exp.failed', { msg: e.message }), true);
      $('expInfo').textContent = '';
    } finally {
      $('btnExport').disabled = false;
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
    try {
      const doc = await fetchXml('/axis-cgi/disks/list.cgi?diskid=all');
      state.disks = Array.from(doc.getElementsByTagName('disk')).map((d) => ({
        id: d.getAttribute('diskid'),
        status: d.getAttribute('status') || '',
        total: Number(d.getAttribute('totalsize')),   // kB
        free: Number(d.getAttribute('freesize')),     // kB
      }));
      const gb = (kb) => (kb / 1024 / 1024).toFixed(1);
      const parts = state.disks
        .filter((d) => d.status && d.status.toLowerCase() !== 'disconnected')
        .map((d) => `${d.id}: ${d.status}${d.total > 0 ? ' – ' + t('storage.used', { used: gb(d.total - d.free), total: gb(d.total) }) : ''}`);
      $('storageStatus').textContent = parts.length ? `${t('storage.label')}: ${parts.join(' | ')}` : t('storage.none');
      const sel = $('recDisk');
      const prev = sel.value;
      sel.innerHTML = '';
      state.disks.filter((d) => d.status.toLowerCase() === 'ok').forEach((d) => {
        const o = document.createElement('option');
        o.value = d.id; o.textContent = d.id;
        sel.appendChild(o);
      });
      if (prev) sel.value = prev;
    } catch (e) {
      $('storageStatus').textContent = t('storage.unavailable');
    }
  }

  // Continuous recording configurations (classic edge storage API)
  let recConfigs = null;     // null = unknown/unavailable

  /** Channel a config records: "camera=N" in its options, otherwise channel 1. */
  function configChannel(cfg) {
    const m = decodeURIComponent(cfg.options || '').match(/(?:^|&)camera=(\d+)/);
    return m ? Number(m[1]) : 1;
  }

  async function loadRecordingConfig() {
    try {
      const doc = await fetchXml('/axis-cgi/record/continuous/listconfiguration.cgi');
      recConfigs = Array.from(doc.getElementsByTagName('continuousrecordingconfiguration')).map((c) => ({
        profile: c.getAttribute('profile'),
        disk: c.getAttribute('diskid'),
        options: c.getAttribute('options') || '',
      }));
    } catch (e) {
      recConfigs = null;
    }
    renderRecordingConfig();
  }

  function renderRecordingConfig() {
    const el = $('recStatus');
    if (recConfigs == null) {
      el.textContent = t('rec.unavailable');
      $('recEnableRow').classList.add('hidden');
      return;
    }
    const mine = recConfigs.filter((c) => configChannel(c) === state.channel);
    if (mine.length) {
      const disks = [...new Set(mine.map((c) => c.disk))].map(escapeHtml).join(', ');
      el.innerHTML = `<span class="dot on"></span>${t('rec.on', { disks })}`;
    } else {
      el.innerHTML = `<span class="dot off"></span>${escapeHtml(multiChannel() ? t('rec.offChannel') : t('rec.off'))}`;
    }
    if (multiChannel() && recConfigs.length) {
      const chans = [...new Set(recConfigs.map(configChannel))].sort((x, y) => x - y).map((c) => channelName(c));
      el.innerHTML += `<div class="muted small">${escapeHtml(t('rec.onOthers', { list: chans.join(', ') }))}</div>`;
    }
    // Only offer when this channel has none yet (otherwise duplicate recording)
    $('recEnableRow').classList.toggle('hidden', mine.length > 0 || !$('recDisk').options.length);
  }

  async function enableContinuous() {
    const disk = $('recDisk').value;
    if (!disk) { toast(t('rec.noDisk'), true); return; }
    try {
      const opts = multiChannel() ? `camera=${state.channel}&videocodec=h264` : 'videocodec=h264';
      const p = new URLSearchParams({ diskid: disk, options: opts });
      const doc = await fetchXml(`/axis-cgi/record/continuous/addconfiguration.cgi?${p}`);
      const c = doc.getElementsByTagName('configure')[0];
      if (c && c.getAttribute('result') === 'OK') toast(t('rec.enabled', { profile: c.getAttribute('profile') }));
      else toast(t('rec.error', { msg: c ? c.getAttribute('errormsg') : t('rec.unknownResponse') }), true);
    } catch (e) {
      toast(t('rec.enableFailed', { msg: e.message }), true);
    }
    loadRecordingConfig();
    setTimeout(refreshRecordings, 3000);
  }

  // ------------------------------------------------------------ Wiring

  $('btnLive').addEventListener('click', () => {
    goLive();
    const now = Date.now();
    if (now < state.viewStart || now > state.viewEnd) showDay(startOfDay(now));
  });
  $('btnPause').addEventListener('click', togglePause);
  $('btnBack').addEventListener('click', () => playAt(currentWall() - SKIP));
  $('btnFwd').addEventListener('click', () => playAt(currentWall() + SKIP));
  $('btnSnapshot').addEventListener('click', () => {
    const p = new URLSearchParams({ camera: String(state.channel) });
    const res = $('resolution').value;
    if (res) p.set('resolution', res);
    const suffix = multiChannel() ? `_ch${state.channel}` : '';
    download(`/axis-cgi/jpg/image.cgi?${p}`, `snapshot${suffix}_${fmtStamp(Date.now())}.jpg`);
  });
  $('resolution').addEventListener('change', () => { if (state.mode === 'live') goLive(); });
  $('streamProfile').addEventListener('change', () => {
    store.set('streamprofile', $('streamProfile').value);
    if (state.mode === 'live') goLive();
  });
  $('channel').addEventListener('change', (ev) => setChannel(Number(ev.target.value)));

  $('dayPicker').addEventListener('change', (ev) => {
    if (!ev.target.value) return;
    const [y, m, d] = ev.target.value.split('-').map(Number);
    showDay(new Date(y, m - 1, d).getTime());
  });
  $('btnPrevDay').addEventListener('click', () => setView(state.viewStart - DAY, state.viewEnd - DAY));
  $('btnNextDay').addEventListener('click', () => setView(state.viewStart + DAY, state.viewEnd + DAY));
  $('btnToday').addEventListener('click', () => showDay(startOfDay(Date.now())));
  $('btnZoomIn').addEventListener('click', () => zoom(0.5, state.mode === 'live' ? null : currentWall()));
  $('btnZoomOut').addEventListener('click', () => zoom(2));
  $('btnFitDay').addEventListener('click', () => showDay(startOfDay((state.viewStart + state.viewEnd) / 2)));
  $('btnSelectMode').addEventListener('click', () => {
    state.selectMode = !state.selectMode;
    $('btnSelectMode').classList.toggle('active', state.selectMode);
    canvas.classList.toggle('selecting', state.selectMode);
  });

  $('expStart').addEventListener('change', selectionFromInputs);
  $('expEnd').addEventListener('change', selectionFromInputs);
  $('expPwEnable').addEventListener('change', (ev) => $('expPw').classList.toggle('hidden', !ev.target.checked));
  $('btnExport').addEventListener('click', doExport);
  $('btnCancelExport').addEventListener('click', () => { if (exportAbort) exportAbort.abort(); });
  $('btnClearSel').addEventListener('click', () => {
    state.selStart = state.selEnd = null;
    $('expStart').value = $('expEnd').value = '';
    $('expInfo').textContent = '';
    $('expLinks').innerHTML = '';
    draw();
  });
  $('btnEnableRec').addEventListener('click', enableContinuous);

  document.querySelectorAll('.lang-switch [data-lang]').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === window.I18N.lang);
    b.addEventListener('click', () => window.I18N.setLang(b.dataset.lang));
  });

  window.addEventListener('resize', resizeCanvas);

  setInterval(() => {
    const time = currentWall();
    $('clock').textContent = fmtDateTime(time);
    // continue past the end of a completed recording
    if (state.mode === 'playback' && state.rec && state.rec.stop != null && time > state.rec.stop + 2000) {
      onRecordingEnded();
    }
    if (!drag) draw();
  }, 250);

  setInterval(refreshRecordings, 30 * 1000);   // running recordings grow
  setInterval(loadStorage, 60 * 1000);

  // Interface for add-on modules (ptz.js)
  window.MicroVms = { toast, mode: () => state.mode, channel: () => state.channel };

  // ------------------------------------------------------------ Start

  (async () => {
    if (!MSL || !MSL.Html5VideoPipeline) videoMsg(t('video.libMissing'));
    const now = Date.now();
    setView(now - 2 * HOUR, now + 30 * MIN, { fetch: false });
    resizeCanvas();
    updateModeUi();
    loadDeviceInfo();
    await Promise.all([loadChannels(), loadStreamProfiles()]);
    document.dispatchEvent(new CustomEvent('microvms:channel', { detail: { channel: state.channel, previous: null } }));
    refreshRecordings();
    loadStorage().then(loadRecordingConfig);
    if (MSL && MSL.Html5VideoPipeline) goLive();
  })();
})();
