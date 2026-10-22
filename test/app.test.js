import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM, VirtualConsole } from "jsdom";
import { demoState, normalizeState } from "../public/model.js";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const STORAGE_KEY = "netzplaner-v1";
let instance = 0;

// Run the actual application module against a fresh DOM for each case. These tests
// exercise forms/events/storage; they do not claim browser layout or rendering coverage.
async function openApp(t, { raw = JSON.stringify(demoState()), failSave = false, confirm = () => true } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(html, { url: "https://netzplaner.test/", virtualConsole });
  const { window } = dom;
  if (raw !== null) window.localStorage.setItem(STORAGE_KEY, raw);
  if (failSave) window.Storage.prototype.setItem = () => { throw new window.DOMException("Storage quota exceeded", "QuotaExceededError"); };
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const downloads = [], blobs = new Map(), fileReads = [];
  const DownloadURL = class extends globalThis.URL {
    static createObjectURL(blob) {
      const url = `blob:https://netzplaner.test/${blobs.size + 1}`;
      blobs.set(url, blob);
      return url;
    }
    static revokeObjectURL(url) { blobs.delete(url); }
  };
  window.HTMLAnchorElement.prototype.click = function () {
    downloads.push({ name: this.download, blob: blobs.get(this.href) });
  };
  const ObservedFileReader = class extends window.FileReader {
    constructor() {
      super();
      fileReads.push(new Promise((resolve) => this.addEventListener("loadend", resolve, { once: true })));
    }
  };

  const bindings = {
    window, document: window.document, localStorage: window.localStorage,
    FormData: window.FormData, Option: window.Option, FileReader: ObservedFileReader, URL: DownloadURL,
    XMLSerializer: window.XMLSerializer, confirm
  };
  const descriptors = new Map();
  const timers = new Set();
  const originalSetTimeout = globalThis.setTimeout;
  bindings.setTimeout = (callback, delay, ...args) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    timers.add(timer);
    return timer;
  };
  for (const [key, value] of Object.entries(bindings)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.deepEqual(errors.map((error) => error.message), [], "Application should not raise DOM event errors");
  });
  await import(`${new URL("../public/app.js", import.meta.url).href}?test=${++instance}`);
  const $ = (selector) => {
    const element = window.document.querySelector(selector);
    assert.ok(element, `Element exists: ${selector}`);
    return element;
  };
  return {
    window, $, downloads,
    click(selector) { $(selector).click(); },
    fill(selector, value, event = "input") {
      const element = $(selector);
      element.value = value;
      element.dispatchEvent(new window.Event(event, { bubbles: true }));
    },
    submit(selector) { $(selector).requestSubmit($(selector).querySelector('[type="submit"]')); },
    async importFile(content, name = "plan.json") {
      const input = $("#import-input");
      Object.defineProperty(input, "files", { configurable: true, value: [new window.File([content], name, { type: "application/json" })] });
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await fileReads.at(-1);
      return input;
    },
    saved() { return JSON.parse(window.localStorage.getItem(STORAGE_KEY)); },
    rows(selector) { return [...window.document.querySelectorAll(selector)]; }
  };
}

test("app device CRUD updates storage and supports undo/redo including related links", async (t) => {
  const app = await openApp(t);
  app.click('[data-action="new-plan"]');
  app.click('[data-action="add-device"]');
  app.fill('#device-form [name="name"]', "Lab Switch");
  app.fill('#device-form [name="portCount"]', "3");
  app.fill('#device-form [name="ip"]', "192.168.1.2");
  app.fill('#device-form [name="notes"]', "Rack links");
  app.submit("#device-form");
  let saved = app.saved();
  assert.equal(saved.devices.length, 1);
  assert.equal(saved.devices[0].ports.length, 3);
  assert.equal(saved.devices[0].notes, "Rack links");
  assert.equal(app.$("#device-dialog").open, false);
  app.click("[data-edit-device]");
  app.fill('#device-form [name="name"]', "Updated Switch");
  app.submit("#device-form");
  assert.equal(app.saved().devices[0].name, "Updated Switch");
  app.click('[data-action="undo"]');
  assert.equal(app.saved().devices[0].name, "Lab Switch");
  app.click('[data-action="redo"]');
  assert.equal(app.saved().devices[0].name, "Updated Switch");
  app.click("[data-edit-device]");
  app.click("#device-delete");
  assert.deepEqual(app.saved(), { devices: [], connections: [] });
  app.click('[data-action="undo"]');
  assert.equal(app.saved().devices[0].name, "Updated Switch");

  app.click('[data-action="reset"]');
  app.click('[data-edit-device="router-1"]');
  app.click("#device-delete");
  assert.equal(app.saved().devices.length, 2);
  assert.equal(app.saved().connections.length, 1);
  app.click('[data-action="undo"]');
  assert.equal(app.saved().devices.length, 3);
  assert.equal(app.saved().connections.length, 2);
});

test("app duplicate preserves notes, creates free ports and asks for a new IP", async (t) => {
  const initial = demoState(); initial.devices[0].notes = "Firewall template";
  const app = await openApp(t, { raw: JSON.stringify(initial) });
  app.click("[data-duplicate-device]");
  const saved = app.saved(), original = saved.devices[0], copy = saved.devices.at(-1);
  assert.equal(saved.devices.length, 4);
  assert.equal(copy.name, "Firewall (Kopie)");
  assert.equal(copy.notes, "Firewall template");
  assert.equal(copy.ip, "");
  assert.equal(copy.ports.length, original.ports.length);
  assert.ok(copy.ports.every((port) => port.deviceId === copy.id && !original.ports.some((p) => p.id === port.id)));
  assert.equal(saved.connections.length, initial.connections.length);
  assert.equal(app.rows("#ports-table .status-pill.free").length, copy.ports.length);
  assert.match(app.$("#toast").textContent, /IP-Adresse bitte neu vergeben/);
});

test("app combines device search/type filters and filters occupied, free and PoE ports", async (t) => {
  const app = await openApp(t);
  assert.equal(app.rows("#device-list .device-row").length, 3);
  app.fill("#device-search", "büro");
  assert.equal(app.rows("#device-list .device-row").length, 1);
  assert.match(app.$("#device-list").textContent, /AP Büro/);
  app.fill("#type-filter", "switch", "change");
  assert.equal(app.rows("#device-list .device-row").length, 0);
  app.fill("#device-search", "");
  assert.equal(app.rows("#device-list .device-row").length, 1);
  assert.match(app.$("#device-list").textContent, /Core Switch/);
  app.fill("#type-filter", "all", "change");
  assert.equal(app.rows("#device-list .device-row").length, 3);
  app.click('[data-select-device="switch-1"]');
  app.fill("#port-filter", "used", "change");
  assert.equal(app.rows("#ports-table .port-name").length, 2);
  app.fill("#port-filter", "free", "change");
  assert.equal(app.rows("#ports-table .port-name").length, 6);
  app.fill("#port-filter", "poe", "change");
  assert.equal(app.rows("#ports-table .port-name").length, 1);
  app.fill("#connections-search", "PoE");
  assert.equal(app.rows("#connections-list tbody tr").length, 1);
});

test("app link editing keeps current endpoints available and rejects another link's occupied port", async (t) => {
  const initial = demoState(), app = await openApp(t, { raw: JSON.stringify(initial) });
  app.click('[data-edit-link="link-1"]');
  const form = app.$("#connection-form");
  assert.equal(form.elements.portA.value, initial.connections[0].a.portId);
  assert.equal(form.elements.portB.value, initial.connections[0].b.portId);
  assert.equal(form.elements.portA.selectedOptions[0].disabled, false);
  assert.equal(form.elements.portB.selectedOptions[0].disabled, false);
  const occupiedPort = initial.devices[1].ports[1].id;
  assert.equal([...form.elements.portB.options].find((o) => o.value === occupiedPort).disabled, true);
  app.fill('#connection-form [name="label"]', "Edited uplink");
  app.submit("#connection-form");
  assert.equal(app.saved().connections.length, 2);
  assert.equal(app.saved().connections[0].label, "Edited uplink");

  app.click('[data-edit-link="link-1"]');
  form.elements.portB.value = occupiedPort;
  // Deliberately bypass the disabled UI choice to verify model validation at save time.
  form.dispatchEvent(new app.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
  assert.equal(app.$("#connection-dialog").open, true);
  assert.match(app.$("#connection-error").textContent, /Port-Konflikt/);
  assert.equal(app.saved().connections[0].b.portId, initial.connections[0].b.portId);
});

test("app cancellation works with empty required fields and reopening clears custom validity", async (t) => {
  const app = await openApp(t);
  const before = app.window.localStorage.getItem(STORAGE_KEY);
  app.click('[data-action="add-device"]');
  app.fill('#device-form [name="name"]', "   ");
  app.submit("#device-form");
  assert.equal(app.$('#device-form [name="name"]').validity.customError, true);
  app.click('#device-dialog [data-close-dialog="device-dialog"]');
  assert.equal(app.$("#device-dialog").open, false);
  assert.equal(app.window.localStorage.getItem(STORAGE_KEY), before);
  app.click('[data-action="add-device"]');
  assert.equal(app.$('#device-form [name="name"]').validity.customError, false);
  app.click('#device-dialog [data-close-dialog="device-dialog"]');

  app.click("[data-edit-port]");
  app.fill('#port-form [name="name"]', "");
  app.click('#port-dialog [data-close-dialog="port-dialog"]');
  assert.equal(app.$("#port-dialog").open, false);
  app.click('[data-action="add-connection"]');
  app.$('#connection-form [name="portA"]').value = "";
  app.click('#connection-dialog [data-close-dialog="connection-dialog"]');
  assert.equal(app.$("#connection-dialog").open, false);
  assert.equal(app.window.localStorage.getItem(STORAGE_KEY), before);
});

test("app reports failed storage and retains edits in the current session", async (t) => {
  const initial = demoState(), app = await openApp(t, { raw: JSON.stringify(initial), failSave: true });
  app.click("[data-duplicate-device]");
  assert.match(app.$("#storage-status").textContent, /Speichern fehlgeschlagen/);
  assert.equal(app.$("#storage-status").classList.contains("storage-warning"), true);
  assert.equal(app.rows("#device-list .device-row").length, 4);
  assert.equal(app.saved().devices.length, 3);
  app.click('[data-action="undo"]');
  assert.equal(app.rows("#device-list .device-row").length, 3);
});

test("app leaves malformed saved JSON intact until explicit replacement", async (t) => {
  const raw = '{"devices": [', app = await openApp(t, { raw });
  assert.equal(app.rows("#device-list .device-row").length, 0);
  assert.equal(app.$("#storage-status").classList.contains("storage-warning"), true);
  assert.ok(app.$('[data-action="recover-storage"]'));
  app.click('[data-action="add-device"]');
  app.fill('#device-form [name="name"]', "Session only");
  app.submit("#device-form");
  assert.equal(app.rows("#device-list .device-row").length, 1);
  assert.equal(app.window.localStorage.getItem(STORAGE_KEY), raw);
  app.click('[data-action="new-plan"]');
  assert.deepEqual(app.saved(), { devices: [], connections: [] });
  assert.equal(app.$("#storage-status").classList.contains("storage-warning"), false);
});

test("app blocks automatic overwrite when stored records need repair", async (t) => {
  const raw = JSON.stringify({ devices: [{ id: "a", type: "switch", name: "Incomplete device", ports: "bad" }], connections: [] });
  const app = await openApp(t, { raw });
  assert.match(app.$("#storage-status").textContent, /Speichern ist gesperrt/);
  app.click("[data-add-port]");
  assert.equal(app.rows("#ports-table .port-name").length, 1);
  assert.equal(app.window.localStorage.getItem(STORAGE_KEY), raw);
});

test("app reads JSON files, preserves notes, keeps canceled/invalid imports unchanged and reuses its input", async (t) => {
  let accept = false;
  const prompts = [], app = await openApp(t, { confirm(message) { prompts.push(message); return accept; } });
  const before = app.window.localStorage.getItem(STORAGE_KEY);
  const plan = normalizeState(demoState()).state;
  plan.devices[0].name = "Imported Firewall";
  plan.devices[0].notes = "Imported notes: rack 2, VLAN 20";
  const input = await app.importFile(JSON.stringify(plan));
  assert.equal(app.window.localStorage.getItem(STORAGE_KEY), before);
  assert.equal(app.rows("#device-list .device-row").length, 3);
  assert.match(app.$("#device-list").textContent, /Firewall/);
  assert.ok(!app.$("#device-list").textContent.includes("Imported Firewall"));
  assert.match(prompts[0], /3 Geräte und 2 Verbindungen importieren/);
  assert.equal(input.value, "");

  await app.importFile('{"invalid": true}');
  assert.match(app.$("#toast").textContent, /Import abgebrochen/);
  assert.equal(app.window.localStorage.getItem(STORAGE_KEY), before);
  await app.importFile('{"devices": [');
  assert.equal(app.window.localStorage.getItem(STORAGE_KEY), before);
  assert.equal(prompts.length, 1, "Invalid payloads are rejected before confirmation");

  accept = true;
  const reused = await app.importFile("\uFEFF" + JSON.stringify(plan));
  assert.equal(reused, input);
  assert.equal(app.saved().devices[0].name, "Imported Firewall");
  assert.equal(app.saved().devices[0].notes, plan.devices[0].notes);
  assert.match(app.$("#ports-heading").textContent, /Imported notes: rack 2, VLAN 20/);
  app.click('[data-action="export"]');
  assert.deepEqual(JSON.parse(await app.downloads.at(-1).blob.text()), app.saved());
  app.click('[data-action="undo"]');
  assert.equal(app.saved().devices[0].name, "Firewall");
});

test("app exports standalone parseable SVG containing every device despite active search", async (t) => {
  const initial = demoState(), app = await openApp(t, { raw: JSON.stringify(initial) });
  app.fill("#device-search", "Büro");
  assert.equal(app.rows("#device-list .device-row").length, 1);
  assert.ok(app.rows("#topology .node").some((node) => node.style.opacity === "0.3"));
  app.click('[data-action="export-svg"]');
  const download = app.downloads.at(-1);
  assert.match(download.name, /^netzplan-\d{4}-\d{2}-\d{2}\.svg$/);
  assert.match(download.blob.type, /^image\/svg\+xml/);
  const xml = new app.window.DOMParser().parseFromString(await download.blob.text(), "image/svg+xml");
  assert.equal(xml.querySelector("parsererror"), null);
  assert.equal(xml.documentElement.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(xml.querySelectorAll(".node").length, initial.devices.length);
  assert.equal(xml.querySelectorAll(".link").length, initial.connections.length);
  assert.ok([...xml.querySelectorAll(".node")].every((node) => node.style.opacity === "1" && !node.hasAttribute("tabindex")));
  assert.match(xml.querySelector("style").textContent, /\.link\{fill:none/);
  assert.match(xml.querySelector("style").textContent, /\.node-title/);
  assert.ok(Number(xml.documentElement.getAttribute("width")) > 0);
  assert.ok(Number(xml.documentElement.getAttribute("height")) > 0);
  assert.equal(app.rows("#device-list .device-row").length, 1, "Export does not change on-screen filters");
});

test("app print events reveal full inventories and restore all filters and selection afterward", async (t) => {
  const app = await openApp(t);
  const before = app.window.localStorage.getItem(STORAGE_KEY);
  app.fill("#type-filter", "switch", "change");
  app.fill("#device-search", "Core");
  app.fill("#port-filter", "used", "change");
  app.fill("#connections-search", "PoE");
  assert.equal(app.rows("#device-list .device-row").length, 1);
  assert.equal(app.rows("#ports-table .port-name").length, 2);
  assert.equal(app.rows("#connections-list tbody tr").length, 1);
  app.window.dispatchEvent(new app.window.Event("beforeprint"));
  assert.equal(app.rows("#device-list .device-row").length, 3);
  assert.equal(app.rows("#ports-table .port-name").length, 8);
  assert.equal(app.rows("#connections-list tbody tr").length, 2);
  assert.ok(app.rows("#topology .node").every((node) => node.style.opacity === "1"));
  app.window.dispatchEvent(new app.window.Event("beforeprint"));
  app.window.dispatchEvent(new app.window.Event("afterprint"));
  assert.equal(app.rows("#device-list .device-row").length, 1);
  assert.equal(app.$("#device-list .device-row").dataset.selectDevice, "switch-1");
  assert.equal(app.rows("#ports-table .port-name").length, 2);
  assert.equal(app.rows("#connections-list tbody tr").length, 1);
  assert.equal(app.$("#device-search").value, "Core");
  assert.equal(app.$("#type-filter").value, "switch");
  assert.equal(app.$("#port-filter").value, "used");
  assert.equal(app.$("#connections-search").value, "PoE");
  assert.equal(app.window.localStorage.getItem(STORAGE_KEY), before, "Printing does not save or mutate data");
});

test("normalization is idempotent after a JSON export/import round trip", () => {
  const first = normalizeState(demoState()).state;
  const second = normalizeState(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(second, { state: first, warnings: [] });
});
