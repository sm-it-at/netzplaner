import { DEVICE_TYPES, STATE_LIMITS, uid } from "./model.js";

export const SCAN_LIMITS = Object.freeze({ hosts: 256, xmlBytes: 2 * 1024 * 1024, services: 128 });
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";

export function canonicalIPv4(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value.trim())) return null;
  const parts = value.trim().split(".").map(Number);
  return parts.every((part) => part <= 255) ? parts.join(".") : null;
}

/** Mirrors the scanner's rule: one address or a canonical network with at most 256 addresses. */
export function scanTargetError(value) {
  const [address, prefix, ...rest] = typeof value === "string" ? value.split("/") : [];
  if (canonicalIPv4(address) !== address || rest.length || (prefix !== undefined && !/^(?:2[4-9]|3[0-2])$/.test(prefix))) {
    return "Bitte eine IPv4-Adresse oder ein Netz mit /24 bis /32 eingeben (maximal 256 Adressen).";
  }
  if (prefix === undefined) return null;
  const size = 2 ** (32 - Number(prefix));
  const numeric = address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
  if (numeric % size === 0) return null;
  const network = [24, 16, 8, 0].map((shift) => Math.floor((numeric - numeric % size) / 2 ** shift) % 256).join(".");
  return `Bitte die Netzadresse angeben: ${network}/${prefix} statt ${value}.`;
}

export function normalizeScanHost(source) {
  if (!record(source)) return null;
  const ip = canonicalIPv4(source.ip);
  if (!ip) return null;
  const seen = new Set();
  const ports = [];
  for (const port of Array.isArray(source.ports) ? source.ports.slice(0, 65536) : []) {
    if (!record(port) || port.protocol !== "tcp" || !Number.isInteger(port.port) || port.port < 1 || port.port > 65535 || seen.has(port.port)) continue;
    seen.add(port.port);
    ports.push({ port: port.port, protocol: "tcp", service: text(port.service, 40) });
    if (ports.length === SCAN_LIMITS.services) break;
  }
  return { ip, hostname: text(source.hostname, 40), name: text(source.name, 40), type: DEVICE_TYPES.some(([id]) => id === source.type) ? source.type : "client", mac: text(source.mac, 24), vendor: text(source.vendor, 80), ports: ports.sort((a, b) => a.port - b.port) };
}

/** Observed TCP services belong in notes, never in the physical port inventory. */
export function mergeScanHosts(state, hosts) {
  if (!record(state) || !Array.isArray(state.devices) || !Array.isArray(state.connections) || !Array.isArray(hosts)) throw new Error("Ungültige Scan-Auswahl.");
  if (hosts.length > SCAN_LIMITS.hosts) throw new Error(`Maximal ${SCAN_LIMITS.hosts} Scan-Geräte sind erlaubt.`);
  const known = new Set(state.devices.map((device) => canonicalIPv4(device.ip)).filter(Boolean));
  const ids = new Set([...state.devices.map((device) => device.id), ...state.devices.flatMap((device) => (device.ports || []).map((port) => port.id)), ...state.connections.map((link) => link.id)]);
  const addedDevices = [];
  let skipped = 0;
  for (const source of hosts) {
    const host = normalizeScanHost(source);
    if (!host || known.has(host.ip)) { skipped++; continue; }
    let id = uid("device"), suffix = 0;
    while (ids.has(id)) id = `${uid("device")}-${++suffix}`;
    ids.add(id);
    const notes = ["Aus Nmap-Ergebnis übernommen (Momentaufnahme).", host.mac ? `MAC: ${host.mac}` : "", host.vendor ? `Hersteller: ${host.vendor}` : "", host.ports.length ? `Beobachtete TCP-Dienste: ${host.ports.map((port) => `${port.port}/tcp${port.service ? ` (${port.service})` : ""}`).join(", ")}` : "Keine offenen TCP-Dienste im gewählten Scan erfasst."].filter(Boolean).join("\n").slice(0, 1000);
    addedDevices.push({ id, name: host.name || host.hostname || host.ip, type: host.type, ip: host.ip, location: "", notes, ports: [] });
    known.add(host.ip);
  }
  if (state.devices.length + addedDevices.length > STATE_LIMITS.devices) throw new Error(`Maximal ${STATE_LIMITS.devices} Geräte sind erlaubt. Bitte weniger Ergebnisse auswählen.`);
  return { state: { ...state, devices: [...state.devices, ...addedDevices] }, added: addedDevices.length, skipped };
}

/** Parse a local Nmap -oX file without resolving its optional external DTD. */
export function parseNmapXml(xml, Parser = globalThis.DOMParser) {
  if (typeof xml !== "string" || xml.length > SCAN_LIMITS.xmlBytes || new TextEncoder().encode(xml).length > SCAN_LIMITS.xmlBytes) throw new Error("Die XML-Datei darf höchstens 2 MB groß sein.");
  if (/<!\s*ENTITY\b/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) throw new Error("XML mit Entity-Deklarationen wird nicht unterstützt.");
  if (typeof Parser !== "function") throw new Error("Dieser Browser unterstützt den XML-Import nicht.");
  const document = new Parser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror") || document.documentElement?.tagName !== "nmaprun") throw new Error("Bitte eine gültige Nmap-XML-Datei (-oX) auswählen.");
  const hosts = [], seen = new Set();
  for (const element of document.documentElement.children) {
    if (element.tagName !== "host" || element.querySelector("status")?.getAttribute("state") !== "up") continue;
    const address = [...element.querySelectorAll("address")].find((address) => address.getAttribute("addrtype") === "ipv4" && canonicalIPv4(address.getAttribute("addr")));
    if (!address) continue;
    const mac = [...element.querySelectorAll("address")].find((address) => address.getAttribute("addrtype") === "mac");
    const ports = [...element.querySelectorAll("ports > port")].filter((port) => port.getAttribute("protocol") === "tcp" && port.querySelector("state")?.getAttribute("state") === "open").map((port) => ({ port: Number(port.getAttribute("portid")), protocol: "tcp", service: port.querySelector("service")?.getAttribute("name") || "" }));
    // -Pn marks every requested address up; only an open TCP port verifies it.
    if (element.querySelector("status")?.getAttribute("reason") === "user-set" && !ports.some((port) => Number.isInteger(port.port) && port.port > 0 && port.port <= 65535)) continue;
    const host = normalizeScanHost({ ip: address.getAttribute("addr"), hostname: element.querySelector("hostnames > hostname")?.getAttribute("name") || "", mac: mac?.getAttribute("addr") || "", vendor: mac?.getAttribute("vendor") || "", ports });
    if (!host || seen.has(host.ip)) continue;
    if (hosts.length === SCAN_LIMITS.hosts) throw new Error(`Die Datei enthält mehr als ${SCAN_LIMITS.hosts} aktive IPv4-Geräte. Bitte den Scanbereich verkleinern.`);
    seen.add(host.ip);
    hosts.push(host);
  }
  return hosts;
}
