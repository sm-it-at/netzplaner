import {
  DEVICE_TYPES, createPorts, demoState, endpointKey, findPort,
  getConflicts, getSummary, removeDevice, removePort, uid, validateConnection
} from "./model.js";

const STORAGE_KEY = "netzplaner-v1";
const colors = { router: "#b7d93d", switch: "#21a19a", ap: "#4285f4", server: "#9b6ce0", client: "#f0a629" };
const typeLabels = Object.fromEntries(DEVICE_TYPES);
const shortType = { router: "FW", switch: "SW", ap: "AP", server: "SRV", client: "END" };
let state = loadState();
let selectedDeviceId = state.devices[0]?.id || null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed && Array.isArray(parsed.devices) && Array.isArray(parsed.connections)) return parsed;
  } catch (_) {}
  return demoState();
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2200);
}

function typeOptions(selected = "switch") {
  return DEVICE_TYPES.map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}

function render() {
  if (!state.devices.some((device) => device.id === selectedDeviceId)) selectedDeviceId = state.devices[0]?.id || null;
  renderSummary();
  renderTopology();
  renderDeviceList();
  renderPorts();
  renderOccupancy();
}

function renderSummary() {
  const summary = getSummary(state);
  const cells = [[summary.devices, "Geräte"], [summary.ports, "Ports"], [summary.used, "belegt"], [summary.free, "frei"]];
  $("#header-summary").innerHTML = cells.map(([value, label]) => `<div class="summary-cell"><strong>${value}</strong><span>${label}</span></div>`).join("");
}

function getPositions() {
  const width = 1180;
  const tiers = { router: 55, switch: 255, ap: 455, server: 655, client: 855 };
  const items = state.devices.map((device, index) => ({ device, index, x: tiers[device.type] ?? 855 }));
  const groups = Object.groupBy ? Object.groupBy(items, (item) => item.device.type) : items.reduce((acc, item) => ((acc[item.device.type] ||= []).push(item), acc), {});
  const result = new Map();
  for (const group of Object.values(groups)) {
    group.forEach((item, index) => {
      const gap = 255 / (group.length + 1);
      result.set(item.device.id, { x: item.x, y: Math.max(35, gap * (index + 1) - 20) });
    });
  }
  if (items.length && items.every((item) => item.x < width - 240)) {}
  return result;
}

function renderTopology() {
  const positions = getPositions();
  const links = state.connections.map((link) => {
    const a = positions.get(link.a.deviceId);
    const b = positions.get(link.b.deviceId);
    if (!a || !b) return "";
    const x1 = a.x + 72, y1 = a.y + 35, x2 = b.x + 72, y2 = b.y + 35;
    const mid = (x1 + x2) / 2;
    return `<path class="link" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}"/><text class="link-label" x="${mid}" y="${(y1 + y2) / 2 - 6}">${escapeHtml(link.label || "Link")}</text>`;
  }).join("");
  const nodes = state.devices.map((device) => {
    const pos = positions.get(device.id);
    const used = device.ports.filter((port) => state.connections.some((link) => [link.a, link.b].some((endpoint) => endpoint.deviceId === device.id && endpoint.portId === port.id))).length;
    return `<g class="node ${selectedDeviceId === device.id ? "selected" : ""}" data-device-id="${device.id}" transform="translate(${pos.x},${pos.y})">
      <rect width="144" height="70" rx="8"/><rect class="type-bar" width="5" height="70" rx="3" fill="${colors[device.type]}"/>
      <circle cx="22" cy="23" r="8" fill="${colors[device.type]}" opacity=".18"/><circle cx="22" cy="23" r="3" fill="${colors[device.type]}"/>
      <text class="node-title" x="37" y="27">${escapeHtml(device.name.slice(0, 17))}</text>
      <text class="node-meta" x="16" y="50">${escapeHtml(device.ip || device.location || typeLabels[device.type])}</text>
      <text class="node-count" x="131" y="50">${used}/${device.ports.length}</text>
    </g>`;
  }).join("");
  $("#topology").innerHTML = state.devices.length
    ? `<svg viewBox="0 0 1180 330" preserveAspectRatio="xMidYMid meet" aria-label="${state.devices.length} Geräte und ${state.connections.length} Verbindungen"><g>${links}</g><g>${nodes}</g></svg>`
    : `<div class="empty-state"><strong>Noch kein Gerät.</strong><br>Lege dein erstes Gerät an.</div>`;
  $$(".node").forEach((node) => node.addEventListener("click", () => {
    selectedDeviceId = node.dataset.deviceId;
    render();
    $("#inventar").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

function renderDeviceList() {
  $("#device-list").innerHTML = state.devices.length ? state.devices.map((device) => `
    <button class="device-row ${device.id === selectedDeviceId ? "active" : ""}" data-device-id="${device.id}">
      <span class="device-icon" style="border-bottom:3px solid ${colors[device.type]}">${shortType[device.type]}</span>
      <span class="device-main"><strong>${escapeHtml(device.name)}</strong><span>${escapeHtml(device.ip || "Keine IP")} · ${escapeHtml(device.location || "Kein Standort")}</span></span>
      <span class="device-port-count">${device.ports.length} Ports</span>
    </button>`).join("") : `<div class="empty-state">Keine Geräte vorhanden.</div>`;
  $$(".device-row").forEach((row) => row.addEventListener("click", () => { selectedDeviceId = row.dataset.deviceId; render(); }));
}

function connectionFor(deviceId, portId) {
  return state.connections.find((connection) => [connection.a, connection.b].some((endpoint) => endpoint.deviceId === deviceId && endpoint.portId === portId));
}

function otherEndpoint(connection, deviceId, portId) {
  const endpoint = [connection.a, connection.b].find((item) => !(item.deviceId === deviceId && item.portId === portId));
  return endpoint ? findPort(state, endpoint) : null;
}

function renderPorts() {
  const device = state.devices.find((item) => item.id === selectedDeviceId);
  if (!device) {
    $("#ports-heading").innerHTML = `<h3>Ports</h3>`;
    $("#ports-table").innerHTML = `<tr><td colspan="5"><div class="empty-state">Wähle ein Gerät aus.</div></td></tr>`;
    return;
  }
  $("#ports-heading").innerHTML = `<div><h3>${escapeHtml(device.name)}</h3><p>${escapeHtml(typeLabels[device.type])} · ${escapeHtml(device.ip || "ohne IP")}</p></div><div class="row-actions"><button class="mini-button" data-edit-device="${device.id}">Bearbeiten</button><button class="icon-button" data-add-port="${device.id}" aria-label="Port hinzufügen">+</button></div>`;
  $("#ports-table").innerHTML = device.ports.map((port) => {
    const connection = connectionFor(device.id, port.id);
    const remote = connection ? otherEndpoint(connection, device.id, port.id) : null;
    return `<tr>
      <td><span class="port-name"><i class="port-led ${connection ? "used" : ""}"></i>${escapeHtml(port.name)}${port.poe ? '<span class="poe-pill">PoE</span>' : ""}</span></td>
      <td><span class="status-pill ${connection ? "" : "free"}">${connection ? "Belegt" : "Frei"}</span></td>
      <td>${remote ? `${escapeHtml(remote.device.name)} · ${escapeHtml(remote.port.name)}` : "—"}</td>
      <td>${escapeHtml(port.speed)} · ${escapeHtml(port.mode)} · VLAN ${escapeHtml(port.vlan || "—")}</td>
      <td><div class="row-actions"><button class="mini-button" data-edit-port="${port.id}">Edit</button>${connection ? `<button class="mini-button" data-remove-link="${connection.id}" title="Verbindung trennen">Trennen</button>` : ""}<button class="mini-button" data-remove-port="${port.id}" title="Port löschen">×</button></div></td>
    </tr>`;
  }).join("") || `<tr><td colspan="5"><div class="empty-state">Noch keine Ports vorhanden.</div></td></tr>`;
}

function renderOccupancy() {
  const summary = getSummary(state);
  const conflicts = getConflicts(state);
  $("#conflict-banner").innerHTML = conflicts.length
    ? `<div class="conflict-banner"><strong>⚠ ${conflicts.length} Port-Konflikt${conflicts.length === 1 ? "" : "e"} gefunden</strong><span>Ein Port wird in mehreren Verbindungen verwendet.</span></div>`
    : `<div class="conflict-banner ok"><strong>✓ Keine Port-Konflikte</strong><span>${summary.connections} Verbindung${summary.connections === 1 ? "" : "en"} geprüft</span></div>`;
  $("#occupancy-grid").innerHTML = state.devices.map((device) => {
    const used = device.ports.filter((port) => connectionFor(device.id, port.id)).length;
    const percentage = device.ports.length ? Math.round(used / device.ports.length * 100) : 0;
    return `<article class="occupancy-card"><div class="occupancy-card-head"><strong>${escapeHtml(device.name)}</strong><span>${percentage}% belegt</span></div><div class="progress"><span style="width:${percentage}%; background:${percentage > 84 ? "#f0a629" : colors[device.type]}"></span></div><div class="occupancy-meta"><span>${used} belegt</span><span>${device.ports.length - used} frei</span></div></article>`;
  }).join("") || `<div class="empty-state">Geräte erscheinen hier mit ihrer Portbelegung.</div>`;
}

function openDeviceDialog(deviceId = null) {
  const form = $("#device-form");
  form.reset();
  form.elements.type.innerHTML = typeOptions();
  const device = state.devices.find((item) => item.id === deviceId);
  $("#device-dialog-title").textContent = device ? "Gerät bearbeiten" : "Gerät anlegen";
  $("#device-delete").hidden = !device;
  if (device) {
    form.elements.id.value = device.id;
    form.elements.name.value = device.name;
    form.elements.type.value = device.type;
    form.elements.portCount.value = device.ports.length;
    form.elements.ip.value = device.ip;
    form.elements.location.value = device.location;
  } else {
    form.elements.id.value = "";
    form.elements.portCount.value = 8;
  }
  $("#device-dialog").showModal();
}

function openPortDialog(deviceId, portId) {
  const device = state.devices.find((item) => item.id === deviceId);
  const port = device?.ports.find((item) => item.id === portId);
  if (!port) return;
  const form = $("#port-form");
  form.elements.deviceId.value = deviceId;
  form.elements.portId.value = portId;
  form.elements.name.value = port.name;
  form.elements.speed.value = port.speed;
  form.elements.mode.value = port.mode;
  form.elements.vlan.value = port.vlan;
  form.elements.poe.checked = port.poe;
  $("#port-dialog").showModal();
}

function endpointOptions(selected) {
  return state.devices.map((device) => `<option value="${device.id}" ${device.id === selected ? "selected" : ""}>${escapeHtml(device.name)}</option>`).join("");
}

function updatePortSelect(deviceSelect, portSelect) {
  const device = state.devices.find((item) => item.id === deviceSelect.value);
  const occupied = new Set(state.connections.flatMap((connection) => [endpointKey(connection.a), endpointKey(connection.b)]));
  portSelect.innerHTML = (device?.ports || []).map((port) => `<option value="${port.id}" ${occupied.has(`${device.id}:${port.id}`) ? "disabled" : ""}>${escapeHtml(port.name)}${occupied.has(`${device.id}:${port.id}`) ? " · belegt" : ""}</option>`).join("");
}

function openConnectionDialog() {
  if (state.devices.length < 2) return toast("Für eine Verbindung brauchst du mindestens zwei Geräte.");
  const form = $("#connection-form");
  form.reset();
  form.elements.deviceA.innerHTML = endpointOptions(selectedDeviceId);
  form.elements.deviceB.innerHTML = endpointOptions(state.devices.find((item) => item.id !== selectedDeviceId)?.id);
  updatePortSelect(form.elements.deviceA, form.elements.portA);
  updatePortSelect(form.elements.deviceB, form.elements.portB);
  $("#connection-error").textContent = "";
  $("#connection-dialog").showModal();
}

function saveDevice(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitter = event.submitter;
  if (submitter?.value === "cancel") return $("#device-dialog").close();
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const existing = state.devices.find((device) => device.id === data.id);
  if (existing) {
    existing.name = data.name.trim(); existing.type = data.type; existing.ip = data.ip.trim(); existing.location = data.location.trim();
    const desired = Number(data.portCount);
    if (desired > existing.ports.length) existing.ports.push(...createPorts(desired - existing.ports.length, existing.id).map((port, i) => ({ ...port, name: `Port ${existing.ports.length + i + 1}` })));
    if (desired < existing.ports.length) {
      const removedIds = new Set(existing.ports.slice(desired).map((port) => port.id));
      existing.ports = existing.ports.slice(0, desired);
      state.connections = state.connections.filter((link) => ![link.a, link.b].some((endpoint) => endpoint.deviceId === existing.id && removedIds.has(endpoint.portId)));
    }
  } else {
    const id = uid("device");
    const device = { id, name: data.name.trim(), type: data.type, ip: data.ip.trim(), location: data.location.trim(), ports: createPorts(data.portCount, id) };
    state.devices.push(device); selectedDeviceId = id;
  }
  $("#device-dialog").close(); persist(); toast(existing ? "Gerät aktualisiert." : "Gerät hinzugefügt.");
}

function savePort(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return $("#port-dialog").close();
  if (!event.currentTarget.reportValidity()) return;
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const port = state.devices.find((device) => device.id === data.deviceId)?.ports.find((item) => item.id === data.portId);
  if (!port) return;
  Object.assign(port, { name: data.name.trim(), speed: data.speed, mode: data.mode, vlan: data.vlan.trim(), poe: data.poe === "on" });
  $("#port-dialog").close(); persist(); toast("Port aktualisiert.");
}

function saveConnection(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return $("#connection-dialog").close();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const connection = { id: uid("link"), label: data.label.trim(), a: { deviceId: data.deviceA, portId: data.portA }, b: { deviceId: data.deviceB, portId: data.portB } };
  const error = validateConnection(state, connection);
  if (error) { $("#connection-error").textContent = error; return; }
  state.connections.push(connection); $("#connection-dialog").close(); persist(); toast("Verbindung angelegt.");
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `netzplan-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); toast("Netzplan exportiert.");
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const next = JSON.parse(reader.result);
      if (!Array.isArray(next.devices) || !Array.isArray(next.connections)) throw new Error();
      state = next; selectedDeviceId = state.devices[0]?.id || null; persist(); toast("Netzplan importiert.");
    } catch (_) { toast("Datei ist kein gültiger Netzplan."); }
  };
  reader.readAsText(file);
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "add-device") openDeviceDialog();
  if (action === "add-connection") openConnectionDialog();
  if (action === "export") exportData();
  if (action === "import") $("#import-input").click();
  if (action === "reset") { state = demoState(); selectedDeviceId = state.devices[0].id; persist(); toast("Beispieldaten wiederhergestellt."); }
  if (target.dataset.editDevice) openDeviceDialog(target.dataset.editDevice);
  if (target.dataset.addPort) {
    const device = state.devices.find((item) => item.id === target.dataset.addPort);
    device.ports.push({ ...createPorts(1, device.id)[0], name: `Port ${device.ports.length + 1}` }); persist(); toast("Port hinzugefügt.");
  }
  if (target.dataset.editPort) openPortDialog(selectedDeviceId, target.dataset.editPort);
  if (target.dataset.removeLink) { state.connections = state.connections.filter((link) => link.id !== target.dataset.removeLink); persist(); toast("Verbindung getrennt."); }
  if (target.dataset.removePort) {
    const portId = target.dataset.removePort;
    state = removePort(state, selectedDeviceId, portId); persist(); toast("Port und zugehörige Verbindung entfernt.");
  }
});

$("#device-form").addEventListener("submit", saveDevice);
$("#port-form").addEventListener("submit", savePort);
$("#connection-form").addEventListener("submit", saveConnection);
$("#connection-form").elements.deviceA.addEventListener("change", (event) => updatePortSelect(event.target, $("#connection-form").elements.portA));
$("#connection-form").elements.deviceB.addEventListener("change", (event) => updatePortSelect(event.target, $("#connection-form").elements.portB));
$("#import-input").addEventListener("change", (event) => event.target.files[0] && importData(event.target.files[0]));

$("#device-delete").addEventListener("click", () => {
  const id = $("#device-form").elements.id.value;
  const device = state.devices.find((item) => item.id === id);
  if (!device || !confirm(`„${device.name}“ samt Verbindungen löschen?`)) return;
  state = removeDevice(state, id);
  $("#device-dialog").close();
  persist();
  toast("Gerät und zugehörige Verbindungen entfernt.");
});

render();
