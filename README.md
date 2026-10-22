# Netzplaner

Die bestehende Netzplaner-App läuft unverändert als statische Website in Nginx.
Geräte, Ports, Verbindungen, Konfliktprüfung und JSON-Import/-Export bleiben erhalten.

## Schnellstart mit Docker

Voraussetzung: Git, Docker mit Linux-Containern und Docker Compose v2.
Das Repository klonen und den Container bauen und starten:

```sh
git clone https://github.com/kaarl92/netzplaner.git
cd netzplaner
docker compose up -d --build
docker compose ps
```

Danach auf dem Docker-Host öffnen: **http://localhost:8080**.
Beim ersten Build lädt Docker das offizielle Nginx-Basisimage herunter.
Es ist über Version und Prüfsumme festgelegt und unterstützt Linux amd64 / x86-64
und ARM64. Node.js, Python und eine Datenbank sind für den Container nicht erforderlich.
Die App selbst arbeitet ohne externe Dienste.

## Optional: vorhandenes Linux-amd64-Image laden

Ein fertiges Image kann später als Release-Datei bereitgestellt werden; es gehört
nicht zum Git-Repository. Falls dir das separat erstellte Archiv
`netzplaner-1.0.0-linux-amd64.tar` bereits vorliegt, kannst du es auf einem
Linux-amd64-Host laden und ohne eigenen Build starten:

```sh
docker load -i /pfad/zu/netzplaner-1.0.0-linux-amd64.tar
docker compose up -d --no-build --pull never
```

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
3. Für Backups regelmäßig **Exportieren** verwenden.

Die Daten liegen weiterhin ausschließlich im Browser (`localStorage`, Schlüssel `netzplaner-v1`).
Eine andere URL, ein anderer Port, HTTP/HTTPS oder ein anderer Browser verwendet einen eigenen Speicher.
Containerneustarts löschen die Browserdaten nicht; ein Docker-Volume ist deshalb nicht erforderlich.
Das Image enthält nur den Originalcode und Beispieldaten, keine persönlichen Netzpläne.

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
Die vier App-Dateien wurden aus den vollständigen Dateiänderungen der ursprünglichen Erstellung wiederhergestellt.

Die fünf bestehenden Tests für Portbelegung, Konflikte und Löschvorgänge sind im Repository enthalten.
Ausführung bei vorhandenem Node.js: `npm test` (ohne Installation weiterer Pakete).
Weitere Ergebnisse und die Grenzen der Prüfung stehen in `PRUEFUNG.md`.

Technische Referenzen: [offizielles Nginx-Image](https://hub.docker.com/_/nginx),
[Docker Compose](https://docs.docker.com/reference/compose-file/services/).
