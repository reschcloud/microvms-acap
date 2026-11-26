# Micro VMS (`microvms-acap`) – ACAP für Axis-Kameras

Ein kleines VMS direkt in der Weboberfläche der Kamera:

- **Live-Ansicht** (H.264 über RTSP-over-WebSocket → HTML5-Video/MSE), Auflösung unter Videoeinstellungen, Live-Schnappschuss als JPEG
- **Mehrere Kanäle/Sensoren** (Multisensor-Kameras, Encoder, View Areas, Quad-Ansicht): Die Kanalauswahl sitzt zusammen mit den Videoeinstellungen unten rechts im Videobild, sobald die Kamera mehr als eine Ansicht meldet – auch ohne SD-Karte (`Properties.Image.NbrOfViews`, Namen aus `Image.I#.Name`, deaktivierte Kanäle sind nicht auswählbar). Live, Timeline, Wiedergabe, Export, Schnappschuss, PTZ und Daueraufzeichnung beziehen sich jeweils auf den gewählten Kanal; beim Kanalwechsel in der Wiedergabe springt die Ansicht zum selben Zeitpunkt des anderen Kanals.
- **Stream-Profile**: Auswahl der auf der Kamera angelegten Profile (`streamprofile.cgi`), H.264 wird dabei erzwungen, damit der Browser es abspielen kann
- **Zweisprachig (Deutsch/English)**: automatisch nach Browsersprache, umschaltbar oben rechts (Auswahl wird gemerkt)
- **Timeline** der Edge-Storage-Aufzeichnungen (SD-Karte / NAS) mit Kalendertagen, Zoom (Mausrad), Verschieben (Ziehen) und direktem Sprung zu Datum/Uhrzeit
  - Getrennte Spuren: Daueraufzeichnung (blau), Ereignis (orange), Zeitplan (lila); ein Klick auf einen orangefarbenen Abschnitt öffnet den Ereignisclip auch bei gleichzeitiger Daueraufnahme.
  - Klick auf die Timeline → Wiedergabe ab diesem Zeitpunkt, automatischer Sprung in die nächste Aufzeichnung
  - ±30 s, −5 s, Pause (Pause im Live-Modus = Timeshift: „Weiter“ spielt ab dem Pausenzeitpunkt aus der Aufzeichnung); Bedienelemente mit Inline-SVG-Icons
- **Clip exportieren**: Zeitraum im Formular oder auf der Timeline wählen, **Export starten** – der Download beginnt sofort, ohne Zwischendialog. Aufnahmelücken und die Anzahl der Teile stehen danach unter den Buttons. Die Kamera kann Ausschnitte am vorherigen Keyframe beginnen; exportiertes Material kann daher vor dem gewählten Start liegen.
  - Liegt der Zeitraum über mehreren Aufzeichnungen (Unterbrechung, Neustart, Ereignisaufzeichnungen), lädt der Browser die Teil-Exporte nacheinander und fügt sie ohne Neukodierung zu einer Datei zusammen (`html/mkvconcat.js`): fortlaufende Zeitstempel, Lücken übersprungen, mit Dauer, Aufnahmedatum und Index (Cues) → in VLC & Co. normal spulbar
  - Fortschrittsanzeige und Abbrechen
  - Fallback auf Einzeldateien, wenn sich die Videoparameter zwischen den Aufzeichnungen unterscheiden (z. B. Auflösung geändert)
  - Optional passwortgeschützt als ZIP (AES-256) – dann allerdings als Einzeldateien, weil verschlüsselte ZIPs nicht zusammengefügt werden können
- **PTZ-Steuerung** – erscheint nur, wenn die Kamera PTZ kann (`Properties.PTZ.PTZ=yes`) **und** der angemeldete Benutzer PTZ-Rechte hat (Gruppe `ptz` bzw. Admin, ermittelt über `/axis-cgi/usergroup.cgi`)
  - Steuerkreuz und Zoom (gedrückt halten), Geschwindigkeit, Home, Presets anfahren
  - Klick ins Livebild zentriert, Mausrad zoomt auf die Mausposition; Tastatur: Pfeiltasten, + / −
  - Nur in der Live-Ansicht aktiv; bei Fokusverlust/Tabwechsel wird jede Bewegung sofort gestoppt
  - Bedienelemente, die das Gerät laut `ptz.cgi?info=1` nicht kann, werden ausgeblendet
- **Aufnahmestatus** am Livebild: „Aufnahme läuft“ nur bei einer von der Kamera als laufend gemeldeten Aufnahme. Ein klassisches Daueraufnahmeprofil allein gilt als „konfiguriert“. Dort und in der Speicheranzeige steht auch, wenn die SD-Karte nicht beschreibbar ist. Eine Daueraufzeichnung lässt sich in der Seitenleiste für den gewählten Kanal starten und wieder beenden (Profil wird entfernt).

Kein eigener Server-Prozess: Die Oberfläche spricht direkt die VAPIX-APIs der Kamera an (gleiche Origin, die Anmeldung an der Kamera wird mitverwendet).

| Funktion | API |
|---|---|
| Live / Wiedergabe | `/rtsp-over-websocket` → `rtsp://…/axis-media/media.amp?…` (`recordingid=` + `Range: npt=` für Wiedergabe) |
| Timeline | `/axis-cgi/record/list.cgi` |
| Export | `/axis-cgi/record/export/exportrecording.cgi` |
| Kanäle | `param.cgi?…Properties.Image.NbrOfViews`, `param.cgi?…group=Image` → `camera=N` |
| Stream-Profile | `/axis-cgi/streamprofile.cgi` (`list`) → `streamprofile=…` |
| Speicher | `/axis-cgi/disks/list.cgi` |
| PTZ | `/axis-cgi/com/ptz.cgi`, Rechte: `/axis-cgi/usergroup.cgi`, `param.cgi?…Properties.PTZ.PTZ` |
| Daueraufzeichnung | `/axis-cgi/record/continuous/listconfiguration.cgi`, `addconfiguration.cgi`, `removeconfiguration.cgi` |

Das Streaming nutzt Axis' MIT-lizenzierte [media-stream-library-js](https://github.com/AxisCommunications/media-stream-library-js) (v13.3.3, im Paket enthalten unter `html/vendor/`).

## Bauen

Voraussetzung: Docker.

```sh
./build.sh
```

Ergebnis: `build/Micro_VMS_<version>_all.eap` – ein Paket für **armv7hf und aarch64** (reine Web-/Shell-App, kein Kompilieren nötig).

Gemockte Tests ohne npm-Abhängigkeiten: `node --test tests/app.test.cjs` (Node 22).

## Release

Ein gepushtes Tag `v<version>` baut das Paket in GitHub Actions und legt den
Release mit angehängtem `.eap` an (`.github/workflows/release.yml`). Der
Workflow bricht ab, wenn Tag und `version` in `app/manifest.json` nicht
übereinstimmen:

```sh
./release.sh 0.2.4     # Version setzen, committen, taggen, pushen
```

Für ein bereits vorhandenes Tag ohne Release: Actions → **Release** →
**Run workflow** mit dem Tag als Eingabe.

## Installieren

1. Kamera-Weboberfläche → **Apps** → **Add app** → `.eap` hochladen
   (bei signierten Firmwares ggf. vorher *Allow unsigned apps* aktivieren)
2. App starten → **Open**
   bzw. direkt: `http(s)://<kamera>/local/microvms/index.html`

Die frühere App-ID `minivms` wird nicht aktualisiert: AXIS OS behandelt `microvms` als neue App. Alte Lesezeichen müssen auf die neue URL zeigen; Browsereinstellungen bleiben beim Wechsel auf derselben Kamera-Origin erhalten.

Für Aufzeichnungen muss eine SD-Karte/NAS eingerichtet und eine Aufzeichnung konfiguriert sein (Kamera → *Aufzeichnungen* bzw. *System → Speicher*, oder in Micro VMS **Daueraufnahme starten**).

### Kameratest

1. Paket installieren, App öffnen und mit eingesetzter SD-Karte die Speicheranzeige prüfen. Falls noch nichts aufzeichnet: als Operator/Admin eine Daueraufnahme starten oder sie in AXIS OS einrichten. Prüfen, dass die App erst bei laufender Aufnahme „Aufnahme läuft“ meldet.
2. Eine bekannte Uhrzeit in der Timeline oder per Datumsfeld öffnen. Direkt danach **Zurück zu Live** wählen. Eine verspätete Suche darf nicht zurück in die Wiedergabe wechseln.
   Falls Treffer keinem Kanal eindeutig zugeordnet werden können, die graue Spur anklicken und die Aufnahme unter dem Videobild auswählen. Der anschließende Clip-Export verwendet in diesem Modus nur diese eine Aufnahme.
3. Einen Bereich wählen und **Export starten**. Der Download beginnt sofort; Datei, Bildinhalt, Zeitraum und Spulbarkeit kontrollieren. Falls möglich, einen Export über eine Aufnahmelücke testen.
4. Als Betrachter prüfen, dass Livebild und Timeline weiterhin nutzbar sind, auch wenn der Speicherstatus nicht gelesen werden darf. Nach einem Kameraneustart Livebild, laufende Aufnahme und alte Aufnahmen erneut prüfen.

## Projektstruktur

```
microvms-acap/
├── Dockerfile               # ACAP Native SDK 12.11 Build-Container
├── build.sh
└── app/
    ├── manifest.json        # schemaVersion 2.2.0, architecture "all", settingPage index.html
    ├── microvms             # Platzhalter-Prozess (hält die App im Status "Running")
    ├── LICENSE
    └── html/
        ├── index.html
        ├── style.css
        ├── i18n.js          # Übersetzungen DE/EN
        ├── app.js           # Hauptlogik
        ├── ptz.js           # PTZ-Steuerung (nur mit Rechten sichtbar)
        ├── mkvconcat.js     # Matroska-Zusammenfügen im Browser (streamend, ohne Neukodierung)
        └── vendor/media-stream-library.min.js
```

## Hinweise / Grenzen

- **Ungetestet auf echter Hardware.** Die UI wurde gegen gemockte VAPIX-Antworten getestet; Streaming und Export konnten ohne Kamera nicht geprüft werden. Am ehesten anzupassen: Wiedergabe-Offset (`npt`) und Zeitzuordnung (`onSync`) bei manchen Firmwares.
- Zeiten werden in der Zeitzone des Browsers angezeigt; die Kamera arbeitet intern mit UTC.
- Beim zusammengefügten Export entsteht die Datei im Browser. Sehr lange Zeiträume (viele GB) brauchen entsprechend Platz; Chrome/Edge lagern große Dateien auf die Festplatte aus. Der Zusammenfüger wurde mit echten H.264-MKV-Dateien getestet (lückenlose Zeitstempel, Dekodieren und Spulen per ffmpeg geprüft), aber noch nicht mit echten Axis-Exporten.
- Exportformat ist Matroska (`.mkv`, z. B. VLC). MP4-Export wird nicht von allen Geräten unterstützt.
- Audio ist deaktiviert (`audio=0`), damit Kameras mit G.711/Opus nicht an MSE scheitern.
- Neuere AXIS OS (12+) können Aufzeichnungen über *Aufzeichnungsgruppen* verwalten. Liste/Wiedergabe/Export funktionieren weiterhin über die obigen APIs, die Anzeige „Daueraufzeichnung“ bezieht sich aber nur auf die klassische Continuous-Recording-API.
- Die Timeline zählt separat gemeldete Ereignisclips, nicht einzelne Auslösungen innerhalb einer gruppierten Daueraufnahme. Wenn AXIS OS mehrere Aktionen in einer Aufnahme zusammenfasst und dafür keine separaten Clips meldet, lassen sich daraus keine Ereigniszeitpunkte ableiten.
- Zugriff: Die Seite ist für angemeldete Kamera-Benutzer erreichbar; Starten und Beenden der Daueraufzeichnung brauchen Operator- oder Admin-Rechte.
- PTZ folgt dem gewählten Kanal. Falls `usergroup.cgi` fehlt, prüft die App die Berechtigung ersatzweise per Positionsabfrage für Kanal 1. Je nach Firmware kann dabei einmal ein Anmeldedialog erscheinen.
- Mehrkanal: Nummerierte Quellen werden nur zugeordnet, wenn die Antwort Hinweise auf 0- oder 1-basierte Nummerierung liefert. `Quad` und mehrdeutige Quellen werden nicht als Aufnahmen eines nummerierten Kanals ausgegeben. Für die klassische Daueraufzeichnung sendet die App `camera=N` in den Stream-Optionen; das muss auf der jeweiligen Firmware geprüft werden.
- Die `vendorId` im Manifest ist ein Platzhalter.
