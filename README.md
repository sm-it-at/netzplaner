# Netzplaner

Interaktiver Netzwerkplaner für Homelab-Netze, als statische Website in Nginx.
Seit Version 1.2.0 ergänzen ein optionaler Nmap-Netzwerkscan und der lokale Import
von Nmap-XML-Dateien die Geräte-, Port- und Verbindungsplanung. Version 1.3.0 bündelt
App und Scanner in einem Container: Nginx und der Scanner laufen unter `tini` in einem
Image, und der Scanner startet nur, wenn `SCAN_TOKEN` gesetzt ist. Die Änderungen im
Einzelnen stehen in [PRUEFUNG.md](PRUEFUNG.md).

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
  liefern Planungshinweise. Diese Hinweise beruhen auf den Angaben im Plan;
  tatsächliche Verkabelung und ausgehandelte Verbindungen werden nicht geprüft.
- Den gesamten Plan als JSON sichern und vorhandene Pläne mit Prüfung und
  Bestätigung importieren. Geräteinventar und Belegungszahlen als CSV exportieren,
  die Topologie als eigenständige SVG-Datei speichern oder die Ansicht drucken.
- Mit einem optionalen Nmap-Dienst erreichbare Geräte und häufige TCP-Dienste
  in ausdrücklich freigegebenen privaten IPv4-Netzen finden. Ausgewählte Funde
  lassen sich als neue Geräte übernehmen; vorhandene IP-Adressen bleiben erhalten.
  Alternativ Nmap-XML-Dateien lokal im Browser einlesen.

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

Danach öffnen: **http://IP-DES-DOCKER-HOSTS:8080** oder auf dem Host selbst **http://localhost:8080**.
Beim ersten Build lädt Docker das offizielle Nginx-Basisimage herunter. Es ist über
Version und Prüfsumme festgelegt und unterstützt Linux amd64 / x86-64 und ARM64.
Für den optionalen Scanner installiert der Build aus Alpine 3.24 zusätzlich `python3`,
`nmap` und `tini`. Node.js oder eine Datenbank werden nicht benötigt. Ohne
`SCAN_TOKEN` läuft im Container nur Nginx.

Ein vorgefertigtes Image-Archiv für Version 1.3.0 ist nicht Teil dieses Repositories.
Der Schnellstart baut das Image aus dem aktuellen Quellcode. Die früheren Nachweise
zu einem separat erstellten Image der Version 1.0.0 stehen in [PRUEFUNG.md](PRUEFUNG.md).

## Zugriff aus dem Heimnetz

Standardmäßig lauscht der Netzplaner seit 1.3.0 auf allen IPv4-Adressen des
Docker-Hosts (`0.0.0.0:8080`) und ist damit im Heimnetz erreichbar. Wer ihn nur auf
dem Host selbst oder auf einer bestimmten LAN-IP anbieten will, legt eine Datei
`.env` neben `compose.yaml` an:

```dotenv
BIND_ADDRESS=127.0.0.1
PORT=8080
```

Danach `docker compose up -d` ausführen. Statt `127.0.0.1` lässt sich auch die
konkrete LAN-IP des Hosts eintragen.
Die Docker-Version besitzt keinen ChatGPT-Login. Für Zugriff aus dem Internet
eine eigene Anmeldung am Reverse Proxy verwenden. Der Container spricht intern HTTP auf Port 8080.

### Ohne Compose (Portainer, `docker run`)

Das Image bringt Benutzer, Entrypoint, Stoppsignal und Healthcheck selbst mit. Die
Härtungs-Flags gelten dagegen nur, wenn sie beim Start angegeben werden:

```sh
docker build -t netzplaner:1.3.0 .
docker run -d --name netzplaner --restart unless-stopped -p 0.0.0.0:8080:8080 --env-file .env --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --memory 256m --cpus 1 netzplaner:1.3.0
```

Wird der Container später über einen Container-Editor neu erstellt, etwa in Portainer,
gehen diese Flags leicht verloren. Nach solchen Änderungen mit `docker inspect`
prüfen oder den Stack mit Compose verwalten.

## Optionalen Netzwerkscan aktivieren

Scans nur für eigene oder ausdrücklich freigegebene Netze verwenden. In `.env`
die tatsächlich erlaubten IPv4-Netze und ein zufälliges Token mit mindestens
24 Zeichen eintragen. Der Scanner startet nur, wenn `SCAN_TOKEN` gesetzt ist. Bei
ungültigem Token oder ohne gültige Freigabe bleibt er deaktiviert und die App nennt
den Grund. Ein solches Token lässt sich zum Beispiel mit einem lokal installierten Python
erzeugen:

```sh
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Das Zielnetz anpassen und die erzeugte Zeichenfolge hinter `SCAN_TOKEN=` eintragen:

```dotenv
SCAN_ALLOWED_CIDRS=192.168.1.0/24
SCAN_TOKEN=
```

`SCAN_ALLOWED_CIDRS` ist eine kommagetrennte Liste privater RFC1918-Netze
(`10.0.0.0/8`, `172.16.0.0/12` oder `192.168.0.0/16` beziehungsweise deren Teilnetze).
Ein einzelner Scan darf höchstens 256 IPv4-Adressen umfassen und muss vollständig
innerhalb dieser Freigabe liegen. Öffentliche Adressen und beliebige Nmap-Argumente
werden nicht akzeptiert. Leerzeichen und ein abschließendes Komma in der Liste stören nicht.

```sh
chmod 600 .env
docker compose up -d
```

`.env` enthält das Token und gehört deshalb nur dem Besitzer. Compose liest `.env`
beim Erstellen des Containers; nach Änderungen daher `docker compose up -d` ausführen,
ein bloßer Neustart übernimmt neue Werte nicht.

In der App den Bereich **Netzwerkscan** öffnen, das Token eingeben und
**Scanner verbinden** wählen. Danach Zielnetz und Scanprofil wählen und den
Scan starten. Das Token bleibt nur während der laufenden Seite
im Arbeitsspeicher; es wird weder im Plan noch im Browser-Speicher abgelegt.
Es wird zur Anmeldung am Scanner über dieselbe App-Adresse übertragen. Für
Zugriff über nicht vertrauenswürdige Netze HTTPS am Reverse Proxy verwenden.

Start und Abbruch eines Scans nimmt der Scanner nur an, wenn der `Origin` der
Browseranfrage zum `Host`-Header passt. Ein vorgeschalteter Reverse Proxy muss
deshalb den ursprünglichen `Host` weitergeben. Caddy, Traefik und Nginx Proxy Manager
tun das standardmäßig; ein eigener Nginx braucht `proxy_set_header Host $host;`.
Fehlt das, meldet die App, dass Origin und Host nicht übereinstimmen.

Die Profile haben unterschiedliche Aussagekraft:

- **Geräte suchen:** Nmap prüft mit unprivilegierten TCP-Probes auf die Ports
  22, 80, 443, 445, 3389 und 8080, ob ein Gerät antwortet. Auch eine Antwort
  „Port geschlossen“ kann ein erreichbares Gerät bestätigen. Geräte, die alle
  Probes filtern, können fehlen.
- **Häufige TCP-Ports:** Nmap sucht zuerst wie bei **Geräte suchen** nach erreichbaren
  Geräten und prüft danach nur diese per TCP-Connect-Scan auf 29 häufige Ports,
  jeweils höchstens acht Geräte gleichzeitig. Gemeldet werden Geräte mit mindestens
  einem offenen Port dieser Auswahl. Geräte, die alle Such-Probes filtern, fehlen
  auch hier. Die angezeigten Dienstnamen stammen aus der Nmap-Porttabelle und sind
  Hinweise, keine bestätigte Software- oder Versionserkennung.

Nmap sendet höchstens 50 Probes pro Sekunde und gibt ein einzelnes Gerät nach
30 Sekunden auf. Ein Scan läuft höchstens 180 Sekunden und kann abgebrochen werden.
Endet er an dieser Grenze, sagt die App das ausdrücklich; dann einen kleineren
Bereich wählen. Der Dienst
behält höchstens acht Aufträge im Arbeitsspeicher; Ergebnisse sind bis zu
15 Minuten ab Scanstart abrufbar. Abgelaufene Einträge werden bei weiteren
Anfragen entfernt.
Ergebnisse werden erst nach Auswahl und ausdrücklicher Übernahme in den Plan
eingefügt. Bereits vorhandene Geräte mit derselben IP-Adresse werden nicht
überschrieben. TCP-Dienste werden als Notizen am Gerät dokumentiert; sie sind
keine physischen Netzwerkports im Plan.

Der Scanner lauscht nur auf `127.0.0.1:8090` innerhalb des Containers; Nginx
vermittelt die Anfragen. Alle Prozesse laufen als Benutzer `101:101` ohne Linux-
Capabilities auf einem schreibgeschützten Dateisystem. `tini` läuft als PID 1 und
leitet Signale an alle Prozesse weiter. Ein beendeter Scanner startet nach 5 Sekunden
neu; endet Nginx, endet der Container und Docker startet ihn gemäß Restart-Policy neu.
Ein Host-Netzwerk ist für diese TCP-Scans nicht erforderlich.
Erreichbar sind nur Netze, zu denen der Docker-Container tatsächlich eine Route
hat und deren Firewalls die Anfragen zulassen. VLANs werden nicht automatisch
überschritten. MAC-Adressen, Betriebssysteme, Switch-Ports und Verkabelung lassen
sich daraus nicht zuverlässig ableiten.

Die gehostete Sites-Version hat keinen Zugriff auf diesen Scanner und
kann deshalb keine direkten LAN-Scans starten. Der XML-Import funktioniert auch
ohne Scanner.

### Vorhandene Nmap-Ergebnisse importieren

Im Bereich **Netzwerkscan** eine Nmap-XML-Datei auswählen und die gewünschten
Funde übernehmen. Die Datei wird lokal im Browser verarbeitet und nicht an den
Scanner hochgeladen. Ein vorhandener Plan bleibt erhalten; nur ausgewählte neue
IP-Adressen werden ergänzt.

Wer Nmap bereits auf einem Rechner im Zielnetz installiert hat, kann dort
beispielsweise eine Datei erzeugen:

```sh
nmap --unprivileged -n -sn -PS22,80,443,445,3389,8080 -oX netz.xml 192.168.1.0/24
```

Dies ist ein Beispiel für ein eigenes freigegebenes Netz. Der Befehl muss auf
dem betreffenden Rechner ausgeführt werden; die App führt ihn beim XML-Import
nicht aus.

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

Die Netzpläne liegen ausschließlich im Browser (`localStorage`, Schlüssel `netzplaner-v1`).
Eine andere Domain, ein anderer Port, HTTP/HTTPS oder ein anderes Browserprofil
verwendet einen eigenen Speicher. Es gibt keine Synchronisation zwischen Browsern
oder Geräten und kein Backend für Netzpläne. Nur bei aktivem Scanner verarbeitet
der optionale Dienst Scanaufträge und vorübergehende Ergebnisse im Arbeitsspeicher.
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
und einem temporären Verzeichnis unter `/tmp`. Der Healthcheck des Images prüft Nginx
und, bei gesetztem `SCAN_TOKEN`, auch den Scanner.
Nginx sendet eine Content-Security-Policy: Skripte, Stylesheets und Verbindungen
kommen nur von der eigenen Adresse, und fremde Seiten dürfen die App nicht einbetten.

### Von 1.2.x auf 1.3.0 umstellen

```sh
git pull
docker compose up -d --build --remove-orphans
```

`--remove-orphans` entfernt den bisherigen Scanner-Container. `.env` gilt unverändert;
das Compose-Profil `scan` gibt es nicht mehr. Pläne im Browser bleiben erhalten, solange
Adresse und Port der App gleich bleiben.

## Herkunft und Prüfung

Quelle: Netzplaner, Sites-Version 1, Projekt `appgprj_6aacd418d2e4819196af072953d42453`,
Quellstand `fcea38ae38a80793ff165b4372f9fa9b3dc7c41d`.
Diese ursprüngliche Version bildet die Grundlage der Docker-App; die Versionen
1.1.0 bis 1.3.0 entwickeln die Laufzeitdateien und Tests weiter.

Für Entwicklung und Tests werden Node.js 26 oder eine von jsdom unterstützte
Version ab Node.js 22.22.2 (22.x) beziehungsweise 24.15.0 (24.x) sowie npm benötigt:

```sh
npm ci
npm test
python -m unittest discover -s test -p "*_test.py"
```

Die Testsuite umfasst Modelltests und DOM-Integrationstests mit jsdom.
Diese Entwicklungsabhängigkeiten werden für den Nginx-Container nicht benötigt.
Die Python-Prüfungen testen den Scanner mit simulierten Nmap-Prozessen und lösen
keine Netzwerkscans aus. Die Tests des Entrypoint-Skripts brauchen eine POSIX-Shell
mit Prozessgruppen und werden unter Windows übersprungen.
Prüfergebnisse, historische Nachweise und offene Laufzeitprüfungen stehen in
[PRUEFUNG.md](PRUEFUNG.md).

Technische Referenzen: [offizielles Nginx-Image](https://hub.docker.com/_/nginx),
[tini](https://github.com/krallin/tini),
[Docker Compose](https://docs.docker.com/reference/compose-file/services/),
[Nmap-Zeitsteuerung](https://nmap.org/book/man-performance.html).
