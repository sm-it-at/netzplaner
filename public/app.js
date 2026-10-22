import {
  DEVICE_TYPES, STATE_LIMITS, createPorts, demoState, endpointKey, findPort,
  getConflicts, getSummary, removeDevice, removePort, uid, validateConnection,
  normalizeState, duplicateDevice, getNetworkIssues, devicesToCsv, createHistory
} from "./model.js";

const STORAGE_KEY = "netzplaner-v1";
const colors = { router: "#b7d93d", switch: "#21a19a", ap: "#4285f4", server: "#9b6ce0", client: "#f0a629" };
const typeLabels = Object.fromEntries(DEVICE_TYPES);
const shortType = { router: "FW", switch: "SW", ap: "AP", server: "SRV", client: "END" };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
let storageMessage = "Privat · lokal gespeichert";
let storageBlocked = false;
let recoveryData = null;
let state = loadState();
const history = createHistory(state);
let selectedDeviceId = state.devices[0]?.id || null;
let search = "", typeFilter = "", portFilter = "all", connectionSearch = "", zoom = 1, fitMode = false;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return demoState();
    recoveryData = raw;
    const result = normalizeState(JSON.parse(raw));
    if (result.warnings.length) {
      storageBlocked = true;
      storageMessage = "Gespeicherter Plan enthält Fehler. Original sichern und erneut importieren; Speichern ist gesperrt.";
    }
    return result.state;
  } catch (_) {
    storageBlocked = true;
    storageMessage = "Browser-Speicher konnte nicht geladen werden. Änderungen bleiben vorerst nur in dieser Sitzung; bitte exportieren.";
    return { devices: [], connections: [] };
  }
}

function persist(record = true) {
  if (record) history.commit(state);
  if (!storageBlocked) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageMessage = `Lokal gespeichert · ${new Date().toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" })}`;
    } catch (_) {
      storageMessage = "Speichern fehlgeschlagen. Änderungen sind nur in dieser Sitzung verfügbar – bitte JSON exportieren.";
    }
  }
  render();
}

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 4500);
}

function filteredDevices() {
  return state.devices.filter((d) => (!typeFilter || d.type === typeFilter) &&
    `${d.name} ${d.ip} ${d.location} ${d.notes || ""}`.toLocaleLowerCase("de").includes(search));
}

function render() {
  const visible = filteredDevices();
  if (!state.devices.some((d) => d.id === selectedDeviceId) || (visible.length && !visible.some((d) => d.id === selectedDeviceId))) selectedDeviceId = visible[0]?.id || null;
  renderSummary(); renderTopology(); renderDeviceList(); renderPorts(); renderConnections(); renderOccupancy();
  $("#storage-status").textContent = storageMessage;
  $("#storage-status").classList.toggle("storage-warning", storageBlocked || storageMessage.includes("fehlgeschlagen"));
  if (recoveryData && storageBlocked) {
    const recovery = document.createElement("button");
    recovery.className = "text-btn"; recovery.dataset.action = "recover-storage"; recovery.textContent = "Original sichern";
    $("#storage-status").append(" ", recovery);
  }
  $$('[data-action="undo"]').forEach((b) => b.disabled = !history.canUndo);
  $$('[data-action="redo"]').forEach((b) => b.disabled = !history.canRedo);
}

function renderSummary() {
  const s = getSummary(state);
  $("#header-summary").innerHTML = [[s.devices, "Geräte"], [s.ports, "Ports"], [s.used, "belegt"], [s.free, "frei"]]
    .map(([v, label]) => `<div class="summary-cell"><strong>${v}</strong><span>${label}</span></div>`).join("");
}

function getLayout() {
  const positions = new Map();
  let rows = 1;
  DEVICE_TYPES.forEach(([type], column) => {
    const group = state.devices.filter((d) => d.type === type);
    rows = Math.max(rows, group.length);
    group.forEach((d, row) => positions.set(d.id, { x: 30 + column * 205, y: 35 + row * 110 }));
  });
  return { positions, width: 1030, height: Math.max(300, rows * 110 + 50) };
}

function renderTopology() {
  const { positions, width, height } = getLayout();
  const matching = new Set(filteredDevices().map((d) => d.id));
  const links = state.connections.map((link) => {
    const a = positions.get(link.a.deviceId), b = positions.get(link.b.deviceId);
    if (!a || !b) return "";
    const x1 = a.x + 72, y1 = a.y + 35, x2 = b.x + 72, y2 = b.y + 35;
    const mid = x1 === x2 ? x1 + 140 : (x1 + x2) / 2;
    return `<g><title>${escapeHtml(link.label || "Verbindung")}</title><path class="link" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}"/><text class="link-label" x="${x1 === x2 ? x1 + 105 : mid}" y="${(y1 + y2) / 2 - 7}">${escapeHtml(link.label || "Link")}</text></g>`;
  }).join("");
  const nodes = state.devices.map((d) => {
    const p = positions.get(d.id);
    const used = d.ports.filter((port) => connectionFor(d.id, port.id)).length;
    return `<g class="node ${selectedDeviceId === d.id ? "selected" : ""}" style="opacity:${matching.has(d.id) ? 1 : .3}" role="button" tabindex="0" aria-label="${escapeHtml(d.name)} – Ports anzeigen" data-device-id="${escapeHtml(d.id)}" transform="translate(${p.x},${p.y})">
      <title>${escapeHtml(d.name)} · ${escapeHtml(d.ip || d.location || typeLabels[d.type])}</title>
      <rect width="164" height="76" rx="8"/><rect class="type-bar" width="5" height="76" rx="3" style="fill:${colors[d.type]}"/>
      <circle cx="22" cy="23" r="8" fill="${colors[d.type]}" opacity=".18"/><circle cx="22" cy="23" r="3" fill="${colors[d.type]}"/>
      <text class="node-title" x="37" y="27">${escapeHtml(d.name.slice(0, 16))}</text>
      <text class="node-meta" x="16" y="51">${escapeHtml(d.ip || d.location || typeLabels[d.type])}</text>
      <text class="node-count" x="151" y="67">${used}/${d.ports.length} Ports</text></g>`;
  }).join("");
  $("#topology").innerHTML = state.devices.length
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="width:${zoom * 100}%;min-width:${fitMode ? 0 : 660 * zoom}px;height:auto" aria-label="${state.devices.length} Geräte und ${state.connections.length} Verbindungen"><g>${links}</g><g>${nodes}</g></svg>`
    : '<div class="empty-state"><strong>Noch kein Gerät.</strong><br>Lege dein erstes Gerät an.</div>';
  $("#zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  $$(".node").forEach((node) => {
    const select = () => {
      clearDeviceFilters();
      selectedDeviceId = node.dataset.deviceId; render();
      $("#inventar").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    node.addEventListener("click", select);
    node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } });
  });
}

function renderDeviceList() {
  const devices = filteredDevices();
  $("#filter-count").textContent = `${devices.length} von ${state.devices.length} Geräten`;
  $("#device-list").innerHTML = devices.map((d) => `<button class="device-row ${d.id === selectedDeviceId ? "active" : ""}" data-select-device="${escapeHtml(d.id)}" aria-pressed="${d.id === selectedDeviceId}">
    <span class="device-icon" style="border-bottom:3px solid ${colors[d.type]}">${shortType[d.type]}</span>
    <span class="device-main"><strong>${escapeHtml(d.name)}</strong><span>${escapeHtml(d.ip || "Keine IP")} · ${escapeHtml(d.location || "Kein Standort")}</span></span>
    <span class="device-port-count">${d.ports.length} Ports</span></button>`).join("") || '<div class="empty-state">Keine passenden Geräte.</div>';
}

function connectionFor(deviceId, portId) {
  return state.connections.find((c) => [c.a, c.b].some((e) => e.deviceId === deviceId && e.portId === portId));
}

function endpointName(endpoint) {
  const found = findPort(state, endpoint);
  return found ? `${found.device.name} · ${found.port.name}` : "Fehlende Gegenstelle";
}

function renderPorts() {
  const device = filteredDevices().find((d) => d.id === selectedDeviceId);
  if (!device) {
    $("#ports-heading").innerHTML = "<h3>Ports</h3>";
    $("#ports-table").innerHTML = '<tr><td colspan="5"><div class="empty-state">Wähle ein passendes Gerät aus.</div></td></tr>';
    return;
  }
  $("#ports-heading").innerHTML = `<div><h3>${escapeHtml(device.name)}</h3><p>${escapeHtml(typeLabels[device.type])} · ${escapeHtml(device.ip || "ohne IP")}</p>${device.notes ? `<p class="device-notes">${escapeHtml(device.notes)}</p>` : ""}</div><div class="row-actions"><button class="mini-button" data-duplicate-device="${escapeHtml(device.id)}">Duplizieren</button><button class="mini-button" data-edit-device="${escapeHtml(device.id)}">Bearbeiten</button><button class="icon-button" data-add-port="${escapeHtml(device.id)}" aria-label="Port hinzufügen">+</button></div>`;
  const ports = device.ports.filter((p) => portFilter === "all" || (portFilter === "poe" ? p.poe : portFilter === "used" ? !!connectionFor(device.id, p.id) : !connectionFor(device.id, p.id)));
  $("#ports-table").innerHTML = ports.map((port) => {
    const connection = connectionFor(device.id, port.id);
    const remote = connection && [connection.a, connection.b].find((e) => e.deviceId !== device.id || e.portId !== port.id);
    return `<tr><td><span class="port-name"><i class="port-led ${connection ? "used" : ""}"></i>${escapeHtml(port.name)}${port.poe ? '<span class="poe-pill">PoE</span>' : ""}</span></td>
      <td><span class="status-pill ${connection ? "" : "free"}">${connection ? "Belegt" : "Frei"}</span></td><td>${remote ? escapeHtml(endpointName(remote)) : "—"}</td>
      <td>${escapeHtml(port.speed)} · ${escapeHtml(port.mode)} · VLAN ${escapeHtml(port.vlan || "—")}</td>
      <td><div class="row-actions"><button class="mini-button" data-edit-port="${escapeHtml(port.id)}" aria-label="${escapeHtml(port.name)} bearbeiten">Bearbeiten</button>${connection ? `<button class="mini-button" data-remove-link="${escapeHtml(connection.id)}">Trennen</button>` : `<button class="mini-button" data-connect-port="${escapeHtml(port.id)}">Verbinden</button>`}<button class="mini-button" data-remove-port="${escapeHtml(port.id)}" aria-label="${escapeHtml(port.name)} löschen">×</button></div></td></tr>`;
  }).join("") || '<tr><td colspan="5"><div class="empty-state">Keine Ports für diesen Filter.</div></td></tr>';
}

function renderConnections() {
  const links = state.connections.filter((c) => `${c.label} ${endpointName(c.a)} ${endpointName(c.b)}`.toLocaleLowerCase("de").includes(connectionSearch));
  $("#connections-list").innerHTML = links.length ? `<div class="table-wrap"><table><thead><tr><th>Bezeichnung</th><th>Gegenstelle A</th><th>Gegenstelle B</th><th>Aktionen</th></tr></thead><tbody>${links.map((c) => `<tr><td>${escapeHtml(c.label || "Verbindung")}</td><td>${escapeHtml(endpointName(c.a))}</td><td>${escapeHtml(endpointName(c.b))}</td><td><div class="row-actions"><button class="mini-button" data-edit-link="${escapeHtml(c.id)}">Bearbeiten</button><button class="mini-button" data-remove-link="${escapeHtml(c.id)}">Trennen</button></div></td></tr>`).join("")}</tbody></table></div>` : '<div class="empty-state">Keine passenden Verbindungen. Verbinde zwei freie Ports.</div>';
}

function renderOccupancy() {
  const summary = getSummary(state), conflicts = getConflicts(state), issues = getNetworkIssues(state);
  $("#conflict-banner").innerHTML = conflicts.length ? `<div class="conflict-banner"><strong>⚠ ${conflicts.length} Port-Konflikte gefunden</strong><span>Ein Port wird mehrfach verwendet.</span></div>` : `<div class="conflict-banner ok"><strong>✓ Keine Port-Konflikte</strong><span>${summary.connections} Verbindungen geprüft</span></div>`;
  $("#network-issues").innerHTML = issues.length ? `<ul class="issue-list">${issues.map((i) => `<li class="issue-item issue-${i.severity}">${escapeHtml(i.message)}</li>`).join("")}</ul>` : '<p class="network-ok">✓ Keine IP- oder Profilhinweise. Die Prüfung bewertet den Plan; sie prüft keine Geräte im Netz.</p>';
  $("#occupancy-grid").innerHTML = state.devices.map((d) => {
    const used = d.ports.filter((p) => connectionFor(d.id, p.id)).length;
    const percent = d.ports.length ? Math.round(used / d.ports.length * 100) : 0;
    return `<article class="occupancy-card"><div class="occupancy-card-head"><strong>${escapeHtml(d.name)}</strong><span>${percent}% belegt</span></div><div class="progress"><span style="width:${percent}%;background:${percent > 84 ? "#f0a629" : colors[d.type]}"></span></div><div class="occupancy-meta"><span>${used} belegt</span><span>${d.ports.length - used} frei</span></div></article>`;
  }).join("");
}

function openDeviceDialog(deviceId = null) {
  const form = $("#device-form"); form.reset();
  form.elements.name.setCustomValidity("");
  form.elements.type.innerHTML = DEVICE_TYPES.map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
  const d = state.devices.find((item) => item.id === deviceId);
  $("#device-dialog-title").textContent = d ? "Gerät bearbeiten" : "Gerät anlegen";
  $("#device-delete").hidden = !d;
  form.elements.id.value = d?.id || "";
  form.elements.name.value = d?.name || "";
  form.elements.type.value = d?.type || "switch";
  form.elements.portCount.value = d?.ports.length ?? 8;
  form.elements.portCount.min = d ? "0" : "1";
  form.elements.portCount.max = STATE_LIMITS.portsPerDevice;
  form.elements.ip.value = d?.ip || "";
  form.elements.location.value = d?.location || "";
  form.elements.notes.value = d?.notes || "";
  $("#device-dialog").showModal();
}

function openPortDialog(deviceId, portId) {
  const port = findPort(state, { deviceId, portId })?.port;
  if (!port) return;
  const f = $("#port-form");
  f.elements.name.setCustomValidity("");
  f.elements.deviceId.value = deviceId; f.elements.portId.value = portId;
  for (const key of ["name", "speed", "mode", "vlan"]) {
    const field = f.elements[key];
    if (field.tagName === "SELECT" && ![...field.options].some((o) => o.value === port[key])) field.add(new Option(port[key], port[key]));
    field.value = port[key];
  }
  f.elements.poe.checked = port.poe;
  $("#port-dialog").showModal();
}

function updatePortSelect(deviceSelect, portSelect, editingId = $("#connection-form").elements.id.value, selectedPort = "") {
  const d = state.devices.find((item) => item.id === deviceSelect.value);
  const occupied = new Set(state.connections.filter((c) => c.id !== editingId).flatMap((c) => [endpointKey(c.a), endpointKey(c.b)]));
  portSelect.innerHTML = (d?.ports || []).map((p) => `<option value="${escapeHtml(p.id)}" ${occupied.has(`${d.id}:${p.id}`) ? "disabled" : ""}>${escapeHtml(p.name)}${occupied.has(`${d.id}:${p.id}`) ? " · belegt" : ""}</option>`).join("");
  portSelect.value = selectedPort || [...portSelect.options].find((o) => !o.disabled)?.value || "";
}

function openConnectionDialog(editId = null, portId = null) {
  if (state.devices.length < 2) return toast("Für eine Verbindung brauchst du mindestens zwei Geräte.");
  const f = $("#connection-form"); f.reset();
  const c = state.connections.find((item) => item.id === editId);
  f.elements.id.value = c?.id || ""; f.elements.label.value = c?.label || "";
  const options = state.devices.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join("");
  f.elements.deviceA.innerHTML = options; f.elements.deviceB.innerHTML = options;
  f.elements.deviceA.value = c?.a.deviceId || selectedDeviceId || state.devices[0].id;
  f.elements.deviceB.value = c?.b.deviceId || state.devices.find((d) => d.id !== f.elements.deviceA.value)?.id || "";
  updatePortSelect(f.elements.deviceA, f.elements.portA, c?.id, c?.a.portId || portId);
  updatePortSelect(f.elements.deviceB, f.elements.portB, c?.id, c?.b.portId);
  $("#connection-dialog-title").textContent = c ? "Verbindung bearbeiten" : "Ports verbinden";
  $("#connection-save").textContent = c ? "Speichern" : "Verbinden";
  $("#connection-error").textContent = ""; $("#connection-dialog").showModal();
}

function saveDevice(event) {
  event.preventDefault(); const f = event.currentTarget;
  if (!f.reportValidity()) return;
  const data = Object.fromEntries(new FormData(f));
  if (!data.name.trim()) { f.elements.name.setCustomValidity("Bitte einen Namen eingeben."); f.reportValidity(); return; }
  const existing = state.devices.find((d) => d.id === data.id), desired = Number(data.portCount);
  if ((!existing && state.devices.length >= STATE_LIMITS.devices) || getSummary(state).ports - (existing?.ports.length || 0) + desired > STATE_LIMITS.totalPorts) return toast("Die maximale Größe des Plans ist erreicht.");
  if (existing && desired < existing.ports.length) {
    const ids = new Set(existing.ports.slice(desired).map((p) => p.id));
    const count = state.connections.filter((c) => [c.a, c.b].some((e) => e.deviceId === existing.id && ids.has(e.portId))).length;
    if (count && !confirm(`${count} Verbindungen an entfernten Ports werden gelöscht. Ports reduzieren?`)) return;
    existing.ports = existing.ports.slice(0, desired);
    state.connections = state.connections.filter((c) => ![c.a, c.b].some((e) => e.deviceId === existing.id && ids.has(e.portId)));
  }
  const device = existing || { id: uid("device"), ports: [] };
  Object.assign(device, { name: data.name.trim(), type: data.type, ip: data.ip.trim(), location: data.location.trim(), notes: data.notes.trim() });
  const start = device.ports.length;
  if (desired > start) device.ports.push(...createPorts(desired - start, device.id).map((p, i) => ({ ...p, name: `Port ${start + i + 1}` })));
  if (!existing) state.devices.push(device);
  selectedDeviceId = device.id; clearDeviceFilters(); $("#device-dialog").close(); persist(); toast(existing ? "Gerät aktualisiert." : "Gerät hinzugefügt.");
}

function savePort(event) {
  event.preventDefault(); const f = event.currentTarget;
  if (!f.reportValidity()) return;
  const data = Object.fromEntries(new FormData(f));
  if (!data.name.trim()) { f.elements.name.setCustomValidity("Bitte eine Bezeichnung eingeben."); f.reportValidity(); return; }
  const port = findPort(state, { deviceId: data.deviceId, portId: data.portId })?.port;
  if (!port) return;
  Object.assign(port, { name: data.name.trim(), speed: data.speed, mode: data.mode, vlan: data.vlan.trim(), poe: data.poe === "on" });
  $("#port-dialog").close(); persist(); toast("Port aktualisiert.");
}

function saveConnection(event) {
  event.preventDefault(); const f = event.currentTarget;
  if (!f.reportValidity()) return;
  const d = Object.fromEntries(new FormData(f));
  const connection = { id: d.id || uid("link"), label: d.label.trim(), a: { deviceId: d.deviceA, portId: d.portA }, b: { deviceId: d.deviceB, portId: d.portB } };
  const error = validateConnection(state, connection, d.id || null);
  if (error) { $("#connection-error").textContent = error; return; }
  const index = state.connections.findIndex((c) => c.id === d.id);
  if (index >= 0) state.connections[index] = connection; else state.connections.push(connection);
  $("#connection-dialog").close(); persist(); toast(index >= 0 ? "Verbindung aktualisiert." : "Verbindung angelegt.");
}

function download(content, type, extension, prefix = "netzplan") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = `${prefix}-${new Date().toISOString().slice(0, 10)}.${extension}`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSvg() {
  const svg = $("#topology svg");
  if (!svg) return toast("Lege zuerst Geräte an.");
  const copy = svg.cloneNode(true), { width, height } = getLayout();
  copy.removeAttribute("style"); copy.setAttribute("width", width); copy.setAttribute("height", height);
  copy.querySelectorAll(".node").forEach((n) => { n.style.opacity = "1"; n.removeAttribute("tabindex"); });
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = '.link{fill:none;stroke:#91a0ab;stroke-width:2}.link-label{fill:#526070;font:10px sans-serif;text-anchor:middle}.node rect{fill:#fff;stroke:#ccd4da}.node .type-bar{stroke:none}.node-title{fill:#132033;font:700 13px sans-serif}.node-meta{fill:#526070;font:10px sans-serif}.node-count{fill:#132033;font:10px sans-serif;text-anchor:end}';
  copy.prepend(style); download(new XMLSerializer().serializeToString(copy), "image/svg+xml;charset=utf-8", "svg"); toast("Topologie als SVG exportiert.");
}

function importData(file) {
  if (file.size > 5 * 1024 * 1024) return toast("Die Datei ist zu groß (maximal 5 MB).");
  const reader = new FileReader();
  reader.onerror = () => toast("Datei konnte nicht gelesen werden.");
  reader.onload = () => {
    try {
      const result = normalizeState(JSON.parse(String(reader.result).replace(/^\uFEFF/, "")));
      const warning = result.warnings.length ? `\n\n${result.warnings.length} Hinweise:\n${result.warnings.slice(0, 5).join("\n")}\nBitte prüfe die importierten Daten.` : "";
      if (!confirm(`${result.state.devices.length} Geräte und ${result.state.connections.length} Verbindungen importieren? Der aktuelle Plan wird ersetzt und kann in dieser Sitzung rückgängig gemacht werden.${warning}`)) return;
      if (storageBlocked && recoveryData && !confirm("Der bisher gespeicherte Originalplan enthält Fehler. Hast du ihn über ‚Original sichern‘ gesichert? Mit dem Import wird er überschrieben.")) return;
      state = result.state; selectedDeviceId = state.devices[0]?.id || null; storageBlocked = false; clearDeviceFilters(); persist(); toast("Netzplan importiert.");
    } catch (error) { toast(`Import abgebrochen: ${error.message || "Datei ist kein gültiger Netzplan."}`); }
  };
  reader.readAsText(file);
}

function clearDeviceFilters() { search = ""; typeFilter = ""; $("#device-search").value = ""; $("#type-filter").value = "all"; }
function travel(direction) {
  const next = history[direction]();
  if (!next) return;
  state = next; clearDeviceFilters(); persist(false); toast(direction === "undo" ? "Änderung rückgängig gemacht." : "Änderung wiederholt.");
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("button"); if (!target) return;
  const action = target.dataset.action;
  if (target.dataset.closeDialog) return $(`#${target.dataset.closeDialog}`).close();
  if (action === "add-device") openDeviceDialog();
  if (action === "add-connection") openConnectionDialog();
  if (action === "undo" || action === "redo") travel(action);
  if (action === "export") { download(JSON.stringify(state, null, 2), "application/json", "json"); toast("Netzplan exportiert."); }
  if (action === "export-csv") { download("\uFEFF" + devicesToCsv(state), "text/csv;charset=utf-8", "csv", "inventar"); toast("Gesamtes Inventar als CSV exportiert."); }
  if (action === "export-svg") exportSvg();
  if (action === "print") window.print();
  if (action === "recover-storage") download(recoveryData, "application/json", "json", "netzplan-original");
  if (action === "import") $("#import-input").click();
  if (action === "zoom-in" || action === "zoom-out" || action === "fit") {
    fitMode = action === "fit";
    const { width, height } = getLayout();
    const available = $("#topology").clientWidth || width;
    zoom = fitMode ? Math.min(1, 620 / (height * available / width)) : Math.min(2.5, Math.max(.5, zoom + (action === "zoom-in" ? .25 : -.25)));
    renderTopology();
  }
  if (action === "reset" || action === "new-plan") {
    if (!confirm(action === "reset" ? "Aktuellen Plan durch Beispieldaten ersetzen? Du kannst dies rückgängig machen." : "Einen leeren Plan beginnen? Der aktuelle Plan kann in dieser Sitzung rückgängig gemacht werden.")) return;
    if (storageBlocked && recoveryData && !confirm("Vorhandene Originaldaten werden überschrieben. Nur fortfahren, wenn du ‚Original sichern‘ verwendet hast.")) return;
    state = action === "reset" ? demoState() : { devices: [], connections: [] }; storageBlocked = false; clearDeviceFilters(); persist(); toast(action === "reset" ? "Beispieldaten geladen." : "Leeren Plan angelegt.");
  }
  if (target.dataset.selectDevice) { selectedDeviceId = target.dataset.selectDevice; render(); }
  if (target.dataset.editDevice) openDeviceDialog(target.dataset.editDevice);
  if (target.dataset.duplicateDevice) {
    const source = state.devices.find((d) => d.id === target.dataset.duplicateDevice);
    if (state.devices.length >= STATE_LIMITS.devices || getSummary(state).ports + source.ports.length > STATE_LIMITS.totalPorts) return toast("Die maximale Größe des Plans ist erreicht.");
    state = duplicateDevice(state, source.id); selectedDeviceId = state.devices.at(-1).id; clearDeviceFilters(); persist(); toast("Gerät mit freien Ports kopiert. IP-Adresse bitte neu vergeben.");
  }
  if (target.dataset.addPort) {
    const d = state.devices.find((item) => item.id === target.dataset.addPort);
    if (d.ports.length >= STATE_LIMITS.portsPerDevice || getSummary(state).ports >= STATE_LIMITS.totalPorts) return toast("Die maximale Portanzahl ist erreicht.");
    d.ports.push({ ...createPorts(1, d.id)[0], name: `Port ${d.ports.length + 1}` }); persist(); toast("Port hinzugefügt.");
  }
  if (target.dataset.editPort) openPortDialog(selectedDeviceId, target.dataset.editPort);
  if (target.dataset.connectPort) openConnectionDialog(null, target.dataset.connectPort);
  if (target.dataset.editLink) openConnectionDialog(target.dataset.editLink);
  if (target.dataset.removeLink) { state.connections = state.connections.filter((c) => c.id !== target.dataset.removeLink); persist(); toast("Verbindung getrennt. Rückgängig ist möglich."); }
  if (target.dataset.removePort) { state = removePort(state, selectedDeviceId, target.dataset.removePort); persist(); toast("Port und zugehörige Verbindung entfernt. Rückgängig ist möglich."); }
});

$("#device-form").addEventListener("submit", saveDevice);
$("#port-form").addEventListener("submit", savePort);
$("#connection-form").addEventListener("submit", saveConnection);
for (const form of [$("#device-form"), $("#port-form")]) form.elements.name.addEventListener("input", () => form.elements.name.setCustomValidity(""));
for (const side of ["A", "B"]) $("#connection-form").elements[`device${side}`].addEventListener("change", (e) => updatePortSelect(e.target, $("#connection-form").elements[`port${side}`]));
$("#import-input").addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ""; });
$("#device-search").addEventListener("input", (e) => { search = e.target.value.trim().toLocaleLowerCase("de"); render(); });
$("#type-filter").addEventListener("change", (e) => { typeFilter = e.target.value === "all" ? "" : e.target.value; render(); });
$("#port-filter").addEventListener("change", (e) => { portFilter = e.target.value; renderPorts(); });
$("#connections-search").addEventListener("input", (e) => { connectionSearch = e.target.value.trim().toLocaleLowerCase("de"); renderConnections(); });
$("#device-delete").addEventListener("click", () => {
  const id = $("#device-form").elements.id.value, d = state.devices.find((item) => item.id === id);
  if (!d || !confirm(`„${d.name}“ samt Verbindungen löschen? Rückgängig ist möglich.`)) return;
  state = removeDevice(state, id); $("#device-dialog").close(); persist(); toast("Gerät und zugehörige Verbindungen entfernt.");
});
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.target.closest("input,textarea,select,[contenteditable=true]") || document.querySelector("dialog[open]")) return;
  const key = e.key.toLowerCase();
  if (key === "z" || key === "y") { e.preventDefault(); travel(key === "y" || e.shiftKey ? "redo" : "undo"); }
});
let printFilters = null;
window.addEventListener("beforeprint", () => {
  if (printFilters) return;
  printFilters = { search, typeFilter, portFilter, connectionSearch, selectedDeviceId };
  search = ""; typeFilter = ""; portFilter = "all"; connectionSearch = "";
  render();
});
window.addEventListener("afterprint", () => {
  if (!printFilters) return;
  ({ search, typeFilter, portFilter, connectionSearch, selectedDeviceId } = printFilters);
  printFilters = null; render();
});
render();
