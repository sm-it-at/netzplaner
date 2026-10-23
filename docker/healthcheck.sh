#!/bin/sh
# The scanner only counts when the entrypoint starts it (token set or SCAN_AUTH=none).
wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
if [ -n "${SCAN_TOKEN:-}" ] || [ "${SCAN_AUTH:-}" = none ]; then
    wget -q -O /dev/null http://127.0.0.1:8090/healthz || exit 1
fi
