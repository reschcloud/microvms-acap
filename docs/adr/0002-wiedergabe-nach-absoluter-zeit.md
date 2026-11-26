# ADR 0002: Wiedergabe nach absoluter Zeit

**Status:** Bestehend

## Kontext

Die Timeline zeigt Aufnahmen aus mehreren Dateien und gegebenenfalls mehreren Kanälen. Ein Video-Offset ist nur innerhalb einer bestimmten Aufnahme sinnvoll; beim Kanalwechsel soll der angezeigte Zeitpunkt erhalten bleiben.

## Entscheidung

Timeline, Timeshift und Kanalwechsel beziehen sich auf absolute Zeitpunkte in Unix-Millisekunden. VAPIX bekommt UTC-Zeitangaben; die Oberfläche zeigt lokale Browserzeit. Erst beim Start der Wiedergabe rechnet `playAt()` den Zielzeitpunkt in einen aufnahmebezogenen RTSP-Offset in Sekunden um. Bei Überlappungen bevorzugt die Aufnahmesuche eine Daueraufnahme. In einer Lücke springt sie zur nächsten verfügbaren Aufnahme; ohne Treffer hält die Wiedergabe am Zielzeitpunkt an. Sehr nahe an der Gegenwart schaltet `playAt()` auf Live.

## Konsequenzen

Zeitsprung und Kanalwechsel brauchen keinen gemeinsamen Medien-Offset. Die Wiedergabeuhr verwendet die NTP-Zeit aus `onSync`, wenn sie nahe genug am erwarteten Startzeitpunkt liegt; sonst zählt sie ab dem erwarteten Startzeitpunkt anhand der Medienzeit weiter. Ob die Zuordnung auf verschiedenen Firmwares stimmt, muss auf Hardware geprüft werden.
