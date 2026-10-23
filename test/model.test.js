import test from "node:test";
import assert from "node:assert/strict";
import {
  STATE_LIMITS, createPorts, getConflicts, getSummary, removeDevice, removePort, validateConnection,
  normalizeState, duplicateDevice, getNetworkIssues, devicesToCsv, createHistory, demoState, uid
} from "../public/model.js";

function fixture() {
  const a = { id: "a", name: "A", ports: createPorts(2, "a") };
  const b = { id: "b", name: "B", ports: createPorts(2, "b") };
  return { devices: [a, b], connections: [] };
}

test("IDs created in one burst stay unique, so a reloaded plan needs no repair", () => {
  const ids = Array.from({ length: 20000 }, () => uid("port"));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[a-zA-Z0-9_-]{1,100}$/.test(id)));
  const devices = Array.from({ length: 39 }, (_, index) => ({ id: `d${index}`, name: "Switch", type: "switch", ports: createPorts(256, `d${index}`) }));
  assert.deepEqual(normalizeState({ devices, connections: [] }).warnings, []);
});

test("summary counts occupied and free ports", () => {
  const state = fixture();
  state.connections.push({ id: "c1", a: { deviceId: "a", portId: state.devices[0].ports[0].id }, b: { deviceId: "b", portId: state.devices[1].ports[0].id } });
  assert.deepEqual(getSummary(state), { devices: 2, ports: 4, used: 2, free: 2, connections: 1, conflicts: 0 });
});

test("connection validator rejects an occupied port", () => {
  const state = fixture();
  const a0 = state.devices[0].ports[0].id;
  state.connections.push({ id: "c1", a: { deviceId: "a", portId: a0 }, b: { deviceId: "b", portId: state.devices[1].ports[0].id } });
  const error = validateConnection(state, { a: { deviceId: "a", portId: a0 }, b: { deviceId: "b", portId: state.devices[1].ports[1].id } });
  assert.match(error, /Port-Konflikt/);
});

test("conflict scan detects duplicate port assignments", () => {
  const state = fixture();
  const shared = { deviceId: "a", portId: state.devices[0].ports[0].id };
  state.connections = [
    { id: "c1", a: shared, b: { deviceId: "b", portId: state.devices[1].ports[0].id } },
    { id: "c2", a: shared, b: { deviceId: "b", portId: state.devices[1].ports[1].id } }
  ];
  assert.equal(getConflicts(state).length, 1);
});

test("removing a port also removes its connection", () => {
  const state = fixture();
  const portId = state.devices[0].ports[0].id;
  state.connections.push({ id: "c1", a: { deviceId: "a", portId }, b: { deviceId: "b", portId: state.devices[1].ports[0].id } });
  const next = removePort(state, "a", portId);
  assert.equal(next.devices[0].ports.length, 1);
  assert.equal(next.connections.length, 0);
});

test("removing a device cleans related links", () => {
  const state = fixture();
  state.connections.push({ id: "c1", a: { deviceId: "a", portId: state.devices[0].ports[0].id }, b: { deviceId: "b", portId: state.devices[1].ports[0].id } });
  const next = removeDevice(state, "a");
  assert.equal(next.devices.length, 1);
  assert.equal(next.connections.length, 0);
});

test("normalization preserves existing exports and returns independent safe records", () => {
  const source = demoState();
  source.devices[0].notes = "  Wartung Freitag  ";
  const { state, warnings } = normalizeState(source);
  assert.deepEqual(warnings, []);
  assert.equal(state.devices[0].notes, "Wartung Freitag");
  assert.deepEqual(state.connections, source.connections);
  state.devices[0].ports[0].name = "Changed";
  assert.notEqual(source.devices[0].ports[0].name, "Changed");
});

test("normalization rejects invalid roots and excessive device, port and connection counts", () => {
  for (const input of [null, [], {}, { devices: [], connections: {} }]) {
    assert.throws(() => normalizeState(input), /Ungültiger Netzplan/);
  }
  assert.throws(() => normalizeState({ devices: Array(STATE_LIMITS.devices + 1), connections: [] }), /Geräte/);
  assert.throws(() => normalizeState({ devices: [{ ports: Array(STATE_LIMITS.portsPerDevice + 1) }], connections: [] }), /Ports pro Gerät/);
  assert.throws(() => normalizeState({ devices: Array.from({ length: 40 }, () => ({ ports: Array(256) })), connections: [] }), /10000 Ports/);
  assert.throws(() => normalizeState({ devices: [], connections: Array(STATE_LIMITS.connections + 1) }), /Verbindungen/);
});

test("normalization repairs IDs and keeps endpoint references and port ownership consistent", () => {
  const source = {
    devices: [
      { id: 'a" onclick="bad', name: " A ", type: "switch", ports: [{ id: 'p"', deviceId: "wrong" }] },
      { id: "b", name: "B", type: "router", ports: [{ id: 'p"', deviceId: "b" }] }
    ],
    connections: [{ id: "b", a: { deviceId: 'a" onclick="bad', portId: 'p"' }, b: { deviceId: "b", portId: 'p"' } }]
  };
  const { state, warnings } = normalizeState(source);
  const allIds = [...state.devices.map((device) => device.id), ...state.devices.flatMap((device) => device.ports.map((port) => port.id)), ...state.connections.map((link) => link.id)];
  assert.equal(new Set(allIds).size, allIds.length);
  assert.ok(allIds.every((id) => /^[a-zA-Z0-9_-]+$/.test(id)));
  assert.equal(state.devices[0].ports[0].deviceId, state.devices[0].id);
  assert.deepEqual(state.connections[0].a, { deviceId: state.devices[0].id, portId: state.devices[0].ports[0].id });
  assert.deepEqual(state.connections[0].b, { deviceId: "b", portId: state.devices[1].ports[0].id });
  assert.ok(warnings.length >= 4);
});

test("normalization skips ambiguous duplicate devices and ports, malformed entries and invalid links", () => {
  const source = {
    devices: [null, { id: "a", ports: [null, { id: "p" }, { id: "p" }] }, { id: "a", ports: [] }, { id: "b" }],
    connections: [null, { a: { deviceId: "a", portId: "p" }, b: { deviceId: "missing", portId: "p" } }, { a: { deviceId: "a", portId: "p" }, b: { deviceId: "a", portId: "p" } }]
  };
  const { state, warnings } = normalizeState(source);
  assert.equal(state.devices.length, 2);
  assert.equal(state.devices[0].ports.length, 1);
  assert.deepEqual(state.devices[1].ports, []);
  assert.deepEqual(state.connections, []);
  assert.ok(warnings.some((warning) => warning.includes("Doppelte Geräte-ID")));
  assert.ok(warnings.some((warning) => warning.includes("Doppelte Port-ID")));
});

test("normalization safely coerces scalars, bounds text and discards arbitrary properties", () => {
  const hostile = { toString() { throw new Error("must not run"); } };
  const source = { devices: [{ id: 123, name: hostile, ip: 42, type: "other", location: false, notes: "x".repeat(1001), ports: [{ id: 321, name: 7, vlan: 20, poe: "false" }], extra: hostile }], connections: [] };
  const { state, warnings } = normalizeState(source);
  assert.equal(state.devices[0].id, "123");
  assert.equal(state.devices[0].name, "Gerät 1");
  assert.equal(state.devices[0].ip, "42");
  assert.equal(state.devices[0].location, "false");
  assert.equal(state.devices[0].notes.length, 1000);
  assert.equal(state.devices[0].type, "client");
  assert.equal(state.devices[0].ports[0].vlan, "20");
  assert.equal(state.devices[0].ports[0].poe, false);
  assert.equal("extra" in state.devices[0], false);
  assert.ok(warnings.length > 0);
});

test("normalization retains port conflicts for visible diagnosis", () => {
  const source = demoState();
  source.connections.push({ ...source.connections[0], id: "another" });
  const { state } = normalizeState(source);
  assert.equal(state.connections.length, 3);
  assert.equal(getConflicts(state).length, 2);
});

test("port creation bounds invalid and excessive counts", () => {
  assert.equal(createPorts(Infinity, "a").length, 1);
  assert.equal(createPorts(-5, "a").length, 1);
  assert.equal(createPorts(2.9, "a").length, 2);
  assert.equal(createPorts(1000000, "a").length, STATE_LIMITS.portsPerDevice);
});

test("device duplication uses new independent ports, preserves notes and clears the IP", () => {
  const source = demoState();
  source.devices[0].notes = "Backup vorhanden";
  const next = duplicateDevice(source, source.devices[0].id);
  const copy = next.devices.at(-1);
  assert.equal(next.devices.length, source.devices.length + 1);
  assert.equal(copy.name, "Firewall (Kopie)");
  assert.equal(copy.ip, "");
  assert.equal(copy.notes, "Backup vorhanden");
  assert.equal(next.connections.length, source.connections.length);
  assert.notEqual(copy.id, source.devices[0].id);
  assert.ok(copy.ports.every((port) => port.deviceId === copy.id && !source.devices[0].ports.some((original) => original.id === port.id)));
  copy.ports[0].name = "Copy only";
  assert.notEqual(source.devices[0].ports[0].name, "Copy only");
  assert.equal(duplicateDevice(source, "missing"), source);
});

test("IP scan accepts IPv4 and IPv6 and rejects malformed input without accepting hostnames or prefixes", () => {
  const valid = ["0.0.0.0", "255.255.255.255", "::", "::1", "2001:db8::1", "2001:db8:0:0:0:0:0:2", "::ffff:192.0.2.1"];
  const invalid = ["256.1.2.3", "10.01.1.1", "router.local", "10.0.0.1/24", "2001:::1", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8::", "::ffff:999.0.0.1", "[::1]"];
  const state = { devices: [...valid, ...invalid].map((ip, index) => ({ id: `d${index}`, name: ip, ip, ports: [] })), connections: [] };
  const issues = getNetworkIssues(state);
  assert.deepEqual(issues.filter((issue) => issue.type === "invalid-ip").map((issue) => issue.deviceIds[0]), invalid.map((_, index) => `d${index + valid.length}`));
});

test("IP duplicate scan compares equivalent IPv6 spellings and ignores missing addresses", () => {
  const state = { devices: [
    { id: "a", name: "A", ip: " 2001:DB8::1 ", ports: [] },
    { id: "b", name: "B", ip: "2001:0db8:0:0:0:0:0:0001", ports: [] },
    { id: "c", name: "C", ip: "", ports: [] }, { id: "d", name: "D", ports: [] }
  ], connections: [] };
  assert.deepEqual(getNetworkIssues(state).map(({ type, deviceIds }) => ({ type, deviceIds })), [{ type: "duplicate-ip", deviceIds: ["a", "b"] }]);
});

test("network scan reports missing endpoints, occupied ports and configured link mismatches", () => {
  const state = fixture();
  state.devices[0].ports[0].vlan = "10";
  state.devices[1].ports[0].vlan = "20";
  state.devices[1].ports[0].speed = "10 Gbit/s";
  const link = { id: "link", a: { deviceId: "a", portId: state.devices[0].ports[0].id }, b: { deviceId: "b", portId: state.devices[1].ports[0].id } };
  state.connections = [link, { ...link, id: "other" }, { id: "missing", a: link.a, b: { deviceId: "gone", portId: "gone" } }];
  const issues = getNetworkIssues(state);
  for (const type of ["vlan-mismatch", "speed-mismatch", "port-conflict", "dangling-connection"]) assert.ok(issues.some((issue) => issue.type === type), type);
  assert.ok(issues.every((issue) => ["error", "warning"].includes(issue.severity) && Array.isArray(issue.deviceIds) && typeof issue.message === "string"));
});

test("link scan avoids VLAN false positives on trunks and treats equal speed units identically", () => {
  const state = fixture();
  state.devices[0].ports[0].vlan = "10,20";
  state.devices[0].ports[0].mode = "Trunk";
  state.devices[1].ports[0].speed = "1000 Mbit/s";
  state.connections = [{ id: "link", a: { deviceId: "a", portId: state.devices[0].ports[0].id }, b: { deviceId: "b", portId: state.devices[1].ports[0].id } }];
  assert.deepEqual(getNetworkIssues(state), []);
});

test("CSV quotes all fields, protects formulas and counts a multiply linked port only once", () => {
  const state = fixture();
  state.devices[0].name = '=HYPERLINK("bad")';
  state.devices[0].location = "Rack; Büro\nOG";
  state.devices[0].type = "switch";
  state.devices[1].name = "  +SUM(A1)";
  const link = { id: "link", a: { deviceId: "a", portId: state.devices[0].ports[0].id }, b: { deviceId: "b", portId: state.devices[1].ports[0].id } };
  state.connections = [link, { ...link, id: "another" }];
  const csv = devicesToCsv(state);
  assert.ok(csv.startsWith('"Name";"Typ";"IP";"Standort";"Ports";"Belegt";"Frei"\r\n'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"\'  +SUM(A1)"'));
  assert.ok(csv.includes('"Rack; Büro\nOG";"2";"1";"1"'));
  assert.equal(csv.charCodeAt(0) === 0xFEFF, false);
});

test("history snapshots are independent, no-op commits are ignored and redo is replaced by edits", () => {
  const initial = fixture();
  const history = createHistory(initial);
  assert.equal(history.undo(), null);
  assert.equal(history.redo(), null);
  assert.equal(history.commit(initial), false);
  initial.devices[0].name = "Changed";
  assert.equal(history.commit(initial), true);
  assert.equal(history.canUndo, true);
  const previous = history.undo();
  assert.equal(previous.devices[0].name, "A");
  previous.devices[0].name = "Mutated outside history";
  assert.equal(history.canRedo, true);
  assert.equal(history.redo().devices[0].name, "Changed");
  assert.equal(history.undo().devices[0].name, "A");
  assert.equal(history.commit({ devices: [], connections: [] }), true);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo().devices[0].name, "A");
});

test("history retains at most the configured number of undo steps", () => {
  const history = createHistory({ value: 0 }, 2);
  history.commit({ value: 1 }); history.commit({ value: 2 }); history.commit({ value: 3 });
  assert.deepEqual(history.undo(), { value: 2 });
  assert.deepEqual(history.undo(), { value: 1 });
  assert.equal(history.canUndo, false);
  assert.equal(history.undo(), null);
  assert.deepEqual(history.redo(), { value: 2 });
});

