# Netzplaner

Interaktiver Netzwerkplaner für Homelab-Netze, als statische Website in Nginx.
Version 1.1.0 erweitert Geräte, Ports und Verbindungen um Suche, Filter,
Änderungsverlauf, Planungshinweise und zusätzliche Exporte.

## Funktionen

- Geräte nach Name, IP-Adresse, Standort oder Notizen suchen und nach Typ filtern.
  Die Porttabelle zeigt wahlweise alle, freie, belegte oder PoE-Ports.
- Geräte mit Notizen dokumentieren und duplizieren. Kopien erhalten eigene Geräte-
  und Port-IDs, freie Ports und eine leere IP-Adresse.
- Verbindungen anlegen, suchen, bearbeiten und trennen. Bereits belegte Ports werden
  in der Auswahl gekennzeichnet und können nicht erneut verbunden werden.
- Änderungen in der laufenden Sitzung bis zu 50 Schritte rückgängig machen und
  wiederholen, auch nach Import, Löschungen oder dem Wechsel zu einem leeren Plan.
  Tastenkürzel: `Ctrl+Z`, `Ctrl+Shift+Z` beziehungsweise `Ctrl+Y`;
  unter macOS auch mit der Befehlstaste. Der Verlauf wird beim Neuladen verworfen.
- Große Topologien scrollen und zoomen. Geräte lassen sich auch mit der Tastatur
  auswählen; die Bedienung ist für schmale Bildschirme angepasst.
- Mehrfach belegte Ports, ungültige und doppelte IPv4-/IPv6-Adressen erkennen.
  Unterschiedliche VLANs zweier Access-Ports und abweichende Portgeschwindigkeiten
  liefern Planungshinweise. Die App fragt keine Geräte im Netz ab und prüft weder
  tatsächliche Erreichbarkeit noch die ausgehandelte Verbindung.
- Den gesamten Plan als JSON sichern und vorhandene Pläne mit Prüfung und
  Bestätigung importieren. Geräteinventar und Belegungszahlen als CSV exportieren,
  die Topologie als eigenständige SVG-Datei speichern oder die Ansicht drucken.

CSV-Dateien enthalten das gesamte Geräteinventar unabhängig vom Suchfilter und
verwenden Semikolon-Trennzeichen sowie einen UTF-8-BOM. Textzellen werden geschützt,
damit typische Tabellenformeln aus Namen oder Standorten nicht ausgeführt werden.
Ein JSON-Export enthält zusätzlich Ports, Verbindungen und Notizen und eignet sich
zum Wiederherstellen eines vollständigen Plans.

## Schnellstart mit Docker

Voraussetzung: Git, Docker mit Linux-Containern und Docker Compose v2.
Das Repository klonen und den Container bauen und starten:

```sh
git clone https://github.com/sm-it-at/netzplaner.git
cd netzplaner
docker compose up -d --build
docker compose ps
```

Danach auf dem Docker-Host öffnen: **http://localhost:8080**.
Beim ersten Build lädt Docker das offizielle Nginx-Basisimage herunter.
Es ist über Version und Prüfsumme festgelegt und unterstützt Linux amd64 / x86-64
und ARM64. Node.js, Python und eine Datenbank sind für den Container nicht erforderlich.
Die App selbst arbeitet ohne externe Dienste.

Ein vorgefertigtes Image-Archiv für Version 1.1.0 ist nicht Teil dieses Repositories.
Der Schnellstart baut das Image aus dem aktuellen Quellcode. Die früheren Nachweise
zu einem separat erstellten Image der Version 1.0.0 stehen in [PRUEFUNG.md](PRUEFUNG.md).

## Zugriff aus dem Heimnetz

Standardmäßig wird nur `127.0.0.1:8080` des Docker-Hosts verwendet.
Für Zugriff über eine andere Maschine eine Datei `.env` neben `compose.yaml` anlegen:

```dotenv
BIND_ADDRESS=0.0.0.0
PORT=8080
```

Danach `docker compose up -d` ausführen und `http://IP-DES-DOCKER-HOSTS:8080` öffnen.
Alternativ lässt sich statt `0.0.0.0` die konkrete LAN-IP des Hosts eintragen.
Die Docker-Version besitzt keinen ChatGPT-Login. Für Zugriff aus dem Internet
eine eigene Anmeldung am Reverse Proxy verwenden. Der Container spricht intern HTTP auf Port 8080.

## Vorhandene Pläne übernehmen und sichern

1. Auf der bisherigen Sites-URL **Exportieren** wählen und die JSON-Datei speichern.
2. Die neue Docker-URL öffnen und die Datei mit **Importieren** laden.
3. Für Backups regelmäßig **JSON sichern** verwenden.

Ein Import ersetzt den aktuellen Plan erst nach Bestätigung. Fehlerhafte Einträge
werden geprüft; notwendige Reparaturen oder ausgelassene Verbindungen erscheinen
als Hinweise vor der Übernahme. Der vorherige Plan bleibt während der Sitzung über
**Rückgängig** erreichbar.

Findet die App beschädigte Daten im Browser-Speicher, bleibt das gespeicherte Original
geschützt: Automatisches Überschreiben ist zunächst gesperrt. Über **Original sichern**
die unveränderten gespeicherten Daten herunterladen und anschließend einen geprüften
Plan importieren. Ein ausdrücklich bestätigter Import, leerer Plan oder Beispieldatensatz
kann den gespeicherten Plan ersetzen. Die sichtbare Speicheranzeige meldet auch
fehlgeschlagene Schreibvorgänge; dann den aktuellen Plan per JSON sichern.

Die Daten liegen ausschließlich im Browser (`localStorage`, Schlüssel `netzplaner-v1`).
Eine andere Domain, ein anderer Port, HTTP/HTTPS oder ein anderes Browserprofil
verwendet einen eigenen Speicher. Es gibt keine Synchronisation zwischen Browsern
oder Geräten und kein Backend für Netzpläne.
Containerneustarts löschen die Browserdaten nicht; ein Docker-Volume ist deshalb nicht erforderlich.
Das Image enthält nur den App-Code und Beispieldaten, keine persönlichen Netzpläne.
Das Löschen der Browserdaten entfernt auch lokal gespeicherte Pläne.

## Betrieb

```sh
# Status und Protokoll
docker compose ps
docker compose logs --tail 50 netzplaner

# Erreichbarkeit (Linux/macOS; unter Windows curl.exe verwenden)
curl -fsS http://localhost:8080/healthz

# Stoppen
docker compose down
```

Der Container läuft als Benutzer `101:101`, mit schreibgeschütztem Dateisystem
und einem temporären Verzeichnis unter `/tmp`. Compose prüft die Erreichbarkeit regelmäßig.

## Herkunft und Prüfung

Quelle: Netzplaner, Sites-Version 1, Projekt `appgprj_6aacd418d2e4819196af072953d42453`,
Quellstand `fcea38ae38a80793ff165b4372f9fa9b3dc7c41d`.
Diese ursprüngliche Version bildet die Grundlage der Docker-App; Version 1.1.0
entwickelt die Laufzeitdateien und Tests weiter.

Für Entwicklung und Tests werden Node.js 26 oder eine von jsdom unterstützte
Version ab Node.js 22.22.2 (22.x) beziehungsweise 24.15.0 (24.x) sowie npm benötigt:

```sh
npm ci
npm test
```

Die Testsuite umfasst Modelltests und DOM-Integrationstests mit jsdom.
Diese Entwicklungsabhängigkeiten werden für den Nginx-Container nicht benötigt.
Prüfergebnisse, historische Nachweise und offene Laufzeitprüfungen stehen in
[PRUEFUNG.md](PRUEFUNG.md).

Technische Referenzen: [offizielles Nginx-Image](https://hub.docker.com/_/nginx),
[Docker Compose](https://docs.docker.com/reference/compose-file/services/).
