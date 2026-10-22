# Prüfstand vom 22.10.2026

- Die vier Laufzeitdateien stimmen bytegenau mit dem aus der ursprünglichen Erstellung wiederhergestellten Netzplaner-Code überein.
- Sites-Version 1 verweist auf denselben abschließenden Quellstand `fcea38ae38a80793ff165b4372f9fa9b3dc7c41d`.
- Alle fünf bestehenden Modelltests bestehen: Belegung, belegte Ports ablehnen, Mehrfachbelegung erkennen, Port samt Verbindung entfernen, Gerät samt Verbindungen entfernen.
- Beide JavaScript-Dateien bestehen die Syntaxprüfung.
- `docker compose config` akzeptiert die Konfiguration. Standardbindung `127.0.0.1:8080` und eine abweichende Host-IP/Port-Kombination wurden geprüft.
- Das festgelegte offizielle Nginx-Basisimage ist in der Registry vorhanden; der Manifest-Digest und Linux-amd64-/ARM64-Unterstützung wurden bestätigt.

## Erneute Prüfung der Repository-Dateien vom 22.10.2026

- Alle fünf Modelltests bestehen erneut mit `node --test test/model.test.js`.
- `public/app.js` und `public/model.js` bestehen erneut `node --check`.
- `docker compose config --quiet` akzeptiert die Repository-Konfiguration.
- Dockerfile, Compose-Konfiguration, Nginx-Konfiguration, App-Dateien und Tests stimmen mit dem zuvor erstellten Docker-Quellpaket überein.

## Separat erstelltes Image-Archiv

Die folgenden Prüfungen beziehen sich auf das ursprüngliche lokale Linux-amd64-Archiv.
Das Archiv ist nicht Bestandteil dieses Git-Repositories und wurde nicht als GitHub-Release hochgeladen.

- Das fertige Image `netzplaner:1.0.0` für Linux amd64 wurde mit dem offiziellen Werkzeug `crane` v0.22.1 lokal erstellt. Dessen Download wurde anhand der veröffentlichten SHA256-Prüfsumme verifiziert; es erfolgte kein Registry-Push.
- Die Image-Struktur besteht `crane validate --tarball`. Zusätzlich wurden sämtliche neun Layer gegen die unkomprimierten SHA256-Digests geprüft. Die App-Dateien und Nginx-Konfiguration im letzten Layer stimmen bytegenau mit dem Quellpaket überein und sind für Benutzer 101 lesbar.
- Image-Konfiguration bestätigt: Benutzer `101:101`, Entrypoint `nginx`, Argumente `-g`, `daemon off;`, freigegebener Port `8080/tcp`.
- Image-ID: `sha256:1518b8994176b8029785d85c15816e77384b203a4fe628d3ce2cdc1e4f7db798`.

## Grenzen der Ausführungsprüfung

Die lokale Docker-Engine war bei der Erstellung nicht erreichbar. Daher konnten
`docker load`, `docker build`, `nginx -t` im Container sowie ein tatsächlicher Containerstart
mit HTTP-/Healthcheck-Prüfung hier nicht ausgeführt werden.

Ein zusätzlicher lokaler Webserver konnte zwar gestartet werden, war in dieser
Ausführungsumgebung über Loopback nicht erreichbar. Ein Browser-Funktionstest des
exportierten Pakets konnte deshalb ebenfalls nicht abgeschlossen werden.

Auf dem Zielhost nach dem Start prüfen:

```sh
docker compose exec netzplaner nginx -t
docker compose ps
docker compose logs --tail 50 netzplaner
curl -fsS http://localhost:8080/healthz
```

Bei einem anderen Port `8080` entsprechend ersetzen. Im Browser müssen die drei
Beispielgeräte und 14 Ports erscheinen; anschließend einen JSON-Export und -Import prüfen.

Referenz zur Image-Erstellung: [crane mutate](https://github.com/google/go-containerregistry/blob/main/cmd/crane/doc/crane_mutate.md).
