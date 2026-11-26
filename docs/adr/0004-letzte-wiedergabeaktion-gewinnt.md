# ADR 0004: Bei Wiedergabewechseln gewinnt die letzte Aktion

**Status:** Umgesetzt; Kameratest ausstehend

## Kontext

Pipeline-Callbacks prüfen bereits `state.generation`. `playAt()` und der automatische Übergang zur nächsten Aufnahme warten aber vorher auf eine VAPIX-Aufnahmesuche. Ein altes Ergebnis kann daher nach einem Wechsel zu Live, nach einem weiteren Zeitsprung oder nach einem Kanalwechsel noch den aktuellen Zustand überschreiben.

## Entscheidung

Den Wiedergabewunsch bei Beginn jeder Aktion eindeutig kennzeichnen und den gewählten Kanal für die Anfrage festhalten. Nach asynchronen Schritten nur dann Modus, Meldung oder Pipeline ändern, wenn der Vorgang noch aktuell ist. Ein automatischer Übergang darf nur fortfahren, solange seine ursprüngliche Wiedergabe noch aktiv ist. Alte Anfragen abzubrechen kann Last sparen, ersetzt die Gültigkeitsprüfung aber nicht.

## Abnahmekriterien

- Timeline-Klick → sofort Live → verspätete Aufnahmeliste: Live bleibt aktiv.
- Zwei schnelle Zeitsprünge oder ein Kanalwechsel während der Suche: Eine ältere Antwort oder Fehlermeldung überschreibt den neueren Zustand nicht.
- Ein verspäteter automatischer Übergang startet keine Wiedergabe, nachdem die laufende Aufnahme verlassen wurde.
