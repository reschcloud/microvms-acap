# ADR 0007: Eine Timeline-Spur pro Kanal und kanalbezogener Export

**Status:** Umgesetzt; Kameratest ausstehend

## Kontext

Die Timeline hatte vier Spuren pro Aufzeichnungstyp (Dauer, Ereignis, Zeitplan,
unbekannt) und zeigte nur den aktiven Kanal. In der Mehrfachansicht braucht es
eine vergleichbare Zeitachse für alle sichtbaren Kanäle. Der Export muss
mehrere Kanäle gleichzeitig liefern können, ohne die bestehende
Ein-Klick-Bedienung zu verlieren.

## Entscheidung

- Genau eine Spur pro sichtbarem Kanal; doppelte Kacheln teilen sich eine Spur.
- Alle Aufzeichnungen sind blau, `triggered` ist gelb und liegt darüber. Eine
  Überlappung erscheint dadurch gelb. Eine Typunterscheidung Dauer/Zeitplan/
  unbekannt gibt es in der Timeline nicht mehr.
- Die Zeitachse ist immer synchron: Klick, Zoom und Pause wirken auf alle
  Kacheln. Ein Klick auf einen Ereignisclip startet diesen explizit nur in der
  zugehörigen Kachel; die übrigen springen auf dieselbe Zeit.
- Links an jeder Spur sitzt ein Export-Haken (Standard an, mit Zeitauswahl
  aktiv). Der Export erzeugt pro gewähltem Kanal eine eigene Datei mit
  `_ch<N>` im Namen; Fehler bleiben kanalbezogen.

## Konsequenzen

- Mehrere automatische Downloads können Browser blockieren; nur die erste
  Datei startet automatisch, weitere stehen als Links bereit.
- Das Auflösen mehrerer Kanäle erzeugt mehrere `list.cgi`-Anfragen; Abbruch
  und Paging bleiben pro Kanal erhalten.
- Die graue Leiste bleibt mehrdeutigen Aufnahmen vorbehalten.
