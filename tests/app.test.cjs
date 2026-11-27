const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

process.env.TZ = 'Europe/Berlin';

// Run the production browser script with a minimal DOM and mocked VAPIX/video.
const source = readFileSync(require.resolve('../app/html/app.js'), 'utf8').replace(/\}\)\(\);\s*$/, `
  window.testApp = { state, listRecordings, selectChannel, planExport, playAt, goLive, togglePause,
    onRecordingEnded, showDay, setChannel, syncSelectionInputs, selectedExportRange, loadStorage,
    loadRecordingConfig, refreshActiveRecording, enableContinuous, disableContinuous, doExport, loadChannels,
    refreshRecordings, laneGeometry, timelineLanes, timelineChannels, exportChecked,
    setView, draw, createTile, activeTile, stopPipeline,
    autoLayoutSize, rankedProfiles, effectiveProfile, applyLayout,
    formatBitrate, totalBitrate, updateBandwidth, updatePing, resolveShortcut, setTheater };
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

async function browser() {
  const nodes = new Map(), requests = [], messages = [], downloads = [];
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
  let handler = defaults;
  const context = {
    document: doc, Date, URLSearchParams, AbortController, AbortSignal,
    DOMParser: class { parseFromString(data) { return data; } }, CustomEvent: class {},
    fetch: async (href, opts) => {
      const url = new URL(href, 'https://camera.invalid');
      requests.push(url);
      const body = await handler(url, opts);
      return body?.ok === false ? body : { ok: true, text: async () => body, json: async () => ({}) };
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
  return { ...context.testApp, element, requests, messages, downloads, rectangles,
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
  assert.match(app.element('tileLabel').textContent, /channel\.default/);
  assert.equal(app.element('tileLabel2').textContent, 'Eingang');
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

test('the selection bar offers channel chips and starts with all channels on', async () => {
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
  app.setView(fixtureTime, fixtureTime + 60000, { fetch: false });
  await app.refreshRecordings();
  app.state.selStart = fixtureTime;
  app.state.selEnd = fixtureTime + 30000;
  app.syncSelectionInputs();
  assert.equal(app.element('selectionBar').classList.contains('hidden'), false);
  assert.equal(app.state.selectionChips.length, 2);
  assert.equal(app.exportChecked(1), true);
  assert.equal(app.exportChecked(2), true);
  assert.equal(app.element('btnExport').disabled, false);

  app.state.selectionChips[0].button.events.click();
  assert.equal(app.exportChecked(1), false);
  assert.equal(app.element('btnExport').disabled, false);

  app.element('btnClearSel').events.click();
  assert.equal(app.element('selectionBar').classList.contains('hidden'), true);
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

test('the tools sidebar is the only status surface and opens from the topbar', async () => {
  const app = await browser();
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  assert.ok(html.includes('id="layoutSeg"'));
  assert.ok(html.includes('id="btnInspector"'));
  assert.equal(html.includes('id="appMenu"'), false);
  assert.equal(app.element('inspector').classList.contains('open'), true); // default open
  assert.ok(html.indexOf('id="netStatus"') > html.indexOf('id="inspector"'));
  assert.ok(html.indexOf('id="netStatus"') < html.indexOf('id="storageStatus"'));
  app.element('btnInspectorClose').events.click();
  assert.equal(app.element('inspector').classList.contains('open'), false);
  app.element('btnInspector').events.click();
  assert.equal(app.element('inspector').classList.contains('open'), true);
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
  assert.equal(app.resolveShortcut({ key: 'e' }, { selection: false }), 'clip');
  assert.equal(app.resolveShortcut({ key: 'e' }, { selection: true, exporting: true }), null);
  assert.equal(app.resolveShortcut({ key: 'e' }, { selection: true }), 'export');
  assert.equal(app.resolveShortcut({ key: '?' , shiftKey: true }, {}), 'help');
  assert.equal(app.resolveShortcut({ key: '1' }, { typing: true }), null);
  assert.equal(app.resolveShortcut({ key: 'f' }, {}), 'theater');

  app.state.channelCount = 2;
  app.state.tiles[1].channel = 2;
  app.state.tiles[1].visible = true;
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
  assert.ok(app.element('btnClip').events.click);
  assert.match(app.element('netPing').textContent, /net\.ping/);
  assert.doesNotMatch(app.element('recordingIndicator').textContent, /rec\.loading/);
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

test('the clip button selects the last minute and opens the export bar', async () => {
  const app = await browser();
  app.element('btnClip').events.click();
  assert.ok(app.state.selEnd - app.state.selStart === 60000);
  assert.equal(app.element('selectionBar').classList.contains('hidden'), false);
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
  assert.match(app.element('tileLabel2').textContent, /channel\.default/);
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

test('snapshot uses the live JPEG endpoint and playback frames without a live JPEG', async () => {
  const app = await browser();
  assert.match(app.element('modeBadge').textContent, /connecting/);
  app.element('video').events.playing();
  assert.equal(app.element('modeBadge').textContent, 'badge.live');
  // While live video plays there is nothing for the live button to do.
  assert.equal(app.element('btnLive').classList.contains('hidden'), true);
  assert.equal(app.element('liveSep').classList.contains('hidden'), true);
  app.element('btnSnapshot').events.click();
  assert.match(app.downloads[0], /\/axis-cgi\/jpg\/image.cgi/);

  app.state.tiles[0].video.videoWidth = 640;
  app.state.tiles[0].video.videoHeight = 360;
  app.route(() => recordings(1, recording('clip')));
  await app.playAt(fixtureTime + 1000);
  app.element('video').events.playing();
  assert.equal(app.element('btnLive').classList.contains('hidden'), false);
  assert.equal(app.element('btnSnapshot').disabled, false);
  app.element('btnSnapshot').events.click();
  assert.equal(app.downloads.length, 2);
  assert.match(app.downloads[1], /^data:image\/jpeg/);

  const paused = app.element('btnPause');
  paused.events.click();
  assert.equal(app.element('btnSnapshot').disabled, false);
  app.element('btnSnapshot').events.click();
  assert.equal(app.downloads.length, 3);
  assert.match(app.downloads[2], /^data:image\/jpeg/);
});

test('dragging the time ruler creates an export range and a click clears it', async () => {
  const app = await browser();
  app.setView(fixtureTime, fixtureTime + 60000, { fetch: false });
  const canvas = app.element('timeline');
  const down = { isPrimary: true, button: 0, pointerId: 1, offsetX: 100, offsetY: 5 };
  const move = { isPrimary: true, button: 0, pointerId: 1, offsetX: 320, offsetY: 5 };
  canvas.events.pointerdown(down);
  canvas.events.pointermove(move);
  canvas.events.pointerup(move);
  assert.ok(app.state.selStart != null);
  assert.ok(app.state.selEnd > app.state.selStart);

  const click = { isPrimary: true, button: 0, pointerId: 2, offsetX: 200, offsetY: 32 };
  canvas.events.pointerdown(click);
  canvas.events.pointerup(click);
  assert.equal(app.state.selStart, null);
  assert.equal(app.state.selEnd, null);
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

test('a configuration is not an active recording and locked SD cards are not eligible', async () => {
  const app = await browser();
  app.route((url) => {
    if (url.pathname.endsWith('/disks/list.cgi')) return listDisks(xml('disk', { diskid: 'SD_DISK', status: 'OK', locked: 'yes' }));
    if (url.pathname.endsWith('/listconfiguration.cgi')) return listConfigs(xml('continuousrecordingconfiguration', { diskid: 'SD_DISK' }));
    return recordings(0);
  });
  await app.loadRecordingConfig();
  assert.match(app.element('recordingIndicator').textContent, /rec.configured/);
  await app.loadStorage();
  assert.match(app.element('recordingIndicator').textContent, /rec.sdNotWritable/);
  assert.equal(app.element('recDisk').options.length, 0);
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
  assert.match(app.element('recordingIndicator').textContent, /rec.activeDisk/);
});

test('continuous recording can be stopped and only the channel profile is removed', async () => {
  const app = await browser();
  app.state.channelCount = 2;
  app.state.channel = 1;
  let configs = [
    xml('continuousrecordingconfiguration', { profile: '1', diskid: 'SD_DISK', options: 'camera=1' }),
    xml('continuousrecordingconfiguration', { profile: '2', diskid: 'SD_DISK', options: 'camera=2' }),
  ];
  const removed = [];
  app.route((url) => {
    if (url.pathname.endsWith('/listconfiguration.cgi')) return listConfigs(...configs);
    if (url.pathname.endsWith('/disks/list.cgi')) return listDisks(xml('disk', { diskid: 'SD_DISK', status: 'OK' }));
    if (url.pathname.endsWith('/removeconfiguration.cgi')) {
      const profile = url.searchParams.get('profile');
      removed.push(profile);
      configs = configs.filter((c) => c.getAttribute('profile') !== profile);
      return xml('root', {}, [xml('remove', { profile, result: 'OK' })]);
    }
    return recordings(0);
  });
  await app.loadStorage();
  await app.loadRecordingConfig();
  await app.refreshActiveRecording();
  assert.equal(app.element('recDisableRow').classList.contains('hidden'), false);
  await app.disableContinuous();
  assert.deepEqual(removed, ['1']);
  assert.match(app.messages[0], /rec\.disable\.confirm/);
  assert.match(app.element('toast').textContent, /rec\.disabled/);
  assert.equal(app.element('recDisableRow').classList.contains('hidden'), true);
  await app.refreshActiveRecording();
  assert.equal(app.element('recEnableRow').classList.contains('hidden'), false);
});

test('continuous recording can be configured with AAC audio', async () => {
  const app = await browser();
  let options = '';
  app.route((url) => {
    if (url.pathname.endsWith('/disks/list.cgi')) return listDisks(xml('disk', { diskid: 'SD_DISK', status: 'OK' }));
    if (url.pathname.endsWith('/addconfiguration.cgi')) {
      options = url.searchParams.get('options');
      return xml('root', {}, [xml('configure', { result: 'OK', profile: '1' })]);
    }
  });
  await app.loadStorage();
  app.element('recAudio').checked = true;
  await app.enableContinuous();
  assert.match(options, /videocodec=h264/);
  assert.match(options, /audio=1/);
  assert.match(options, /audiocodec=aac/);
});

test('stopping continuous recording does nothing when the confirmation is declined', async () => {
  const app = await browser();
  app.options({ confirm: false });
  const removed = [];
  app.route((url) => {
    if (url.pathname.endsWith('/listconfiguration.cgi')) return listConfigs(xml('continuousrecordingconfiguration', { profile: '1', diskid: 'SD_DISK' }));
    if (url.pathname.endsWith('/removeconfiguration.cgi')) { removed.push(url.searchParams.get('profile')); return ''; }
    return recordings(0);
  });
  await app.loadRecordingConfig();
  await app.disableContinuous();
  assert.equal(removed.length, 0);
  assert.equal(app.element('toast').textContent, '');
});

test('a viewer cannot stop continuous recording', async () => {
  const app = await browser();
  app.route((url) => {
    if (url.pathname.endsWith('/listconfiguration.cgi')) return listConfigs(xml('continuousrecordingconfiguration', { profile: '1', diskid: 'SD_DISK' }));
    if (url.pathname.endsWith('/removeconfiguration.cgi')) return bad(403);
    return recordings(0);
  });
  await app.loadRecordingConfig();
  await app.disableContinuous();
  assert.match(app.element('toast').textContent, /rec\.disableFailed/);
  assert.match(app.element('recStatus').textContent, /rec\.needsRights/);
});

test('continuous setup sends only one request while a first click is pending', async () => {
  const app = await browser();
  const adding = deferred();
  let count = 0;
  app.route((url) => {
    if (url.pathname.endsWith('/disks/list.cgi')) return listDisks(xml('disk', { diskid: 'SD_DISK', status: 'OK' }));
    if (url.pathname.endsWith('/addconfiguration.cgi')) { count++; return adding.response; }
  });
  await app.loadStorage();
  const first = app.enableContinuous();
  await app.enableContinuous();
  assert.equal(count, 1);
  adding.resolve(xml('root', {}, [xml('configure', { result: 'OK', profile: '1' })]));
  await first;
});
