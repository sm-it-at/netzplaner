#!/bin/sh
# PID 1 is tini -g: stop signals reach nginx, the restart loop and the scanner.
set -eu

if [ -n "${SCAN_TOKEN:-}" ]; then
    delay="${SCANNER_RESTART_DELAY:-5}"
    (
        while :; do
            python3 /opt/netzplaner/server.py && code=0 || code=$?
            echo "netzplaner: Scanner beendet (Code $code), Neustart in $delay s" >&2
            sleep "$delay"
        done
    ) &
else
    echo "netzplaner: SCAN_TOKEN ist leer, Scanner nicht gestartet"
fi

# nginx needs neither the token nor the allowlist.
unset SCAN_TOKEN SCAN_ALLOWED_CIDRS
exec nginx -g 'daemon off;'
