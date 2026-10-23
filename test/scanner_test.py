"""Unit/API tests use fake Nmap processes and in-memory HTTP; no sockets or scans."""

import importlib.util
import inspect
import io
import ipaddress
import json
from pathlib import Path
import sys
import time
import unittest
from types import SimpleNamespace


spec = importlib.util.spec_from_file_location("netzplaner_scanner", Path(__file__).parents[1] / "scanner" / "server.py")
scanner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = scanner
spec.loader.exec_module(scanner)
TOKEN = "test-only-scan-token-at-least-24-chars"


def config(**overrides):
    return scanner.Config.from_env({"SCAN_TOKEN": TOKEN, "SCAN_ALLOWED_CIDRS": "192.168.1.0/24,10.0.0.0/8", **overrides})


def host(ip="192.168.1.10", status="up", ports="", hostname=""):
    return (f'<host><status state="{status}"/><address addr="{ip}" addrtype="ipv4"/>'
            f'<hostnames><hostname name="{hostname}"/></hostnames><ports>{ports}</ports></host>')


def port(number=8006, state="open", protocol="tcp", service="https"):
    return f'<port protocol="{protocol}" portid="{number}"><state state="{state}"/><service name="{service}"/></port>'


def xml(hosts=""):
    return ('<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE nmaprun><nmaprun>' + hosts + '</nmaprun>').encode()


class FakeProcess:
    def __init__(self, output=None, code=0, running=False):
        self.stdout = io.BytesIO(xml(host()) if output is None else output)
        self.returncode = None if running else code
        self.killed = False

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


class FakeRunner:
    def __init__(self, **process_options):
        self.options = process_options
        self.calls = []
        self.processes = []

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        process = FakeProcess(**self.options)
        self.processes.append(process)
        return process


def wait_job(manager, job_id):
    # Wait until finalization has released the active slot and closed the pipe.
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        with manager.lock:
            if manager.active != job_id:
                return manager.get(job_id)
        time.sleep(0.005)
    raise AssertionError("Fake scan did not finish")


class ConfigTests(unittest.TestCase):
    def test_disabled_by_default_and_short_secret(self):
        self.assertFalse(scanner.Config.from_env({}).enabled)
        self.assertFalse(config(SCAN_TOKEN="short").enabled)
        self.assertFalse(config(SCAN_TOKEN="a" * 24 + " ").enabled)
        self.assertFalse(config(SCAN_ALLOWED_CIDRS="").enabled)

    def test_only_explicit_rfc1918_allowlists(self):
        self.assertTrue(config().enabled)
        for value in ("127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "8.8.8.0/24", "::1/128", "192.168.1.2/24", "invalid", "192.168.0.0/15"):
            with self.subTest(value=value):
                self.assertFalse(config(SCAN_ALLOWED_CIDRS=value).enabled)

    def test_allowlist_ignores_empty_entries_from_stray_commas(self):
        for value in ("192.168.1.0/24,", " 192.168.1.0/24 , 10.0.0.0/8 ,", "192.168.1.0/24,,10.0.0.0/8"):
            with self.subTest(value=value):
                self.assertTrue(config(SCAN_ALLOWED_CIDRS=value).enabled)
        self.assertEqual(config(SCAN_ALLOWED_CIDRS="192.168.1.0/24,").networks, (ipaddress.ip_network("192.168.1.0/24"),))
        for value in (",", " , ,"):
            with self.subTest(value=value):
                settings = config(SCAN_ALLOWED_CIDRS=value)
                self.assertFalse(settings.enabled)
                self.assertIn("Kein Scan-Netz", settings.reason)

    def test_server_listens_on_loopback_by_default(self):
        self.assertEqual(inspect.signature(scanner.make_server).parameters["address"].default, ("127.0.0.1", 8090))

    def test_accept_target_host_and_canonical_small_network(self):
        for target in ("192.168.1.10", "192.168.1.0/24", "10.1.2.0/25", "10.1.2.3/32"):
            with self.subTest(target=target):
                self.assertEqual(config().target(target), ipaddress.ip_network(target))

    def test_reject_flags_dns_public_ipv6_noncanonical_and_large_targets(self):
        for target in ("localhost", "example.org", "-sV", "192.168.1.1 -sV", "192.168.1.1;whoami", "192.168.1.1\n", "192.168.1.2/24", "192.168.1.0/255.255.255.0", "192.168.001.1", "8.8.8.8", "127.0.0.1", "fe80::1", "10.0.0.0/23", "192.168.2.0/24", "10.0.0.0/7", ""):
            with self.subTest(target=target):
                with self.assertRaises(scanner.APIError):
                    config().target(target)


class XmlTests(unittest.TestCase):
    target = ipaddress.ip_network("192.168.1.0/24")

    def test_discovery_accepts_only_up_ipv4_inside_target_and_sorts(self):
        data = xml(host("192.168.1.20") + host("192.168.1.2") + host("192.168.1.2") + host("192.168.1.3", "down") + host("192.168.2.1") + host("invalid"))
        self.assertEqual([item["ip"] for item in scanner.parse_xml(data, self.target, "discovery")], ["192.168.1.2", "192.168.1.20"])

    def test_ports_require_real_open_tcp_evidence_and_restrict_port_list(self):
        data = xml(host("192.168.1.1") + host("192.168.1.2", ports=port(state="closed")) + host("192.168.1.3", ports=port(protocol="udp")) + host("192.168.1.4", ports=port(12345)) + host("192.168.1.5", ports=port(8006) + port(22, service="ssh") + port(8006)))
        hosts = scanner.parse_xml(data, self.target, "ports")
        self.assertEqual(len(hosts), 1)
        self.assertEqual(hosts[0]["ip"], "192.168.1.5")
        self.assertEqual([item["port"] for item in hosts[0]["ports"]], [22, 8006])

    def test_mac_vendor_and_text_are_bounded(self):
        data = xml(host(hostname="x" * 300).replace("</host>", '<address addr="aa:bb:cc:dd:ee:ff" addrtype="mac" vendor="Example"/></host>'))
        result = scanner.parse_xml(data, self.target, "discovery")[0]
        self.assertEqual(result["mac"], "AA:BB:CC:DD:EE:FF")
        self.assertEqual(result["vendor"], "Example")
        self.assertEqual(len(result["hostname"]), 253)

    def test_reject_entities_external_doctype_utf16_invalid_and_oversized_xml(self):
        for data in (b'<!DOCTYPE nmaprun SYSTEM "file:///etc/passwd"><nmaprun/>',
                     b'<!DOCTYPE nmaprun [<!ENTITY test "test">]><nmaprun/>',
                     '<nmaprun/>'.encode('utf-16'), b'<nmaprun>', b'<other/>', b'x' * (scanner.MAX_OUTPUT + 1)):
            with self.subTest(data=data[:80]):
                with self.assertRaises(scanner.ScanFailure):
                    scanner.parse_xml(data, self.target, "discovery")


class ManagerTests(unittest.TestCase):
    def test_runner_uses_fixed_argv_shell_false_no_dns_or_privileged_scan(self):
        runner = FakeRunner(output=xml(host(ports=port())))
        manager = scanner.ScanManager(config(), popen=runner, interval=0)
        started = manager.start("192.168.1.10", "ports")
        result = wait_job(manager, started["id"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["hosts"][0]["ports"][0]["port"], 8006)
        command, kwargs = runner.calls[0]
        self.assertFalse(kwargs["shell"])
        self.assertEqual(command[-1], "192.168.1.10")
        for value in ("--unprivileged", "-n", "-sT", "--open", scanner.DISCOVERY_PROBES):
            self.assertIn(value, command)
        for value in ("-Pn", "-sS", "-sV", "-O", "-A", "--script"):
            self.assertNotIn(value, command)
        self.assertLessEqual(len(scanner.PORTS), 30)
        self.assertIn("finishedAt", result)

    def test_ports_profile_host_group_fits_rate_and_host_timeout(self):
        command = scanner.ScanManager.command("192.168.1.0/24", "ports")
        option = lambda name: command[command.index(name) + 1]
        rate, group = int(option("--max-rate")), int(option("--max-hostgroup"))
        timeout, attempts = int(option("--host-timeout").removesuffix("s")), int(option("--max-retries")) + 1
        # Every probe of one host group, retried once, must fit into the per-host timeout.
        self.assertLessEqual(group * len(option("-p").split(",")) * attempts / rate, timeout)

    def test_discovery_fixed_probe_ports(self):
        command = scanner.ScanManager.command("192.168.1.0/24", "discovery")
        self.assertIn("-sn", command)
        self.assertIn("-PS22,80,443,445,3389,8080", command)
        self.assertNotIn("-Pn", command)

    def test_concurrency_rejected_and_cancel_kills_process(self):
        runner = FakeRunner(running=True)
        manager = scanner.ScanManager(config(), popen=runner, interval=0)
        started = manager.start("192.168.1.1", "discovery")
        with self.assertRaises(scanner.APIError) as caught:
            manager.start("192.168.1.2", "discovery")
        self.assertEqual(caught.exception.status, 409)
        # Wait for launch so this also verifies process termination, not just prelaunch cancellation.
        deadline = time.monotonic() + 1
        while not runner.processes and time.monotonic() < deadline:
            time.sleep(0.005)
        manager.cancel(started["id"])
        self.assertEqual(wait_job(manager, started["id"])["status"], "cancelled")
        self.assertTrue(runner.processes[0].killed)

    def test_timeout_kills_process(self):
        runner = FakeRunner(running=True)
        manager = scanner.ScanManager(config(), popen=runner, timeout=0.01, interval=0)
        started = manager.start("192.168.1.1", "discovery")
        result = wait_job(manager, started["id"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("180", result["error"])
        self.assertTrue(runner.processes[0].killed)

    def test_output_limit_nonzero_exit_and_runner_errors_are_sanitized(self):
        for runner in (FakeRunner(output=b'x' * (scanner.MAX_OUTPUT + 1)), FakeRunner(code=1), lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("secret/path/token"))):
            manager = scanner.ScanManager(config(), popen=runner, interval=0)
            started = manager.start("192.168.1.1", "discovery")
            result = wait_job(manager, started["id"])
            self.assertEqual(result["status"], "failed")
            self.assertNotIn("secret", result["error"])

    def test_cooldown_retention_expiry_and_copy_isolation(self):
        manager = scanner.ScanManager(config(), popen=FakeRunner(output=xml(host("192.168.1.1"))), interval=10)
        started = manager.start("192.168.1.1", "discovery")
        wait_job(manager, started["id"])
        with self.assertRaises(scanner.APIError) as caught:
            manager.start("192.168.1.1", "discovery")
        self.assertEqual(caught.exception.status, 429)
        result = manager.get(started["id"])
        result["hosts"].clear()
        self.assertEqual(len(manager.get(started["id"])["hosts"]), 1)
        manager.interval = 0
        for _ in range(9):
            new_job = manager.start("192.168.1.1", "discovery")
            wait_job(manager, new_job["id"])
        self.assertEqual(len(manager.jobs), scanner.MAX_JOBS)
        with self.assertRaises(scanner.APIError):
            manager.get(started["id"])
        manager.jobs[new_job["id"]]["created"] -= scanner.JOB_TTL + 1
        with self.assertRaises(scanner.APIError):
            manager.get(new_job["id"])

    def test_disabled_and_unknown_profile_never_launch(self):
        runner = FakeRunner()
        for settings, profile in ((scanner.Config.from_env({}), "discovery"), (config(), "scripts")):
            manager = scanner.ScanManager(settings, popen=runner)
            with self.assertRaises(scanner.APIError):
                manager.start("192.168.1.1", profile)
        self.assertFalse(runner.calls)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runner = FakeRunner()
        cls.manager = scanner.ScanManager(config(), popen=cls.runner, interval=0)
        cls.server = SimpleNamespace(manager=cls.manager)

    def raw_request(self, request):
        class MemorySocket:
            def __init__(self, data):
                self.input = io.BytesIO(data)
                self.output = io.BytesIO()

            def makefile(self, mode, *_args):
                return self.input if "r" in mode else self.output

            def sendall(self, data):
                self.output.write(data)

            def settimeout(self, _timeout):
                pass

        connection = MemorySocket(request)
        scanner.Handler(connection, ("127.0.0.1", 0), self.server)
        return connection.output.getvalue()

    def request(self, method, path, body=None, authorized=True, headers=None):
        request_headers = {"Host": "netzplaner.test"}
        if authorized:
            request_headers["Authorization"] = "Bearer " + TOKEN
        if body is not None:
            request_headers["Content-Type"] = "application/json"
            if not isinstance(body, (str, bytes)):
                body = json.dumps(body)
            body = body.encode("utf-8") if isinstance(body, str) else body
            request_headers["Content-Length"] = str(len(body))
        request_headers.update(headers or {})
        raw = (f"{method} {path} HTTP/1.0\r\n" + "".join(f"{key}: {value}\r\n" for key, value in request_headers.items()) + "\r\n").encode() + (body or b"")
        header, data = self.raw_request(raw).split(b"\r\n\r\n", 1)
        lines = header.decode().split("\r\n")
        status = int(lines[0].split()[1])
        response_headers = dict(line.split(": ", 1) for line in lines[1:])
        return status, json.loads(data), response_headers

    def test_unauthenticated_status_reveals_no_ranges_and_health_is_minimal(self):
        status, data, headers = self.request("GET", "/api/scan/status", authorized=False)
        self.assertEqual(status, 200)
        self.assertEqual(set(data), {"enabled", "reason"})
        self.assertNotIn("192.168", json.dumps(data))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.request("GET", "/healthz", authorized=False)[:2], (200, {"ok": True}))

    def test_every_job_endpoint_and_config_require_bearer_token(self):
        for method, path, body in (("GET", "/api/scan/config", None), ("GET", "/api/scan/jobs/" + "a" * 32, None),
                                   ("DELETE", "/api/scan/jobs/" + "a" * 32, None),
                                   ("POST", "/api/scan/jobs", {"target": "192.168.1.1", "profile": "discovery"})):
            with self.subTest(method=method):
                self.assertEqual(self.request(method, path, body, authorized=False)[0], 401)
        self.assertEqual(self.request("GET", "/api/scan/config", headers={"Authorization": "Bearer wrong"})[0], 401)

    def test_config_and_job_lifecycle_with_same_origin_https(self):
        status, data, _ = self.request("GET", "/api/scan/config")
        self.assertEqual(status, 200)
        self.assertEqual(data["maxHosts"], 256)
        self.assertEqual([item["id"] for item in data["profiles"]], ["discovery", "ports"])
        status, job, _ = self.request("POST", "/api/scan/jobs", {"target": "192.168.1.10", "profile": "discovery"},
                                     headers={"Host": "netzplaner.example", "Origin": "https://netzplaner.example"})
        self.assertEqual(status, 202)
        self.assertEqual(job["status"], "running")
        wait_job(self.manager, job["id"])
        status, result, _ = self.request("GET", "/api/scan/jobs/" + job["id"])
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.request("DELETE", "/api/scan/jobs/" + job["id"])[0], 202)

    def test_reject_cross_site_browser_mutations(self):
        for headers in ({"Origin": "https://evil.example"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"},
                        {"Host": "good.example", "Origin": "https://good.example@evil.example"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("POST", "/api/scan/jobs", {"target": "192.168.1.1", "profile": "discovery"}, headers=headers)[0], 403)
                self.assertEqual(self.request("DELETE", "/api/scan/jobs/" + "a" * 32, headers=headers)[0], 403)

    def test_reject_large_invalid_or_wrong_content_type_bodies(self):
        for body, headers, expected in (("x" * 4097, {}, 413), ("{}", {"Content-Type": "text/plain"}, 415),
                                        ("{bad", {}, 400), ("[]", {}, 400),
                                        ({"target": "192.168.1.1", "profile": "discovery", "flags": "-sV"}, {}, 400),
                                        ({"target": ["192.168.1.1"], "profile": "discovery"}, {}, 400)):
            with self.subTest(expected=expected, headers=headers):
                self.assertEqual(self.request("POST", "/api/scan/jobs", body, headers=headers)[0], expected)

    def test_reject_transfer_encoding_duplicate_or_absent_content_length(self):
        for extra_headers, expected in (("Transfer-Encoding: chunked\r\nContent-Length: 0\r\n", 400),
                                        ("Content-Length: 2\r\nContent-Length: 2\r\n", 411), ("", 411)):
            with self.subTest(headers=extra_headers):
                request = (f"POST /api/scan/jobs HTTP/1.0\r\nHost: netzplaner.test\r\nAuthorization: Bearer {TOKEN}\r\n"
                           "Content-Type: application/json\r\n" + extra_headers + "\r\n{}")
                self.assertIn(f" {expected} ".encode(), self.raw_request(request.encode()).split(b"\r\n", 1)[0])

    def test_invalid_or_unknown_job_ids(self):
        for suffix in ("../status", "a" * 31, "a" * 32 + "/extra", "a" * 32):
            with self.subTest(suffix=suffix):
                self.assertEqual(self.request("GET", "/api/scan/jobs/" + suffix)[0], 404)


if __name__ == "__main__":
    unittest.main()
