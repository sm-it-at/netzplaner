"""Run docker/entrypoint.sh with stub python3 and nginx commands; no container or scan."""

import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import unittest


ENTRYPOINT = Path(__file__).parents[1] / "docker" / "entrypoint.sh"
TOKEN = "test-only-scan-token-at-least-24-chars"
# Every scanner start appends one line, so restarts can be counted.
STUB_PYTHON = """#!/bin/sh
echo "$* token=${SCAN_TOKEN:+gesetzt}" >> "$STUB_LOG/scanner"
sleep 0.1 2>/dev/null || sleep 1
"""
STUB_NGINX = """#!/bin/sh
env > "$STUB_LOG/nginx-env"
echo "$*" > "$STUB_LOG/nginx-args"
[ -n "${WAIT_FOR_RESTART:-}" ] || exit 0
i=0
while [ "$i" -lt 100 ]; do
    [ "$(cat "$STUB_LOG/scanner" 2>/dev/null | wc -l)" -ge 2 ] && exit 0
    sleep 0.1 2>/dev/null || sleep 1
    i=$((i + 1))
done
exit 1
"""


@unittest.skipUnless(hasattr(os, "killpg") and shutil.which("sh"), "POSIX-Shell mit Prozessgruppen erforderlich")
class EntrypointTests(unittest.TestCase):
    def run_entrypoint(self, **env):
        log, bin_dir = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, log, True)
        self.addCleanup(shutil.rmtree, bin_dir, True)
        for name, body in (("python3", STUB_PYTHON), ("nginx", STUB_NGINX)):
            (bin_dir / name).write_text(body, encoding="utf-8")
            (bin_dir / name).chmod(0o755)
        base = {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "STUB_LOG": str(log), "SCANNER_RESTART_DELAY": "0"}
        # Files, not pipes: the restart loop keeps inherited pipes open after nginx exits.
        with open(log / "stdout", "wb") as stdout, open(log / "stderr", "wb") as stderr:
            process = subprocess.Popen(["sh", str(ENTRYPOINT)], env={**base, **env}, stdout=stdout, stderr=stderr,
                                       start_new_session=True)
            try:
                code = process.wait(timeout=20)
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        return code, log

    def test_without_token_only_nginx_starts(self):
        code, log = self.run_entrypoint()
        self.assertEqual(code, 0)
        self.assertFalse((log / "scanner").exists())
        self.assertEqual((log / "nginx-args").read_text().strip(), "-g daemon off;")
        self.assertIn("Scanner nicht gestartet", (log / "stdout").read_text(encoding="utf-8"))

    def test_token_starts_and_restarts_scanner_but_stays_out_of_nginx(self):
        code, log = self.run_entrypoint(SCAN_TOKEN=TOKEN, SCAN_ALLOWED_CIDRS="192.168.1.0/24", WAIT_FOR_RESTART="1")
        self.assertEqual(code, 0)
        starts = (log / "scanner").read_text().splitlines()
        self.assertGreaterEqual(len(starts), 2)
        self.assertTrue(all(line == "/opt/netzplaner/server.py token=gesetzt" for line in starts), starts)
        nginx_env = (log / "nginx-env").read_text()
        self.assertNotIn("SCAN_TOKEN=", nginx_env)
        self.assertNotIn("SCAN_ALLOWED_CIDRS=", nginx_env)
        self.assertIn("Neustart", (log / "stderr").read_text(encoding="utf-8"))

    def test_scan_auth_none_starts_scanner_without_token(self):
        code, log = self.run_entrypoint(SCAN_AUTH="none", SCAN_ALLOWED_CIDRS="192.168.1.0/24", WAIT_FOR_RESTART="1")
        self.assertEqual(code, 0)
        self.assertTrue((log / "scanner").read_text().startswith("/opt/netzplaner/server.py token="))
        self.assertNotIn("SCAN_AUTH=", (log / "nginx-env").read_text())


if __name__ == "__main__":
    unittest.main()
