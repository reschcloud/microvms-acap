# ADR 0006: Mehrfachansicht mit gemeinsamer Zeit

**Status:** Umgesetzt; Kameratest ausstehend

## Kontext

Die Oberfläche hatte genau eine Pipeline, einen Kanal und einen `#video`-Block.
Gefordert sind 1er-, 2er-, 4er- und 6er-Ansichten, freie Kanalwahl und
Streamprofile pro Kachel. Eine gemeinsame Zeit ist für den Vergleich von
Kanälen und für den Export wichtiger als unabhängige Playheads.

## Entscheidung

- Sechs feste Kachel-Slots im DOM; sichtbar ist eine Teilmenge (`layoutSize`).
- Jede sichtbare Kachel hat einen eigenen Controller mit eigener Pipeline,
  Generation, Abbruchlogik und Fehlerstatus.
- Eine gemeinsame Wanduhr treibt Sprünge, Pause und Wiedergabe. Jede Kachel
  löst für ihren Kanal selbstständig die passende Aufnahme auf; fehlt Material,
  hält nur diese Kachel an.
- Fokus (Klick) bestimmt PTZ, Seitenleiste und Schnappschuss. Globale
  Bedienelemente wirken auf alle sichtbaren Kacheln.
- Streamprofile: Einzelansicht nimmt das größte, Mehrfachansicht das kleinste
  auflösbare Profil; eine explizite Wahl wird pro Kanal gespeichert.

## Konsequenzen

- Fehler und Verbindungslimits bleiben pro Kachel sichtbar; sechs Streams
  können je nach Kamera zu viel sein (kleinstes Profil als Standard, Staffelung
  als Feinschliff offen).
- Die alte Einzelansicht bleibt als ein sichtbarer Slot erhalten.
- Die Timeline zeigt später alle sichtbaren Kanäle, nicht nur die aktive
  Kachel.
