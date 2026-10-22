export const DEVICE_TYPES = [
  ["router", "Router / Firewall"],
  ["switch", "Switch"],
  ["ap", "Access Point"],
  ["server", "Server / NAS"],
  ["client", "Client / IoT"]
];

export const uid = (prefix = "id") => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function createPorts(count, deviceId) {
  return Array.from({ length: Math.max(1, Number(count) || 1) }, (_, index) => ({
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
  return `${endpoint.deviceId}:${endpoint.portId}`;
}

export function findPort(state, endpoint) {
  const device = state.devices.find((item) => item.id === endpoint.deviceId);
  const port = device?.ports.find((item) => item.id === endpoint.portId);
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
