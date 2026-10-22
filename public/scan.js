import { DEVICE_TYPES } from "./model.js";
import { canonicalIPv4, normalizeScanHost, parseNmapXml, SCAN_LIMITS } from "./scan-model.js";

const PROFILE_NAMES = { discovery: "Geräte suchen", ports: "Häufige TCP-Ports" };
const HTTP_MESSAGES = { 400: "Bitte Scanbereich und Profil prüfen.", 401: "Der Scanner-Token ist ungültig. Bitte erneut verbinden.", 403: "Dieser Scanbereich ist nicht freigegeben.", 409: "Im Scanner läuft bereits ein Scan. Bitte später erneut versuchen.", 429: "Bitte einige Sekunden warten und erneut starten.", 503: "Der lokale Scanner ist nicht verfügbar. Bitte Docker-Konfiguration prüfen oder XML importieren." };

/** No network or browser-storage operations occur until an explicit user action. */
export function initScanner({ getState, onImport, fetch: fetchOverride } = {}) {
  const document = globalThis.document, window = document?.defaultView;
  const root = document?.getElementById("netzwerkscan");
  if (!root) return { destroy() {} };
  const $ = (selector) => root.querySelector(selector);
  const requestFetch = fetchOverride || globalThis.fetch?.bind(globalThis);
  let token = "", config = null, job = null, results = [], rows = [], timer = null, deadline = 0, requestController = null, disposed = false, connecting = false, starting = false, reading = false, cancelRequested = false, pollVersion = 0;
  const handlers = [];
  const listen = (element, type, callback) => { element.addEventListener(type, callback); handlers.push(() => element.removeEventListener(type, callback)); };
  const status = (message, error = false) => { $("#scan-status").textContent = message; $("#scan-status").classList.toggle("scan-error", error); };
  const locked = () => connecting || starting || reading || Boolean(job);
  const controls = () => {
    $("#scan-connect").disabled = locked();
    $("#scan-token").disabled = locked();
    $("#scan-target").disabled = !config || locked();
    $("#scan-profile").disabled = !config || locked();
    $("#scan-start").disabled = !config || locked();
    $("#scan-xml-input").disabled = locked();
    $("#scan-cancel").disabled = !job || cancelRequested;
    $("#scan-import-selected").disabled = locked() || !rows.some((row) => row.checkbox.checked && !row.checkbox.disabled);
  };
  const stopPoll = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const cancelRequest = () => { requestController?.abort(); requestController = null; };
  const api = async (path, options = {}, authenticated = true) => {
    if (typeof requestFetch !== "function") throw new Error("Dieser Browser kann den Scanner nicht erreichen. Bitte XML importieren.");
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await requestFetch(`/api/scan${path}`, { ...options, cache: "no-store", credentials: "omit", redirect: "error", headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }, signal: controller.signal });
      if (!response.ok) {
        if (response.status === 401) { token = ""; config = null; stopPoll(); job = null; cancelRequested = false; $("#scan-connection").textContent = "Nicht verbunden. Bitte Token erneut eingeben."; }
        throw new Error(HTTP_MESSAGES[response.status] || "Der Scanner hat die Anfrage nicht abgeschlossen. Bitte erneut versuchen.");
      }
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Die Scanner-Antwort konnte nicht gelesen werden.");
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Der Scanner antwortet nicht rechtzeitig. Verbindung und Container prüfen.");
      if (error instanceof TypeError || error instanceof SyntaxError) throw new Error("Der lokale Scanner ist nicht erreichbar. Bitte Docker-Betrieb verwenden oder XML importieren.");
      throw error;
    } finally { clearTimeout(timeout); if (requestController === controller) requestController = null; }
  };
  const knownIps = () => new Set((getState()?.devices || []).map((device) => canonicalIPv4(device.ip)).filter(Boolean));
  const selectionCount = () => {
    const available = rows.filter((row) => !row.checkbox.disabled), selected = available.filter((row) => row.checkbox.checked).length;
    $("#scan-selection-count").textContent = `${selected} von ${available.length} neuen Geräten ausgewählt`;
    $("#scan-select-all").disabled = !available.length || locked();
    $("#scan-select-all").checked = Boolean(available.length) && selected === available.length;
    $("#scan-select-all").indeterminate = selected > 0 && selected < available.length;
    controls();
  };
  const refreshKnown = () => {
    const known = knownIps();
    for (const row of rows) {
      const exists = known.has(row.host.ip);
      if (exists) row.checkbox.checked = false;
      row.checkbox.disabled = exists || locked();
      row.name.disabled = exists || locked();
      row.type.disabled = exists || locked();
      row.label.textContent = exists ? "Bereits im Plan" : "Neu";
    }
    selectionCount();
  };
  const showResults = (sources, title) => {
    if (!Array.isArray(sources) || sources.length > SCAN_LIMITS.hosts) throw new Error("Die Scanner-Ergebnisliste ist ungültig oder zu groß.");
    const seen = new Set();
    results = sources.map(normalizeScanHost).filter((host) => host && !seen.has(host.ip) && seen.add(host.ip));
    rows = [];
    const body = $("#scan-results-body");
    body.replaceChildren();
    for (const host of results) {
      const tr = document.createElement("tr");
      const cell = (content) => { const td = document.createElement("td"); typeof content === "string" ? td.textContent = content : td.append(content); tr.append(td); return td; };
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = true; checkbox.setAttribute("aria-label", `${host.ip} übernehmen`); cell(checkbox);
      cell(host.ip);
      const name = document.createElement("input"); name.type = "text"; name.maxLength = 40; name.value = host.name || host.hostname || host.ip; name.setAttribute("aria-label", `Name für ${host.ip}`); cell(name);
      const type = document.createElement("select"); type.setAttribute("aria-label", `Gerätetyp für ${host.ip}`);
      for (const [id, label] of DEVICE_TYPES) { const option = document.createElement("option"); option.value = id; option.textContent = label; type.append(option); }
      type.value = host.type; cell(type);
      cell(host.ports.length ? host.ports.map((port) => `${port.port}/tcp${port.service ? ` · ${port.service}` : ""}`).join(", ") : "Keine erfasst").className = "scan-services";
      const label = document.createElement("span"); label.className = "scan-row-status"; cell(label);
      checkbox.addEventListener("change", selectionCount);
      rows.push({ host, checkbox, name, type, label }); body.append(tr);
    }
    $("#scan-results").hidden = false;
    $("#scan-results-heading").textContent = title;
    $("#scan-result-count").textContent = `${results.length} aktive IPv4-Geräte`;
    refreshKnown();
  };
  const finishJob = (message, error = false) => { stopPoll(); job = null; cancelRequested = false; controls(); status(message, error); };
  const schedulePoll = () => { if (!disposed && job) { stopPoll(); timer = setTimeout(poll, 1000); } };
  const poll = async () => {
    timer = null;
    if (disposed || !job) return;
    const version = pollVersion;
    if (Date.now() >= deadline) { status("Die Statusabfrage ist nach 200 Sekunden beendet. Der Scan kann noch laufen; mit „Scan abbrechen“ den Abbruch anfordern.", true); return; }
    try {
      const next = await api(`/jobs/${encodeURIComponent(job.id)}`);
      if (disposed || !job || version !== pollVersion) return;
      if (next.id !== job.id || next.target !== job.target || next.profile !== job.profile) throw new Error("Die Scanner-Antwort passt nicht zum laufenden Scan.");
      if (next.status === "running") { status(`${cancelRequested ? "Abbruch angefordert" : "Scan läuft"}: ${job.target} · ${PROFILE_NAMES[job.profile]}`); schedulePoll(); }
      else if (next.status === "completed") { const completed = job; finishJob(`Scan abgeschlossen: ${completed.target}. Bitte Ergebnisse prüfen und auswählen.`); showResults(next.hosts, `Scan: ${completed.target} · ${PROFILE_NAMES[completed.profile]}`); }
      else if (next.status === "cancelled") finishJob("Scan abgebrochen. Es wurden keine Geräte übernommen.");
      else if (next.status === "failed") finishJob("Der Scan ist fehlgeschlagen. Scanner-Konfiguration und Erreichbarkeit des Netzes prüfen.", true);
      else throw new Error("Der Scanner hat einen unbekannten Status geliefert.");
    } catch (error) { if (!disposed && version === pollVersion) { status(`${error.message} ${job ? "Der Scanstatus ist unklar; bei Bedarf den Abbruch anfordern." : "Der Scanstatus ist unklar. Bitte erneut verbinden und den Scanner prüfen."}`, true); controls(); } }
  };
  listen($("#scan-connect"), "click", async () => {
    if (locked()) return;
    const entered = $("#scan-token").value.trim(); $("#scan-token").value = "";
    if (entered.length < 24) { status("Bitte einen Scanner-Token mit mindestens 24 Zeichen eingeben.", true); return; }
    token = entered; config = null; connecting = true; controls(); status("Scanner wird verbunden …");
    try {
      const availability = await api("/status", {}, false);
      if (!availability.enabled) throw new Error("Der lokale Scanner ist deaktiviert. Bitte Docker-Konfiguration prüfen oder XML importieren.");
      const next = await api("/config");
      if (!Array.isArray(next.allowedCidrs) || !next.allowedCidrs.length || next.allowedCidrs.some((cidr) => typeof cidr !== "string" || cidr.length > 32) || !Array.isArray(next.profiles)) throw new Error("Die Scanner-Konfiguration konnte nicht gelesen werden.");
      const profiles = next.profiles.filter((profile) => profile && Object.hasOwn(PROFILE_NAMES, profile.id));
      if (!profiles.length) throw new Error("Im Scanner ist kein unterstütztes Profil aktiviert.");
      config = next;
      $("#scan-profile").replaceChildren(...profiles.map((profile) => { const option = document.createElement("option"); option.value = profile.id; option.textContent = PROFILE_NAMES[profile.id]; return option; }));
      $("#scan-networks").textContent = `Freigegeben: ${next.allowedCidrs.join(", ")}. Maximal 256 Adressen je Scan.`;
      $("#scan-connection").textContent = "Scanner verbunden. Der Token bleibt im Arbeitsspeicher dieser Sitzung.";
      status("Scanner bereit. Bereich und Profil auswählen und bewusst starten.");
    } catch (error) { token = ""; config = null; $("#scan-connection").textContent = "Nicht verbunden. XML-Import ist weiterhin verfügbar."; status(error.message, true); }
    finally { connecting = false; controls(); }
  });
  listen($("#scan-form"), "submit", async (event) => {
    event.preventDefault();
    if (locked() || !config) return;
    const target = $("#scan-target").value.trim(), profile = $("#scan-profile").value;
    const parts = target.split("/");
    if (!canonicalIPv4(parts[0]) || parts.length > 2 || (parts.length === 2 && (!/^(?:2[4-9]|3[0-2])$/.test(parts[1])))) { status("Bitte eine IPv4-Adresse oder ein Netz mit /24 bis /32 eingeben (maximal 256 Adressen).", true); return; }
    starting = true; controls(); status(`Scan wird gestartet: ${target} · ${PROFILE_NAMES[profile]}`);
    try {
      const next = await api("/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target, profile }) });
      if (typeof next.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(next.id) || next.status !== "running") throw new Error("Der Scanner hat den Start nicht bestätigt.");
      job = { ...next, target, profile }; cancelRequested = false; deadline = Date.now() + 200000;
      $("#scan-results").hidden = true; rows = []; results = [];
      status(`Scan läuft: ${target} · ${PROFILE_NAMES[profile]}`); schedulePoll();
    } catch (error) { status(error.message, true); }
    finally { starting = false; controls(); }
  });
  listen($("#scan-cancel"), "click", async () => {
    if (!job || cancelRequested) return;
    stopPoll(); pollVersion++; cancelRequest(); cancelRequested = true; controls();
    try {
      const next = await api(`/jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
      if (next.status === "cancelled") finishJob("Scan abgebrochen. Es wurden keine Geräte übernommen.");
      else { status("Abbruch angefordert. Warte auf den Scanner …"); deadline = Date.now() + 200000; schedulePoll(); }
    } catch (error) { cancelRequested = false; status(`${error.message} Der Abbruch wurde nicht bestätigt.`, true); controls(); }
  });
  listen($("#scan-xml-input"), "change", async () => {
    const input = $("#scan-xml-input"), file = input.files?.[0]; input.value = "";
    if (!file || locked()) return;
    if (file.size > SCAN_LIMITS.xmlBytes) { status("Die XML-Datei darf höchstens 2 MB groß sein.", true); return; }
    reading = true; controls(); status("XML-Datei wird lokal eingelesen …");
    try {
      const xml = await new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("Die XML-Datei konnte nicht gelesen werden.")); reader.readAsText(file); });
      const hosts = parseNmapXml(xml, window.DOMParser);
      if (disposed) return;
      reading = false; showResults(hosts, "Vorschau: lokale Nmap-XML-Datei"); status(hosts.length ? "XML eingelesen. Namen und Typen prüfen und ausgewählte Geräte übernehmen." : "Die XML-Datei enthält keine aktiven IPv4-Geräte.");
    } catch (error) { status(error.message, true); }
    finally { reading = false; controls(); }
  });
  listen($("#scan-select-all"), "change", () => { for (const row of rows) if (!row.checkbox.disabled) row.checkbox.checked = $("#scan-select-all").checked; selectionCount(); });
  listen($("#scan-import-selected"), "click", () => {
    if (locked()) return;
    refreshKnown();
    const selection = rows.filter((row) => row.checkbox.checked && !row.checkbox.disabled).map((row) => ({ ...row.host, name: row.name.value, type: row.type.value }));
    if (!selection.length) { status("Bitte mindestens ein neues Gerät auswählen."); return; }
    try {
      const result = onImport(selection);
      refreshKnown();
      status(`${result.added} Geräte übernommen${result.skipped ? `, ${result.skipped} übersprungen` : ""}. Physische Ports und Verbindungen kannst du jetzt ergänzen.`);
    } catch (error) { status(error?.message?.startsWith("Maximal ") ? error.message : "Die Auswahl konnte nicht übernommen werden. Bitte weniger Geräte auswählen und erneut versuchen.", true); }
  });
  const destroy = () => { disposed = true; stopPoll(); cancelRequest(); token = ""; $("#scan-token").value = ""; handlers.splice(0).forEach((remove) => remove()); };
  listen(window, "pagehide", destroy);
  controls();
  return { destroy, refresh: refreshKnown };
}
