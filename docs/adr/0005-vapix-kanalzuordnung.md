# ADR 0005: Firmware-Unterschiede an der VAPIX-Grenze behandeln

**Status:** Vorgeschlagen

## Kontext

VAPIX verwendet für `camera=N` einen 1-basierten Kanal, aber `Image.I#` ist 0-basiert. Für das `source`-Attribut von Aufnahmen nimmt der aktuelle Code 1-basierte Werte an, bis er in einer Antwort `source=0` sieht. Ohne diesen Beleg kann derselbe Wert zu zwei verschiedenen Kanälen passen. Fehlende Quellen werden derzeit nicht nach Kanal ausgefiltert.

## Vorschlag

Kanalnummern und Aufnahmequellen an einer gemeinsamen Grenze zur Kamera normalisieren, bevor Timeline, Wiedergabe oder Export sie verwenden. Die Kanal-ID der App bleibt 1-basiert. Eindeutige, fehlende und mehrdeutige Zuordnungen sollen im Datenmodell unterscheidbar sein. Welche Aufnahmen bei unklarer Quelle angezeigt, abgespielt oder exportiert werden dürfen, ist vor der Umstellung explizit zu entscheiden, nicht pro Funktion nebenbei.

## Nächster Schritt

Anonymisierte Aufnahmelisten von Mehrkanalgeräten sammeln und die Zuordnung gegen bekannte Kanäle prüfen. Testfälle sollen 0- und 1-basierte Antworten, fehlende Quellen, deaktivierte Kanäle und eine Teilliste ohne `source=0` abdecken. Bis diese Daten vorliegen, keine Firmware-Regel als gesichert dokumentieren.
