#!/bin/sh
# The scanner only counts when SCAN_TOKEN asks the entrypoint to start it.
wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
[ -z "${SCAN_TOKEN:-}" ] || wget -q -O /dev/null http://127.0.0.1:8090/healthz || exit 1
