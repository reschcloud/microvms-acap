# ADR 0003: Export ohne Transcoding, mit Rückfall auf Einzeldateien

**Status:** Bestehend

## Kontext

Ein gewählter Zeitraum kann mehrere Aufnahmen, Überlappungen und Lücken enthalten. VAPIX liefert einzelne Ausschnitte, während die Oberfläche nach Möglichkeit eine einzige abspielbare Datei anbieten soll.

## Entscheidung

Der Browser bildet nicht überlappende Segmente und gibt Daueraufnahmen Vorrang. Einen einzelnen Ausschnitt oder einen Export ohne Zusammenführung lädt er direkt von der Kamera herunter. Bei aktivierter Zusammenführung liest `mkvconcat.js` die MKV-Teile nacheinander als Streams, prüft die Spuren und Codec-Parameter, schreibt fortlaufende Zeitstempel und erzeugt einen Suchindex. Lücken erscheinen dadurch nicht als Leerlauf in der Ausgabedatei. Bei inkompatiblen Teilen oder passwortgeschütztem ZIP werden Einzeldateien heruntergeladen. Andere Fehler werden gemeldet, statt sie als Inkompatibilität zu behandeln.

## Konsequenzen

Kein Transcoder und kein Exportdienst sind nötig. Die Ausgabe wird trotzdem als Blob im Browser aufgebaut; große Exporte bleiben ressourcenabhängig. Da die Wiedergabezeit der Ausgabedatei lückenlos ist, entspricht sie nach der ersten Aufnahmelücke nicht mehr der Originalzeit.
