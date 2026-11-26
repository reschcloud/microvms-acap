/*
 * Micro VMS – Übersetzungen (Deutsch / English)
 *
 * Sprache: gespeicherte Auswahl (localStorage) > Browsersprache (de* -> Deutsch, sonst Englisch).
 * HTML: data-i18n="key" (Text), data-i18n-title="key", data-i18n-placeholder="key", data-i18n-html="key".
 * JS:   I18N.t('key', { var: 'wert' })
 */
(function (global) {
  'use strict';

  const STRINGS = {
    de: {
      'app.title': 'Micro VMS',
      'lang.switch': 'Sprache',
      'storage.label': 'Speicher',
      'storage.none': 'Speicher: kein Datenträger',
      'storage.unavailable': 'Speicher: nicht abrufbar',
      'storage.used': '{used}/{total} GB belegt',

      'badge.live': 'LIVE',
      'badge.paused': 'PAUSE',
      'badge.playback': 'WIEDERGABE',
      'live.btn': 'Live-Ansicht',
      'live.back': '⏭ Zurück zu Live',
      'live.btn.title': 'Wiedergabe beenden und zur Live-Ansicht wechseln',
      'ctl.back.title': '30 s zurück',
      'ctl.pause.title': 'Pause / Weiter',
      'ctl.fwd.title': '30 s vor',
      'ctl.snapshot': '📷 Schnappschuss',
      'ctl.snapshot.title': 'Aktuelles Live-Bild als JPEG speichern',
      'ctl.channel': 'Kanal',
      'ctl.stream': 'Stream',
      'ctl.stream.auto': 'Standard (H.264)',
      'ctl.resolution': 'Auflösung',
      'ctl.resolution.default': 'Standard',
      'channel.default': 'Kanal {n}',

      'video.reconnect': 'Verbindung getrennt – verbinde neu…',
      'video.rtspError': 'RTSP-Fehler: {msg}',
      'video.connectFailed': 'Verbindung fehlgeschlagen: {msg}',
      'video.wsError': 'WebSocket-Fehler',
      'video.noRecordingFrom': 'Keine Aufzeichnung ab {when}',
      'video.endOfRecording': 'Ende der Aufzeichnung',
      'video.libMissing': 'media-stream-library konnte nicht geladen werden.',
      'toast.recListFailed': 'Aufzeichnungen konnten nicht gelesen werden: {msg}',
      'toast.jumpTo': 'Keine Aufzeichnung zu diesem Zeitpunkt – springe zu {time}',
      'toast.timeline': 'Timeline: {msg}',
      'err.xml': 'Ungültige XML-Antwort',

      'tl.prevDay': 'Vorheriger Tag',
      'tl.nextDay': 'Nächster Tag',
      'tl.today': 'Heute',
      'tl.zoomOut': 'Herauszoomen',
      'tl.zoomIn': 'Hineinzoomen',
      'tl.fitDay': 'Ganzen Tag anzeigen',
      'tl.select': '✂ Bereich wählen',
      'tl.select.title': 'Bereich für Export auf der Timeline ziehen',
      'tl.legend.continuous': 'Dauer',
      'tl.legend.triggered': 'Ereignis',
      'tl.legend.scheduled': 'Zeitplan',
      'tl.hint': 'Klick = Wiedergabe ab Zeitpunkt · Ziehen = verschieben · Mausrad = Zoom · Shift+Ziehen oder „Bereich wählen“ = Exportbereich',

      'exp.title': 'Export',
      'exp.from': 'Von',
      'exp.to': 'Bis',
      'exp.name': 'Dateiname',
      'exp.merge': 'Als eine Datei zusammenfügen',
      'exp.password': 'Passwortgeschützt (ZIP/AES-256)',
      'exp.password.placeholder': 'Passwort',
      'exp.start': '⬇ Exportieren',
      'exp.cancel': 'Abbrechen',
      'exp.clear': 'Auswahl löschen',
      'exp.duration': 'Dauer: {d}',
      'exp.endBeforeStart': 'Ende liegt vor dem Start',
      'exp.invalidRange': 'Bitte gültigen Zeitraum wählen',
      'exp.confirmLarge': 'Der Export umfasst {d}. Das kann sehr groß werden. Fortfahren?',
      'exp.needPassword': 'Bitte Passwort eingeben',
      'exp.none': 'Im gewählten Zeitraum gibt es keine Aufzeichnung.',
      'exp.parts': '{n} Teil-Exporte. Falls der Browser Downloads blockiert, die Links unten verwenden.',
      'exp.started': 'Export gestartet. Falls kein Download startet, den Link unten verwenden.',
      'exp.pwNoMerge': 'Passwortgeschützte ZIPs lassen sich nicht zusammenfügen – {n} einzelne Dateien.',
      'exp.aborted': 'Export abgebrochen.',
      'exp.incompatible': 'Die Aufzeichnungen haben unterschiedliche Videoparameter (z. B. Auflösung/Codec) und können nicht verlustfrei zusammengefügt werden. Es werden {n} einzelne Dateien exportiert.',
      'exp.failed': 'Export fehlgeschlagen: {msg}',
      'exp.loading': 'Lade Teil {part}/{parts} · {bytes} …',
      'exp.done': 'Fertig: {n} Aufzeichnungsabschnitte zu einer Datei zusammengefügt. Lücken ohne Aufzeichnung wurden übersprungen.',
      'exp.partFailed': 'Teil {n}: HTTP {status}',

      'rec.title': 'Daueraufzeichnung',
      'rec.loading': 'Lade…',
      'rec.enable': 'Aktivieren',
      'rec.disk.title': 'Speicherort',
      'rec.hint': 'Rund-um-die-Uhr-Aufnahme auf SD-Karte/NAS. Aktivieren braucht Operator-/Admin-Rechte; alternativ in der Kamera unter <em>Aufzeichnungen</em>.',
      'rec.off': 'Nicht eingerichtet – die Kamera nimmt nur auf, wenn andere Regeln (z. B. Ereignisse) das auslösen.',
      'rec.offChannel': 'Für diesen Kanal nicht eingerichtet.',
      'rec.on': 'Aktiv – nimmt durchgehend auf <b>{disks}</b> auf.',
      'rec.onOthers': 'Aktiv für: {list}',
      'rec.unavailable': 'Status nicht abrufbar (fehlende Rechte oder neuere Firmware mit Aufzeichnungsgruppen). Aufzeichnungen in der Timeline sind davon unabhängig.',
      'rec.noDisk': 'Kein verfügbarer Datenträger',
      'rec.enabled': 'Daueraufzeichnung aktiviert (Profil {profile})',
      'rec.error': 'Fehler: {msg}',
      'rec.unknownResponse': 'unbekannte Antwort',
      'rec.enableFailed': 'Aktivieren fehlgeschlagen: {msg}',

      'ptz.title': 'PTZ',
      'ptz.onlyLive': 'PTZ nur in der Live-Ansicht verfügbar.',
      'ptz.home': 'Home-Position',
      'ptz.zoom': 'Zoom',
      'ptz.zoomIn': 'Zoom rein (gedrückt halten)',
      'ptz.zoomOut': 'Zoom raus (gedrückt halten)',
      'ptz.speed': 'Geschwindigkeit:',
      'ptz.goto': 'Anfahren',
      'ptz.reload': 'Presets neu laden',
      'ptz.clickCenter': 'Klick ins Bild zentriert, Mausrad zoomt',
      'ptz.keyboard': 'Tastatur: Pfeiltasten, + / −',
      'ptz.noPresets': '– keine Presets –',
      'ptz.presetsUnavailable': '– nicht verfügbar –',
      'ptz.error': 'PTZ: {msg}',
      'ptz.dir.ul': 'links oben', 'ptz.dir.u': 'hoch', 'ptz.dir.ur': 'rechts oben',
      'ptz.dir.l': 'links', 'ptz.dir.r': 'rechts',
      'ptz.dir.dl': 'links unten', 'ptz.dir.d': 'runter', 'ptz.dir.dr': 'rechts unten',
    },

    en: {
      'app.title': 'Micro VMS',
      'lang.switch': 'Language',
      'storage.label': 'Storage',
      'storage.none': 'Storage: no disk',
      'storage.unavailable': 'Storage: unavailable',
      'storage.used': '{used}/{total} GB used',

      'badge.live': 'LIVE',
      'badge.paused': 'PAUSED',
      'badge.playback': 'PLAYBACK',
      'live.btn': 'Live view',
      'live.back': '⏭ Back to live',
      'live.btn.title': 'Stop playback and return to the live view',
      'ctl.back.title': 'Back 30 s',
      'ctl.pause.title': 'Pause / resume',
      'ctl.fwd.title': 'Forward 30 s',
      'ctl.snapshot': '📷 Snapshot',
      'ctl.snapshot.title': 'Save the current live image as JPEG',
      'ctl.channel': 'Channel',
      'ctl.stream': 'Stream',
      'ctl.stream.auto': 'Default (H.264)',
      'ctl.resolution': 'Resolution',
      'ctl.resolution.default': 'Default',
      'channel.default': 'Channel {n}',

      'video.reconnect': 'Connection lost – reconnecting…',
      'video.rtspError': 'RTSP error: {msg}',
      'video.connectFailed': 'Connection failed: {msg}',
      'video.wsError': 'WebSocket error',
      'video.noRecordingFrom': 'No recording from {when}',
      'video.endOfRecording': 'End of recording',
      'video.libMissing': 'media-stream-library could not be loaded.',
      'toast.recListFailed': 'Could not read recordings: {msg}',
      'toast.jumpTo': 'No recording at this time – jumping to {time}',
      'toast.timeline': 'Timeline: {msg}',
      'err.xml': 'Invalid XML response',

      'tl.prevDay': 'Previous day',
      'tl.nextDay': 'Next day',
      'tl.today': 'Today',
      'tl.zoomOut': 'Zoom out',
      'tl.zoomIn': 'Zoom in',
      'tl.fitDay': 'Show whole day',
      'tl.select': '✂ Select range',
      'tl.select.title': 'Drag on the timeline to select an export range',
      'tl.legend.continuous': 'Continuous',
      'tl.legend.triggered': 'Event',
      'tl.legend.scheduled': 'Scheduled',
      'tl.hint': 'Click = play from that time · Drag = pan · Wheel = zoom · Shift+drag or “Select range” = export range',

      'exp.title': 'Export',
      'exp.from': 'From',
      'exp.to': 'To',
      'exp.name': 'File name',
      'exp.merge': 'Merge into a single file',
      'exp.password': 'Password protected (ZIP/AES-256)',
      'exp.password.placeholder': 'Password',
      'exp.start': '⬇ Export',
      'exp.cancel': 'Cancel',
      'exp.clear': 'Clear selection',
      'exp.duration': 'Duration: {d}',
      'exp.endBeforeStart': 'End is before start',
      'exp.invalidRange': 'Please select a valid time range',
      'exp.confirmLarge': 'The export covers {d}. This may be very large. Continue?',
      'exp.needPassword': 'Please enter a password',
      'exp.none': 'There is no recording in the selected range.',
      'exp.parts': '{n} separate exports. If the browser blocks downloads, use the links below.',
      'exp.started': 'Export started. If no download starts, use the link below.',
      'exp.pwNoMerge': 'Password-protected ZIPs cannot be merged – {n} separate files.',
      'exp.aborted': 'Export cancelled.',
      'exp.incompatible': 'The recordings use different video parameters (e.g. resolution/codec) and cannot be merged losslessly. Exporting {n} separate files instead.',
      'exp.failed': 'Export failed: {msg}',
      'exp.loading': 'Loading part {part}/{parts} · {bytes} …',
      'exp.done': 'Done: {n} recording segments merged into one file. Gaps without recording were skipped.',
      'exp.partFailed': 'Part {n}: HTTP {status}',

      'rec.title': 'Continuous recording',
      'rec.loading': 'Loading…',
      'rec.enable': 'Enable',
      'rec.disk.title': 'Storage',
      'rec.hint': 'Round-the-clock recording to SD card/NAS. Enabling requires operator/admin rights; alternatively use <em>Recordings</em> in the camera settings.',
      'rec.off': 'Not set up – the camera only records when other rules (e.g. events) trigger it.',
      'rec.offChannel': 'Not set up for this channel.',
      'rec.on': 'Active – recording continuously to <b>{disks}</b>.',
      'rec.onOthers': 'Active for: {list}',
      'rec.unavailable': 'Status unavailable (missing rights or newer firmware using recording groups). Recordings in the timeline are not affected.',
      'rec.noDisk': 'No storage available',
      'rec.enabled': 'Continuous recording enabled (profile {profile})',
      'rec.error': 'Error: {msg}',
      'rec.unknownResponse': 'unknown response',
      'rec.enableFailed': 'Enabling failed: {msg}',

      'ptz.title': 'PTZ',
      'ptz.onlyLive': 'PTZ is only available in live view.',
      'ptz.home': 'Home position',
      'ptz.zoom': 'Zoom',
      'ptz.zoomIn': 'Zoom in (hold)',
      'ptz.zoomOut': 'Zoom out (hold)',
      'ptz.speed': 'Speed:',
      'ptz.goto': 'Go to',
      'ptz.reload': 'Reload presets',
      'ptz.clickCenter': 'Click in image to center, wheel to zoom',
      'ptz.keyboard': 'Keyboard: arrow keys, + / −',
      'ptz.noPresets': '– no presets –',
      'ptz.presetsUnavailable': '– unavailable –',
      'ptz.error': 'PTZ: {msg}',
      'ptz.dir.ul': 'up left', 'ptz.dir.u': 'up', 'ptz.dir.ur': 'up right',
      'ptz.dir.l': 'left', 'ptz.dir.r': 'right',
      'ptz.dir.dl': 'down left', 'ptz.dir.d': 'down', 'ptz.dir.dr': 'down right',
    },
  };

  const STORE_KEY = 'minivms.lang'; // preserve language preferences on the same camera origin

  function detect() {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved && STRINGS[saved]) return saved;
    } catch (e) { /* Storage evtl. gesperrt */ }
    const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
    return /^de\b/i.test(langs[0] || '') ? 'de' : 'en';
  }

  const lang = detect();

  function t(key, vars) {
    let s = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
    return s;
  }

  function apply(root) {
    const r = root || document;
    r.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    r.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    r.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    r.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  }

  function setLang(l) {
    if (!STRINGS[l] || l === lang) return;
    try { localStorage.setItem(STORE_KEY, l); } catch (e) { /* ignore */ }
    location.reload();
  }

  document.documentElement.lang = lang;
  global.I18N = { t, apply, setLang, lang, languages: Object.keys(STRINGS) };
})(window);
