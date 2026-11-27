# Ideen / Backlog

Keine Zusagen, nur gesammelte Vorschläge mit dem nötigen Kontext.

## PTZ: mehrere Home-Positionen

Stand: `ptz.js` bietet genau einen Home-Button, der `move=home` an
`/axis-cgi/com/ptz.cgi` sendet. Das ist die eine, in AXIS OS hinterlegte
Home-Position des Geräts. Presets der Kamera (`gotoserverpresetname`) sind
bereits auswählbar.

Idee: mehrere eigene Home-Positionen speichern und gezielt anfahren, z. B.
„Einfahrt“, „Tür“, „Hof“ – ohne die Preset-Liste der Kamera zu belegen.

Offene Punkte vor der Umsetzung:

- **Speicherort:** Browser (`localStorage`, wie `minivms.*`) oder Kamera
  (Presets mit Namenspräfix). Kamera-Presets überleben einen Browserwechsel und
  sind für andere Clients sichtbar, verändern aber die Preset-Liste in AXIS OS.
- **Position ermitteln und anfahren:** aktuelle Werte über `ptz.cgi?query=position`
  lesen; zum Wiederherstellen reicht `continuouspantiltmove` mit 0 nicht aus,
  es braucht absolute Werte (`pan`/`tilt`/`zoom`) – auf der Ziel-Firmware prüfen.
- **Bezug:** pro Kamera oder pro Kanal (View Areas teilen sich teils den PTZ-Antrieb).
- **Rechte:** PTZ-Bedienung braucht die Gruppe `ptz` bzw. Admin; Speichern im
  Browser funktioniert auch ohne, das Anfahren nicht.
- **UI:** Home-Button mit kleiner Auswahl (Dropdown oder Presets-Zeile),
  bestehende Bedienung darf nicht enger werden.

## Audio in der Live-Ansicht (umgesetzt)

Stand 2026-11-26: Pro Kachel ein Lautsprecher-Icon, mehrere Kacheln gleichzeitig
möglich, AAC über die MSE-Pipeline (`audio=1&audiocodec=aac`), Tonwahl pro Kanal
in `localStorage`. Nach einem Reload bleibt die Wahl gespeichert, der Ton wird
aber erst nach der ersten Nutzergeste hörbar. Wiedergabe liefert Ton nur, wenn
die Aufnahme eine Tonspur hat. Neue Daueraufnahmen können optional mit
„Mit Ton aufzeichnen (AAC)“ angelegt werden.

Offen: Kameratest (AAC über RTSP-over-WebSocket, Rechte, Mehrfach-Ton) und
Prüfung, ob Zuhören eine eigene AXIS-OS-Gruppe verlangt.

## Schnappschuss in der Wiedergabe (umgesetzt)

Stand 2026-11-26: Live weiterhin über `/axis-cgi/jpg/image.cgi`; in Wiedergabe
und Pause wird der sichtbare Frame per Canvas als JPEG gespeichert. Beim
Pausieren wird der letzte Frame vor dem Schließen der Pipeline gesichert.
Dateiname mit Kanal und Frame-Zeit. Offen: Kameratest mit echten
Wiedergabeframes und pausiertem Bild.
