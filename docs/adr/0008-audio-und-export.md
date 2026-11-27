# ADR 0008: Audio pro Kachel und Audiofilter im Export

**Status:** Umgesetzt; Kameratest ausstehend

## Kontext

Audio war absichtlich deaktiviert (`audio=0`), weil Kameras auch G.711/Opus
liefern. Gefordert sind Ton pro Kachel, mehrere gleichzeitig aktive Kacheln und
eine Exportfrage mit Standard „Audio an“. `exportrecording.cgi` exportiert die
Aufnahme unverändert; die VAPIX-Dokumentation nennt keinen Audio-Parameter.

## Entscheidung

- Live und Wiedergabe fordern nur bei aktiver Kachel
  `audio=1&audiocodec=aac` an; MSE-AAC wird vorher geprüft. G.711/Opus bleiben
  ohne Fallback.
- Ton ist standardmäßig stumm. Die Wahl wird pro Kanal gespeichert und nach
  einem Reload erst nach der ersten Nutzergeste hörbar. Mehrere Kacheln dürfen
  gleichzeitig Ton haben.
- Neue Daueraufnahmen können optional AAC mitschreiben; bestehende Profile
  werden nicht verändert.
- Export: Checkbox „Audio einschließen“ (Standard an). Ohne Audio werden
  gemergte Exporte und unverschlüsselte Einzeldateien über `MkvConcat` neu
  gemuxt und die Audiospur verworfen (kein Transcoding). Bei
  passwortgeschützten ZIPs wird „ohne Audio“ abgelehnt.

## Konsequenzen

- Ob eine Aufnahme Ton hat, hängt von der Aufnahmequelle ab; fehlender Ton ist
  kein Fehler.
- Das Entfernen der Audiospur kostet bei Einzeldateien einen zusätzlichen
  Browser-Remux und damit Speicher/Zeit.
- AAC-Unterstützung von Kamera und Browser muss im Kameratest bestätigt werden.
