"""Optional, deliberately restricted Nmap sidecar for trusted homelab users.

Only RFC1918 IPv4 targets explicitly allowed by the operator are accepted. Nmap
runs without raw sockets; no shell, DNS, script engine, or arbitrary flags exist
in this API. Tests inject a fake process and never scan a network.
"""

import copy
from dataclasses import dataclass
from datetime import datetime, timezone
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
import re
import signal
import subprocess
import threading
import time
from urllib.parse import urlsplit
import uuid
import xml.etree.ElementTree as ET


MAX_HOSTS = 256
MAX_OUTPUT = 4 * 1024 * 1024
MAX_BODY = 4096
MAX_JOBS = 8
JOB_TTL = 15 * 60
SCAN_TIMEOUT = 180
START_INTERVAL = 10
MAX_RATE = 50
HOST_TIMEOUT = 30
PORT_HOSTGROUP = 8
DISCOVERY_PROBES = "-PS22,80,443,445,3389,8080"
PORTS = (22, 53, 80, 111, 139, 443, 445, 631, 2049, 2375, 2376, 3000,
         3306, 3389, 5000, 5001, 5432, 5900, 6379, 8000, 8006, 8080,
         8081, 8123, 8443, 9000, 9090, 9443, 32400)
PROFILES = ({"id": "discovery", "name": "Geräte suchen"},
            {"id": "ports", "name": "Häufige TCP-Ports"})
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in
                         ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
JOB_ID = re.compile(r"[0-9a-f]{32}")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def is_private_network(network):
    return network.version == 4 and any(network.subnet_of(item) for item in PRIVATE_NETWORKS)


@dataclass(frozen=True)
class Config:
    token: str
    networks: tuple
    reason: str = ""

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        token = env.get("SCAN_TOKEN", "")
        if not 24 <= len(token) <= 256 or not all(33 <= ord(char) <= 126 for char in token):
            return cls("", (), "SCAN_TOKEN muss 24 bis 256 druckbare Zeichen ohne Leerzeichen enthalten.")
        raw = env.get("SCAN_ALLOWED_CIDRS", "").strip()
        if not raw:
            return cls(token, (), "Kein Scan-Netz freigegeben (SCAN_ALLOWED_CIDRS).")
        try:
            values = raw.split(",")
            if len(values) > 32:
                raise ValueError()
            networks = tuple(ipaddress.ip_network(value.strip(), strict=True) for value in values)
            if not all(is_private_network(network) for network in networks):
                raise ValueError()
        except ValueError:
            return cls(token, (), "SCAN_ALLOWED_CIDRS enthält ungültige oder nicht private IPv4-Netze.")
        return cls(token, networks)

    @property
    def enabled(self):
        return bool(self.token and self.networks and not self.reason)

    def target(self, value):
        if not isinstance(value, str) or not value or len(value) > 32 or value != value.strip():
            raise APIError(400, "Eine private IPv4-Adresse oder ein kanonisches CIDR-Netz angeben.")
        try:
            network = ipaddress.ip_network(value, strict=True)
            canonical = str(network) if "/" in value else str(network.network_address)
            if value != canonical or not is_private_network(network):
                raise ValueError()
        except ValueError:
            raise APIError(400, "Nur private IPv4-Adressen oder kanonische CIDR-Netze sind erlaubt.") from None
        if network.num_addresses > MAX_HOSTS:
            raise APIError(400, "Ein Scan darf höchstens 256 IPv4-Adressen umfassen.")
        if not any(network.subnet_of(allowed) for allowed in self.networks):
            raise APIError(403, "Das Ziel liegt außerhalb der freigegebenen Scan-Netze.")
        return network


class APIError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class ScanFailure(Exception):
    pass


class ScanCancelled(Exception):
    pass


def clean_text(value, limit):
    return "".join(char for char in (value or "") if char.isprintable())[:limit]


def parse_xml(data, target, profile):
    if len(data) > MAX_OUTPUT:
        raise ScanFailure("Die Scan-Ausgabe ist zu groß.")
    if b"\x00" in data:
        raise ScanFailure("Die Scan-Ausgabe muss UTF-8-XML sein.")
    # Nmap emits this simple DOCTYPE. Reject internal/external DTDs and entities.
    without_doctype = re.sub(br"<!DOCTYPE\s+nmaprun\s*>", b"", data, flags=re.IGNORECASE)
    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", without_doctype, re.IGNORECASE):
        raise ScanFailure("Die Scan-Ausgabe enthält unerlaubte XML-Deklarationen.")
    try:
        root = ET.fromstring(without_doctype)
    except ET.ParseError:
        raise ScanFailure("Nmap hat keine gültige XML-Ausgabe geliefert.") from None
    if root.tag != "nmaprun":
        raise ScanFailure("Unerwartetes Format der Scan-Ausgabe.")
    hosts = {}
    for element in root.findall("host"):
        status = element.find("status")
        if status is None or status.get("state") != "up":
            continue
        address = next((item for item in element.findall("address") if item.get("addrtype") == "ipv4"), None)
        if address is None:
            continue
        try:
            ip = ipaddress.IPv4Address(address.get("addr", ""))
        except ipaddress.AddressValueError:
            continue
        if ip not in target:
            continue
        ports = {}
        if profile == "ports":
            for item in element.findall("ports/port"):
                state = item.find("state")
                try:
                    port = int(item.get("portid", ""))
                except ValueError:
                    continue
                if item.get("protocol") != "tcp" or port not in PORTS or state is None or state.get("state") != "open":
                    continue
                service = item.find("service")
                ports[port] = {"port": port, "protocol": "tcp", "service": clean_text(service.get("name", "") if service is not None else "", 80)}
            # The ports profile reports services: a host without an open listed port is no result.
            if not ports:
                continue
        hostname = element.find("hostnames/hostname")
        host = {"ip": str(ip), "hostname": clean_text(hostname.get("name", "") if hostname is not None else "", 253),
                "ports": [ports[port] for port in sorted(ports)]}
        mac = next((item for item in element.findall("address") if item.get("addrtype") == "mac"), None)
        if mac is not None and re.fullmatch(r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}", mac.get("addr", "")):
            host["mac"] = mac.get("addr").upper()
            host["vendor"] = clean_text(mac.get("vendor", ""), 120)
        hosts[str(ip)] = host
        if len(hosts) > MAX_HOSTS:
            raise ScanFailure("Die Scan-Ausgabe enthält zu viele Geräte.")
    return sorted(hosts.values(), key=lambda host: ipaddress.IPv4Address(host["ip"]))


class ScanManager:
    def __init__(self, config, popen=subprocess.Popen, timeout=SCAN_TIMEOUT, interval=START_INTERVAL):
        self.config = config
        self.popen = popen
        self.timeout = timeout
        self.interval = interval
        self.lock = threading.RLock()
        self.jobs = {}
        self.active = None
        self.last_start = float("-inf")

    def cleanup(self):
        cutoff = time.monotonic() - JOB_TTL
        for job_id, job in list(self.jobs.items()):
            if job_id != self.active and job["created"] < cutoff:
                del self.jobs[job_id]

    @staticmethod
    def view(job):
        return copy.deepcopy(job["public"])

    def get(self, job_id):
        with self.lock:
            self.cleanup()
            if job_id not in self.jobs:
                raise APIError(404, "Scan-Auftrag nicht gefunden oder abgelaufen.")
            return self.view(self.jobs[job_id])

    def start(self, target, profile):
        if not self.config.enabled:
            raise APIError(503, self.config.reason or "Netzwerkscan ist deaktiviert.")
        network = self.config.target(target)
        if profile not in {item["id"] for item in PROFILES}:
            raise APIError(400, "Unbekanntes Scan-Profil.")
        with self.lock:
            self.cleanup()
            if self.active:
                raise APIError(409, "Es läuft bereits ein Netzwerkscan.")
            if time.monotonic() - self.last_start < self.interval:
                raise APIError(429, "Zwischen zwei Scans mindestens 10 Sekunden warten.")
            while len(self.jobs) >= MAX_JOBS:
                del self.jobs[next(iter(self.jobs))]
            job_id = uuid.uuid4().hex
            public = {"id": job_id, "status": "running", "target": target, "profile": profile,
                      "startedAt": now_iso(), "hosts": []}
            job = {"public": public, "created": time.monotonic(), "cancel": threading.Event()}
            self.jobs[job_id] = job
            self.active = job_id
            self.last_start = time.monotonic()
            thread = threading.Thread(target=self.run, args=(job_id, network), daemon=True)
            job["thread"] = thread
            thread.start()
            return self.view(job)

    def cancel(self, job_id):
        with self.lock:
            self.get(job_id)
            self.jobs[job_id]["cancel"].set()
            return self.view(self.jobs[job_id])

    @staticmethod
    def command(target, profile):
        command = ["nmap", "--unprivileged", "-n", "--max-retries", "1", "--host-timeout", f"{HOST_TIMEOUT}s",
                   "--max-rate", str(MAX_RATE), "--max-parallelism", "16", "-oX", "-"]
        if profile == "discovery":
            command += ["-sn", DISCOVERY_PROBES]
        else:
            # No -Pn: at MAX_RATE a /24 needs 256 * 29 / 50 = 149 s for probes alone, and Nmap's
            # default group of 64 hosts overruns HOST_TIMEOUT. Probe live hosts in small groups.
            command += ["-sT", DISCOVERY_PROBES, "--open", "--max-hostgroup", str(PORT_HOSTGROUP),
                        "-p", ",".join(map(str, PORTS))]
        return command + [target]

    def run(self, job_id, network):
        with self.lock:
            job = self.jobs[job_id]
            public = job["public"]
            target, profile = public["target"], public["profile"]
        process = None
        reader = None
        output = bytearray()
        read_errors = []
        try:
            if job["cancel"].is_set():
                raise ScanCancelled()
            process = self.popen(self.command(target, profile), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 stdin=subprocess.DEVNULL, shell=False, close_fds=True)

            def read_output():
                try:
                    while True:
                        chunk = process.stdout.read(8192)
                        if not chunk:
                            break
                        if len(output) + len(chunk) > MAX_OUTPUT:
                            read_errors.append("Die Scan-Ausgabe ist zu groß.")
                            break
                        output.extend(chunk)
                except (OSError, ValueError):
                    read_errors.append("Die Scan-Ausgabe konnte nicht gelesen werden.")

            reader = threading.Thread(target=read_output, daemon=True)
            reader.start()
            deadline = time.monotonic() + self.timeout
            while process.poll() is None:
                if job["cancel"].is_set():
                    raise ScanCancelled()
                if read_errors:
                    raise ScanFailure(read_errors[0])
                if time.monotonic() >= deadline:
                    raise ScanFailure("Der Scan wurde nach 180 Sekunden beendet.")
                job["cancel"].wait(0.05)
            reader.join(1)
            if job["cancel"].is_set():
                raise ScanCancelled()
            if read_errors:
                raise ScanFailure(read_errors[0])
            if reader.is_alive() or process.returncode != 0:
                raise ScanFailure("Nmap konnte den Scan nicht abschließen.")
            hosts = parse_xml(bytes(output), network, profile)
            with self.lock:
                if job["cancel"].is_set():
                    raise ScanCancelled()
                public.update(status="completed", hosts=hosts)
        except ScanCancelled:
            with self.lock:
                public.update(status="cancelled")
        except ScanFailure as error:
            with self.lock:
                public.update(status="failed", error=str(error))
        except Exception:
            # Never expose process stderr, filesystem details, or exception strings.
            with self.lock:
                public.update(status="failed", error="Der Scan konnte nicht gestartet oder verarbeitet werden.")
        finally:
            if process is not None:
                try:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    pass
                if reader is not None:
                    reader.join(1)
                if process.stdout is not None:
                    try:
                        process.stdout.close()
                    except OSError:
                        pass
            with self.lock:
                public["finishedAt"] = now_iso()
                self.active = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "NetzplanerScan"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_args):
        pass

    @property
    def manager(self):
        return self.server.manager

    def respond(self, status, data):
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 401:
            self.send_header("WWW-Authenticate", "Bearer")
        if status == 429:
            self.send_header("Retry-After", str(START_INTERVAL))
        self.end_headers()
        self.wfile.write(payload)

    def authorize(self):
        expected = self.manager.config.token
        authorization = self.headers.get("Authorization", "")
        provided = authorization[7:] if authorization.startswith("Bearer ") else ""
        if not expected or not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
            raise APIError(401, "Gültiges Scan-Token erforderlich.")
        if not self.manager.config.enabled:
            raise APIError(503, self.manager.config.reason)

    def check_origin(self):
        if self.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
            raise APIError(403, "Browser-Anfragen von fremden Websites sind nicht erlaubt.")
        origin = self.headers.get("Origin")
        if origin is None:
            return
        try:
            parsed = urlsplit(origin)
            host = self.headers.get("Host", "")
            if (parsed.scheme not in ("http", "https") or not host or parsed.netloc.lower() != host.lower()
                    or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username is not None):
                raise ValueError()
        except ValueError:
            raise APIError(403, "Origin und Host der Anfrage müssen übereinstimmen.") from None

    def body(self):
        if self.headers.get("Transfer-Encoding"):
            raise APIError(400, "Transfer-Encoding wird nicht unterstützt.")
        length = self.headers.get("Content-Length", "")
        if len(self.headers.get_all("Content-Length", [])) != 1 or not re.fullmatch(r"[0-9]{1,10}", length):
            raise APIError(411, "Eine gültige Content-Length ist erforderlich.")
        length = int(length)
        if length > MAX_BODY:
            self.close_connection = True
            raise APIError(413, "Die Anfrage ist zu groß.")
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise APIError(415, "Content-Type application/json ist erforderlich.")
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError()
            data = json.loads(raw)
            if not isinstance(data, dict) or set(data) != {"target", "profile"}:
                raise ValueError()
            if not isinstance(data["target"], str) or not isinstance(data["profile"], str):
                raise ValueError()
            return data
        except (UnicodeDecodeError, ValueError):
            raise APIError(400, "Die Anfrage muss target und profile als JSON-Textfelder enthalten.") from None

    def dispatch(self):
        path = urlsplit(self.path).path
        if self.command == "GET" and path == "/healthz":
            return self.respond(200, {"ok": True})
        if self.command == "GET" and path == "/api/scan/status":
            return self.respond(200, {"enabled": self.manager.config.enabled, "reason": self.manager.config.reason})
        self.authorize()
        if self.command in ("POST", "DELETE"):
            self.check_origin()
        if self.command == "GET" and path == "/api/scan/config":
            return self.respond(200, {"allowedCidrs": [str(item) for item in self.manager.config.networks],
                                      "maxHosts": MAX_HOSTS, "profiles": PROFILES})
        if self.command == "POST" and path == "/api/scan/jobs":
            data = self.body()
            return self.respond(202, self.manager.start(data["target"], data["profile"]))
        if path.startswith("/api/scan/jobs/"):
            job_id = path.removeprefix("/api/scan/jobs/")
            if JOB_ID.fullmatch(job_id):
                if self.command == "GET":
                    return self.respond(200, self.manager.get(job_id))
                if self.command == "DELETE":
                    return self.respond(202, self.manager.cancel(job_id))
        raise APIError(404, "Endpunkt nicht gefunden.")

    def handle_request(self):
        try:
            self.dispatch()
        except APIError as error:
            self.respond(error.status, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            self.respond(500, {"error": "Die Anfrage konnte nicht verarbeitet werden."})

    do_GET = handle_request
    do_POST = handle_request
    do_DELETE = handle_request


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def make_server(address=("0.0.0.0", 8090), config=None, manager=None):
    server = BoundedHTTPServer(address, Handler)
    server.manager = manager or ScanManager(config or Config.from_env())
    return server


if __name__ == "__main__":
    server = make_server()
    # shutdown() must run outside the thread executing serve_forever().
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print("Netzplaner scanner: " + ("enabled" if server.manager.config.enabled else "disabled"), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with server.manager.lock:
            for job in server.manager.jobs.values():
                job["cancel"].set()
            workers = [job["thread"] for job in server.manager.jobs.values()]
        for worker in workers:
            worker.join(3)
        server.server_close()
