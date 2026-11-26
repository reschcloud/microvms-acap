# ADR 0005: Firmware-Unterschiede an der VAPIX-Grenze behandeln

**Status:** Konservative Zuordnung umgesetzt; Kameratest ausstehend

## Kontext

VAPIX verwendet für `camera=N` einen 1-basierten Kanal, aber `Image.I#` ist 0-basiert. Der frühere Code nahm für Aufnahmequellen zunächst 1-basierte Werte an und wechselte erst bei `source=0`. Ohne Beleg kann derselbe Wert zu zwei verschiedenen Kanälen passen.

## Entscheidung

`selectChannel()` normalisiert nummerierte Quellen vor Timeline, Wiedergabe und Export. Die Kanal-ID der App bleibt 1-basiert. Bei Mehrkanalgeräten sprechen `0` bzw. die physische Kanalanzahl für die jeweilige Nummerierung. Der Quellenkatalog (`listentity=source`) ergänzt die Aufnahmeliste; ohne eindeutigen Beleg oder bei widersprüchlichen Daten bleibt die Zuordnung offen. Ausnahme: Kennen Quellenkatalog und Aufnahmeliste zusammen genau eine nummerierte Quelle, gehören deren Aufnahmen zum ersten aktivierten Kanal (beobachtet: Einzelsensor-Kamera mit `NbrOfViews=2`, Katalog und alle Aufnahmen nur `source=1`). `Quad` gehört zu keinem nummerierten Kanal. Die graue Timeline-Spur erlaubt die bewusste Auswahl einer mehrdeutigen Aufnahme; Wiedergabe und Clip-Export verwenden dann ausschließlich deren ID. Ein kanalbezogener Clip-Export mit mehrdeutigen Treffern bricht weiterhin ab. Bei Ein-Kanal-Geräten bleibt eine fehlende Quelle zulässig.

## Nächster Schritt

Anonymisierte Aufnahmelisten von Mehrkanalgeräten sammeln und die Zuordnung gegen bekannte Kanäle prüfen. Die Mock-Tests prüfen die konservative Entscheidung, belegen aber keine Firmware-Regel.
