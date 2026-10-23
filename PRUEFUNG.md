# Prüfstand vom 23-10-2026

## Aktueller Quellstand: Version 1.3.0

App und Scanner laufen in einem Container. Funktionsumfang, Scanner-API und
Datenformat bleiben gleich; gespeicherte Pläne und JSON-Exporte werden unverändert
gelesen.

### Änderungen

- **Ein Image:** `nginx:1.30.6-alpine@sha256:47928bf6…` (Alpine 3.24.3), dazu aus
  Alpine 3.24 `python3` 3.14.8, `nmap` 7.99 und `tini` 0.19.0. `scanner/Dockerfile`
  und der Compose-Dienst `scanner` samt Profil `scan` entfallen.
- **Prozessmodell:** `tini -g` ist PID 1 und startet `docker/entrypoint.sh`. Das Skript
  startet den Scanner nur bei gesetztem `SCAN_TOKEN`, und zwar in einer
  Neustart-Schleife mit 5 Sekunden Pause. Danach ersetzt es sich durch Nginx; Nginx
  erbt `SCAN_TOKEN` und `SCAN_ALLOWED_CIDRS` nicht. Das Stoppsignal ist SIGTERM, das
  der Scanner mit seinem vorhandenen Handler geordnet verarbeitet.
- **Kein Docker-DNS mehr:** Der Scanner lauscht auf `127.0.0.1:8090`, Nginx leitet ohne
  `resolver` dorthin weiter. Anlass war der Ausfall vom 23-10-2026: Ein Scanner-Container,
  der außerhalb von Compose neu erstellt worden war, hatte den DNS-Alias `scanner`
  verloren.
- **Im Image festgelegt:** Benutzer `101:101`, Entrypoint, Stoppsignal und Healthcheck.
  `docker/healthcheck.sh` prüft Nginx und, bei gesetztem Token, den Scanner. Diese
  Einstellungen überstehen damit auch eine Neuerstellung außerhalb von Compose.
- **Compose:** ein Dienst mit `pids_limit 128`, `mem_limit 256m` und `cpus 1.0`. Nginx
  läuft mit `worker_processes 2`, weil sich `auto` nach den CPUs des Hosts richtet.
- **Konfiguration:** Leere Einträge in `SCAN_ALLOWED_CIDRS` (abschließendes Komma)
  werden ignoriert. Ist der Scanner deaktiviert, nennt die App den festen Grund aus
  `/api/scan/status`. Die 503-Antworten von Nginx und App nennen `SCAN_TOKEN` und
  `SCAN_ALLOWED_CIDRS`.
- **Zeilenenden:** `.gitattributes` erzwingt LF für Shell-Skripte.
- **Standard-Bindung:** `BIND_ADDRESS` ist ohne `.env` jetzt `0.0.0.0` statt `127.0.0.1`
  (Wunsch Kaarl), die App ist also ohne weitere Konfiguration im Heimnetz erreichbar.
  Intern bleibt alles auf Loopback: Scanner, Nginx-Weiterleitung und Healthcheck.

### Prüfungen am 23-10-2026

- **Lokal (Windows, Node.js 26.8.1):** 63 JavaScript-Tests bestanden, außerdem 27
  Python-Tests unter Python 3.13.15 und 3.14.7. Davon wurden 2 Entrypoint-Tests
  übersprungen, weil Windows keine Prozessgruppen hat. Gegenprobe gegen 1.2.1: Die
  neuen Tests schlagen dort fehl.
- **Build auf `pve-docker`** (Docker 29.9.1, Compose v5.6.0):
  - Build erfolgreich, Image 114.612.472 Byte. Zum Vergleich 1.2.1: App-Image 62,4 MB
    plus Scanner-Image 63,2 MB.
  - Im Image: Alpine 3.24.3, Python 3.14.8, Nmap 7.99, tini 0.19.0, Nginx 1.30.6.
    `nginx -t` erfolgreich.
  - Alle 27 Python-Tests im Image bestanden, auch die Entrypoint-Tests mit
    BusyBox-`sh`.
- **Testcontainer** (Compose-Projekt `netzplaner-test` auf `127.0.0.1:18080`, eigenes
  Test-Token, Freigabe `10.200.0.0/24`):
  - Status `healthy`, `/api/scan/status` liefert `{"enabled":true,"reason":""}`, der
    CSP-Header ist gesetzt.
  - Prozessbaum: `tini` → Nginx-Master → `sh`-Schleife → `python3`, dazu 2 Worker.
    `pids_limit 128`, 256 MiB, `read_only`, `cap_drop: ALL` und `no-new-privileges`
    sind aktiv.
  - Scanner per SIGTERM beendet: Logzeile „Scanner beendet (Code 0), Neustart in 5 s“,
    nach 5,06 s wieder bereit.
  - Echter Scan „Geräte suchen“ auf `10.200.0.11`, den Docker-Host selbst:
    abgeschlossen, Gerät gefunden.
  - `docker stop` in 287 ms mit Exit-Code 0.
  - Ohne Token: Container `healthy`, `/api/scan/status` antwortet mit 503 und dem neuen
    Hinweis, das Log meldet „Scanner nicht gestartet“.
  - Danach wurden Testcontainer, Netz und Test-Images entfernt. Der laufende Stack
    blieb unberührt.

Weiterhin offen: die Umstellung des laufenden Stacks auf `pve-docker`, das Profil
„Häufige TCP-Ports“ über ein ganzes /24 und eine Browserprüfung der geänderten
Scanner-Hinweise.

## Historischer Prüfstand: Version 1.2.1

Fehlerbehebung und Härtung auf Basis von 1.2.0. Funktionsumfang und Datenformat
bleiben gleich; gespeicherte Pläne und JSON-Exporte aus 1.2.0 werden unverändert
gelesen. Pläne bleiben im Browser erhalten, solange Adresse und Port der App gleich
bleiben.

### Änderungen

- **Portprofil für /24-Netze (Scanner):** Bis 1.2.0 lief „Häufige TCP-Ports“ mit
  `-Pn` gegen jede Adresse des Ziels. Bei `--max-rate 50` braucht ein /24 dafür
  mindestens 256 × 29 / 50 = 148,5 Sekunden ohne eine einzige Wiederholung; die
  harte Grenze liegt bei 180 Sekunden. Außerdem bildet Nmap bei 29 TCP-Ports
  Hostgruppen von 64 Geräten (`determineScanGroupSize()` in `scan_engine.cc`:
  `MAX(1024 / 29, 64)`), verteilt die Probes reihum auf alle Geräte der Gruppe und
  startet die Uhr von `--host-timeout` mit der ersten Port-Probe eines Geräts. Eine
  Gruppe braucht so mindestens 64 × 29 / 50 = 37,1 Sekunden und überschreitet die
  30 Sekunden je Gerät. Abgelaufene Geräte fehlen im Ergebnis, ohne dass der Scan
  als fehlgeschlagen gilt. 1.2.1 sucht zuerst mit denselben sechs TCP-Probes wie
  „Geräte suchen“ und prüft danach nur erreichbare Geräte in Gruppen zu höchstens
  acht (`--max-hostgroup 8`): höchstens 8 × 29 × 2 / 50 = 9,3 Sekunden je Gruppe
  einschließlich einer Wiederholung. Folge: Geräte, die alle sechs Such-Probes
  filtern, fehlen jetzt auch in diesem Profil. Grundlage ist der Nmap-Quelltext
  (Stand `master`, 23-10-2026), keine Messung.
- **Hinweise statt Sammelmeldung:** Endet ein Scan an der 180-Sekunden-Grenze, nennt
  die App das samt Abhilfe. Weist der Scanner Start oder Abbruch ab, weil `Origin`
  und `Host` nicht übereinstimmen, verweist die App auf den Host-Header des Reverse
  Proxy statt auf eine angeblich fehlende Netzfreigabe. Beide Texte stehen in einer
  festen Liste; alle anderen Servertexte bleiben verborgen.
- **Zieleingabe:** Ein Netz mit gesetzten Hostbits wie `192.168.1.77/24` wird vor dem
  Senden mit der passenden Netzadresse beantwortet (`192.168.1.0/24`). Bisher kam
  dafür die allgemeine Meldung „Bitte Scanbereich und Profil prüfen.“
- **IDs:** `uid()` kombiniert einen Sitzungszähler mit 48 Zufallsbits aus
  `crypto.getRandomValues()`, das anders als `crypto.randomUUID()` auch über
  einfaches HTTP verfügbar ist. Vorher waren es fünf Zeichen aus `Math.random()` je
  Millisekunde. Doppelte IDs hätten beim nächsten Laden die Speicherung gesperrt;
  in einer Messung mit 2 Millionen IDs der alten Funktion trat keine Kollision auf.
- **Speicheranzeige:** Der farbige Statuspunkt verschwand nach dem ersten Rendern;
  die Warnfarbe aus `styles.css` war dadurch wirkungslos.
- **JSON-Import:** `accept=".json,application/json"`, damit Systeme ohne
  JSON-MIME-Zuordnung die Datei im Dateidialog anbieten.
- **Nginx:** Content-Security-Policy mit `script-src 'self'`, `connect-src 'self'`,
  `object-src 'none'`, `base-uri 'none'` und `frame-ancestors 'none'`. Inline-Styles
  bleiben erlaubt, weil Topologie und Belegungsbalken Positionen und Farben als
  `style`-Attribut setzen. `nosniff` und `Referrer-Policy` gelten jetzt auch für
  Scanner- und Ersatzantworten.
- **Basisimages:** Der Scanner nutzt `python:3.13.17-alpine3.24` mit Digest
  `sha256:fa0bb0d0cd7c7d6cef30a69094d32ac2b71c7304c87c6107fec100e1ee4eda02`
  (vorher ungepinnt `python:3.13-alpine`). Der Nginx-Pin folgt dem aktuellen Stand
  des Tags `1.30.6-alpine`, `sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951`.
  Docker Hub hat den Tag am 22-10-2026 um 16:50 UTC neu gebaut; der bisherige Digest
  `sha256:c59d1f8b…` ist weiter abrufbar. Beide Images bekamen OCI-Labels mit Version 1.2.1.
- **Profilnamen:** Die Scanner-API meldet die Namen wie die Oberfläche
  („Geräte suchen“, „Häufige TCP-Ports“).

### Prüfungen am 23-10-2026

- 60 JavaScript-Tests bestehen (Node.js 26.8.1), 23 Python-Tests bestehen
  (Python 3.13.15). Neu sind Tests für Netzadressen, den Zeit- und den Origin-Hinweis
  samt Schutz gegen untergeschobene Texte, eindeutige IDs in Serie, den Statuspunkt
  und das Zeitbudget je Hostgruppe im Portprofil.
- Gegenprobe gegen den Code von 1.2.0: Die neuen Tests schlagen fehl. Ausnahmen sind
  zwei 403-Fälle, die das bisherige Verhalten absichern, und der ID-Test. Er schlug
  in einem von 37 Läufen fehl, ließ sich aber nicht wiederholen.
- `node --check` für die vier JavaScript-Laufzeitdateien, `py_compile` für
  `scanner/server.py`.
- Nmap 7.80 (Windows) akzeptiert beide Argumentlisten unverändert. Als Ziel diente
  eine leere Liste (`-iL` auf eine leere Datei), es wurde kein Paket gesendet. Die
  echte XML-Ausgabe mit DOCTYPE und Stylesheet-Anweisung läuft fehlerfrei durch
  `parse_xml`.
- Digests und Plattformen beider Basisimages per Registry-API geprüft; amd64 und
  arm64 sind in beiden Manifest-Indizes enthalten.
- Browser: Chromium im Browserbereich der Claude-Desktop-App, App unter
  `http://127.0.0.1` von einem Python-Testserver mit den Headern aus `nginx.conf`
  und einer 503-Antwort für `/api/scan/`. Ergebnis: kein CSP-Verstoß und kein
  Konsolenfehler außer der erwarteten 503-Antwort; drei Beispielgeräte mit 14 Ports;
  Duplizieren mit neuen IDs und leerer IP; `Ctrl+Z` und `Ctrl+Shift+Z`; Scanner ohne
  Dienst mit verständlichem Hinweis, geleertem Token-Feld und ohne Eintrag im
  Browser-Speicher; Nmap-XML mit vorhandener IP, `-Pn`-Gerät ohne Port und HTML im
  Hostnamen (als Text angezeigt); Übernahme zweier Geräte mit Diensten als Notiz;
  Neuladen ohne Reparaturhinweis; bei 375 px Breite kein horizontaler Seitenüberlauf.

Weiterhin offen: Auf dem Prüfrechner gibt es kein Docker. `docker compose config`,
Build, `nginx -t`, Healthchecks und die Header-Auslieferung durch Nginx selbst sind
ungeprüft; die CSP wurde mit dem Testserver nachgestellt. Es lief kein Netzwerkscan.
Die Laufzeit des Portprofils auf einem eigenen /24 auf dem Zielhost messen und hier
eintragen; erwartet werden die Gerätesuche plus etwa Anzahl erreichbarer Geräte × 29 / 50
Sekunden. Druckvorschau, SVG und CSV in Zielanwendungen sowie Firefox und Safari sind
nicht geprüft.

## Historischer Prüfstand: Version 1.2.0

Die Version ergänzt einen optionalen Nmap-Dienst sowie Auswahl und Import von
Scanergebnissen. Der Standardbetrieb ohne Compose-Profil `scan` stellt weiterhin
die statische App mit Nginx bereit.

- 50 JavaScript-Tests prüfen Modell und Oberfläche mit jsdom, einschließlich
  Nmap-XML-Import, Auswahl, vorhandener IPs, Übernahme in den Plan und Rückgängig/
  Wiederholen. Scanner-Anfragen werden simuliert; getestet sind Abschluss,
  Fehler, Tokenverlust, Abbruch und das Ende der Statusabfragen.
- 22 Python-Tests prüfen Freigaben, feste Nmap-Argumente, Token-Anmeldung,
  HTTP-Anfragen, XML-Verarbeitung, Begrenzungen, Zeitüberschreitung und Abbruch.
  Nmap-Prozesse und HTTP-Verbindungen werden für diese Tests im Speicher simuliert.
- Die vier JavaScript-Laufzeitdateien und `scanner/server.py` bestehen die
  Syntaxprüfung. Compose akzeptiert sowohl den Standardbetrieb als auch das Profil `scan`.
- Die lokal vorhandene Nmap-Version 7.98 wurde ausschließlich mit `--version`
  abgefragt. Es wurden keine Geräte oder Netze gescannt.

Ein tatsächlicher Nmap-Scan, ein Container-Build/-Start und eine visuelle Prüfung
im echten Browser sind weiterhin offen. Die lokale Docker-Engine ist nicht
verfügbar; lokale HTTP-/Browserprüfungen sind durch die Ausführungsumgebung
eingeschränkt. Die automatisierten Prüfungen bestätigen keine Erreichbarkeit
eines Netzes und ersetzen keinen Container- oder Browsertest auf dem Zielhost.

## Historischer Prüfstand: Version 1.1.0

Die Version erweitert die ursprüngliche App. Frühere Aussagen über bytegleiche
Laufzeitdateien oder das Image der Version 1.0.0 gelten ausschließlich für den
historischen Stand weiter unten.

- Alle 20 Modelltests bestehen. Geprüft werden unter anderem Portbelegung,
  Verbindungsvalidierung, Löschvorgänge, Import-Normalisierung, Gerätekopien,
  IPv4-/IPv6- und Profilhinweise, CSV-Ausgabe sowie der Änderungsverlauf.
- Insgesamt bestehen 32 Tests: 20 Modelltests und 12 weitere Prüfungen der
  Anwendung mit jsdom und des JSON-Roundtrips. Abgedeckt sind Geräteverwaltung,
  Rückgängig/Wiederholen, Filter, Verbindungsbearbeitung, Dialoge, Speicherfehler,
  Importschutz und tatsächlicher Dateiimport einschließlich Abbruch und Fehlerfällen.
  Der SVG-Download lässt sich als XML mit allen Geräten und Verbindungen parsen;
  Druckereignisse stellen die Filter nach der Ausgabe wieder her.
- Die Tests wurden mit Node.js 26.8.1 ausgeführt.
- `public/app.js` und `public/model.js` bestehen die JavaScript-Syntaxprüfung.
- `docker compose config` akzeptiert die aktuelle Konfiguration.
- Die lokale Docker-Engine ist nicht erreichbar. Ein Build und ein Start des
  aktuellen Containers sowie eine HTTP-/Healthcheck-Prüfung sind damit noch offen.
- Lokale Node.js- und Python-Webserver konnten gestartet werden; Zugriffe über
  Loopback liefen in dieser Ausführungsumgebung in einen Timeout. Ein visueller
  Funktionstest im echten Browser konnte deshalb nicht abgeschlossen werden.

DOM-Tests prüfen die Anwendung in einer simulierten Dokumentumgebung. Sie ersetzen
keine visuelle Prüfung von Topologie, mobiler Darstellung, Dialogen, SVG-Dateien
oder Drucklayout im echten Browser. Für den aktuellen Stand liegen keine
bestätigten Browser-Screenshots oder Container-Laufzeitnachweise vor.

## Tests erneut ausführen

Mit Node.js und npm im Repository:

```sh
npm ci
npm test
node --check public/app.js
node --check public/model.js
node --check public/scan.js
node --check public/scan-model.js
python -m unittest discover -s test -p "*_test.py"
sh -n docker/entrypoint.sh
sh -n docker/healthcheck.sh
docker compose config --quiet
```

Die jsdom-Abhängigkeit wird ausschließlich für Entwicklung und Tests benötigt.
Das Image enthält Nginx, Python, Nmap und tini, aber weder Node.js noch eine
Datenbank. Die Python-Tests lassen sich auch im gebauten Image ausführen; dort
laufen die Entrypoint-Tests mit der Shell des Images:

```sh
docker run --rm --entrypoint python3 -v "$PWD":/src:ro -w /src netzplaner:1.3.0 -m unittest discover -s test -p "*_test.py"
```

## Auf dem Docker-Zielhost prüfen

```sh
docker compose up -d --build
docker compose exec netzplaner nginx -t
docker compose ps
docker compose logs --tail 50 netzplaner
curl -fsS http://localhost:8080/healthz
```

Bei einem abweichenden Host-Port die URL entsprechend ändern; unter Windows
`curl.exe` verwenden. Anschließend im Browser prüfen:

1. Die drei Beispielgeräte und insgesamt 14 Ports erscheinen.
2. Geräte suchen und Typ-/Portfilter wechseln; Verbindungen bearbeiten.
3. Ein Gerät duplizieren: neue IDs, freie Ports und leere IP-Adresse prüfen.
4. Eine Änderung rückgängig machen, wiederholen und den Plan neu laden.
5. JSON sichern, nach bestätigtem Import vergleichen und fehlerhafte Importdaten prüfen.
6. CSV und SVG exportieren und in einer passenden Anwendung öffnen.
7. Auf einem schmalen Bildschirm sowie in der Druckvorschau alle Bedienelemente
   und Tabellen auf Lesbarkeit prüfen.
8. Ohne `SCAN_TOKEN` im Bereich Netzwerkscan eine Verbindung versuchen: verständlicher
   Hinweis auf den fehlenden Scanner; XML-Import und übrige App bleiben benutzbar.
9. Eine selbst erzeugte Nmap-XML-Datei importieren, einzelne Funde auswählen und
   übernehmen. Vorhandene IP-Adressen bleiben unverändert; TCP-Dienste erscheinen
   als Notizen und erzeugen keine physischen Ports.

Für die optionale Scanner-Prüfung `.env` gemäß README mit dem eigenen erlaubten
privaten Zielnetz und einem Token konfigurieren, dann:

```sh
docker compose up -d
docker compose ps
docker compose logs --tail 50 netzplaner
```

Im Browser Token, Zielnetz und Profil eingeben. Nur ein eigenes oder ausdrücklich
freigegebenes Netz verwenden. Scanstart, Fortschritt, Abbruch, Ergebnisvorschau
und selektive Übernahme prüfen. Außerdem verifizieren, dass falsche Tokens und
Ziele außerhalb der Freigabe abgewiesen werden. Ein Scan darf höchstens 256
Adressen umfassen und höchstens 180 Sekunden laufen. Token und Scanergebnisse
dürfen nicht im Plan-Export oder Browser-Speicher landen; ausschließlich
übernommene Geräte gehören zum gespeicherten Plan.

Seit 1.2.1 zusätzlich das Profil **Häufige TCP-Ports** einmal über das ganze eigene
/24 laufen lassen. Dauer und Anzahl der gemeldeten Geräte hier eintragen und mit
**Geräte suchen** im selben Netz vergleichen. Ist ein Reverse Proxy vorgeschaltet,
Scanstart und Abbruch auch über dessen Adresse prüfen. Die Antwort-Header von `/` mit
`curl -sI http://localhost:8080/` auf die Content-Security-Policy kontrollieren.

Diese Schritte sind ausstehende Zielhost-Prüfungen, keine bereits bestätigten Ergebnisse.

## Historische Nachweise: Version 1.0.0

Die folgenden Belege stammen vom ursprünglichen Docker-Quellpaket und dessen
damaliger Repository-Prüfung am 22-10-2026:

- Die vier damaligen Laufzeitdateien stimmten bytegenau mit dem aus der
  ursprünglichen Erstellung wiederhergestellten Netzplaner-Code überein.
- Sites-Version 1 verwies auf den abschließenden Quellstand
  `fcea38ae38a80793ff165b4372f9fa9b3dc7c41d`.
- Alle fünf damaligen Modelltests bestanden: Belegung, belegte Ports ablehnen,
  Mehrfachbelegung erkennen, Port samt Verbindung entfernen und Gerät samt
  Verbindungen entfernen. Beide JavaScript-Dateien bestanden die Syntaxprüfung.
- Compose akzeptierte die damalige Konfiguration mit Standardbindung
  `127.0.0.1:8080` sowie einer abweichenden Host-IP-/Port-Kombination.
- Dockerfile, Compose- und Nginx-Konfiguration, App-Dateien und Tests stimmten
  mit dem damaligen Docker-Quellpaket überein.
- Das festgelegte offizielle Nginx-Basisimage war in der Registry vorhanden;
  Manifest-Digest und Linux-amd64-/ARM64-Unterstützung wurden bestätigt.

### Separates Image-Archiv der Version 1.0.0

Das historische Linux-amd64-Archiv ist nicht Bestandteil dieses Repositories und
wurde nicht als GitHub-Release hochgeladen. Es enthält keine Änderungen der Version 1.1.0.

- `netzplaner:1.0.0` wurde lokal mit `crane` v0.22.1 erstellt. Der Werkzeug-Download
  wurde anhand der veröffentlichten SHA256-Prüfsumme verifiziert; es erfolgte kein Registry-Push.
- Die Image-Struktur bestand `crane validate --tarball`. Sämtliche neun Layer
  wurden gegen ihre unkomprimierten SHA256-Digests geprüft. App-Dateien und
  Nginx-Konfiguration im letzten Layer stimmten bytegenau mit dem damaligen
  Quellpaket überein und waren für Benutzer 101 lesbar.
- Image-Konfiguration: Benutzer `101:101`, Entrypoint `nginx`, Argumente
  `-g`, `daemon off;`, freigegebener Port `8080/tcp`.
- Image-ID: `sha256:1518b8994176b8029785d85c15816e77384b203a4fe628d3ce2cdc1e4f7db798`.
- Auch damals war die lokale Docker-Engine nicht erreichbar. `docker load`,
  `docker build`, `nginx -t` im Container und ein tatsächlicher Containerstart
  mit HTTP-/Healthcheck-Prüfung wurden nicht ausgeführt. Ein zusätzlicher
  lokaler Webserver war über Loopback nicht erreichbar; ein Browser-Funktionstest
  konnte nicht abgeschlossen werden.

Referenz zur historischen Image-Erstellung:
[crane mutate](https://github.com/google/go-containerregistry/blob/main/cmd/crane/doc/crane_mutate.md).
