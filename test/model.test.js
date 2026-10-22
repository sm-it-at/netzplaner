import test from "node:test";
import assert from "node:assert/strict";
import { createPorts, getConflicts, getSummary, removeDevice, removePort, validateConnection } from "../public/model.js";

function fixture() {
  const a = { id: "a", name: "A", ports: createPorts(2, "a") };
  const b = { id: "b", name: "B", ports: createPorts(2, "b") };
  return { devices: [a, b], connections: [] };
}

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

