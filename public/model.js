export const DEVICE_TYPES = [
  ["router", "Router / Firewall"],
  ["switch", "Switch"],
  ["ap", "Access Point"],
  ["server", "Server / NAS"],
  ["client", "Client / IoT"]
];

let uidCounter = 0;
// The counter keeps IDs unique within one page; random bytes separate tabs. Unlike
// crypto.randomUUID, getRandomValues also exists when the app is opened over plain HTTP.
const randomHex = () => globalThis.crypto?.getRandomValues
  ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("")
  : Math.random().toString(16).slice(2, 14);
export const uid = (prefix = "id") => `${prefix}-${Date.now().toString(36)}-${(uidCounter++).toString(36)}-${randomHex()}`;

export const STATE_LIMITS = Object.freeze({ devices: 500, portsPerDevice: 256, totalPorts: 10000, connections: 10000 });

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Never invoke imported objects' toString/valueOf methods or copy arbitrary properties.
const plainText = (value, fallback = "") => typeof value === "string" ? value :
  typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" ? String(value) : fallback;
const cloneState = (state) => JSON.parse(JSON.stringify(state));
const unusedId = (prefix, ids) => {
  const base = uid(prefix);
  let candidate = base, suffix = 1;
  while (ids.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
};

/** Validate old exports and saved browser data. Repairs are reported, never silently applied. */
export function normalizeState(input) {
  if (!isRecord(input) || !Array.isArray(input.devices) || !Array.isArray(input.connections)) {
    throw new Error("Ungültiger Netzplan: Geräte und Verbindungen müssen Listen sein.");
  }
  if (input.devices.length > STATE_LIMITS.devices) throw new Error(`Maximal ${STATE_LIMITS.devices} Geräte sind erlaubt.`);
  if (input.connections.length > STATE_LIMITS.connections) throw new Error(`Maximal ${STATE_LIMITS.connections} Verbindungen sind erlaubt.`);
  let portCount = 0;
  for (const device of input.devices) {
    if (!Array.isArray(device?.ports)) continue;
    if (device.ports.length > STATE_LIMITS.portsPerDevice) throw new Error(`Maximal ${STATE_LIMITS.portsPerDevice} Ports pro Gerät sind erlaubt.`);
    portCount += device.ports.length;
  }
  if (portCount > STATE_LIMITS.totalPorts) throw new Error(`Maximal ${STATE_LIMITS.totalPorts} Ports sind erlaubt.`);

  const warnings = [];
  const state = { devices: [], connections: [] };
  const ids = new Set();
  const deviceRefs = new Map();
  const text = (value, fallback, maxLength, description) => {
    let result = plainText(value, fallback).trim();
    if (value != null && typeof value !== "string") warnings.push(`${description}: Wert wurde in Text umgewandelt oder ersetzt.`);
    if (result.length > maxLength) {
      warnings.push(`${description}: Text wurde auf ${maxLength} Zeichen gekürzt.`);
      result = result.slice(0, maxLength);
    }
    return result;
  };
  const uniqueId = (value, prefix, description) => {
    const original = plainText(value);
    let result = original;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(result) || ids.has(result)) {
      result = unusedId(prefix, ids);
      warnings.push(`${description}: Fehlende, unsichere oder doppelte ID wurde ersetzt.`);
    }
    ids.add(result);
    return result;
  };

  input.devices.forEach((source, index) => {
    const description = `Gerät ${index + 1}`;
    if (!isRecord(source)) { warnings.push(`${description}: Ungültiger Eintrag wurde übersprungen.`); return; }
    const originalId = plainText(source.id);
    if (originalId && deviceRefs.has(originalId)) {
      warnings.push(`${description}: Doppelte Geräte-ID; Eintrag wurde übersprungen.`);
      return;
    }
    const id = uniqueId(source.id, "device", description);
    const type = DEVICE_TYPES.some(([value]) => value === source.type) ? source.type : "client";
    if (source.type !== type) warnings.push(`${description}: Unbekannter Gerätetyp wurde durch Client / IoT ersetzt.`);
    const device = {
      id, name: text(source.name, `Gerät ${index + 1}`, 120, `${description}, Name`) || `Gerät ${index + 1}`,
      type, ip: text(source.ip, "", 100, `${description}, IP`),
      location: text(source.location, "", 120, `${description}, Standort`),
      notes: text(source.notes, "", 1000, `${description}, Notizen`), ports: []
    };
    const portRefs = new Map();
    if (originalId) deviceRefs.set(originalId, { device, portRefs });
    if (!Array.isArray(source.ports)) warnings.push(`${description}: Fehlende oder ungültige Portliste wurde durch eine leere Liste ersetzt.`);
    (Array.isArray(source.ports) ? source.ports : []).forEach((portSource, portIndex) => {
      const portDescription = `${description}, Port ${portIndex + 1}`;
      if (!isRecord(portSource)) { warnings.push(`${portDescription}: Ungültiger Eintrag wurde übersprungen.`); return; }
      const originalPortId = plainText(portSource.id);
      if (originalPortId && portRefs.has(originalPortId)) {
        warnings.push(`${portDescription}: Doppelte Port-ID; Eintrag wurde übersprungen.`);
        return;
      }
      const port = {
        id: uniqueId(portSource.id, "port", portDescription),
        name: text(portSource.name, `Port ${portIndex + 1}`, 120, `${portDescription}, Name`) || `Port ${portIndex + 1}`,
        speed: text(portSource.speed, "1 Gbit/s", 40, `${portDescription}, Geschwindigkeit`) || "1 Gbit/s",
        mode: text(portSource.mode, "Access", 30, `${portDescription}, Modus`) || "Access",
        vlan: text(portSource.vlan, "1", 100, `${portDescription}, VLAN`),
        poe: portSource.poe === true || portSource.poe === "true", deviceId: id
      };
      if (portSource.deviceId != null && plainText(portSource.deviceId) !== originalId) warnings.push(`${portDescription}: Gerätezuordnung wurde korrigiert.`);
      if (originalPortId) portRefs.set(originalPortId, port.id);
      device.ports.push(port);
    });
    state.devices.push(device);
  });

  const resolveEndpoint = (source) => {
    if (!isRecord(source)) return null;
    const ref = deviceRefs.get(plainText(source.deviceId));
    const portId = ref?.portRefs.get(plainText(source.portId));
    return portId ? { deviceId: ref.device.id, portId } : null;
  };
  input.connections.forEach((source, index) => {
    const description = `Verbindung ${index + 1}`;
    if (!isRecord(source)) { warnings.push(`${description}: Ungültiger Eintrag wurde übersprungen.`); return; }
    const a = resolveEndpoint(source.a), b = resolveEndpoint(source.b);
    if (!a || !b) { warnings.push(`${description}: Nicht vorhandenes Gerät oder Port; Verbindung wurde übersprungen.`); return; }
    if (endpointKey(a) === endpointKey(b)) { warnings.push(`${description}: Verbindung eines Ports mit sich selbst wurde übersprungen.`); return; }
    state.connections.push({ id: uniqueId(source.id, "link", description), label: text(source.label, "", 120, `${description}, Bezeichnung`), a, b });
  });
  return { state, warnings };
}

export function createPorts(count, deviceId) {
  const numericCount = Number(count);
  const length = Number.isFinite(numericCount) ? Math.min(STATE_LIMITS.portsPerDevice, Math.max(1, Math.floor(numericCount))) : 1;
  return Array.from({ length }, (_, index) => ({
    id: uid("port"),
    name: `Port ${index + 1}`,
    speed: "1 Gbit/s",
    mode: "Access",
    vlan: "1",
    poe: false,
    deviceId
  }));
}

export function endpointKey(endpoint) {
  return `${endpoint?.deviceId}:${endpoint?.portId}`;
}

export function findPort(state, endpoint) {
  if (!endpoint) return null;
  const device = state.devices.find((item) => item.id === endpoint.deviceId);
  const port = device?.ports?.find((item) => item.id === endpoint.portId);
  return device && port ? { device, port } : null;
}

export function validateConnection(state, connection, ignoreId = null) {
  if (!connection?.a?.deviceId || !connection?.a?.portId || !connection?.b?.deviceId || !connection?.b?.portId) {
    return "Bitte zwei Ports auswählen.";
  }
  if (endpointKey(connection.a) === endpointKey(connection.b)) return "Ein Port kann nicht mit sich selbst verbunden werden.";
  if (!findPort(state, connection.a) || !findPort(state, connection.b)) return "Mindestens ein ausgewählter Port existiert nicht mehr.";

  const used = new Set(
    state.connections
      .filter((item) => item.id !== ignoreId)
      .flatMap((item) => [endpointKey(item.a), endpointKey(item.b)])
  );
  if (used.has(endpointKey(connection.a)) || used.has(endpointKey(connection.b))) {
    return "Port-Konflikt: Mindestens einer der Ports ist bereits belegt.";
  }
  return null;
}

export function getConflicts(state) {
  const occurrences = new Map();
  for (const connection of state.connections) {
    for (const endpoint of [connection.a, connection.b]) {
      const key = endpointKey(endpoint);
      occurrences.set(key, [...(occurrences.get(key) || []), connection.id]);
    }
  }
  const conflicts = [];
  for (const [key, connectionIds] of occurrences) {
    if (connectionIds.length > 1) conflicts.push({ key, connectionIds });
  }
  return conflicts;
}

export function getSummary(state) {
  const ports = state.devices.flatMap((device) => device.ports || []);
  const usedKeys = new Set(state.connections.flatMap((connection) => [endpointKey(connection.a), endpointKey(connection.b)]));
  return {
    devices: state.devices.length,
    ports: ports.length,
    used: ports.filter((port) => usedKeys.has(`${port.deviceId}:${port.id}`)).length,
    free: ports.filter((port) => !usedKeys.has(`${port.deviceId}:${port.id}`)).length,
    connections: state.connections.length,
    conflicts: getConflicts(state).length
  };
}

export function removeDevice(state, deviceId) {
  return {
    devices: state.devices.filter((device) => device.id !== deviceId),
    connections: state.connections.filter((connection) => connection.a.deviceId !== deviceId && connection.b.deviceId !== deviceId)
  };
}

export function removePort(state, deviceId, portId) {
  return {
    devices: state.devices.map((device) => device.id === deviceId
      ? { ...device, ports: device.ports.filter((port) => port.id !== portId) }
      : device),
    connections: state.connections.filter((connection) =>
      !(connection.a.deviceId === deviceId && connection.a.portId === portId) &&
      !(connection.b.deviceId === deviceId && connection.b.portId === portId))
  };
}

/** Clone a device and its ports. An address must be assigned explicitly to the copy. */
export function duplicateDevice(state, deviceId) {
  const original = state.devices.find((device) => device.id === deviceId);
  if (!original) return state;
  if (state.devices.length >= STATE_LIMITS.devices) throw new Error(`Maximal ${STATE_LIMITS.devices} Geräte sind erlaubt.`);
  const totalPorts = state.devices.reduce((sum, device) => sum + device.ports.length, 0);
  if (totalPorts + original.ports.length > STATE_LIMITS.totalPorts) throw new Error(`Maximal ${STATE_LIMITS.totalPorts} Ports sind erlaubt.`);
  const ids = new Set([...state.devices.map((device) => device.id), ...state.devices.flatMap((device) => device.ports.map((port) => port.id)), ...state.connections.map((link) => link.id)]);
  const id = unusedId("device", ids);
  ids.add(id);
  const device = {
    ...cloneState(original), id, name: `${original.name} (Kopie)`.slice(0, 120), ip: "",
    ports: original.ports.map((port) => {
      const portId = unusedId("port", ids);
      ids.add(portId);
      return { ...cloneState(port), id: portId, deviceId: id };
    })
  };
  return { ...state, devices: [...state.devices, device] };
}

function ipv4Parts(value) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) ? parts.map(Number) : null;
}

// Compare expanded IPv6 groups, so compressed spelling and letter case cannot hide a duplicate.
function ipKey(value) {
  if (!value.includes(":")) {
    const parts = ipv4Parts(value);
    return parts ? `v4:${parts.join(".")}` : null;
  }
  let address = value.toLowerCase();
  if (address.includes(".")) {
    const boundary = address.lastIndexOf(":");
    const parts = ipv4Parts(address.slice(boundary + 1));
    if (!parts) return null;
    address = `${address.slice(0, boundary + 1)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(address) || address.split("::").length > 2) return null;
  const compressed = address.includes("::");
  const halves = address.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = compressed ? [...left, ...right] : left;
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  if (compressed ? groups.length >= 8 : groups.length !== 8) return null;
  const expanded = compressed ? [...left, ...Array(8 - groups.length).fill("0"), ...right] : groups;
  return `v6:${expanded.map((group) => parseInt(group, 16).toString(16)).join(":")}`;
}

const speedValue = (value) => {
  const match = plainText(value).trim().replace(",", ".").match(/^(\d+(?:\.\d+)?)\s*([kmg])(?:bit|bps)(?:\/s)?$/i);
  return match ? Number(match[1]) * ({ k: 0.001, m: 1, g: 1000 })[match[2].toLowerCase()] : null;
};

/** Planning hints only: this does not probe live devices or negotiate links. */
export function getNetworkIssues(state) {
  const issues = [], addresses = new Map(), occurrences = new Map();
  for (const device of state.devices) {
    const value = plainText(device.ip).trim();
    if (!value) continue;
    const key = ipKey(value);
    if (!key) issues.push({ type: "invalid-ip", severity: "error", message: `${device.name}: „${value}“ ist keine gültige IPv4- oder IPv6-Adresse.`, deviceIds: [device.id] });
    else addresses.set(key, [...(addresses.get(key) || []), device]);
  }
  for (const devices of addresses.values()) {
    if (devices.length > 1) issues.push({ type: "duplicate-ip", severity: "error", message: `IP-Adresse ${devices[0].ip} wird mehrfach verwendet: ${devices.map((device) => device.name).join(", ")}.`, deviceIds: devices.map((device) => device.id) });
  }
  for (const link of state.connections) {
    const a = findPort(state, link.a), b = findPort(state, link.b);
    const deviceIds = [...new Set([link.a?.deviceId, link.b?.deviceId].filter(Boolean))];
    if (!a || !b) {
      issues.push({ type: "dangling-connection", severity: "error", message: `Verbindung „${link.label || link.id}“ verweist auf ein fehlendes Gerät oder einen fehlenden Port.`, deviceIds });
      continue;
    }
    if (endpointKey(link.a) === endpointKey(link.b)) issues.push({ type: "self-connection", severity: "error", message: `${a.device.name}, ${a.port.name}: Ein Port ist mit sich selbst verbunden.`, deviceIds });
    for (const endpoint of [link.a, link.b]) {
      const key = endpointKey(endpoint);
      occurrences.set(key, [...(occurrences.get(key) || []), endpoint]);
    }
    const aVlan = plainText(a.port.vlan).trim(), bVlan = plainText(b.port.vlan).trim();
    if (plainText(a.port.mode).toLowerCase() === "access" && plainText(b.port.mode).toLowerCase() === "access" && /^\d+$/.test(aVlan) && /^\d+$/.test(bVlan) && Number(aVlan) !== Number(bVlan)) {
      issues.push({ type: "vlan-mismatch", severity: "warning", message: `${a.device.name} ↔ ${b.device.name}: Access-Ports verwenden unterschiedliche VLANs (${aVlan} / ${bVlan}).`, deviceIds });
    }
    const aSpeed = speedValue(a.port.speed), bSpeed = speedValue(b.port.speed);
    if (aSpeed !== null && bSpeed !== null && aSpeed !== bSpeed) issues.push({ type: "speed-mismatch", severity: "warning", message: `${a.device.name} ↔ ${b.device.name}: Unterschiedliche Portgeschwindigkeiten (${a.port.speed} / ${b.port.speed}); tatsächliche Aushandlung prüfen.`, deviceIds });
  }
  for (const endpoints of occurrences.values()) {
    if (endpoints.length < 2) continue;
    const endpoint = endpoints[0], found = findPort(state, endpoint);
    issues.push({ type: "port-conflict", severity: "error", message: `${found.device.name}, ${found.port.name}: Port ist mehrfach belegt.`, deviceIds: [endpoint.deviceId] });
  }
  return issues;
}

/** Semicolon-separated for spreadsheet imports; the download caller may prepend a UTF-8 BOM. */
export function devicesToCsv(state) {
  const labels = Object.fromEntries(DEVICE_TYPES);
  const used = new Set(state.connections.flatMap((link) => [endpointKey(link.a), endpointKey(link.b)]));
  const cell = (value) => {
    let text = plainText(value);
    // Quoting alone does not stop formulas in spreadsheet applications.
    if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [["Name", "Typ", "IP", "Standort", "Ports", "Belegt", "Frei"], ...state.devices.map((device) => {
    const occupied = device.ports.filter((port) => used.has(endpointKey({ deviceId: device.id, portId: port.id }))).length;
    return [device.name, labels[device.type] || device.type, device.ip, device.location, device.ports.length, occupied, device.ports.length - occupied];
  })];
  return rows.map((row) => row.map(cell).join(";")).join("\r\n") + "\r\n";
}

/** Keep independent JSON snapshots, with at most `limit` undo steps. */
export function createHistory(initialState, limit = 50) {
  const capacity = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(1000, Math.floor(Number(limit)))) : 50;
  let snapshots = [JSON.stringify(initialState)], index = 0;
  return {
    commit(state) {
      const snapshot = JSON.stringify(state);
      if (snapshot === snapshots[index]) return false;
      snapshots = snapshots.slice(0, index + 1);
      snapshots.push(snapshot);
      if (snapshots.length > capacity + 1) snapshots.shift();
      index = snapshots.length - 1;
      return true;
    },
    undo() { return index > 0 ? JSON.parse(snapshots[--index]) : null; },
    redo() { return index < snapshots.length - 1 ? JSON.parse(snapshots[++index]) : null; },
    get canUndo() { return index > 0; },
    get canRedo() { return index < snapshots.length - 1; }
  };
}

export function demoState() {
  const router = { id: "router-1", name: "Firewall", type: "router", ip: "10.20.0.1", location: "Rack", ports: [] };
  const sw = { id: "switch-1", name: "Core Switch", type: "switch", ip: "10.20.0.2", location: "Rack", ports: [] };
  const ap = { id: "ap-1", name: "AP Büro", type: "ap", ip: "10.20.0.10", location: "Büro", ports: [] };
  router.ports = createPorts(4, router.id);
  sw.ports = createPorts(8, sw.id);
  ap.ports = createPorts(2, ap.id);
  sw.ports[0].name = "Uplink";
  sw.ports[1].name = "AP Büro";
  sw.ports[1].poe = true;
  ap.ports[0].name = "LAN / PoE";
  return {
    devices: [router, sw, ap],
    connections: [
      { id: "link-1", label: "WAN/LAN", a: { deviceId: router.id, portId: router.ports[0].id }, b: { deviceId: sw.id, portId: sw.ports[0].id } },
      { id: "link-2", label: "PoE", a: { deviceId: sw.id, portId: sw.ports[1].id }, b: { deviceId: ap.id, portId: ap.ports[0].id } }
    ]
  };
}
