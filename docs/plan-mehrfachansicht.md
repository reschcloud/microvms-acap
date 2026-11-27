# Plan: Mehrfachansicht (4/6) mit Kanaltimelines, Audio und Export

**Status:** Etappen 1–8 umgesetzt (Stand 2026-11-26); Kameratest auf echter
Hardware ausstehend. Etappe 9 (Feinschliff nach Kameratest) offen.

**Grundlage:** `docs/backlog.md` (Audio in der Live-Ansicht, Schnappschuss in
der Wiedergabe), ADR 0003 (Export ohne Transcoding), ADR 0004 (letzte
Wiedergabeaktion gewinnt), ADR 0005 (VAPIX-Kanalzuordnung).

## 1. Ziel

- **Ansichten:** Einzelansicht, 2er-, 4er- und 6er-Raster. Der Standard
  richtet sich nach der Zahl der vorhandenen Kanäle und ist manuell
  umschaltbar. Nicht belegte Plätze bleiben als leere Kacheln stehen.
- **Kacheln:** Jede Kachel zeigt einen Kanal und hat ein dezentes Menü
  (Zahnrad/Chevron) für Kanal und Streamprofil. Der Ton bekommt ein eigenes
  kleines Lautsprecher-Icon.
- **Streams pro Kanal:** Einzelansicht standardmäßig der größte Stream,
  Mehrfachansicht der kleinste. Eine explizite Auswahl wird pro Kanal gemerkt.
- **Timeline:** Grundsätzlich **eine Spur pro Kanal** – blau für
  Daueraufzeichnung, gelb für Ereignis; überlagern sich beide, ist der
  Abschnitt gelb. In der Mehrfachansicht gibt es entsprechend mehrere Spuren.
- **Export:** Bei einer Zeitauswahl steht links an jeder Kanalspur ein Haken
  für den Export dieses Kanals; standardmäßig sind alle gesetzt.
- **Audio:** Jede Kachel kann Ton unabhängig ein-/ausschalten, in der
  Mehrfachansicht auch mehrere gleichzeitig. Beim Export wird gefragt, ob
  Audio enthalten sein soll; Standard ist ein.
- **Offene Ideen mit eingeplant:** Audio in Live/Wiedergabe und Schnappschuss
  in der Wiedergabe (beide auch pro Kachel).

Nicht Teil dieses Plans: serverseitiges Transcoding, ein Thumbnail-Wandbild,
gleichzeitige PTZ-Bedienung mehrerer Kanäle, kanalübergreifend garantierte
Bildsynchronität.

## 2. Grundentscheidungen

| Thema | Entscheidung |
|---|---|
| Layouts | `auto` (Standard), `1`, `2`, `4`, `6`. `auto`: 1 Kanal → 1er, 2 → 2er, 3–4 → 4er, ab 5 → 6er. |
| Kachelbelegung | Erste aktivierte Kanäle in Reihenfolge; leere Plätze bleiben sichtbar. Das Kachelmenü erlaubt jederzeit eine freie Kanalwahl. Bei mehr als 6 Kanälen liegen die ersten 6 auf den Kacheln. |
| Zeitbezug | **Eine gemeinsame, immer synchrone Zeit** für alle Kacheln. Klick/Sprung/Pause wirken auf alle; jede Kachel löst für ihren Kanal die passende Aufnahme auf. |
| Kein Material | Eine Kachel ohne Aufnahme im Zielzeitraum bleibt stehen und zeigt „keine Aufnahme“; die übrigen laufen weiter. |
| Timeline-Spuren | Eine Spur pro sichtbarer Kachel/Kanal, gemeinsame Zeitachse, gemeinsamer Playhead. Mehrfachansicht ist immer synchron. |
| Spurfarben | Gelb: `triggered` (Ereignis). Blau: alle übrigen Aufzeichnungen (`continuous`, `scheduled`, `other`). Gelb liegt über Blau (Überlappung → gelb). |
| Export-Haken | Pro Kanalspur links, standardmäßig alle an; ohne Zeitauswahl deaktiviert. |
| Stream-Default | Einzelansicht: größtes Profil (Pixel, dann Bitrate). Mehrfach: kleinstes Profil. Ohne auflösbare Profilgröße: Kamera-Default in Einzelansicht, sonst kleinste bekannte Auflösung; sonst Kamera-Default mit Hinweis. |
| Audio-Default | Stumm. Einschalten per Klick auf das Lautsprecher-Icon (Nutzergeste); mehrere Kacheln dürfen gleichzeitig Ton haben. Die Wahl wird pro Kanal über einen Reload gemerkt. |
| Export-Audio | Sichtbare Checkbox „Audio einschließen“ (Standard an). |
| Schnappschuss | Pro Kachel. Live weiterhin JPEG-Endpunkt; Wiedergabe/Pause als Canvas-Frame des sichtbaren Bildes. |
| Netzstatus | Kleine Anzeige in der Topbar: Ping zur Kamera (alle 5 s) und am Browser eingehende Streambandbreite (Summe aller Kacheln). |
| Fokus | Angeklickte Kachel ist „aktiv“: PTZ, Seitenleiste (Aufnahmekonfiguration) und der globale Schnappschuss-Button beziehen sich darauf. |

Beispiel-Layout:

```
┌ Werkzeugleiste: [1] [2] [4] [6]   [Live] [-30 s] [-5 s] [Pause] [+30 s] ┐
│ ┌───────────────┬───────────────┬───────────────┐                   │
│ │ K1        🔇 ⚙ │ K2        🔊 ⚙ │ K3        🔇 ⚙ │                   │
│ └───────────────┴───────────────┴───────────────┘                   │
│ ┌───────────────┬───────────────┬───────────────┐                   │
│ │ K4        🔇 ⚙ │ K5        🔇 ⚙ │ K6        🔇 ⚙ │                   │
│ └───────────────┴───────────────┴───────────────┘                   │
├ Timeline ───────────────────────────────────────────────────────────┤
│ ☑ K1 │██████████▓▓▓▓████████████████                                │
│ ☑ K2 │███████████████████████████████                                │
│ ☑ K3 │      ▓▓▓▓▓      ██████████████                                │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. Datenmodell und Zustand

Der heutige Zustand ist auf genau eine Pipeline, einen Kanal und eine
Timeline ausgelegt (`state.pipeline`, `state.channel`, `state.rec`,
`state.mode`, `state.recordings`). Künftig:

```js
state.layout = 'auto' | 1 | 2 | 4 | 6;
state.active = 0;                 // Index der aktiven Kachel

state.tiles = [{
  id, channel,                 // VAPIX-Kanal (1-basiert)
  profile, resolution,         // Streamprofil-Override / Auflösungs-Override
  audio: false,                // Ton gewünscht (Pipeline-Parameter)
  muted: true,                 // aktueller Lautsprecherzustand
  pipeline, generation,        // wie heute, aber pro Kachel
  mode, streamStatus,          // live | playback | paused | error | noRecording
  rec, manualRecording,        // aktuell laufende Aufnahme
  pendingSeek, intent,         // Abbruch/Generation pro Kachel
  startWall, syncWall, baseCt, pausedAt,
  lastFrame,                   // Canvas/ImageBitmap für Pause + Snapshot
}];

state.time = { mode: 'live' | 'playback' | 'paused', wall };
state.recordingsByChannel = new Map(); // channel -> { recs, unknown, complete }
```

- `currentWall()` wird zu einer gemeinsamen Zeitquelle. Eine Kachel (die den
  Sprung ausgelöst hat) ist Master; ihr `onSync`/`currentTime` treibt die
  Anzeige. Die anderen Kacheln laufen mit derselben `startWall`.
- Die bisherigen Einzelwerte bleiben während der Umbauphase als Getter auf die
  aktive Kachel erhalten (Testkompatibilität), werden aber nicht mehr als
  eigene Wahrheit gepflegt.
- Persistenz (bestehende `minivms.*`-Keys bleiben):
  - `minivms.layout` (`auto`, `1`, `2`, `4`, `6`)
  - `minivms.stream.<channel>` (Profilname oder `auto`)
  - `minivms.resolution.<channel>` (optionaler Override)
  - `minivms.audio.<channel>` (Tonwahl, überlebt den Reload)
  - `minivms.channel` bleibt für die Einzelansicht/Fokus initial relevant.

## 4. Architektur

### 4.1 Kachel-Controller statt globaler Pipeline

Die Pipeline-Logik aus `startPipeline()`, `goLive()`, `playAt()`,
`startRecording()`, `holdAt()` und `onRecordingEnded()` wird in einen
Controller pro Kachel gezogen:

- `tileStart(tile, params, offset)`, `tileStop(tile)`, `tileFail(tile, …)`
- Jede Kachel hat eigene `generation`, `intent` (AbortController) und
  Retry-/Timeout-Logik. Ein Fehler in Kachel 3 darf die Kacheln 1, 2, 4–6
  nicht stoppen.
- Kacheln werden gestaffelt gestartet (ca. 150–300 ms), damit die Kamera nicht
  sechs RTSP-Sitzungen gleichzeitig aufbauen muss.
- `goLiveAll()`, `playAtAll(time)`, `pauseAll()`, `skipAll(seconds)` rufen die
  Kachel-Controller auf. Die „letzte Aktion gewinnt“-Regel (ADR 0004) gilt
  global über einen gemeinsamen Intent-Zähler plus pro Kachel.
- Beim Layoutwechsel werden nicht mehr sichtbare Kacheln geschlossen
  (`tileStop`), sichtbare behalten ihre Pipeline.

### 4.2 Kanal- und Streamauswahl pro Kachel

- `loadChannels()` bleibt die Quelle für Anzahl, Namen und Reihenfolge.
- `loadStreamProfiles()` wird einmal global geladen. Für die Sortierung wird
  `parameters` ausgewertet (`resolution=WxH`, optional `bitrate=…`).
  - „Größter“ = meiste Pixel, Gleichstand → höhere Bitrate, dann Name.
  - „Kleinster“ = wenigste Pixel, Gleichstand → niedrigere Bitrate, dann Name.
  - Profile ohne `resolution` sind nicht belastbar sortierbar und werden im
    Menü als „Größe unbekannt“ geführt.
- Das Kachelmenü bietet: Kanal, „Automatisch (Layout)“, alle Streamprofile,
  optional Auflösung. Ein Wechsel startet nur diese Kachel neu.
- Pipeline-Parameter bleiben: `camera=N`, zuerst `streamprofile=…`, danach
  explizit `videocodec=h264` (letzter Wert gewinnt), optional
  `resolution=…`, `audio=1&audiocodec=aac` nur bei aktivem Ton.
- Der bisher globale Auflösungs-Select entfällt bzw. wandert ins Kachelmenü.
  Kameras ohne `streamprofile.cgi` behalten die Auflösungswahl als Fallback.

### 4.3 Gemeinsame Zeit und Wiedergabe

- Live: alle sichtbaren Kacheln `goLive()`.
- Sprung/Zeitwahl: `playAtAll(time)` löst für jeden Kanal parallel
  `findRecordingAtOrAfter()` auf. Kacheln ohne Treffer halten an `time` und
  zeigen den Grund; die anderen starten.
- Pause: alle Kacheln pausieren. Vor dem Schließen der Pipeline wird der
  letzte Frame für den Schnappschuss gesichert (siehe 9). „Weiter“ startet
  alle Kacheln ab der gemeinsamen Pausenzeit.
- Ende einer Aufnahme: nur die betroffene Kachel springt in die nächste
  Aufnahme ihres Kanals; die gemeinsame Zeit läuft weiter.
- Die Fortschrittsuhr und der Playhead nutzen die Master-Kachel. Weichen
  Kacheln durch `onSync` leicht ab, wird nicht hart nachkorrigiert – das ist
  bei getrennten RTSP-Sitzungen nicht zuverlässig und würde Bilder springen
  lassen.

### 4.4 DOM und Layout

- `#video` wird durch ein Raster `.video-grid` mit einer Kachel-DOM pro Kanal
  ersetzt. Jede Kachel enthält `<video muted playsinline>`, Badge,
  Kanalname, Statusmeldung, Lautsprecher-Icon, Menü-Icon und Fokusrahmen.
- CSS: `layout-1` (1×1), `layout-2` (2×1), `layout-4` (2×2), `layout-6`
  (3×2). Bei 3 Kanälen bleibt das 4er-Raster aktiv, ein Platz bleibt leer.
  Leere Kacheln sind sichtbar und können über ihr Menü frei belegt werden; bei
  mehr als 6 Kanälen liegen zunächst die ersten 6 auf den Kacheln. Auf
  schmalen Bildschirmen wird das Raster untereinander scrollbar.
- Freie Kanalwahl: Jede Kachel kann jeden aktivierten Kanal zeigen, auch
  mehrfach. Die Timeline zeigt die Kanäle der sichtbaren Kacheln; doppelte
  Kacheln teilen sich eine Spur.
- Fokus: Klick/Tap auf eine Kachel setzt `state.active` und den Rahmen.
  `microvms:channel` wird bei Fokuswechsel für PTZ gefeuert.
- `ptz.js` bindet heute fest an `#video`. Es bekommt über `window.MicroVms`
  die aktive Kachel (`activeVideo()`, `activeChannel()`) und arbeitet mit
  Ereignis-Delegation auf dem Raster; nur die aktive Live-Kachel reagiert auf
  Klick/Rad. Die PTZ-Karte bleibt kanalbezogen.
- Die Seitenleiste (Aufnahmekonfiguration, Speicher) folgt weiterhin dem
  aktiven Kanal. Zusätzlich zeigt jede Kachel einen kleinen Aufnahmepunkt.
- Der bestehende Quellen-Dialog für mehrdeutige Aufnahmen wird kachelbezogen:
  er nennt den Kanal und öffnet die Wiedergabe in dieser Kachel. In der
  Mehrfachansicht kann jeweils nur eine Kachel einen offenen Dialog haben;
  die Auswahl bleibt an Kachel und Aufnahme-ID gebunden.

## 5. Timeline

### 5.1 Daten

- `refreshRecordings()` wird kanalweise: pro sichtbarem Kanal ein
  `listRecordings()` mit eigenem AbortController, begrenzt parallel (z. B. 3
  gleichzeitig), Ergebnisse in `state.recordingsByChannel`.
- Beim Zoomen/Tagwechsel/Scrollen werden alte Anfragen abgebrochen; pro Kanal
  gilt weiterhin Paging und `complete`.
- Abfrageintervall in der Mehrfachansicht eher 60 s statt 30 s; nur sichtbare
  Kanäle.
- `unassigned` (mehrdeutige Quelle) bleibt eine gemeinsame graue Leiste unter
  den Kanalspuren.

### 5.2 Spuren und Farben

- Eine Spur pro sichtbarer Kachel, Höhe ca. 28–32 px, links Kanalname und
  Export-Haken.
- Zeichnen: alle Aufzeichnungen blau; `triggered` (Ereignis) gelb darüber.
  Dadurch wird eine Überlappung sichtbar gelb. Eine Unterscheidung zwischen
  `continuous`, `scheduled` und `other` gibt es nicht mehr.
- Überlappende Aufnahmen desselben Kanals werden zu einem Intervall
  zusammengefasst, damit keine Doppelbalken entstehen.
- Die Legende wird auf Blau (Aufzeichnung) und Gelb (Ereignis) reduziert.

### 5.3 Linke Spalte mit Export-Haken

- Die Spuren bekommen eine echte HTML-Spalte links neben dem Canvas:
  `[☑] Kanalname` je Zeile, über CSS-Grid exakt auf die Canvas-Spuren
  ausgerichtet. Keine Checkboxen im Canvas (Barrierefreiheit, Klickziele).
- Standard: alle Haken gesetzt. Neue Kanäle nach Layout-/Kanalwechsel starten
  ebenfalls gesetzt. Der Zustand gilt für die aktuelle Sitzung.
- Ohne Zeitauswahl sind die Haken deaktiviert und ausgegraut; ein Tooltip
  erklärt „Zeitbereich wählen“.
- „Alle an/aus“ ist optional als kleine Aktion in der Timeline-Leiste.

### 5.4 Interaktion

- Die Zeitachse ist immer gemeinsam und synchron: Klick setzt die gemeinsame
  Zeit, Ziehen verschiebt, Rad zoomt.
- Ein Klick auf einen gelben Abschnitt startet bevorzugt die jeweilige
  Aufnahme dieses Kanals in genau dieser Kachel; die übrigen Kacheln springen
  auf dieselbe Zeit (normale Auflösung). Das erhält das bestehende Verhalten
  für Ereignisclips, ohne die gemeinsame Zeit aufzugeben.
- Die graue Leiste für mehrdeutige Aufnahmen bleibt wie heute anklickbar.

## 6. Wiedergabe- und Bedienlogik

- Globale Bedienelemente (Live, ±30 s, −5 s, Pause, +30 s) wirken auf alle
  Kacheln.
- Der Badge-Text ist pro Kachel (live, Wiedergabe, Puffer, Fehler, keine
  Aufnahme); die Uhr zeigt die gemeinsame Zeit.
- Schlägt eine Kachel fehl, zeigt sie „Erneut versuchen“ nur für sich; die
  anderen laufen weiter.
- Der Kanalwechsel in der Einzelansicht entspricht künftig dem Wechsel der
  Kachelbelegung; die gemeinsame Zeit bleibt erhalten.
- Ein Kanal in zwei Kacheln ist möglich (Menü), wird aber nicht speziell
  synchronisiert – es sind zwei unabhängige Pipelines.

## 7. Audio

- Jede Kachel fordert `audio=1&audiocodec=aac` nur an, wenn ihr Ton aktiv ist.
  Einschalten startet die Kachel neu (kurze Unterbrechung), Ausschalten mutet
  sofort und lässt den nächsten Start ohne Audio erfolgen.
- Vor dem Einschalten prüfen:
  `MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')`.
  G.711/PCMU/Opus werden nicht über MSE abgespielt; die Kamera muss AAC
  liefern können.
- Standardmäßig stumm (Autoplay-Policy). Das Lautsprecher-Icon ist die
  Nutzergeste. Mehrere Kacheln dürfen gleichzeitig aktiv sein; es gibt keinen
  „exklusiven“ Ton.
- Die Tonwahl wird pro Kanal gespeichert (`minivms.audio.<channel>`). Nach
  einem Reload zeigt das Icon den gemerkten Zustand und die Pipeline fordert
  Audio an; das `<video>` bleibt aber bis zur ersten Nutzergeste stumm. Ein
  Klick auf die Kachel/Seite übernimmt den Ton. Verweigert der Browser das
  Entstummen, bleibt die Kachel stumm und zeigt einen kurzen Hinweis.
- Icon-Zustände: stumm, aktiv, „kein Ton möglich“ (deaktiviert mit Titel).
  Ein Klick auf eine Kachel ändert den Ton nicht unbeabsichtigt.
- Wiedergabe: Ton nur, wenn die Aufnahme eine Tonspur hat und die Kachel Ton
  aktiviert hat (`recordingid=…&audio=1`). Aufnahmen ohne Tonspur laufen
  stumm weiter; kein Fehler.
- Aufnahmen dieses Tools haben bisher **keinen** Tontrack, weil
  `enableContinuous()` nur `videocodec=h264` schreibt. Für nutzbaren
  Export-Ton muss die Daueraufnahme künftig optional `audio=1` (AAC)
  mitkonfigurieren. Das kostet Bandbreite/Speicher und ist eine eigene
  Entscheidung; bestehende Profile bleiben unverändert.
- Rechte: Prüfen, ob Zuhören eine eigene Gruppe verlangt; bei 403 bleibt das
  Icon deaktiviert und die Videowiedergabe funktioniert weiter.

## 8. Export

### 8.1 Kanalauswahl

- `doExport()` wird zum Orchestrator:
  1. gemeinsamen Zeitbereich und die gesetzten Kanal-Haken lesen,
  2. pro Kanal `listRecordings()` + `planExport()`,
  3. pro Kanal Teile exportieren und – wenn möglich – zu einer Datei mergen,
  4. Ergebnisse/Fehler pro Kanal sammeln.
- Nicht gesetzte Kanäle werden übersprungen. Kanäle ohne Aufnahme im Bereich
  werden mit Hinweis übersprungen; bleibt kein Kanal übrig, bricht der Export
  mit einer Meldung ab.
- Dateinamen: `<name>_ch<N>_<start>.mkv`; bei genau einem gewählten Kanal
  bleibt das bisherige Schema ohne `_ch` erhalten.
- Ein mehrdeutiger Treffer betrifft nur seinen Kanal: dieser Kanal wird mit
  Fehler gemeldet, die anderen werden weiter exportiert (heute bricht der
  gesamte Export ab).
- Fortschritt: „Kanal 2/4 · Teil 3/7 · 120 MB“, Abbrechen bricht alle laufenden
  Anfragen ab.

### 8.2 Eine Datei pro Kanal

- Das bestehende `exportMerged()` arbeitet pro Kanal; ein Zusammenfügen über
  Kanäle hinweg ist nicht sinnvoll (verschiedene Bildinhalte).
- Passwort/ZIP: pro Kanal eine eigene verschlüsselte Datei, kein Merge.
- Browser-Downloads: Der erste Download pro Kanal kann automatisch starten;
  weitere Teile/Kanäle erscheinen als Links. Bei mehreren Kanälen werden die
  Dateien nacheinander angeboten, weil Browser mehrere automatische Downloads
  blockieren können. Die UI sagt das offen.
- Ein gemeinsames ZIP aller Kanäle würde eine neue ZIP-Bibliothek und viel
  Speicher brauchen; nicht Teil dieses Plans.

### 8.3 Audio im Export

Wichtig: `exportrecording.cgi` exportiert die Aufnahme **so, wie sie auf der
Kamera liegt**. Die aktuelle VAPIX-Dokumentation nennt keinen
`audio`-Parameter. Ein Haken „Audio einschließen“ kann daher nicht einfach
per API gesetzt werden.

Vorgehen:

1. **Firmware-Test:** Prüfen, ob die Ziel-Firmware `audio=0` (oder einen
   vergleichbaren Parameter) bei `exportrecording.cgi` akzeptiert. Wenn ja,
   ist die Umsetzung trivial und für alle Exportwege gleich.
2. **Fallback über den Remuxer – umgesetzt:** `mkvconcat.js` verwirft die
   Audiospur beim Remuxen (`includeAudio: false`): Audio-`TrackEntry`s werden
   weggelassen, Audio-`SimpleBlock`/`BlockGroup`s übersprungen. Kein
   Transcoding (ADR 0003). Mit einer synthetischen MKV (Video+AAC) geprüft:
   ohne Audio bleibt eine dekodierbare Videospur übrig.
   - **Gemergter Export:** wie bisher über `MkvConcat` – Filter greift direkt.
   - **Einzeldateien (ohne Passwort):** Ja, auch dort ist Entfernen möglich.
     Statt eines direkten Links lädt die App die Datei per `fetch`, schickt sie
     durch `MkvConcat.concat([source], { includeAudio: false })` und speichert
     das Ergebnis als Blob. Das kostet Zwischenspeicher und einen
     Fortschrittsdialog; der Download kommt nicht mehr direkt aus der Kamera.
   - **Passwort/ZIP:** Nein. Ein verschlüsseltes ZIP lässt sich im Browser
     nicht sinnvoll neu schreiben. Die Kombination „ohne Audio“ wird mit
     deutlichem Hinweis abgelehnt, statt still Ton zu behalten.
3. **Wenn die API `audio=0` kann:** alle Wege inklusive ZIP direkt über die
   Kamera; der Remuxer-Filter bleibt nur als Fallback.

UI:

- Checkbox `#expAudio` „Audio einschließen (falls vorhanden)“, sichtbar im
  Export-Bereich, Standard **an**. Kein zusätzlicher Dialog – so bleibt der
  Ein-Klick-Export erhalten.
- `parseRecordings()` erweitert um `hasAudio` (`<audio>`-Kind in der
  Aufnahme). Hat keine sichtbare Aufnahme eine Tonspur, zeigt die Checkbox
  einen Hinweis, bleibt aber bedienbar (der Exportzeitraum kann abweichen).
- Die Checkbox gilt für alle gewählten Kanäle. Kanäle ohne Tonspur werden
  ohne Ton exportiert, ohne den Gesamtexport zu scheitern.

## 9. Schnappschuss

- Pro Kachel ein Schnappschuss; der globale Button wirkt auf die aktive
  Kachel.
- **Live:** weiterhin `/axis-cgi/jpg/image.cgi?camera=N[&resolution=…]` –
  eine im Kachelmenü erzwungene Auflösung wird mitgegeben, sonst liefert die
  Kamera ihr Standardbild. Das ist unabhängig vom laufenden Streamprofil.
- **Wiedergabe/Pause:** sichtbaren Frame aus dem `<video>` in ein `<canvas>`
  zeichnen und als JPEG speichern. Gleiche Origin → Canvas bleibt untainted,
  `toBlob()` funktioniert. Auflösung = sichtbarer Stream, nicht die volle
  Sensorauflösung.
- **Pause:** `holdAt()` schließt heute die Pipeline. Vorher den Frame in
  `tile.lastFrame` (Canvas/ImageBitmap) sichern; der Schnappschuss nutzt ihn
  auch nach dem Schließen. So bleibt Pause weiterhin ressourcenschonend.
- Dateiname mit Kanal und **Frame-Zeit**, nicht mit `Date.now()`:
  `snapshot_ch2_20261126_141530.jpg`; bei manueller Aufnahme zusätzlich die
  Aufnahme-ID/Quelle.
- Deaktiviert nur, wenn kein Frame vorhanden ist (kein Live-Bild, keine
  Wiedergabe, Puffer leer).
- Der bestehende Test „Wiedergabe holt kein Live-JPEG“ wird bewusst ersetzt:
  Wiedergabe speichert künftig den Canvas-Frame, aber weiterhin kein Live-JPEG.

## 10. Ping- und Bandbreitenanzeige

Kleine, unaufdringliche Anzeige in der Topbar, neben dem Speicherstatus:

```
Ping 14 ms   ↓ 4,2 Mbit/s
```

**Ping, alle 5 s:**

- Dedizierte winzige statische Datei `app/html/ping.txt` (Inhalt z. B. `ok`),
  gleiche Origin, keine VAPIX-Last. `fetch('ping.txt?t=' + Date.now(),
  { cache: 'no-store' })`; RTT mit `performance.now()` messen.
- `HEAD` bevorzugen; beantwortet ACAP das nicht, die wenigen Bytes per `GET`
  holen. Timeout 3 s; Fehler zeigen `–`, ohne rot zu blinken.
- Nur bei sichtbarem Tab pingen (`visibilitychange`); beim Zurückkehren sofort
  einmal.
- „Ping“ ist der HTTP-Rundlauf über den Kamera-Webserver, nicht ICMP.

**Bandbreite:**

- Summe von `tile.pipeline?.bitrate` über alle Kacheln (die media-stream-
  library liefert die empfangene Bitrate; auf der Ziel-Firmware verifizieren).
  Anzeige in Mbit/s mit einer Nachkommastelle, Aktualisierung 1×/s.
- Gilt für Live und Wiedergabe; Audio zählt mit. Fehlt ein Wert, `–` zeigen,
  nicht 0.
- Tooltip: „Am Browser eingehend (Summe aller Kacheln), nicht Kamera-Uplink.“
- Auf schmalen Bildschirmen ausblenden oder nur die Bandbreite zeigen.

**Tests:** Formatierung (`formatBitrate`), Summe über mehrere Kacheln,
Ping-Timeout/Fehler, kein Ping bei verstecktem Tab.

## 11. Rechte, Fehler und Grenzen

- **Kamera-Limits:** Sechs gleichzeitige RTSP/MSE-Streams können je nach
  Modell und Firmware das Verbindungslimit überschreiten. Kleinstes Profil,
  gestaffelter Start, Fehler pro Kachel und ein Hinweis „weniger Kacheln oder
  kleineres Profil“ sind Pflicht.
- **Dekodierlast:** Sechs H.264-Streams plus Audio belasten Browser und
  Kamera. Die 6er-Ansicht ist für Substreams gedacht; das Kachelmenü erlaubt
  ein größeres Profil bewusst nur manuell.
- **Audio:** Ohne AAC-fähige Kamera/MSE-Unterstützung bleibt das Icon
  deaktiviert. Kein G.711-Fallback.
- **Streamprofile:** `streamprofile.cgi` kann für Betrachter gesperrt sein;
  dann bleibt nur die Auflösungswahl bzw. der Kamera-Default.
- **Timeline:** Sechs Kanäle mit Paging können viele Requests erzeugen;
  Abbruch, Parallelitätslimit und Cache sind nötig. `complete=false` wird
  weiterhin sichtbar gemeldet.
- **Mehr als 6 Kanäle:** Die ersten 6 liegen auf den Kacheln; jede Kachel kann
  per Menü auf einen anderen Kanal umbelegt werden. Kein Blättern.
- **Rechte:** Aufnahmekonfiguration, Speicher und Audio können je Kanal
  unterschiedlich erlaubt sein; Fehler bleiben kanalbezogen.

## 12. i18n und Persistenz

- Neue Schlüssel in **DE und EN** (beide `i18n.js`-Wörterbücher):
  `layout.auto/1/2/4/6`, `tile.menu`, `tile.channel`, `tile.stream.auto`,
  `tile.stream.unknown`, `tile.audio.on/off/unavailable`, `tile.snapshot`,
  `tile.noRecording`, `tl.exportChannel`, `exp.audio`, `exp.audio.none`,
  `exp.audio.unavailable`, `exp.channelProgress`, `exp.channelFailed`,
  `net.ping`, `net.bandwidth`, `net.unavailable`.
- Bestehende `minivms.*`-Keys bleiben. Neue Keys wie in Abschnitt 3; alte
  globale Stream-/Auflösungswerte dienen höchstens als Startwert für Kanal 1
  und werden nicht überschrieben.
- Der Docker-Build hängt weiterhin `?v=<version>` an lokale CSS/JS-Dateien;
  im Quellcode kein `?v=` hardcodieren.

## 13. Tests

Automatisiert (`node --test tests/app.test.cjs`, hier 40 Tests grün mit Node 25.5; Node 22 ist auf dem System nicht installiert):

- `defaultLayout(n)`: 1 → 1, 2 → 2, 3–4 → 4, ≥5 → 6.
- `rankStreamProfiles()`: größtes/kleinstes Profil, fehlende Auflösung,
  Gleichstand.
- `timelineLanes()`: eine Spur pro sichtbarem Kanal, Blau/Gelb, Überlappung
  gelb; alle Nicht-Ereignis-Typen blau.
- Export: alle Haken an, nicht gesetzte Kanäle übersprungen, ein Kanal ohne
  Material blockiert die anderen nicht, Dateinamen mit `_ch<N>`; Klick auf
  eine Zeit spielt alle Kacheln, Ereignis-Klick nur die Clip-Kachel explizit.
- Audio: pro Kachel an/aus, AAC-Parameter, mehrere Kacheln, Export-Hinweis bei
  fehlender Tonspur, `recAudio` schreibt AAC in neue Profile.
- Schnappschuss: Live → JPEG-Endpunkt; Wiedergabe → Canvas-Frame; Pause →
  gesicherter Frame; Dateiname mit Frame-Zeit.
- Netzstatus: Formatierung, Summe über Kacheln, Ping-Request und Pause bei
  verstecktem Tab.
- Kacheln: ein Fehler stoppt die anderen nicht; Layoutwechsel schließt
  entfernte Pipelines; Fokus wechselt PTZ-Kanal; `stopPipeline` und die
  Zustands-Accessoren wirken nur auf die gewählte/aktive Kachel.
- Layout 1/2/4/6: Auto-Belegung, leere Kacheln, freie Kanalwahl, Umschalten
  per Auswahlfeld; Stream-Defaults größtes/kleinstes Profil.
- Bestehende Tests, die sich ändern: „overlapping event footage has its own
  visible track“, „live badge and snapshot …“, alle direkten Zugriffe auf
  `state.pipeline`/`state.rec`/`element('video')`.

Kameratest (manuell):

1. Kamera mit 1, 2, 4 und 6 Kanälen: Auto-Layout und Umschaltung prüfen.
2. Pro Kachel größtes/kleinstes Profil und manuellen Wechsel prüfen; nur die
   Kachel darf neu verbinden.
3. Timeline: pro Kanal eine Spur, Blau/Gelb, Überlappung gelb; Zoom/Tag/
   Verschieben mit 6 Kanälen.
4. Zeitauswahl, Haken abwählen, Export: nur gewählte Kanäle, Dateien und
   Zeiträume prüfen.
5. Audio: eine und mehrere Kacheln, Live und Wiedergabe, Aufnahme mit/ohne
   Tonspur, Rechte als Betrachter.
6. Export mit/ohne Audio, gemergt, Einzeldateien und ZIP (ohne Audio im ZIP
   wird bewusst abgelehnt).
7. Wiedergabe pausieren und Schnappschuss; Dateiname und Frame prüfen.
8. Netzanzeige: Ping und Bandbreite plausibel, Tab im Hintergrund pausiert den
   Ping.
9. Verbindungslimit provozieren (6 Kacheln, großes Profil) und
   Fehlerisolierung prüfen.

## 14. Umsetzungsetappen

1. **API-Prüfung** (klein): `<audio>` in `list.cgi`, `streamprofile`-
   `parameters`, `exportrecording.cgi` mit `audio`-Parameter, AAC über
   RTSP-over-WebSocket. Ergebnisse in diesen Plan/ADR nachtragen.
2. **Kachel-Refactor ohne sichtbare Änderung – umgesetzt:** Einzelansicht läuft
   über einen Tile-Controller; Kompatibilitäts-Getter für bestehende Tests;
   alle Tests grün (inkl. Kachel-Isolation).
3. **Layouts und Kachelmenü – umgesetzt:** 1/2/4/6, Auto-Standard, leere
   Kacheln, freie Kanalwahl, Streamauswahl mit größtem/kleinstem Profil,
   Fokus; PTZ folgt der aktiven Kachel. Staffelung der Streamstarts und
   Feinheiten folgen im Feinschliff.
4. **Mehrfach-Timeline – umgesetzt:** kanalweise Daten, eine Spur pro Kanal,
   Blau/Gelb, linke Export-Haken (Standard an), gemeinsame/synchrone Zeit.
5. **Mehrkanal-Export – umgesetzt:** Orchestrator, kanalweise Fehler,
   Dateinamen, Fortschritt; Audio-Checkbox, Spur-Filter für gemergte und
   unverschlüsselte Einzeldateien, ZIP-Sperre ohne Audio.
6. **Audio – umgesetzt:** pro Kachel, AAC-Prüfung, Wiedergabe, Persistenz pro
   Kanal; neue Daueraufnahmen können optional AAC-Ton mitschreiben.
7. **Schnappschuss in der Wiedergabe – umgesetzt:** Frame-Sicherung bei Pause,
   Canvas-Export, Dateinamen mit Frame-Zeit.
8. **Netzanzeige – umgesetzt:** `ping.txt`, 5-s-Ping, Bandbreitensumme aus
   den Kacheln.
9. **Feinschliff:** 6-Kanal-Performance/Stream-Staffelung, i18n, README,
   Backlog-Status, ADRs fortschreiben, Kameratest.

ADRs (englisch): `docs/adr/0009-shared-timeline-and-export.md`,
`0010-single-tools-sidebar-and-desktop-keyboard.md`,
`0011-audio-and-recording-ownership.md`, `0012-explicit-no-footage-state.md`.

## 15. Offene Fragen

1. **Kameratest:** AAC über RTSP-over-WebSocket, gleichzeitige Streams in
   4er/6er-Ansicht, echtes Axis-`<audio>` in `list.cgi`, Export mit/ohne Ton
   und Schnappschuss in der Wiedergabe prüfen.
2. **ZIP ohne Audio:** Bewusst gesperrt. Falls die Ziel-Firmware doch einen
   `audio=0`-Parameter bei `exportrecording.cgi` akzeptiert, kann die Sperre
   später entfallen.

Entschieden: 2er-Layout für 2 Kanäle; leere Kacheln; freie Kanalwahl, bei mehr
als 6 Kanälen zunächst die ersten 6; Audio-Checkbox beim Export; Ereignis gelb,
alles andere blau; Tonwahl überlebt den Reload; Mehrfach-Timeline immer
synchron.
