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
    refreshRecordings, trackGeometry, setView, draw };
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
const recording = (id, start = fixtureTime, stop = start + 60000, attrs = {}) => xml('recording', {
  recordingid: id, diskid: 'SD_DISK', starttime: new Date(start).toISOString(),
  stoptime: stop == null ? '' : new Date(stop).toISOString(), recordingtype: 'continuous',
  recordingstatus: 'completed', ...attrs,
});
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
        play: async () => {}, pause() {}, setAttribute() {}, setPointerCapture() {},
      });
    }
    return nodes.get(id);
  };
  const doc = {
    getElementById: element, querySelectorAll: () => [], dispatchEvent() {},
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

test('the channel overlay reflects reported views independently of storage', async () => {
  const app = await browser();
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  assert.ok(html.indexOf('class="video-wrap"') < html.indexOf('id="channelWrap"'));
  assert.ok(html.indexOf('id="channelWrap"') < html.indexOf('id="sourceChoices"'));
  assert.equal(app.element('channelWrap').classList.contains('hidden'), true);
  app.route((url) => {
    if (url.searchParams.get('group') === 'Properties.Image.NbrOfViews') return 'root.Properties.Image.NbrOfViews=3';
    if (url.searchParams.get('group') === 'Image') return 'root.Image.I1.Name=Eingang\nroot.Image.I2.Enabled=no';
  });
  await app.loadChannels();
  assert.deepEqual(app.element('channel').options.map((o) => o.textContent), ['channel.default {"n":1}', '2: Eingang']);
  assert.equal(app.element('channelWrap').classList.contains('hidden'), false);
  assert.match(app.element('channelLabel').textContent, /"n":3/);
});

test('overlapping event footage has its own visible track and opens by recording ID', async () => {
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
  assert.equal(app.element('otherLegend').classList.contains('hidden'), false);
  const eventBar = app.rectangles.find((r) => r.color === '#f59e0b');
  const continuousBar = app.rectangles.find((r) => r.color === '#3b82f6');
  const scheduleBar = app.rectangles.find((r) => r.color === '#a855f7');
  assert.ok(continuousBar.y + continuousBar.h < eventBar.y);
  assert.ok(eventBar.y + eventBar.h < scheduleBar.y);
  const ev = { isPrimary: true, button: 0, pointerId: 1, offsetX: eventBar.x + 1, offsetY: eventBar.y + 1 };
  const canvas = app.element('timeline');
  canvas.events.pointerdown(ev);
  canvas.events.pointerup(ev);
  assert.equal(app.state.pipeline.parameters[0], 'recordingid=evt');
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

test('live badge and snapshot require active video; playback does not fetch a live JPEG', async () => {
  const app = await browser();
  assert.match(app.element('modeBadge').textContent, /connecting/);
  app.element('video').events.playing();
  assert.equal(app.element('modeBadge').textContent, 'badge.live');
  // While live video plays there is nothing for the button to do.
  assert.equal(app.element('btnLive').classList.contains('hidden'), true);
  assert.equal(app.element('liveSep').classList.contains('hidden'), true);
  app.element('btnSnapshot').events.click();
  assert.match(app.downloads[0], /\/axis-cgi\/jpg\/image.cgi/);
  app.route(() => recordings(1, recording('clip')));
  await app.playAt(fixtureTime + 1000);
  app.element('video').events.playing();
  assert.equal(app.element('btnLive').classList.contains('hidden'), false);
  assert.equal(app.element('btnSnapshot').disabled, true);
  app.element('btnSnapshot').events.click();
  assert.equal(app.downloads.length, 1);
});

test('timeline messages are an overlay in the image and vanish when empty', async () => {
  const app = await browser();
  const html = readFileSync(require.resolve('../app/html/index.html'), 'utf8');
  const status = app.element('timelineStatus');
  assert.ok(html.indexOf('id="timelineStatus"') > html.indexOf('class="video-wrap"'));
  assert.ok(html.indexOf('id="timelineStatus"') < html.indexOf('class="timeline-panel"'));
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
