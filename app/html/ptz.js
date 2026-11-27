/*
 * PTZ control for Micro VMS
 *
 * Shown only if
 *   1. the device supports PTZ (Properties.PTZ.PTZ=yes),
 *   2. the logged-in user may control PTZ (group "ptz" or admin), and
 *   3. the selected video channel offers PTZ commands (ptz.cgi?info=1&camera=N).
 *
 * Control: /axis-cgi/com/ptz.cgi (VAPIX PTZ API) on the selected channel
 *   - pad / arrow keys      -> continuouspantiltmove (hold)
 *   - zoom +/- / keys + -   -> continuouszoommove
 *   - click in live image   -> center=x,y (with imagewidth/imageheight)
 *   - wheel in live image   -> areazoom=x,y,z
 *   - home, presets         -> move=home, gotoserverpresetname
 * Disabled during playback.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const { t } = window.I18N;
  const ui = () => window.MicroVms;

  const ptz = {
    allowed: null,          // Promise<boolean>: device + user rights
    enabled: false,         // PTZ usable on the current channel
    live: true,
    camera: null,           // VAPIX camera number currently controlled
    commands: new Set(),
    moving: null,           // 'pt' | 'zoom' while a button/key is held
    applySeq: 0,
  };

  // ------------------------------------------------------------ Requests

  async function ptzRequest(params, camera = ptz.camera) {
    const p = new URLSearchParams(Object.assign({ camera: String(camera || 1) }, params));
    const res = await fetch(`/axis-cgi/com/ptz.cgi?${p}`, { credentials: 'same-origin', cache: 'no-store' });
    const text = res.status === 204 ? '' : await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    if (/^\s*Error/i.test(text)) throw new Error(text.trim());
    return text;
  }

  function send(params, { force = false, camera = ptz.camera } = {}) {
    if ((!ptz.enabled && !force) || (!ptz.live && !force)) return Promise.resolve();
    return ptzRequest(params, camera).catch((e) => ui() && ui().toast(t('ptz.error', { msg: e.message }), true));
  }

  // ------------------------------------------------------------ Rights

  async function deviceHasPtz() {
    try {
      const res = await fetch('/axis-cgi/param.cgi?action=list&group=Properties.PTZ.PTZ',
        { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return false;
      return /Properties\.PTZ\.PTZ=yes/i.test(await res.text());
    } catch (e) { return false; }
  }

  /** Groups of the logged-in user, e.g. "root\nadmin operator viewer ptz". null = unknown. */
  async function userGroups() {
    try {
      const res = await fetch('/axis-cgi/usergroup.cgi', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return null;
      const lines = (await res.text()).trim().split(/\r?\n/);
      if (lines.length < 2) return null;
      return new Set(lines.slice(1).join(' ').toLowerCase().split(/[\s,]+/).filter(Boolean));
    } catch (e) { return null; }
  }

  async function checkAccess() {
    if (!(await deviceHasPtz())) return false;
    const groups = await userGroups();
    if (groups) return groups.has('ptz') || groups.has('admin');
    // Fallback: harmless query that only works with PTZ rights
    try { return /pan=|zoom=/i.test(await ptzRequest({ query: 'position' }, 1)); } catch (e) { return false; }
  }

  /** Commands available on a channel; empty set = no PTZ on this channel. */
  async function channelCommands(camera) {
    const cmds = new Set();
    try {
      const text = await ptzRequest({ info: '1' }, camera);
      text.split(/\r?\n/).forEach((l) => {
        const m = l.trim().match(/^([a-z]+)/i);
        if (m) cmds.add(m[1].toLowerCase());
      });
    } catch (e) { /* error -> no PTZ on this channel */ }
    return cmds;
  }

  const supports = (cmd) => ptz.commands.has(cmd);

  async function loadPresets() {
    const sel = $('ptzPreset');
    sel.innerHTML = '';
    const camera = ptz.camera;
    try {
      const text = await ptzRequest({ query: 'presetposall' }, camera);
      if (camera !== ptz.camera) return;
      const presets = [];
      // Response may contain several cameras; take the block of ours (or the only one)
      let current = null;
      text.split(/\r?\n/).forEach((l) => {
        const h = l.match(/camera\s+(\d+)/i);
        if (h) { current = Number(h[1]); return; }
        const m = l.match(/^presetposno(\d+)=(.*)$/);
        if (m && (current == null || current === camera)) presets.push({ no: Number(m[1]), name: m[2].trim() });
      });
      presets.sort((a, b) => a.no - b.no);
      if (!presets.length) {
        sel.innerHTML = `<option value="">${t('ptz.noPresets')}</option>`;
        return;
      }
      for (const p of presets) {
        const o = document.createElement('option');
        o.value = p.name;
        o.textContent = `${p.no}: ${p.name}`;
        sel.appendChild(o);
      }
    } catch (e) {
      sel.innerHTML = `<option value="">${t('ptz.presetsUnavailable')}</option>`;
    }
  }

  // ------------------------------------------------------------ Movement

  const speed = () => Number($('ptzSpeed').value) || 50;

  function startPanTilt(dx, dy) {
    ptz.moving = 'pt';
    const s = speed();
    send({ continuouspantiltmove: `${Math.round(dx * s)},${Math.round(dy * s)}` });
  }
  function startZoom(dir) {
    ptz.moving = 'zoom';
    send({ continuouszoommove: String(Math.round(dir * speed())) });
  }
  /** Always sends the stop, even when PTZ was just disabled (mode/channel change). */
  function stopAll() {
    if (!ptz.moving || ptz.camera == null) return;
    const m = ptz.moving;
    ptz.moving = null;
    if (m === 'pt') send({ continuouspantiltmove: '0,0' }, { force: true });
    else send({ continuouszoommove: '0' }, { force: true });
  }

  function bindHold(el, start) {
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      el.classList.add('pressed');
      start();
    });
    const end = () => { el.classList.remove('pressed'); stopAll(); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  // Click position in the video element -> pixel in the stream (object-fit: contain)
  function videoPoint(ev) {
    const v = ev.currentTarget;
    const vw = v.videoWidth; const vh = v.videoHeight;
    if (!vw || !vh) return null;
    const r = v.getBoundingClientRect();
    const scale = Math.min(r.width / vw, r.height / vh);
    const ox = (r.width - vw * scale) / 2;
    const oy = (r.height - vh * scale) / 2;
    const x = (ev.clientX - r.left - ox) / scale;
    const y = (ev.clientY - r.top - oy) / scale;
    if (x < 0 || y < 0 || x > vw || y > vh) return null;
    return { x: Math.round(x), y: Math.round(y), w: vw, h: vh };
  }

  // ------------------------------------------------------------ UI

  const active = () => ptz.enabled && ptz.live;

  function setLive(live) {
    ptz.live = live;
    if (!live) stopAll();
    $('ptzCard').classList.toggle('disabled', !live);
    $('ptzHint').textContent = live ? '' : t('ptz.onlyLive');
    const videos = (ui() && ui().videos && ui().videos()) || [$('video')];
    for (const video of videos) video.classList.remove('ptz-active');
    const current = (ui() && ui().activeVideo && ui().activeVideo()) || $('video');
    if (current) current.classList.toggle('ptz-active', active() && $('ptzClickCenter').checked);
  }

  async function applyChannel(camera) {
    const seq = ++ptz.applySeq;
    stopAll();                      // stop movement on the previous channel
    ptz.camera = camera;
    ptz.enabled = false;
    $('ptzCard').classList.add('hidden');
    const videos = (ui() && ui().videos && ui().videos()) || [$('video')];
    for (const video of videos) video.classList.remove('ptz-active');
    if (camera == null || !(await ptz.allowed)) return;
    const cmds = await channelCommands(camera);
    if (seq !== ptz.applySeq) return;
    ptz.commands = cmds;
    const usable = ['continuouspantiltmove', 'continuouszoommove', 'center', 'areazoom', 'gotoserverpresetname']
      .some((c) => cmds.has(c));
    if (!usable) return;           // no PTZ on this channel
    ptz.enabled = true;
    $('ptzPad').classList.toggle('hidden', !supports('continuouspantiltmove'));
    $('ptzZoomRow').classList.toggle('hidden', !supports('continuouszoommove'));
    $('ptzPresetRow').classList.toggle('hidden', !supports('gotoserverpresetname'));
    $('ptzCenterRow').classList.toggle('hidden', !supports('center') && !supports('areazoom'));
    $('ptzCard').classList.remove('hidden');
    setLive(!ui() || ui().mode() === 'live');
    if (supports('gotoserverpresetname')) loadPresets();
  }

  function wireUi() {
    document.querySelectorAll('#ptzPad [data-dir]').forEach((btn) => {
      const [dx, dy] = btn.dataset.dir.split(',').map(Number);
      bindHold(btn, () => startPanTilt(dx, dy));
    });
    $('ptzHome').addEventListener('click', () => send({ move: 'home' }));
    bindHold($('ptzZoomIn'), () => startZoom(1));
    bindHold($('ptzZoomOut'), () => startZoom(-1));
    $('ptzSpeedVal').textContent = $('ptzSpeed').value;
    $('ptzSpeed').addEventListener('input', () => { $('ptzSpeedVal').textContent = $('ptzSpeed').value; });

    $('ptzGoPreset').addEventListener('click', () => {
      const name = $('ptzPreset').value;
      if (name) send({ gotoserverpresetname: name });
    });
    $('ptzPreset').addEventListener('dblclick', () => $('ptzGoPreset').click());
    $('ptzReloadPresets').addEventListener('click', loadPresets);

    const videos = (ui() && ui().videos && ui().videos()) || [$('video')];
    $('ptzClickCenter').addEventListener('change', () => setLive(ptz.live));
    let wheelTimer = null;
    for (const video of videos) {
      video.addEventListener('click', (ev) => {
        if (!active() || video !== ((ui() && ui().activeVideo && ui().activeVideo()) || video)) return;
        if (!$('ptzClickCenter').checked || !supports('center')) return;
        const p = videoPoint(ev);
        if (!p) return;
        send({ center: `${p.x},${p.y}`, imagewidth: String(p.w), imageheight: String(p.h) });
      });
      video.addEventListener('wheel', (ev) => {
        if (!active() || video !== ((ui() && ui().activeVideo && ui().activeVideo()) || video)) return;
        if (!$('ptzClickCenter').checked || !supports('areazoom')) return;
        ev.preventDefault();
        if (wheelTimer) return;                      // throttle: max. 1 command / 400 ms
        wheelTimer = setTimeout(() => { wheelTimer = null; }, 400);
        const p = videoPoint(ev);
        if (!p) return;
        const z = ev.deltaY < 0 ? 200 : 50;          // >100 zoom in, <100 zoom out
        send({ areazoom: `${p.x},${p.y},${z}`, imagewidth: String(p.w), imageheight: String(p.h) });
      }, { passive: false });
    }

    const keys = {
      ArrowLeft: () => startPanTilt(-1, 0), ArrowRight: () => startPanTilt(1, 0),
      ArrowUp: () => startPanTilt(0, 1), ArrowDown: () => startPanTilt(0, -1),
      '+': () => startZoom(1), '-': () => startZoom(-1),
    };
    let held = null;
    document.addEventListener('keydown', (ev) => {
      if (!active() || held || ev.repeat) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
      const fn = keys[ev.key];
      if (!fn) return;
      ev.preventDefault();
      held = ev.key;
      fn();
    });
    document.addEventListener('keyup', (ev) => {
      if (ev.key === held) { held = null; stopAll(); }
    });

    // Safety: always stop on leaving / losing focus
    window.addEventListener('blur', () => { held = null; stopAll(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { held = null; stopAll(); } });
    window.addEventListener('pagehide', stopAll);
  }

  // Listeners first (synchronously), so no event from app.js is missed
  document.addEventListener('microvms:mode', (ev) => { if (ptz.enabled) setLive(ev.detail.mode === 'live'); else ptz.live = ev.detail.mode === 'live'; });
  document.addEventListener('microvms:channel', (ev) => applyChannel(ev.detail.channel));
  wireUi();
  ptz.allowed = checkAccess();
})();
