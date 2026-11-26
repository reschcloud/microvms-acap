# Micro VMS (`microvms-acap`) – ACAP für Axis-Kameras

Ein kleines VMS direkt in der Weboberfläche der Kamera:

- **Live-Ansicht** (H.264 über RTSP-over-WebSocket → HTML5-Video/MSE), Auflösung wählbar, Schnappschuss als JPEG
- **Mehrere Kanäle/Sensoren** (Multisensor-Kameras, Encoder, View Areas, Quad-Ansicht): Kanalauswahl erscheint automatisch, sobald die Kamera mehr als einen Kanal meldet (`Properties.Image.NbrOfViews`, Namen aus `Image.I#.Name`, deaktivierte Kanäle werden ausgeblendet). Live, Timeline, Wiedergabe, Export, Schnappschuss, PTZ und Daueraufzeichnung beziehen sich jeweils auf den gewählten Kanal; beim Kanalwechsel in der Wiedergabe springt die Ansicht zum selben Zeitpunkt des anderen Kanals.
- **Stream-Profile**: Auswahl der auf der Kamera angelegten Profile (`streamprofile.cgi`), H.264 wird dabei erzwungen, damit der Browser es abspielen kann
- **Zweisprachig (Deutsch/English)**: automatisch nach Browsersprache, umschaltbar oben rechts (Auswahl wird gemerkt)
- **Timeline** der Edge-Storage-Aufzeichnungen (SD-Karte / NAS) mit Tagesauswahl, Zoom (Mausrad), Verschieben (Ziehen)
  - Farben: Daueraufzeichnung (blau), Ereignis (orange), Zeitplan (lila)
  - Klick auf die Timeline → Wiedergabe ab diesem Zeitpunkt, automatischer Sprung in die nächste Aufzeichnung
  - ±30 s, Pause (Pause im Live-Modus = Timeshift: „Weiter“ spielt ab dem Pausenzeitpunkt aus der Aufzeichnung)
- **Export** eines Zeitbereichs (auf der Timeline ziehen oder Von/Bis eingeben) als **eine** Matroska-Datei (`.mkv`)
  - Liegt der Zeitraum über mehreren Aufzeichnungen (Unterbrechung, Neustart, Ereignisaufzeichnungen), lädt der Browser die Teil-Exporte nacheinander und fügt sie ohne Neukodierung zu einer Datei zusammen (`html/mkvconcat.js`): fortlaufende Zeitstempel, Lücken übersprungen, mit Dauer, Aufnahmedatum und Index (Cues) → in VLC & Co. normal spulbar
  - Fortschrittsanzeige und Abbrechen
  - Fallback auf Einzeldateien, wenn sich die Videoparameter zwischen den Aufzeichnungen unterscheiden (z. B. Auflösung geändert)
  - Optional passwortgeschützt als ZIP (AES-256) – dann allerdings als Einzeldateien, weil verschlüsselte ZIPs nicht zusammengefügt werden können
- **PTZ-Steuerung** – erscheint nur, wenn die Kamera PTZ kann (`Properties.PTZ.PTZ=yes`) **und** der angemeldete Benutzer PTZ-Rechte hat (Gruppe `ptz` bzw. Admin, ermittelt über `/axis-cgi/usergroup.cgi`)
  - Steuerkreuz und Zoom (gedrückt halten), Geschwindigkeit, Home, Presets anfahren
  - Klick ins Livebild zentriert, Mausrad zoomt auf die Mausposition; Tastatur: Pfeiltasten, + / −
  - Nur in der Live-Ansicht aktiv; bei Fokusverlust/Tabwechsel wird jede Bewegung sofort gestoppt
  - Bedienelemente, die das Gerät laut `ptz.cgi?info=1` nicht kann, werden ausgeblendet
- Statusanzeige SD-Karte, Anzeige/Anlegen einer Daueraufzeichnung

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
| Daueraufzeichnung | `/axis-cgi/record/continuous/listconfiguration.cgi`, `addconfiguration.cgi` |

Das Streaming nutzt Axis' MIT-lizenzierte [media-stream-library-js](https://github.com/AxisCommunications/media-stream-library-js) (v13.3.3, im Paket enthalten unter `html/vendor/`).

## Bauen

Voraussetzung: Docker.

```sh
./build.sh
```

Ergebnis für `v0.1`: `build/Micro_VMS_0_1_0_all.eap` – ein Paket für **armv7hf und aarch64** (reine Web-/Shell-App, kein Kompilieren nötig).

## Installieren

1. Kamera-Weboberfläche → **Apps** → **Add app** → `.eap` hochladen
   (bei signierten Firmwares ggf. vorher *Allow unsigned apps* aktivieren)
2. App starten → **Open**
   bzw. direkt: `http(s)://<kamera>/local/microvms/index.html`

Die frühere App-ID `minivms` wird nicht aktualisiert: AXIS OS behandelt `microvms` als neue App. Alte Lesezeichen müssen auf die neue URL zeigen; Browsereinstellungen bleiben beim Wechsel auf derselben Kamera-Origin erhalten.

Für Aufzeichnungen muss eine SD-Karte/NAS eingerichtet und eine Aufzeichnung konfiguriert sein (Kamera → *Aufzeichnungen* bzw. *System → Speicher*, oder in Micro VMS „Daueraufzeichnung aktivieren“).

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
- Zugriff: Die Seite ist für angemeldete Kamera-Benutzer erreichbar; „Daueraufzeichnung aktivieren“ braucht Operator- oder Admin-Rechte.
- PTZ: Falls `usergroup.cgi` auf einer Firmware fehlt, wird ersatzweise eine harmlose `ptz.cgi?query=position`-Abfrage probiert. Je nach Firmware kann der Browser dabei für Benutzer ohne PTZ-Rechte einmal einen Anmeldedialog zeigen. Gesteuert wird immer Videokanal 1.
- Mehrkanal: Aufzeichnungen werden über ihr `source`-Attribut dem Kanal zugeordnet. Ob die Firmware das 1-basiert (wie `camera=N`) oder 0-basiert (wie `Image.I#`) liefert, ist nicht dokumentiert; die App erkennt 0-basiert automatisch, sobald irgendwo `source="0"` auftaucht. Daueraufzeichnung pro Kanal wird mit `camera=N` in den Optionen angelegt (laut Doku sind dort Stream-Parameter erlaubt, `camera` ist aber nicht explizit genannt).
- Die `vendorId` im Manifest ist ein Platzhalter.
