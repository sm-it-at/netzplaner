#!/bin/sh
# PID 1 is tini -g: stop signals reach nginx, the restart loop and the scanner.
set -eu

if [ -n "${SCAN_TOKEN:-}" ] || [ "${SCAN_AUTH:-}" = none ]; then
    delay="${SCANNER_RESTART_DELAY:-5}"
    (
        while :; do
            python3 /opt/netzplaner/server.py && code=0 || code=$?
            echo "netzplaner: Scanner beendet (Code $code), Neustart in $delay s" >&2
            sleep "$delay"
        done
    ) &
else
    echo "netzplaner: SCAN_TOKEN ist leer und SCAN_AUTH nicht none, Scanner nicht gestartet"
fi

# nginx needs none of the scanner settings.
unset SCAN_TOKEN SCAN_ALLOWED_CIDRS SCAN_AUTH
exec nginx -g 'daemon off;'
