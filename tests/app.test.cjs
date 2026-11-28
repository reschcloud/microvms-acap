const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

process.env.TZ = 'Europe/Berlin';

// Run the production browser script with a minimal DOM and mocked VAPIX/video.
const source = readFileSync(require.resolve('../app/html/app.js'), 'utf8').replace(/\}\)\(\);\s*$/, `
  window.testApp = { state, updateModeUi, listRecordings, selectChannel, planExport, playAt, goLive, togglePause,
    onRecordingEnded, showDay, setChannel, syncSelectionInputs, selectedExportRange, loadStorage,
    refreshActiveRecording, doExport, loadChannels, skipForwardAll, setLayout, setTheme, followSharedClock, loadDeviceInfo, fmtDayTime, nightness, daylightTint, sparkPath, rtspReason,
    refreshRecordings, laneGeometry, timelineLanes, timelineChannels, exportChecked, findRecordingAtOrAfter, verifyPausedFootage, parseRecordings, recStop,
    setView, draw, createTile, activeTile, stopPipeline,
    autoLayoutSize, rankedProfiles, effectiveProfile, applyLayout,
    formatBitrate, totalBitrate, updateBandwidth, updatePing, resolveShortcut, setTheater, footageAt };
})();`);

function xml(name, attrs = {}, children = []) {
  return {
    name, textContent: attrs.text || '',
    getAttribute: (key) => attrs[key] ?? null,
    getElementsByTagName: (key) => children.flatMap((n) => [...(n.name === key ? [n] : []), ...n.getElementsByTagName(key)]),
  };
}
const recordings = (total, ...rows) => xml('root', {}, [xml('recordings', { numberofrecordings: String(total) }, rows)]);
const listConfigs = (...rows) => xml('root', {}, [xml('continuousrecordingconfigurations', {}, rows)]);
const listDisks = (...rows) => xml('root', {}, [xml('disks', {}, rows)]);
const fixtureTime = Date.UTC(2026, 9, 24, 10);
const recording = (id, start = fixtureTime, stop = start + 60000, attrs = {}, children = []) => xml('recording', {
  recordingid: id, diskid: 'SD_DISK', starttime: new Date(start).toISOString(),
  stoptime: stop == null ? '' : new Date(stop).toISOString(), recordingtype: 'continuous',
  recordingstatus: 'completed', ...attrs,
}, children);
const bad = (status) => ({ ok: false, status, statusText: 'test error' });
const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const response = new Promise((r) => { resolve = r; });
  return { resolve, response };
}

async function browser({ route: startRoute, session, mediaSource, managedMediaSource } = {}) {
  const nodes = new Map(), requests = [], messages = [], downloads = [];
  const local = new Map();
  const rectangles = [];
  const canvasContext = new Proxy({}, { get: (ctx, key) => ctx[key] ?? (() => {}) });
  canvasContext.fillRect = (x, y, w, h) => rectangles.push({ x, y, w, h, color: canvasContext.fillStyle });
  let options;
  const element = (id) => {
    if (!nodes.has(id)) {
      const children = [];
      const classes = new Set();
      nodes.set(id, {
        options: children, value: '', textContent: '', className: '', disabled: false,
        style: {}, clientWidth: 800, clientHeight: 112, currentTime: 0, events: {},
        classList: {
          add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
          toggle: (c, on) => on ? classes.add(c) : classes.delete(c),
        },
        addEventListener(type, fn) { this.events[type] = fn; },
        appendChild: (n) => children.push(n), replaceChildren: () => { children.length = 0; },
        getContext: () => canvasContext,
        toDataURL: () => 'data:image/jpeg;base64,mock',
        play: async () => {}, pause() {}, setAttribute() {}, setPointerCapture() {},
      });
    }
    return nodes.get(id);
  };
  // A real addEventListener: optional chaining must not hide undefined handlers.
  const docEvents = {};
  const doc = {
    documentElement: { dataset: {} },
    getElementById: element, querySelectorAll: () => [], dispatchEvent() {},
    addEventListener(type, fn) { (docEvents[type] ||= []).push(fn); },
    events: docEvents,
    createElement: (tag) => tag === 'a' ? { click() { downloads.push(this.href); }, remove() {} } : element(Symbol(tag)),
    body: { appendChild() {} },
  };
  const defaults = (url) => {
    if (url.pathname.endsWith('/record/list.cgi')) return recordings(0);
    if (url.pathname.endsWith('/listconfiguration.cgi')) return listConfigs();
    if (url.pathname.endsWith('/disks/list.cgi')) return listDisks();
    return '';
  };
  let handler = startRoute ? (url, opts) => startRoute(url, opts) ?? defaults(url) : defaults;
  const context = {
    document: doc, Date, URLSearchParams, AbortController, AbortSignal,
    MediaSource: mediaSource === undefined ? class {} : mediaSource, ManagedMediaSource: managedMediaSource,
    localStorage: { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)) },
    sessionStorage: { getItem: () => (session ? JSON.stringify(session) : null), setItem() {} },
    DOMParser: class { parseFromString(data) { return data; } }, CustomEvent: class {},
    fetch: async (href, opts) => {
      const url = new URL(href, 'https://camera.invalid');
      requests.push(url);
      const body = await handler(url, opts);
      const json = async () => (typeof body === 'string' ? (body.trim().startsWith('{') ? JSON.parse(body) : {}) : (body ?? {}));
      return body?.ok === false ? body : { ok: true, text: async () => body, json };
    },
    setInterval() {}, setTimeout() {}, clearTimeout() {}, addEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    confirm: (msg) => { messages.push(msg); return options?.confirm ?? true; },
    I18N: { t: (key, vars) => key + (vars ? ` ${JSON.stringify(vars)}` : ''), lang: 'de' },
    mediaStreamLibrary: { Html5VideoPipeline: class {
      constructor(opts) { this.parameters = opts.rtsp.parameters; this.rtsp = { play() {} }; this.ready = Promise.resolve(); }
      close() {}
    } },
  };
  context.window = context;
  vm.runInNewContext(source, context);
  await tick();
  requests.length = 0;
  return { ...context.testApp, element, requests, messages, downloads, rectangles, local, win: context,
    route(fn) { handler = (url, opts) => fn(url, opts) ?? defaults(url); },
    options(value) { options = value; },
  };
}

test('reported views fill the tiles and each tile has its own channel menu', async () => {
  const app = await browser();
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  assert.ok(html.indexOf('id="videoGrid"') < html.indexOf('id="sourceChoices"'));
  assert.ok(html.includes('id="tileChannel"') && html.includes('id="tileOptions"'));
  assert.equal((html.match(/class="video-wrap/g) || []).length, 6);
  assert.equal(html.includes('id="channelWrap"'), false);

  app.route((url) => {
    if (url.searchParams.get('group') === 'Properties.Image.NbrOfViews') return 'root.Properties.Image.NbrOfViews=3';
    if (url.searchParams.get('group') === 'Image') return 'root.Image.I1.Name=Eingang\nroot.Image.I2.Enabled=no';
  });
  await app.loadChannels();
  // Three physical views, two enabled -> 2-tile layout with channels 1 and 2.
  assert.equal(app.state.layoutSize, 2);
  assert.equal(app.state.tiles[0].channel, 1);
  assert.equal(app.state.tiles[1].channel, 2);
  assert.equal(app.state.tiles[2].visible, false);
  assert.equal(app.element('tile0').classList.contains('hidden'), false);
  assert.equal(app.element('tile1').classList.contains('hidden'), false);
  assert.equal(app.element('tile2').classList.contains('hidden'), true);
  assert.match(app.element('tileName').textContent, /channel\.default/);
  assert.equal(app.element('tileName2').textContent, 'Eingang');
  assert.deepEqual(app.element('tileChannel').options.map((o) => o.textContent), [
    'tile.empty', 'channel.default {"n":1}', '2: Eingang',
  ]);
  assert.equal(app.element('tileChannel2').value, '2');

  app.element('tile1').events.pointerdown();
  assert.equal(app.state.active, 1);
  assert.equal(app.state.channel, 2);
  assert.equal(app.element('tile1').classList.contains('active'), true);
  assert.equal(app.element('tile0').classList.contains('active'), false);
});

test('events are yellow on the channel lane and open by recording ID', async () => {
  const app = await browser();
  const marker = fixtureTime + 19000;
  app.route(() => recordings(5,
    recording('evt', marker, marker + 500, { recordingtype: ' Triggered ' }),
    recording('daily', fixtureTime, fixtureTime + 60000, { eventid: 'configured-name' }),
    recording('scheduled', marker, marker + 500, { recordingtype: 'scheduled' }),
    recording('legacy-trigger', marker + 1000, marker + 1500, { recordingtype: '', eventtrigger: 'VMD' }),
    recording('unknown', marker, marker + 500, { recordingtype: '', eventid: 'custom' }),
  ));
  app.setView(fixtureTime, fixtureTime + 60000, { fetch: false });
  app.rectangles.length = 0;
  await app.refreshRecordings();
  const eventBar = app.rectangles.find((r) => r.color === '#f59e0b');
  const continuousBar = app.rectangles.find((r) => r.color === '#3b82f6');
  assert.ok(eventBar && continuousBar);
  // One lane per channel: events sit on top of the channel's blue recording.
  assert.equal(eventBar.y, continuousBar.y);
  assert.ok(eventBar.y >= 24);
  const ev = { isPrimary: true, button: 0, pointerId: 1, offsetX: eventBar.x + 1, offsetY: eventBar.y + 1 };
  const canvas = app.element('timeline');
  canvas.events.pointerdown(ev);
  canvas.events.pointerup(ev);
  assert.equal(app.state.pipeline.parameters[0], 'recordingid=evt');
});

test('visible channels get separate lanes and a timeline click seeks all tiles', async () => {
  const app = await browser();
  app.state.channelCount = 2;
  app.state.channels = [{ camera: 1, name: 'K1' }, { camera: 2, name: 'K2' }];
  app.state.sourceCatalog = ['1', '2'];
  app.state.tiles[1].channel = 2;
  app.state.tiles[1].visible = true;
  app.state.tiles[0].mode = app.state.tiles[1].mode = 'paused';   // archive: lanes unfold
  app.route(() => recordings(2,
    recording('one', fixtureTime, fixtureTime + 60000, { source: '1' }),
    recording('two', fixtureTime, fixtureTime + 60000, { source: '2' }),
  ));
  app.setView(fixtureTime, fixtureTime + 60000, { fetch: false });
  app.rectangles.length = 0;
  await app.refreshRecordings();
  assert.equal(JSON.stringify(app.timelineLanes().map((lane) => lane.channel)), '[1,2]');
  assert.equal(app.state.recordingsByChannel.size, 2);
  const blues = app.rectangles.filter((r) => r.color === '#3b82f6');
  assert.equal(new Set(blues.map((r) => r.y)).size, 2);

  const canvas = app.element('timeline');
  const x = 20;
  const y = app.laneGeometry(1).y + 5;
  canvas.events.pointerdown({ isPrimary: true, button: 0, pointerId: 1, offsetX: x, offsetY: y });
  canvas.events.pointerup({ isPrimary: true, button: 0, pointerId: 1, offsetX: x, offsetY: y });
  await tick();
  await tick();
  assert.match(app.state.tiles[0].pipeline.parameters[0], /^recordingid=one$/);
  assert.match(app.state.tiles[1].pipeline.parameters[0], /^recordingid=two$/);
});

test('export checkboxes beside the lanes choose the channels and start all on', async () => {
  const app = await browser();
  twoChannels(app);
  app.state.tiles[1].channel = 2;
  app.state.tiles[1].visible = true;
  app.setView(fixtureTime, fixtureTime + 60000, { fetch: false });
  assert.equal(app.state.exportBoxes.length, 0, 'no checkboxes outside the export mode');
  app.element('btnExport').events.click();
  assert.equal(app.element('selectionBar').classList.contains('hidden'), false);
  assert.equal(app.state.exportBoxes.length, 2);
  assert.ok(app.state.exportBoxes.every(({ input }) => input.checked));
  assert.equal(app.element('btnExport').disabled, false);

  const [first, second] = app.state.exportBoxes;
  first.input.checked = false;
  first.input.events.change();
  assert.equal(app.exportChecked(1), false);
  assert.equal(app.element('btnExport').disabled, false);
  second.input.checked = false;
  second.input.events.change();
  assert.equal(app.element('btnExport').disabled, true, 'nothing to export');

  app.element('btnClearSel').events.click();
  assert.equal(app.element('selectionBar').classList.contains('hidden'), true);
  assert.equal(app.state.exportBoxes.length, 0);
});

test('multi-channel export writes one file per selected channel and keeps links for the rest', async () => {
  const app = await browser();
  app.state.channelCount = 2;
  app.state.channels = [{ camera: 1 }, { camera: 2 }];
  app.state.sourceCatalog = ['1', '2'];
  app.state.tiles[1].channel = 2;
  app.state.tiles[1].visible = true;
  app.route(() => recordings(2,
    recording('one', fixtureTime, fixtureTime + 60000, { source: '1' }),
    recording('two', fixtureTime, fixtureTime + 60000, { source: '2' }),
  ));
  await app.doExport(fixtureTime, fixtureTime + 30000);
  assert.equal(app.downloads.length, 1);
  assert.match(app.downloads[0], /recordingid=one/);
  assert.match(app.downloads[0], /_ch1/);
  const links = app.element('expLinks').options;
  assert.equal(links.length, 2);
  assert.match(links[1].options[0].href, /recordingid=two/);
  assert.match(links[1].options[0].href, /_ch2/);
  assert.match(app.element('expInfo').textContent, /exp\.channelDone/);
});

test('per-tile audio restarts live with AAC and can be muted again', async () => {
  const app = await browser();
  const tile = app.state.tiles[0];
  app.element('tileAudio').events.click();
  assert.equal(tile.audio, true);
  assert.ok(tile.pipeline.parameters.includes('audio=1'));
  assert.ok(tile.pipeline.parameters.includes('audiocodec=aac'));
  assert.equal(tile.video.muted, true); // muted until the new stream plays
  app.element('video').events.playing();
  assert.equal(tile.video.muted, false);
  assert.equal(app.element('tileAudio').classList.contains('audio-on'), true);

  app.element('tileAudio').events.click();
  assert.equal(tile.audio, false);
  assert.equal(tile.video.muted, true);
  app.goLive();
  assert.ok(app.state.pipeline.parameters.includes('audio=0'));
});

test('network status sums stream bitrates and pings the camera', async () => {
  const app = await browser();
  assert.equal(app.formatBitrate(2_500_000), '2.5 Mbit/s');
  assert.equal(app.formatBitrate(850_000), '850 kbit/s');
  app.state.tiles[0].pipeline.bitrate = 2_500_000;
  app.state.tiles[1].channel = 2;
  app.state.tiles[1].visible = true;
  app.state.tiles[1].pipeline = { bitrate: 1_500_000 };
  assert.equal(app.totalBitrate(), 4_000_000);
  app.updateBandwidth();
  assert.match(app.element('netRate').textContent, /4\.0 Mbit\/s/);

  app.requests.length = 0;
  await app.updatePing();
  assert.match(app.element('netPing').textContent, /net\.ping/);
  assert.ok(app.requests.some((url) => url.pathname.endsWith('/ping.txt')));
});

test('recordings expose audio tracks and control the export audio option', async () => {
  const app = await browser();
  app.setView(fixtureTime, fixtureTime + 60000, { fetch: false });
  app.route(() => recordings(1, recording('with-audio', fixtureTime, fixtureTime + 60000, {}, [xml('audio')])));
  await app.refreshRecordings();
  assert.equal(app.state.recordings[0].hasAudio, true);
  assert.equal(app.element('expAudioHint').classList.contains('hidden'), true);

  app.route(() => recordings(1, recording('silent', fixtureTime, fixtureTime + 60000)));
  await app.refreshRecordings();
  assert.equal(app.state.recordings[0].hasAudio, false);
  assert.equal(app.element('expAudioHint').classList.contains('hidden'), false);
});

test('the settings sheet holds the secondary status and opens from the topbar', async () => {
  const app = await browser();
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  assert.ok(html.includes('id="layoutSeg"'));
  assert.ok(html.includes('id="btnInspector"'));
  assert.equal(html.includes('id="appMenu"'), false);
  // Secondary information is out of the way until asked for.
  assert.equal(app.element('inspector').classList.contains('open'), false);
  for (const id of ['netStatus', 'storageStatus', 'deviceName', 'themeSeg', 'btnHelp']) {
    assert.ok(html.indexOf(`id="${id}"`) > html.indexOf('id="inspector"'), id);
  }
  app.element('btnInspector').events.click();
  assert.equal(app.element('inspector').classList.contains('open'), true);
  assert.equal(app.local.get('minivms.inspector'), '1');
  app.element('btnInspectorClose').events.click();
  assert.equal(app.element('inspector').classList.contains('open'), false);
});

test('the storage meter visualizes usage and shows an encrypted lock', async () => {
  const app = await browser();
  app.route((url) => {
    if (url.pathname.endsWith('/disks/list.cgi')) {
      return listDisks(xml('disk', {
        diskid: 'SD_DISK', status: 'OK', totalsize: '1000', freesize: '400', diskencrypted: 'true',
      }));
    }
  });
  await app.loadStorage();
  assert.equal(app.element('storageDiskName').textContent, 'storage.sd');
  assert.equal(app.element('storageFill').style.width, '60.0%');
  assert.equal(app.element('storageLock').classList.contains('hidden'), false);
  assert.equal(app.element('storageLock').classList.contains('encrypted'), true);
  assert.equal(app.element('storageLock').classList.contains('unencrypted'), false);
  assert.match(app.element('storageUsed').textContent, /storage\.used/);
});

test('shortcut resolution and theater mode follow the desktop rules', async () => {
  const app = await browser();
  assert.equal(app.resolveShortcut({ key: ' ' }, {}), 'pause');
  assert.equal(app.resolveShortcut({ key: ' ' }, { button: true }), null);
  assert.equal(app.resolveShortcut({ key: 'ArrowLeft' }, {}), 'back5');
  assert.equal(app.resolveShortcut({ key: 'ArrowLeft', shiftKey: true }, {}), 'back30');
  assert.equal(app.resolveShortcut({ key: 'e' }, { selection: false }), 'export');
  assert.equal(app.resolveShortcut({ key: 'e' }, { selection: true, exporting: true }), null);
  assert.equal(app.resolveShortcut({ key: 'e' }, { selection: true }), 'export');
  assert.equal(app.resolveShortcut({ key: '?' , shiftKey: true }, {}), 'help');
  assert.equal(app.resolveShortcut({ key: '1' }, { typing: true }), null);
  assert.equal(app.resolveShortcut({ key: 'f' }, {}), 'theater');
  assert.equal(app.resolveShortcut({ key: 'j' }, {}), 'back5');
  assert.equal(app.resolveShortcut({ key: 'J', shiftKey: true }, {}), 'back30');
  assert.equal(app.resolveShortcut({ key: 'k' }, {}), 'pause');
  assert.equal(app.resolveShortcut({ key: 'l' }, {}), 'forward5');
  assert.equal(app.resolveShortcut({ key: 'L', shiftKey: true }, {}), 'forward30');

  app.state.channelCount = 2;
  app.state.tiles[1].channel = 2;
  app.state.tiles[1].visible = true;
  app.state.tiles[0].mode = app.state.tiles[1].mode = 'paused';
  assert.equal(app.timelineLanes().length, 2);
  app.setTheater(true);
  assert.equal(app.state.theater, true);
  assert.equal(app.timelineLanes().length, 1);
  assert.equal(app.timelineLanes()[0].channel, 1);
  app.setTheater(false);
  assert.equal(app.state.theater, false);
  assert.equal(app.timelineLanes().length, 2);
});

test('startup wires every tile, the ping and the status refresh', async () => {
  const app = await browser();
  // Regression 0.2.8: an undefined handler aborted the script before wiring and startup.
  assert.ok(app.element('video').events.playing);
  assert.ok(app.element('video6').events.timeupdate);
  assert.ok(app.element('tileStream').events.change);
  assert.ok(app.element('btnExport').events.click);
  assert.match(app.element('netPing').textContent, /net\.ping/);
});

test('a running picture clears the timeout error and stale pipelines are closed', async () => {
  const app = await browser();
  const tile = app.state.tiles[0];
  app.element('video').events.timeupdate();
  assert.equal(tile.streamStatus, 'playing');
  assert.equal(app.element('videoMsg').classList.contains('hidden'), true);
});

test('an unplayable auto profile falls back to the camera default once', async () => {
  const app = await browser();
  const tile = app.state.tiles[0];
  app.state.streamProfiles = [{ name: 'big', parameters: 'resolution=3840x2160' }];
  app.state.layoutSize = 1;
  app.goLive();
  assert.ok(tile.pipeline.parameters.includes('streamprofile=big'));
  tile.pipeline.rtsp.onError(new Error('decode'));
  assert.equal(tile.autoFallback, true);
  assert.ok(!tile.pipeline.parameters.some((p) => p.startsWith('streamprofile=')));
  tile.pipeline.rtsp.onError(new Error('again'));
  assert.equal(tile.streamStatus, 'error');
});

test('export opens a frame of one minute around the playhead that can be resized and moved', async () => {
  const app = await browser();
  const T = fixtureTime + 120000;
  app.route(() => recordings(1, recording('clip', fixtureTime, fixtureTime + 600000)));
  await app.playAt(T);
  app.setView(fixtureTime - 3600000, fixtureTime + 3600000, { fetch: false });
  const button = app.element('btnExport');
  assert.equal(app.element('btnExportLabel').textContent, 'exp.mode');
  button.events.click();
  assert.equal(app.state.selectMode, true);
  assert.equal(app.state.selStart, T - 60000);
  assert.equal(app.state.selEnd, T + 60000);
  // The view zooms in so the frame edges can be grabbed.
  assert.deepEqual([app.state.viewStart, app.state.viewEnd], [T - 300000, T + 300000]);
  assert.equal(app.element('btnExportLabel').textContent, 'exp.saveSelection');
  assert.equal(button.disabled, false);
  // The duration appears once (in the bar), not again in the info line.
  assert.match(app.element('selRange').textContent, /2 min 00 s/);
  assert.equal(app.element('expInfo').textContent, '');

  const canvas = app.element('timeline');
  const x = (time) => ((time - app.state.viewStart) / (app.state.viewEnd - app.state.viewStart)) * 800;
  const px = (ms) => (ms / (app.state.viewEnd - app.state.viewStart)) * 800;
  const drag = (from, to) => {
    canvas.events.pointerdown({ isPrimary: true, button: 0, pointerId: 1, offsetX: from, offsetY: 40 });
    canvas.events.pointermove({ isPrimary: true, button: 0, pointerId: 1, offsetX: to, offsetY: 40 });
    canvas.events.pointerup({ isPrimary: true, button: 0, pointerId: 1, offsetX: to, offsetY: 40 });
  };
  drag(x(T + 60000), x(T + 60000) + px(30000));  // end edge: +30 s
  assert.equal(app.state.selEnd, T + 90000);
  drag(x(T - 60000), x(T - 60000) - px(10000));  // start edge: -10 s
  assert.equal(app.state.selStart, T - 70000);
  drag(x(T) + px(30000), x(T) + px(50000));      // body (away from the playhead): both +20 s
  assert.deepEqual([app.state.selStart, app.state.selEnd], [T - 50000, T + 110000]);

  // A click outside the frame seeks but keeps the frame.
  const click = { isPrimary: true, button: 0, pointerId: 2, offsetX: 700, offsetY: 40 };
  canvas.events.pointerdown(click);
  canvas.events.pointerup(click);
  assert.deepEqual([app.state.selStart, app.state.selEnd], [T - 50000, T + 110000]);

  button.events.click();
  await ticks();
  assert.match(app.downloads[0], /recordingid=clip/);

  app.element('btnClearSel').events.click();
  assert.equal(app.state.selectMode, false);
  assert.equal(app.state.selStart, null);
  assert.equal(app.element('btnExportLabel').textContent, 'exp.mode');
});

test('play/pause sits between two equal halves and held tiles without footage show no time', () => {
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  const css = readFileSync(require.resolve('../app/html/style.css'), 'utf8');
  const transport = html.slice(html.indexOf('class="transport"'), html.indexOf('class="controls-side end"'));
  assert.equal((transport.match(/class="transport-half/g) || []).length, 2);
  assert.ok(transport.indexOf('id="btnPause"') > transport.indexOf('transport-half start'));
  assert.ok(transport.indexOf('id="btnPause"') < transport.lastIndexOf('class="transport-half"'));
  assert.match(css, /\.transport\s*\{[^}]*grid-template-columns:\s*1fr auto 1fr/);
  assert.match(css, /\.video-wrap\.no-recording \.clock\s*\{\s*display:\s*none/);
  // The channel name is a tab outside the picture, not an overlay on it.
  assert.match(css, /\.video-wrap > \.tile-label\s*\{[^}]*position:\s*static/);
  assert.doesNotMatch(html, /jumpForm|jumpTime|btnClip/);
});

test('double-clicking a tile zooms to 1-up and back to the saved multi-view', async () => {
  const app = await browser();
  app.state.channelCount = 2;
  app.state.channels = [{ camera: 1 }, { camera: 2 }];
  app.state.sourceCatalog = ['1', '2'];
  app.state.tiles[1].channel = 2;
  app.state.tiles[1].visible = true;
  app.state.layout = '2';
  app.applyLayout();
  assert.equal(app.state.layoutSize, 2);

  app.element('tile1').events.dblclick({});
  assert.equal(app.state.layoutSize, 1);
  assert.equal(app.state.tiles[0].channel, 2);
  assert.equal(app.state.tiles[1].visible, false);
  assert.equal(app.state.active, 0);
  assert.ok(app.state.zoomReturn);

  app.element('tile0').events.dblclick({});
  assert.equal(app.state.layoutSize, 2);
  assert.equal(app.state.tiles[0].channel, 1);
  assert.equal(app.state.tiles[1].channel, 2);
  assert.equal(app.state.active, 1);
  assert.equal(app.state.zoomReturn, null);
});

test('the centered channel button keeps its position while pressed', () => {
  const css = readFileSync(require.resolve('../app/html/style.css'), 'utf8');
  assert.match(css, /\.tile-empty-cta:active\s*\{[^}]*translate\(-50%,\s*-50%\)/);
});

test('both duplicate channels dim and warn when there is no footage at the held time', async () => {
  const app = await browser();
  app.state.channelCount = 2;
  app.state.channels = [{ camera: 1 }, { camera: 2 }];
  app.state.tiles[1].channel = 2;
  app.state.tiles[1].visible = true;
  app.setView(fixtureTime - 60000, fixtureTime + 60000, { fetch: false });
  app.state.recordingsByChannel.set(1, { recs: [], unknown: [], complete: true });
  app.state.recordingsByChannel.set(2, { recs: [], unknown: [], complete: true });
  assert.equal(app.footageAt(1, fixtureTime), false);
  assert.equal(app.footageAt(1, fixtureTime - 120000), null); // outside loaded view

  app.route(() => recordings(0));
  await app.playAt(fixtureTime, { tile: app.state.tiles[0] });
  await app.playAt(fixtureTime, { tile: app.state.tiles[1] });
  for (const tile of [app.state.tiles[0], app.state.tiles[1]]) {
    assert.equal(tile.noRecording, true);
    assert.equal(tile.el.classList.contains('no-recording'), true);
    assert.equal(app.element(tile.id === 0 ? 'videoMsg' : `videoMsg${tile.id + 1}`).textContent, 'video.noRecording');
    assert.equal(app.element(tile.id === 0 ? 'videoMsg' : `videoMsg${tile.id + 1}`).classList.contains('hidden'), false);
  }
});

test('audio rejected by the camera falls back to a muted video stream', async () => {
  const app = await browser();
  const tile = app.state.tiles[0];
  app.element('tileAudio').events.click();
  assert.equal(tile.audio, true);
  assert.ok(tile.pipeline.parameters.includes('audio=1'));
  tile.pipeline.rtsp.onError(new Error('RTSP/1.0 400 Bad Request'));
  assert.equal(tile.audio, false);
  assert.equal(tile.audioFailed, true);
  assert.ok(tile.pipeline.parameters.includes('audio=0'));
  assert.match(app.element('toast').textContent, /tile\.audio\.failed/);
  assert.equal(app.rtspReason(new Error('RTSP/1.0 400 Bad Request\r\nCSeq: 2')), '400 Bad Request');
  assert.notEqual(tile.streamStatus, 'error');
});

test('the continuous recording controls are gone', async () => {
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  assert.equal(html.includes('recEnableRow'), false);
  assert.equal(html.includes('recDisableRow'), false);
  assert.equal(html.includes('Daueraufzeichnung'), false);
});

test('an ongoing recording remains open when it has no stop time', async () => {
  const app = await browser();
  const now = Date.now();
  const rows = app.parseRecordings(xml('recordings', {}, [recording('live', now - 3600000, null, { recordingstatus: 'recording' })]));
  assert.equal(rows[0].status, 'recording');
  assert.ok(app.recStop(rows[0]) >= now);
});

test('pausing keeps the frame and does not claim no recording when footage exists', async () => {
  const app = await browser();
  app.route(() => recordings(1, recording('live', Date.now() - 3600000, Date.now() + 3600000, { recordingstatus: 'recording' })));
  app.element('btnPause').events.click();
  const tile = app.state.tiles[0];
  const direct = await app.findRecordingAtOrAfter(tile.pausedAt, { channel: tile.channel });
  assert.ok(direct.rec, JSON.stringify({ direct, pausedAt: tile.pausedAt, now: Date.now(), channel: tile.channel }));
  await app.verifyPausedFootage(tile, tile.pausedAt);
  assert.equal(tile.mode, 'paused');
  assert.equal(tile.noRecording, false);
  assert.equal(tile.el.classList.contains('no-recording'), false);
  assert.doesNotMatch(app.element('videoMsg').textContent, /video\.noRecording/);
});

test('a late seek does not override returning to live', async () => {
  const app = await browser();
  const query = deferred();
  app.route(() => query.response);
  const seek = app.playAt(fixtureTime + 10000);
  assert.match(app.element('modeBadge').textContent, /seeking/);
  assert.equal(app.element('btnLive').disabled, false);
  app.goLive();
  query.resolve(recordings(1, recording('old')));
  await seek;
  assert.equal(app.state.mode, 'live');
  assert.match(app.state.pipeline.parameters[0], /^camera=/);
});

test('the newest seek wins and an old error changes neither stream nor message', async () => {
  const app = await browser();
  const first = deferred(), second = deferred();
  const queue = [first, second];
  app.route(() => queue.shift().response);
  const old = app.playAt(fixtureTime + 1000);
  const current = app.playAt(fixtureTime + 2000);
  second.resolve(recordings(1, recording('new')));
  await current;
  first.resolve(bad(500));
  await old;
  assert.equal(app.state.rec.id, 'new');
  assert.match(app.element('videoMsg').textContent, /video.connecting/);
});

test('automatic continuation respects a newer pause', async () => {
  const app = await browser();
  app.route(() => recordings(1, recording('first')));
  await app.playAt(fixtureTime + 20000);
  const query = deferred();
  app.route(() => query.response);
  const ending = app.onRecordingEnded();
  app.togglePause();
  query.resolve(recordings(1, recording('next', fixtureTime + 60000)));
  await ending;
  assert.equal(app.state.mode, 'paused');
  assert.equal(app.state.pipeline, null);
});

test('switching channels during a seek keeps the target time but rejects the old channel response', async () => {
  const app = await browser();
  app.state.channelCount = 2;
  app.state.sourceCatalog = ['1', '2'];
  const oldQuery = deferred(), newQuery = deferred();
  const queue = [oldQuery, newQuery];
  const time = fixtureTime + 15000;
  // Seeks use maxnumberofresults=200; timeline and status refreshes use a larger page.
  app.route((url) => url.searchParams.get('maxnumberofresults') === '200' ? queue.shift().response : recordings(0));
  const old = app.playAt(time);
  app.setChannel(2);
  newQuery.resolve(recordings(1, recording('channel2', fixtureTime, undefined, { source: '2' })));
  await tick();
  oldQuery.resolve(recordings(1, recording('channel1', fixtureTime, undefined, { source: '1' })));
  await old;
  assert.equal(app.state.rec.id, 'channel2');
  assert.equal(app.state.startWall, time);
});

test('pipeline state is isolated per tile and the accessors follow the active tile', async () => {
  const app = await browser();
  const first = app.activeTile();
  const second = app.state.tiles[1];
  second.channel = 2;
  second.visible = true;

  const closed = [];
  first.pipeline = { close: () => closed.push('first') };
  second.pipeline = { close: () => closed.push('second') };
  const firstGeneration = first.generation;
  const secondGeneration = second.generation;
  app.stopPipeline(second);
  assert.deepEqual(closed, ['second']);
  assert.equal(second.pipeline, null);
  assert.ok(first.pipeline);
  assert.equal(second.generation, secondGeneration + 1);
  assert.equal(first.generation, firstGeneration);

  first.mode = 'playback';
  second.mode = 'live';
  first.pendingSeek = 42;
  assert.equal(app.state.mode, 'playback');
  assert.equal(app.state.pendingSeek, 42);
  app.state.active = 1;
  assert.equal(app.state.mode, 'live');
  assert.equal(app.state.pendingSeek, null);
  assert.equal(app.state.channel, 2);
  app.state.pendingSeek = 43;
  assert.equal(second.pendingSeek, 43);
  assert.equal(first.pendingSeek, 42);
});

test('layout and stream defaults follow channel count and view mode', async () => {
  const app = await browser();
  assert.equal(app.autoLayoutSize(), 1);
  app.state.channels = [{ camera: 1 }, { camera: 2 }];
  assert.equal(app.autoLayoutSize(), 2);
  app.state.channels = [{ camera: 1 }, { camera: 2 }, { camera: 3 }];
  assert.equal(app.autoLayoutSize(), 4);
  app.state.channels = Array.from({ length: 6 }, (_, i) => ({ camera: i + 1 }));
  assert.equal(app.autoLayoutSize(), 6);

  app.state.streamProfiles = [
    { name: 'low', parameters: 'resolution=640x360&bitrate=200' },
    { name: 'high', parameters: 'resolution=1920x1080&bitrate=4000' },
    { name: 'mid', parameters: 'resolution=1280x720&bitrate=1000' },
    { name: 'unknown', parameters: 'fps=25' },
  ];
  assert.deepEqual(app.rankedProfiles().map((x) => x.profile.name), ['low', 'mid', 'high']);
  const tile = app.state.tiles[0];
  tile.profile = 'auto';
  app.state.layoutSize = 1;
  assert.equal(app.effectiveProfile(tile), 'high');
  app.state.layoutSize = 4;
  assert.equal(app.effectiveProfile(tile), 'low');
  tile.profile = 'mid';
  assert.equal(app.effectiveProfile(tile), 'mid');
});

test('a manual 4-tile layout keeps empty slots and allows a free channel choice', async () => {
  const app = await browser();
  app.state.channels = [{ camera: 1 }, { camera: 2 }, { camera: 3 }];
  app.state.layout = '4';
  app.applyLayout();
  assert.equal(app.state.layoutSize, 4);
  assert.equal(app.state.tiles[2].channel, 3);
  assert.equal(app.state.tiles[3].channel, null);
  assert.equal(app.state.tiles[3].visible, true);
  assert.equal(app.element('tile3').classList.contains('empty'), true);
  assert.equal(app.element('tileEmptyCta4').classList.contains('hidden'), false);
  assert.equal(app.element('tileChannel4').options[0].textContent, 'tile.empty');

  app.element('tileEmptyCta4').events.click();
  assert.equal(app.state.tiles[3].picker.classList.contains('hidden'), false);
  assert.ok(app.state.tiles[3].picker.options.length >= 2);
  app.state.tiles[3].picker.options[1].events.click();
  assert.equal(app.state.tiles[3].channel, 1);
  assert.equal(app.state.tiles[3].picker.classList.contains('hidden'), true);

  const select = app.element('tileChannel2');
  select.value = '3';
  select.events.change();
  assert.equal(app.state.tiles[1].channel, 3);
  assert.equal(app.state.tiles[1].channelTouched, true);
  assert.match(app.element('tileName2').textContent, /channel\.default/);
});

test('the layout selector switches 1/2/4/6 and keeps the first six channels', async () => {
  const app = await browser();
  app.state.channels = Array.from({ length: 6 }, (_, i) => ({ camera: i + 1 }));
  const select = app.element('layoutSelect');
  select.value = '1';
  select.events.change({ target: select });
  assert.equal(app.state.layoutSize, 1);
  assert.equal(app.state.tiles[1].visible, false);

  select.value = '6';
  select.events.change({ target: select });
  assert.equal(app.state.layoutSize, 6);
  assert.equal(app.state.tiles[5].visible, true);
  assert.equal(app.state.tiles[5].channel, 6);

  app.state.channels.push({ camera: 7 });
  select.value = 'auto';
  select.events.change({ target: select });
  assert.equal(app.state.layoutSize, 6);
  assert.equal(app.state.tiles[5].channel, 6);
});

test('each tile saves its own picture: live JPEG endpoint, playback and paused frames', async () => {
  const app = await browser();
  const camera = app.element('tileSnapshot');
  assert.match(app.element('modeBadge').textContent, /connecting/);
  assert.equal(camera.disabled, true, 'no picture yet');
  app.element('video').events.playing();
  assert.equal(app.element('modeBadge').textContent, 'badge.live');
  // The Live | Archive switch shows where we are.
  assert.equal(app.element('btnLive').classList.contains('active'), true);
  assert.equal(app.element('btnArchive').classList.contains('active'), false);
  assert.equal(camera.disabled, false);
  camera.events.click({ stopPropagation() {} });
  assert.match(app.downloads[0], /\/axis-cgi\/jpg\/image.cgi/);

  app.state.tiles[0].video.videoWidth = 640;
  app.state.tiles[0].video.videoHeight = 360;
  app.route(() => recordings(1, recording('clip')));
  await app.playAt(fixtureTime + 1000);
  app.element('video').events.playing();
  assert.equal(app.element('btnLive').classList.contains('active'), false);
  assert.equal(app.element('btnArchive').classList.contains('active'), true);
  assert.equal(camera.disabled, false);
  camera.events.click({ stopPropagation() {} });
  assert.equal(app.downloads.length, 2);
  assert.match(app.downloads[1], /^data:image\/jpeg/);

  const paused = app.element('btnPause');
  paused.events.click();
  assert.equal(camera.disabled, false);
  camera.events.click({ stopPropagation() {} });
  assert.equal(app.downloads.length, 3);
  assert.match(app.downloads[2], /^data:image\/jpeg/);
});

test('outside the export mode a drag in the timeline only pans', async () => {
  const app = await browser();
  app.element('btnPause').events.click();          // archive: the timeline unfolds
  app.setView(fixtureTime, fixtureTime + 60000, { fetch: false });
  const canvas = app.element('timeline');
  for (const offsetY of [5, 40]) {       // time ruler and lane
    const before = app.state.viewStart;
    canvas.events.pointerdown({ isPrimary: true, button: 0, pointerId: 1, offsetX: 100, offsetY, shiftKey: true });
    canvas.events.pointermove({ isPrimary: true, button: 0, pointerId: 1, offsetX: 320, offsetY, shiftKey: true });
    canvas.events.pointerup({ isPrimary: true, button: 0, pointerId: 1, offsetX: 320, offsetY, shiftKey: true });
    assert.equal(app.state.selStart, null);
    assert.ok(app.state.viewStart < before, 'the view moved instead');
  }
});

test('timeline messages sit in the timeline panel and vanish when empty', async () => {
  const app = await browser();
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  const status = app.element('timelineStatus');
  assert.ok(html.indexOf('id="timelineStatus"') > html.indexOf('class="timeline-panel"'));
  assert.equal(status.classList.contains('hidden'), false); // the startup fetch found no recordings
  app.state.viewStart = fixtureTime;
  app.state.viewEnd = fixtureTime + 60000;
  app.route(() => recordings(1, recording('clip', fixtureTime, fixtureTime + 60000)));
  await app.refreshRecordings();
  assert.equal(status.textContent, '');
  assert.equal(status.classList.contains('hidden'), true);
  app.route(() => recordings(0));
  await app.refreshRecordings();
  assert.equal(status.textContent, 'tl.empty');
  assert.equal(status.classList.contains('hidden'), false);
});

test('calendar views include a full 25-hour or 23-hour local day', async () => {
  const app = await browser();
  for (const [month, day, hours] of [[9, 25, 25], [2, 29, 23]]) {
    app.showDay(new Date(2026, month, day).getTime());
    assert.equal((app.state.viewEnd - app.state.viewStart) / 3600000, hours);
    assert.equal(new Date(app.state.viewEnd).getHours(), 0);
  }
});

test('a timeline export keeps the second occurrence of a repeated local time', async () => {
  const app = await browser();
  const second = Date.UTC(2026, 9, 25, 1, 30, 0, 123);
  app.state.selStart = second;
  app.state.selEnd = second + 30000;
  app.syncSelectionInputs();
  assert.match(app.element('expStart').value, /T02:30/);
  assert.equal(app.selectedExportRange()[0], second);
  assert.equal(app.selectedExportRange()[1], second + 30000);
});

test('a short page is complete even when the camera reports a misleading total', async () => {
  const app = await browser();
  // Regression: 0.2.0-0.2.2 discarded these rows and left the timeline empty.
  app.route(() => recordings(900, recording('visible')));
  const result = await app.listRecordings(fixtureTime, fixtureTime + 60000);
  assert.equal(result.recs.length, 1);
  assert.equal(result.complete, true);
  assert.equal(app.requests.length, 1);
});

test('pagination deduplicates the boundary and a stalled page keeps partial results', async () => {
  const app = await browser();
  const rows = Array.from({ length: 5000 }, (_, i) => recording(`part${i}`));
  app.route((url) => url.searchParams.has('startatresultnumber') ? recordings(5001, rows.at(-1), recording('last')) : recordings(5001, ...rows));
  const result = await app.listRecordings(fixtureTime, fixtureTime + 60000);
  assert.equal(result.recs.length, 5001);
  assert.equal(result.recs.at(-1).id, 'last');
  assert.equal(result.complete, true);
  assert.equal(app.requests.at(-1).searchParams.get('startatresultnumber'), '5000');
  // A camera that ignores the paging argument must not blank the timeline.
  app.route(() => recordings(6000, ...rows));
  const partial = await app.listRecordings(fixtureTime, fixtureTime + 60000);
  assert.equal(partial.recs.length, 5000);
  assert.equal(partial.complete, false);
});

test('numbered channels do not silently inherit Quad or ambiguous footage', async () => {
  const app = await browser();
  app.state.channelCount = 2;
  const rows = [{ source: '1' }, { source: 'Quad' }, { source: '' }];
  assert.equal(app.selectChannel(rows, 2).recs.length, 0);
  assert.equal(app.selectChannel(rows, 2).unknown.length, 2);
  app.state.sourceCatalog = ['0', '1', 'Quad'];
  assert.equal(app.selectChannel(rows, 2).recs[0], rows[0]);
  assert.equal(app.selectChannel(rows, 1).recs.length, 0);
  app.state.sourceCatalog = ['1', '2'];
  assert.equal(app.selectChannel(rows, 1).recs[0], rows[0]);
});

test('a sole catalog source belongs to the first enabled channel on a two-view camera', async () => {
  const app = await browser();
  app.state.channelCount = 2;
  app.state.sourceCatalog = ['1'];
  app.state.viewStart = fixtureTime - 60000;
  app.state.viewEnd = fixtureTime + 120000;
  const marker = fixtureTime + 10000;
  app.route(() => recordings(2,
    recording('continuous', fixtureTime, fixtureTime + 60000, { source: '1' }),
    recording('motion', marker, marker + 5000, { source: '1', recordingtype: 'triggered' }),
  ));
  await app.refreshRecordings();
  assert.equal(JSON.stringify(app.state.recordings.map((r) => [r.id, r.type])), '[["continuous","continuous"],["motion","triggered"]]');
  assert.equal(app.state.unassignedRecordings.length, 0);
  assert.equal(app.selectChannel([{ source: '1' }], 2).recs.length, 0);
  const zeroBased = [{ source: '0' }, { source: '1' }];
  const picked = app.selectChannel(zeroBased, 1).recs;
  assert.equal(picked.length, 1);
  assert.equal(picked[0], zeroBased[0]); // explicit numbering wins
});

test('an ambiguous lookup offers explicit playback and exports only the opened recording', async () => {
  const app = await browser();
  app.state.channelCount = 2;
  app.route(() => recordings(2,
    recording('ambiguous', fixtureTime, undefined, { source: '1' }),
    recording('missing', fixtureTime, undefined, { source: '' }),
  ));
  await app.playAt(fixtureTime + 10000);
  assert.equal(app.state.mode, 'paused');
  assert.equal(app.state.pipeline, null);
  const buttons = app.element('sourceChoiceList').options;
  assert.equal(buttons.length, 2);
  assert.match(buttons[0].textContent, /sourceChoice/);
  const second = buttons[1];
  buttons[0].events.click();
  assert.equal(app.state.pipeline.parameters[0], 'recordingid=ambiguous');
  assert.match(app.element('manualSourceInfo').textContent, /manualSource/);
  await app.doExport(fixtureTime, fixtureTime + 30000);
  assert.equal(app.messages.length, 0);
  assert.equal(app.downloads.length, 1);
  assert.match(app.downloads[0], /recordingid=ambiguous/);
  assert.doesNotMatch(app.downloads[0], /_ch1/);
  app.goLive();
  second.events.click();
  assert.equal(app.state.mode, 'live');
  assert.equal(app.state.manualRecording, null);
});

test('playback controls use inline icons and a 5 s step button', async () => {
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  const strings = readFileSync(require.resolve('../app/html/i18n.js'), 'utf8');
  assert.match(html, /id="btnBack5"/);
  assert.match(html, /<symbol id="ic-pause"/);
  assert.match(html, /id="pauseIcon"[^>]*href="#ic-pause"/);
  assert.doesNotMatch(html, /[⏪⏸⏩⏭📷]/u);
  assert.doesNotMatch(strings, /[⏪⏸⏩⏭📷]/u);
});

test('the 5 s step button seeks five seconds before the shown time', async () => {
  const app = await browser();
  app.route(() => recordings(1, recording('daily', fixtureTime, fixtureTime + 60000)));
  await app.playAt(fixtureTime + 20000);
  assert.equal(app.state.mode, 'playback');
  app.requests.length = 0;
  app.element('btnBack5').events.click();
  await tick();
  const starttime = new Date(fixtureTime + 15000).toISOString().replace('.000Z', 'Z');
  assert.ok(app.requests.some((u) => u.searchParams.get('starttime') === starttime),
    app.requests.map((u) => u.search).join('\n'));
});

test('the 5 s step from live view lands in playback instead of staying live', async () => {
  const app = await browser();
  app.route(() => recordings(1, recording('daily', Date.now() - 120000, Date.now() - 60000)));
  await app.playAt(Date.now());
  assert.equal(app.state.mode, 'live');
  app.requests.length = 0;
  app.element('btnBack5').events.click();
  await tick();
  assert.equal(app.state.mode, 'paused'); // no usable option => held, but not live
  assert.ok(app.requests.some((u) => u.pathname.endsWith('/record/list.cgi')));
  assert.ok(app.state.pendingSeek == null);
});

test('a channel range export still refuses ambiguous footage without an explicit selection', async () => {
  const app = await browser();
  app.state.channelCount = 2;
  app.route(() => recordings(1, recording('ambiguous', fixtureTime, undefined, { source: '1' })));
  await app.doExport(fixtureTime, fixtureTime + 30000);
  assert.match(app.element('expInfo').textContent, /err.source/);
  assert.equal(app.downloads.length, 0);
});

test('clip planning favors continuous recording, preserves sub-second footage and identifies gaps', async () => {
  const app = await browser();
  const parts = app.planExport([
    { id: 'event', type: 'triggered', start: 100, stop: 900 },
    { id: 'continuous', type: 'continuous', start: 250, stop: 500 },
  ], 0, 1000);
  assert.equal(JSON.stringify(parts.map(({ r, s, e }) => [r.id, s, e])), JSON.stringify([
    ['event', 100, 250], ['continuous', 250, 500], ['event', 500, 900],
  ]));
});

test('an export downloads immediately without a confirmation dialog', async () => {
  const app = await browser();
  app.route(() => recordings(1, recording('clip', fixtureTime + 1000, fixtureTime + 20000)));
  await app.doExport(fixtureTime, fixtureTime + 30000);
  assert.equal(app.messages.length, 0);
  assert.match(app.downloads[0], /recordingid=clip/);
  assert.match(app.element('expInfo').textContent, /exp\.gaps/);
});

test('the old quick clip button is gone', async () => {
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  assert.doesNotMatch(html, /btnQuickClip|exp\.quick/);
});

test('an export stops before review if the camera will not return all matching recordings', async () => {
  const app = await browser();
  // Full first page, more matches reported, but the camera ignores startatresultnumber.
  const rows = Array.from({ length: 5000 }, (_, i) => recording(`part${i}`, fixtureTime + i));
  app.route(() => recordings(6000, ...rows));
  await app.doExport(fixtureTime, fixtureTime + 30000);
  assert.match(app.element('expInfo').textContent, /err.incomplete/);
  assert.equal(app.messages.length, 0);
  assert.equal(app.downloads.length, 0);
});

test('a viewer can see active recording even without access to the disk list', async () => {
  const app = await browser();
  app.route((url) => {
    if (url.pathname.endsWith('/disks/list.cgi')) return bad(403);
    if (url.pathname.endsWith('/record/list.cgi')) return recordings(1, recording('active', Date.now() - 60000, null, { recordingstatus: 'recording' }));
  });
  await app.loadStorage();
  await app.refreshActiveRecording();
  assert.match(app.element('storageStatus').textContent, /storage.forbidden/);
  assert.equal(app.state.recordingNow.get(1), true);
});


// ---------------------------------------------------------------- Regressions (review 2026-11-27)

const ticks = async (n = 10) => { for (let i = 0; i < n; i++) await tick(); };
const localInput = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
function twoChannels(app) {
  app.state.channelCount = 2;
  app.state.channels = [{ camera: 1, name: 'K1' }, { camera: 2, name: 'K2' }];
  app.state.sourceCatalog = ['1', '2'];
}

test('the bandwidth adds up the per-track bitrates the stream library reports', async () => {
  const app = await browser();
  // media-stream-library: one value per track (video, audio).
  app.state.tiles[0].pipeline.bitrate = [2_000_000, 128_000];
  assert.equal(app.totalBitrate(), 2_128_000);
  app.updateBandwidth();
  assert.match(app.element('netRate').textContent, /2\.1 Mbit\/s/);
});

test('skipping forward in live view keeps the running streams', async () => {
  const app = await browser();
  const tile = app.state.tiles[0];
  const running = tile.pipeline;
  app.skipForwardAll(5000);
  assert.equal(tile.pipeline, running);
  assert.equal(tile.mode, 'live');
});

test('a layout change keeps a pause and the current layout does not reconnect', async () => {
  const app = await browser();
  twoChannels(app);
  app.setLayout('1');
  const live = app.state.tiles[0].pipeline;
  app.setLayout('1');
  assert.equal(app.state.tiles[0].pipeline, live, 'same layout must not reconnect');

  app.element('btnPause').events.click();
  const pausedAt = app.state.tiles[0].pausedAt;
  app.setLayout('2');
  for (const tile of app.state.tiles.slice(0, 2)) {
    assert.equal(tile.visible, true);
    assert.equal(tile.mode, 'paused');
    assert.equal(tile.pipeline, null);
    assert.equal(tile.pausedAt, pausedAt);
  }
});

test('zooming a paused tile keeps it paused', async () => {
  const app = await browser();
  twoChannels(app);
  app.setLayout('2');
  app.element('btnPause').events.click();
  app.element('tile1').events.dblclick({});
  assert.equal(app.state.tiles[0].channel, 2);
  assert.equal(app.state.tiles[0].mode, 'paused');
  assert.equal(app.state.tiles[0].pipeline, null);
  app.element('tile0').events.dblclick({});
  assert.equal(app.state.tiles[0].channel, 1);
  assert.ok(app.state.tiles.slice(0, 2).every((tile) => tile.mode === 'paused' && tile.pipeline == null));
});

test('ambiguous source choices belong to their tile', async () => {
  const app = await browser();
  twoChannels(app);
  app.state.tiles[1].channel = 2;
  app.state.tiles[1].visible = true;
  app.state.layoutSize = 2;
  app.route(() => recordings(1, recording('nosource', fixtureTime, undefined, { source: '' })));
  await app.playAt(fixtureTime + 10000, { tile: app.state.tiles[0] });
  await app.playAt(fixtureTime + 10000, { tile: app.state.tiles[1] });
  const list = app.element('sourceChoiceList').options;
  assert.equal(list.length, 1, 'only the active tile lists its choices');

  app.element('tile1').events.pointerdown();
  assert.equal(list.length, 1);
  assert.match(app.element('sourceChoiceHint').textContent, /^K2: /);
  list[0].events.click();
  assert.equal(app.state.tiles[1].pipeline.parameters[0], 'recordingid=nosource');
  assert.equal(app.state.tiles[0].pipeline, null, 'the other tile still waits for its own choice');
  assert.equal(app.element('sourceChoices').classList.contains('hidden'), true);
});

test('a deliberately emptied tile stays empty after a reload', async () => {
  const app = await browser({
    session: { layout: '2', channels: [1, null], active: 0 },
    route: (url) => (url.searchParams.get('group') === 'Properties.Image.NbrOfViews'
      ? 'root.Properties.Image.NbrOfViews=2' : undefined),
  });
  await ticks();
  assert.equal(app.state.tiles[1].visible, true);
  assert.equal(app.state.tiles[1].channel, null);
});

test('only an RTSP rejection disables audio, and only for this session', async () => {
  const app = await browser();
  const tile = app.state.tiles[0];
  app.element('tileAudio').events.click();
  assert.equal(app.local.get('minivms.audio.1'), '1');
  tile.pipeline.rtsp.onError(new Error('RTSP/1.0 415 Unsupported Media Type'));
  assert.equal(tile.audio, false);
  assert.equal(app.local.get('minivms.audio.1'), '1', 'the saved preference stays');

  const other = await browser();
  const second = other.state.tiles[0];
  other.element('tileAudio').events.click();
  other.win.mediaStreamLibrary.Html5VideoPipeline = class { constructor() { throw new Error('websocket'); } };
  other.goLive();
  assert.equal(second.audio, true, 'a connection failure is not an audio problem');
  assert.equal(second.streamStatus, 'error');
});

test('a recording without an audio track is requested without audio', async () => {
  const app = await browser();
  app.element('tileAudio').events.click();
  app.route(() => recordings(1, recording('silent')));
  await app.playAt(fixtureTime + 1000);
  assert.ok(app.state.pipeline.parameters.includes('audio=0'));
  app.route(() => recordings(1, recording('loud', fixtureTime, fixtureTime + 60000, {}, [xml('audio')])));
  await app.playAt(fixtureTime + 2000);
  assert.ok(app.state.pipeline.parameters.includes('audio=1'));
});

test('the export frame never reaches into the future', async () => {
  const app = await browser();
  const now = Date.now();
  app.setView(now - 300000, now + 100000, { fetch: false });
  app.element('btnExport').events.click();       // live: the frame ends at now
  assert.ok(app.state.selEnd <= Date.now());
  assert.ok(app.state.selEnd - app.state.selStart >= 59000);
  const canvas = app.element('timeline');
  const endX = ((app.state.selEnd - app.state.viewStart) / (app.state.viewEnd - app.state.viewStart)) * 800;
  canvas.events.pointerdown({ isPrimary: true, button: 0, pointerId: 1, offsetX: endX, offsetY: 40 });
  canvas.events.pointermove({ isPrimary: true, button: 0, pointerId: 1, offsetX: 790, offsetY: 40 });
  assert.ok(app.state.selEnd <= Date.now());
});

test('the production script has no debug logging', () => {
  const js = readFileSync(require.resolve('../app/html/app.js'), 'utf8');
  assert.doesNotMatch(js, /console\.log\(/);
});

test('light and dark mode follow the saved choice and refresh the timeline colors', async () => {
  const app = await browser();
  const root = app.win.document.documentElement;
  assert.equal(root.dataset.theme, 'dark'); // no system preference reported -> dark
  app.setTheme('light');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(app.local.get('minivms.theme'), 'light');
  app.setTheme('dark');
  assert.equal(root.dataset.theme, 'dark');
  app.setTheme('nonsense');
  assert.equal(app.local.get('minivms.theme'), 'system');

  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  const css = readFileSync(require.resolve('../app/html/style.css'), 'utf8');
  // The theme is set before the first paint, and both palettes define the canvas colors.
  assert.ok(html.indexOf("localStorage.getItem('minivms.theme')") < html.indexOf('style.css'));
  for (const theme of ['dark', 'light']) {
    const block = css.match(new RegExp(`:root\\[data-theme="${theme}"\\][^{]*\\{([^}]*)\\}`))[1];
    for (const token of ['--bg', '--text', '--muted', '--accent', '--tl-bg', '--tl-future', '--tl-playhead', '--sel', '--tl-night-rgb', '--tl-night-alpha', '--tl-day-rgb', '--tl-day-alpha']) {
      assert.match(block, new RegExp(`${token}:`), `${theme} ${token}`);
    }
  }
});

test('one text size: the stylesheet sets no other font size than the shared token', () => {
  const css = readFileSync(require.resolve('../app/html/style.css'), 'utf8');
  const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
  // The only exception is the step number drawn inside the skip icons.
  assert.deepEqual([...new Set(sizes)].sort(), ['11px', 'var(--fs)']);
  assert.match(css, /--fs:\s*15px/);
});

test('further export parts are offered as visible links in the export bar', async () => {
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  const links = html.match(/<ul id="expLinks"[^>]*>/)[0];
  assert.doesNotMatch(links, /hidden/);
  assert.ok(html.indexOf('id="expLinks"') > html.indexOf('id="selectionBar"'));
  assert.ok(html.indexOf('id="expLinks"') < html.indexOf('id="inspector"'));
});

test('a click into a gap moves the shared clock to the earliest footage of any tile', async () => {
  const app = await browser();
  twoChannels(app);
  const [overview, landscape] = app.state.tiles;
  landscape.channel = 2;
  landscape.visible = true;
  app.state.layoutSize = 2;
  const T = fixtureTime;
  // Overview records later than Landscape; the click lands before both.
  app.route(() => recordings(2,
    recording('later', T + 120000, T + 180000, { source: '1' }),
    recording('earlier', T + 60000, T + 90000, { source: '2' }),
  ));
  app.setView(T - 60000, T + 240000, { fetch: false });
  const canvas = app.element('timeline');
  const click = { isPrimary: true, button: 0, pointerId: 1, offsetX: 160, offsetY: 40 };
  canvas.events.pointerdown(click);
  canvas.events.pointerup(click);
  await ticks();

  assert.equal(landscape.pipeline.parameters[0], 'recordingid=earlier');
  assert.equal(landscape.startWall, T + 60000);
  assert.equal(overview.mode, 'paused', 'the overview must not run ahead to its own recording');
  assert.equal(overview.pausedAt, T + 60000);
  assert.equal(overview.noRecording, true);
  assert.equal(overview.waitingFor.id, 'later');

  // The shared clock is still before the overview footage: it keeps waiting.
  landscape.streamStatus = 'playing';
  landscape.startWall = T + 80000;
  app.followSharedClock();
  assert.equal(overview.mode, 'paused');

  // Pausing now holds the waiting tile at the shared time, and resuming keeps them together.
  app.element('btnPause').events.click();
  assert.equal(overview.pausedAt, T + 80000);
  assert.equal(overview.waitingFor, null);
  app.element('btnPause').events.click();
  await ticks();
  assert.equal(landscape.pipeline.parameters[0], 'recordingid=earlier');
  assert.equal(landscape.startWall, T + 80000);
  assert.equal(overview.waitingFor.id, 'later');

  // Once the clock reaches the overview recording, the overview starts by itself.
  landscape.streamStatus = 'playing';
  landscape.startWall = T + 125000;
  app.followSharedClock();
  assert.equal(overview.mode, 'playback');
  assert.equal(overview.pipeline.parameters[0], 'recordingid=later');
  assert.equal(overview.startWall, T + 125000);
});

test('a long export range shows a warning in the export bar', async () => {
  const app = await browser();
  twoChannels(app);
  app.state.tiles[1].channel = 2;
  app.state.tiles[1].visible = true;
  app.state.selStart = fixtureTime;
  app.state.selEnd = fixtureTime + 20 * 60000;    // 20 min x 2 channels: fine
  app.syncSelectionInputs();
  assert.equal(app.element('selWarn').classList.contains('hidden'), true);
  app.state.selEnd = fixtureTime + 40 * 60000;    // 40 min x 2 channels = 80 min
  app.syncSelectionInputs();
  assert.equal(app.element('selWarn').classList.contains('hidden'), false);
  assert.match(app.element('selWarn').textContent, /exp\.long/);
});

test('a seek into a gap jumps silently to the next recording', async () => {
  const app = await browser();
  app.route(() => recordings(1, recording('next', fixtureTime + 60000, fixtureTime + 120000)));
  await app.playAt(fixtureTime);
  assert.equal(app.state.startWall, fixtureTime + 60000);
  assert.doesNotMatch(app.element('toast').textContent, /jumpTo/);
});

test('the timeline folds to one strip in live view and unfolds for archive and export', async () => {
  const app = await browser();
  twoChannels(app);
  const [first, second] = app.state.tiles;
  second.channel = 2;
  second.visible = true;
  app.goLive(true, second);
  app.state.recordingsByChannel.set(1, { recs: [{ id: 'a', type: 'continuous', start: 1, stop: 2 }], unknown: [], complete: true });
  app.state.recordingsByChannel.set(2, { recs: [{ id: 'b', type: 'triggered', start: 1, stop: 2 }], unknown: [], complete: true });
  // Live: one merged lane with every channel's footage, slimmer than a normal lane.
  let lanes = app.timelineLanes();
  assert.equal(lanes.length, 1);
  assert.equal(JSON.stringify(lanes[0].recs.map((r) => r.id)), '["a","b"]');
  assert.ok(app.laneGeometry(0).height < 36);

  app.element('btnPause').events.click();        // archive
  lanes = app.timelineLanes();
  assert.equal(JSON.stringify(lanes.map((lane) => lane.channel)), '[1,2]');
  assert.equal(app.laneGeometry(0).height, 36);

  app.goLive(true, first);
  app.goLive(true, second);
  assert.equal(app.timelineLanes().length, 1);
  app.element('btnExport').events.click();       // export always shows the lanes
  assert.equal(app.timelineLanes().length, 2);
});

test('the tile tab shows a state dot, the channel name and the time; no big live badge', async () => {
  const app = await browser();
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  const css = readFileSync(require.resolve('../app/html/style.css'), 'utf8');
  const tab = html.match(/<div id="tileLabel"[^>]*>(.*?)<\/div>/)[1];
  assert.match(tab, /class="tile-dot"/);
  assert.match(tab, /id="tileName"/);
  assert.match(tab, /id="clock"/);
  assert.match(css, /\.badge\s*\{[^}]*clip: rect\(0, 0, 0, 0\)/, 'badge only for screen readers');

  const tile = app.state.tiles[0];
  app.element('video').events.playing();
  assert.equal(tile.el.getAttribute?.('data-state') ?? 'live', 'live');
  assert.equal(tile.el.classList.contains('recording'), false);

  // The camera records channel 1 right now: the live dot turns red.
  app.route(() => recordings(1, recording('now', Date.now() - 60000, null, { recordingstatus: 'recording' })));
  await app.refreshActiveRecording();
  assert.equal(app.state.recordingNow.get(1), true);
  assert.equal(tile.el.classList.contains('recording'), true);
  // Playback is never "recording".
  app.route(() => recordings(1, recording('clip')));
  await app.playAt(fixtureTime + 1000);
  app.element('video').events.playing();
  assert.equal(tile.el.classList.contains('recording'), false);
});

test('the device section lists model, serial, firmware and the IPv4/IPv6 addresses', async () => {
  const app = await browser();
  const info = JSON.stringify({ data: { propertyList: {
    ProdFullName: 'AXIS M4317-PLVE Panoramic Camera', ProdShortName: 'AXIS M4317-PLVE', SerialNumber: 'B8A44F000001', Version: '12.6.85',
  } } });
  const network = JSON.stringify({ data: {
    system: { hostname: { hostname: 'axis-b8a44f000001' } },
    devices: [{ IPv4: { addresses: [{ address: '192.168.1.20' }] }, IPv6: { addresses: [{ address: 'fe80::1' }, { address: '2001:db8::20' }] } }],
  } });
  app.route((url) => {
    if (url.pathname.endsWith('/basicdeviceinfo.cgi')) return info;
    if (url.pathname.endsWith('/network_settings.cgi')) return network;
  });
  await app.loadDeviceInfo();
  const pairs = (rows) => Object.fromEntries(rows.reduce((acc, el, i) => (i % 2 ? acc : [...acc, [el.textContent, rows[i + 1].textContent]]), []));
  const shown = pairs(app.element('deviceInfo').options);
  assert.equal(shown['device.model'], 'AXIS M4317-PLVE Panoramic Camera');
  assert.equal(shown['device.serial'], 'B8A44F000001');
  assert.equal(shown['device.firmware'], '12.6.85');
  assert.equal(shown['device.hostname'], 'axis-b8a44f000001');
  assert.equal(shown['device.ipv4'], '192.168.1.20');
  assert.equal(shown['device.ipv6'], 'fe80::1\n2001:db8::20');
  assert.equal(app.element('deviceName').textContent, 'AXIS M4317-PLVE · B8A44F000001');

  // Without rights for the network API the Network parameters still help.
  app.route((url) => {
    if (url.pathname.endsWith('/network_settings.cgi')) return bad(403);
    if (url.searchParams.get('group') === 'Network') {
      return 'root.Network.eth0.IPAddress=10.0.0.5\nroot.Network.eth0.IPv6.IPAddresses=2001:db8::5\nroot.Network.HostName=cam';
    }
  });
  await app.loadDeviceInfo();
  const fallback = pairs(app.element('deviceInfo').options);
  assert.equal(fallback['device.ipv4'], '10.0.0.5');
  assert.equal(fallback['device.ipv6'], '2001:db8::5');
  assert.equal(fallback['device.hostname'], 'cam');
});

test('the tile clock says today or yesterday instead of the date', async () => {
  const app = await browser();
  const now = new Date();
  now.setHours(12, 24, 42, 0);
  const today = now.getTime();
  assert.equal(app.fmtDayTime(today), 'day.today 12:24:42');
  assert.equal(app.fmtDayTime(today - 24 * 3600000), 'day.yesterday 12:24:42');
  assert.match(app.fmtDayTime(today - 3 * 24 * 3600000), /^\d\d\.\d\d\.\d{4} 12:24:42$/);
});

test('the timeline background is darkest at night and lightest in the afternoon', async () => {
  const app = await browser();
  const at = (h) => new Date(2026, 10, 27, h).getTime();
  assert.ok(Math.abs(app.nightness(at(2)) - 1) < 1e-9);
  assert.ok(Math.abs(app.nightness(at(14))) < 1e-9);
  assert.ok(app.nightness(at(22)) > app.nightness(at(18)));
  assert.ok(app.nightness(at(6)) > app.nightness(at(10)));
  // Blue at night, yellow by day, neutral at dawn and dusk (no mix of both).
  assert.equal(app.daylightTint(at(2)).rgb, '0, 0, 0');
  assert.equal(app.daylightTint(at(14)).rgb, '255, 200, 60');
  assert.ok(Math.abs(app.daylightTint(at(2)).alpha - 0.35) < 1e-9);
  assert.ok(app.daylightTint(at(8)).alpha < 1e-9 && app.daylightTint(at(20)).alpha < 1e-9);
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  assert.doesNotMatch(html, /statusChip|recordingIndicator/, 'no redundant recording chip in the top bar');
});

test('dragging the playhead scrubs and seeks once on release', async () => {
  const app = await browser();
  const T = fixtureTime + 120000;
  app.route(() => recordings(1, recording('clip', fixtureTime, fixtureTime + 600000)));
  await app.playAt(T);
  app.setView(fixtureTime, fixtureTime + 400000, { fetch: false });   // 500 ms per pixel
  const canvas = app.element('timeline');
  const xT = (T - fixtureTime) / 500;
  app.requests.length = 0;
  canvas.events.pointerdown({ isPrimary: true, button: 0, pointerId: 1, offsetX: xT, offsetY: 40 });
  canvas.events.pointermove({ isPrimary: true, button: 0, pointerId: 1, offsetX: xT + 120, offsetY: 40 });
  assert.equal(app.state.scrubTime, T + 60000);
  assert.deepEqual([app.state.viewStart, app.state.viewEnd], [fixtureTime, fixtureTime + 400000], 'no panning');
  assert.equal(app.requests.length, 0, 'no lookup while dragging');
  canvas.events.pointerup({ isPrimary: true, button: 0, pointerId: 1, offsetX: xT + 120, offsetY: 40 });
  await ticks();
  assert.equal(app.state.scrubTime, null);
  assert.equal(app.state.startWall, T + 60000);
});

test('the live strip stays on today and the archive switch leaves live', async () => {
  const app = await browser();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // The app opens on today.
  assert.equal(app.state.viewStart, today.getTime());
  const canvas = app.element('timeline');
  canvas.events.pointerdown({ isPrimary: true, button: 0, pointerId: 1, offsetX: 100, offsetY: 40 });
  canvas.events.pointermove({ isPrimary: true, button: 0, pointerId: 1, offsetX: 300, offsetY: 40 });
  canvas.events.pointerup({ isPrimary: true, button: 0, pointerId: 1, offsetX: 300, offsetY: 40 });
  assert.equal(app.state.viewStart, today.getTime(), 'live view is not panned');

  app.route(() => recordings(1, recording('recent', Date.now() - 3600000, Date.now() - 1000)));
  app.element('btnArchive').events.click();
  await ticks();
  assert.equal(app.state.mode, 'playback');
  assert.ok(Math.abs(app.state.startWall - (Date.now() - 60000)) < 5000);
  app.element('btnLive').events.click();
  assert.equal(app.state.mode, 'live');
});

test('the connection graphs cover three minutes and leave a gap for a failed ping', async () => {
  const app = await browser();
  const now = 1_000_000_000;
  const samples = [
    { t: now - 4 * 60000, v: 99 },       // outside the window: clipped left of 0
    { t: now - 90000, v: 10 }, { t: now - 60000, v: 20 },
    { t: now - 30000, v: null },
    { t: now, v: 40 },
  ];
  const { line, area } = app.sparkPath(samples, now, 300, 48, 20);
  assert.equal((line.match(/M/g) || []).length, 2, 'the failed ping splits the line');
  assert.match(line, /M150\.0,/, 'a sample 90 s ago sits in the middle');
  assert.match(line, /L300\.0,/, 'now is the right edge');
  assert.ok(area.endsWith('Z'));
  const empty = app.sparkPath([], now, 300, 48, 20);
  assert.equal(empty.line + empty.area, '');
});

test('playback asks the camera for the absolute start time, not a clip offset', async () => {
  const app = await browser();
  const sent = [];
  app.win.mediaStreamLibrary.Html5VideoPipeline = class {
    constructor(opts) {
      this.parameters = opts.rtsp.parameters;
      this.rtsp = { play() {}, _enqueue: (command) => sent.push(command) };
      this.ready = Promise.resolve();
    }
    close() {}
  };
  const start = Date.UTC(2026, 10, 27, 9, 0, 0);
  app.route(() => recordings(1, recording('long', start, start + 3600000)));
  await app.playAt(start + 20 * 60000 + 250);
  // The library would send npt=<offset>; the camera gets the wall time instead.
  app.state.pipeline.rtsp._enqueue({ method: 'PLAY', headers: { Range: 'npt=1200.25-' } });
  app.state.pipeline.rtsp._enqueue({ method: 'DESCRIBE' });
  assert.equal(sent[0].headers.Range, 'clock=20261127T092000.250Z-');
  assert.equal(sent[1].method, 'DESCRIBE');
});

test('the clock follows the stream time even if a camera starts at the clip start', async () => {
  const app = await browser();
  const start = fixtureTime;
  app.route(() => recordings(1, recording('long', start, start + 3600000)));
  await app.playAt(start + 20 * 60000);
  const tile = app.state.tiles[0];
  // The camera ignored the seek: the first frame is the beginning of the clip.
  tile.pipeline.onSync(start);
  tile.video.currentTime = 30;
  assert.equal(app.state.tiles[0].syncWall, start);
  assert.equal(app.state.rec.id, 'long');
  // The export frame centers on the playhead time: the true stream time.
  app.element('btnExport').events.click();
  assert.equal(app.state.selStart, start + 30000 - 60000);
});

test('the Live switch turns on when the last tile to go live is not the active one', async () => {
  const app = await browser();
  twoChannels(app);
  app.state.tiles[1].channel = 2;
  app.state.tiles[1].visible = true;
  for (const tile of app.state.tiles.slice(0, 2)) { tile.mode = 'playback'; tile.streamStatus = 'connecting'; }
  app.updateModeUi();
  assert.equal(app.element('btnArchive').classList.contains('active'), true);
  // No stream reaches "playing" (as on a phone without picture): the switch alone must follow.
  app.element('btnLive').events.click();
  await tick();
  assert.equal(app.element('btnLive').classList.contains('active'), true);
  assert.equal(app.element('btnArchive').classList.contains('active'), false);
});

test('iPhone: ManagedMediaSource stands in for MediaSource and AirPlay is off on the video', async () => {
  class ManagedMediaSource {}
  const app = await browser({ mediaSource: null, managedMediaSource: ManagedMediaSource });
  app.goLive(true, app.state.tiles[0]);
  assert.equal(app.win.MediaSource, ManagedMediaSource);
  assert.equal(app.state.tiles[0].video.disableRemotePlayback, true);
  assert.ok(app.state.tiles[0].pipeline);
});

test('a browser without any MediaSource gets a clear message instead of a timeout', async () => {
  const app = await browser({ mediaSource: null });
  app.goLive(true, app.state.tiles[0]);
  assert.equal(app.state.tiles[0].streamStatus, 'error');
  assert.equal(app.state.tiles[0].pipeline, null);
});

test('an aborted early play() (Safari) is retried when the video can play, not reported', async () => {
  const app = await browser();
  const tile = app.state.tiles[0];
  let calls = 0;
  tile.video.play = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  };
  app.goLive(true, tile);
  await tick(); await tick();
  assert.notEqual(tile.streamStatus, 'error');
  assert.equal(calls, 1);
  tile.video.events.canplay();
  await tick();
  assert.equal(calls, 2);
});
