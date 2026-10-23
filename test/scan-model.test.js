import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { canonicalIPv4, mergeScanHosts, normalizeScanHost, parseNmapXml, scanTargetError, SCAN_LIMITS } from "../public/scan-model.js";
const dom = new JSDOM("");
const parse = (xml) => parseNmapXml(xml, dom.window.DOMParser);
const empty = () => ({ devices: [], connections: [] });
const xmlHost = (ip, content = "", status = 'state="up" reason="arp-response"') => `<host><status ${status}/><address addr="${ip}" addrtype="ipv4"/>${content}</host>`;
const xml = (hosts) => `<?xml version="1.0"?><!DOCTYPE nmaprun SYSTEM "https://example.invalid/nmap.dtd"><nmaprun>${hosts}</nmaprun>`;
const service = (port, protocol = "tcp", state = "open") => `<ports><port protocol="${protocol}" portid="${port}"><state state="${state}"/><service name="https"/></port></ports>`;

test("scan IPv4 addresses must use valid canonical decimal octets", () => {
  for (const invalid of ["1.2.3.999", "01.2.3.4", "1.2.3", "127.1", "::1", "1.2.3.4/24", {}, "1e2.2.3.4", "1.2.3.4\nignored"]) assert.equal(canonicalIPv4(invalid), null);
  assert.equal(canonicalIPv4(" 192.168.1.8 "), "192.168.1.8");
});

test("scan targets follow the scanner rule: one address or a canonical network of at most 256 addresses", () => {
  for (const valid of ["192.168.1.10", "192.168.1.0/24", "10.1.2.128/25", "10.1.2.3/32"]) assert.equal(scanTargetError(valid), null);
  for (const invalid of ["192.168.0.0/16", "192.168.1.0/33", "192.168.1.0/", "192.168.001.1", " 192.168.1.1", "192.168.1.0/24/1", "", undefined]) assert.match(scanTargetError(invalid), /maximal 256/);
  assert.equal(scanTargetError("192.168.1.77/24"), "Bitte die Netzadresse angeben: 192.168.1.0/24 statt 192.168.1.77/24.");
  assert.match(scanTargetError("10.0.0.200/26"), /10\.0\.0\.192\/26/);
});

test("scan merge preserves every existing device and connection and never creates physical ports", () => {
  const existing = { id: "old", ip: "192.168.1.1", name: "My Router", notes: "Keep", ports: [{ id: "physical-1" }] };
  const state = { devices: [existing], connections: [{ id: "link" }] };
  const original = JSON.stringify(state);
  const result = mergeScanHosts(state, [{ ip: existing.ip, hostname: "overwrite", ports: [] }, { ip: "192.168.1.2", hostname: "nas", type: "server", ports: [{ port: 443, protocol: "tcp", service: "https" }] }, { ip: "192.168.1.2" }, { ip: "bad" }]);
  assert.equal(result.added, 1); assert.equal(result.skipped, 3);
  assert.equal(result.state.devices[0], existing); assert.equal(result.state.connections, state.connections);
  assert.equal(JSON.stringify(state), original);
  const device = result.state.devices[1];
  assert.equal(device.type, "server"); assert.equal(device.name, "nas"); assert.deepEqual(device.ports, []);
  assert.match(device.notes, /443\/tcp \(https\)/); assert.equal(device.location, "");
});

test("scan metadata is strictly bounded and TCP services are validated", () => {
  const result = normalizeScanHost({ ip: "10.0.0.1", name: "A".repeat(500), type: "script", hostname: {}, vendor: "V".repeat(1000), mac: "M".repeat(100), ports: [{ port: 22, protocol: "udp" }, { port: "80", protocol: "tcp" }, { port: 443, protocol: "tcp", service: "X".repeat(100) }, { port: 443, protocol: "tcp" }, { port: 65536, protocol: "tcp" }] });
  assert.equal(result.name.length, 40); assert.equal(result.type, "client"); assert.equal(result.vendor.length, 80); assert.equal(result.mac.length, 24);
  assert.equal(result.ports.length, 1); assert.equal(result.ports[0].service.length, 40);
  assert.equal(mergeScanHosts(empty(), [result]).state.devices[0].notes.length <= 1000, true);
});

test("scan merge refuses oversized selections and atomically enforces device limit", () => {
  assert.throws(() => mergeScanHosts(empty(), Array(257).fill({ ip: "10.0.0.1" })), /256/);
  const state = { devices: Array.from({ length: 500 }, (_, index) => ({ id: `d${index}`, ports: [] })), connections: [] };
  assert.throws(() => mergeScanHosts(state, [{ ip: "10.0.0.1" }]), /500/);
  assert.equal(state.devices.length, 500);
});

test("local Nmap XML supports standard external doctype and active IPv4 TCP services", () => {
  const hosts = parse(xml(xmlHost("192.168.1.8", '<hostnames><hostname name="nas.example"/></hostnames><address addr="AA:BB:CC:DD:EE:FF" addrtype="mac" vendor="Example"/>' + service(443) + service(53, "udp") + service(22, "tcp", "closed")) + xmlHost("192.168.1.9", "", 'state="down"') + '<host><status state="up"/><address addr="::1" addrtype="ipv6"/></host>'));
  assert.equal(hosts.length, 1); assert.equal(hosts[0].hostname, "nas.example"); assert.equal(hosts[0].mac, "AA:BB:CC:DD:EE:FF");
  assert.deepEqual(hosts[0].ports, [{ port: 443, protocol: "tcp", service: "https" }]);
});

test("Nmap -Pn user-set hosts need an open TCP service and duplicate addresses are removed", () => {
  const hosts = parse(xml(xmlHost("10.0.0.1", "", 'state="up" reason="user-set"') + xmlHost("10.0.0.2", service(443), 'state="up" reason="user-set"') + xmlHost("10.0.0.2", service(22))));
  assert.equal(hosts.length, 1); assert.equal(hosts[0].ip, "10.0.0.2");
});

test("Nmap XML rejects entities, malformed or unrelated documents, and oversized files", () => {
  for (const document of ['<!DOCTYPE nmaprun [<!ENTITY x SYSTEM "file:///secret">]><nmaprun/>', "<html/>", "<nmaprun>", "<!ENTITY x 'bad'><nmaprun/>"]) assert.throws(() => parse(document));
  assert.throws(() => parse(" ".repeat(SCAN_LIMITS.xmlBytes + 1)), /2 MB/);
  assert.throws(() => parse("é".repeat(SCAN_LIMITS.xmlBytes / 2 + 1)), /2 MB/);
});

test("Nmap XML rejects more than 256 active IPv4 hosts instead of silently truncating", () => {
  assert.throws(() => parse(xml(Array.from({ length: 257 }, (_, index) => xmlHost(`10.0.${Math.floor(index / 256)}.${index % 256}`)).join(""))), /mehr als 256/);
});
