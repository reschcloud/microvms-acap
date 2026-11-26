# ADR 0001: Browser-only ACAP, Kamera als Backend

**Status:** Bestehend

## Kontext

Micro VMS wird auf einer Axis-Kamera installiert. Die Kamera stellt Anmeldung, Live-Streams, Edge Storage und PTZ bereits bereit.

## Entscheidung

Die Kamera liefert die statische Oberfläche unter `/local/microvms/index.html` aus. Der Browser nutzt die bestehende Kamera-Anmeldung und spricht VAPIX und RTSP-over-WebSocket direkt auf derselben Origin an. Es gibt keinen eigenen Proxy, Login oder VMS-Dienst. Der Shellprozess `app/microvms` hält ACAP lediglich im Status „Running“, damit die Kamera die Schaltfläche **Open** anbietet. HTML, JavaScript und Shell werden als ein architekturunabhängiges `.eap` paketiert.

## Konsequenzen

Installation und Betrieb bleiben klein. API-Verhalten und Berechtigungen hängen dafür von Kamera und AXIS OS ab. Ein lokaler Preview mit Mock-Antworten kann die Oberfläche prüfen; echtes Streaming und echte Exporte brauchen einen Kameratest. Ein separates Backend wäre erst dann sinnvoll, wenn Funktionen wie kameraübergreifende Verwaltung oder ein eigener Authentifizierungskontext erforderlich werden.
