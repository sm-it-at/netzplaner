# Prüfstand vom 22.10.2026

## Aktueller Quellstand: Version 1.2.0

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
docker compose config --quiet
docker compose --profile scan config --quiet
```

Die jsdom-Abhängigkeit wird ausschließlich für Entwicklung und Tests benötigt.
Der Nginx-Container stellt die statischen App-Dateien bereit und benötigt kein
Node.js, Python oder eine Datenbank. Nur der optionale Scanner-Container benötigt
Python und Nmap.

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
8. Ohne Scanner-Profil im Bereich Netzwerkscan eine Verbindung versuchen: verständlicher Hinweis
   auf den fehlenden Dienst; XML-Import und übrige App bleiben benutzbar.
9. Eine selbst erzeugte Nmap-XML-Datei importieren, einzelne Funde auswählen und
   übernehmen. Vorhandene IP-Adressen bleiben unverändert; TCP-Dienste erscheinen
   als Notizen und erzeugen keine physischen Ports.

Für die optionale Scanner-Prüfung `.env` gemäß README mit dem eigenen erlaubten
privaten Zielnetz und einem Token konfigurieren, dann:

```sh
docker compose --profile scan up -d --build
docker compose --profile scan ps
docker compose --profile scan logs --tail 50 scanner
```

Im Browser Token, Zielnetz und Profil eingeben. Nur ein eigenes oder ausdrücklich
freigegebenes Netz verwenden. Scanstart, Fortschritt, Abbruch, Ergebnisvorschau
und selektive Übernahme prüfen. Außerdem verifizieren, dass falsche Tokens und
Ziele außerhalb der Freigabe abgewiesen werden. Ein Scan darf höchstens 256
Adressen umfassen und höchstens 180 Sekunden laufen. Token und Scanergebnisse
dürfen nicht im Plan-Export oder Browser-Speicher landen; ausschließlich
übernommene Geräte gehören zum gespeicherten Plan.

Diese Schritte sind ausstehende Zielhost-Prüfungen, keine bereits bestätigten Ergebnisse.

## Historische Nachweise: Version 1.0.0

Die folgenden Belege stammen vom ursprünglichen Docker-Quellpaket und dessen
damaliger Repository-Prüfung am 22.10.2026:

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
