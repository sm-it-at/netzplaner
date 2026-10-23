import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { initScanner } from "../public/scan.js";
import { mergeScanHosts } from "../public/scan-model.js";
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const token = "test-scanner-token-123456789";
const fixture = (body = '<hostnames><hostname name="nas"/></hostnames>') => `<nmaprun><host><status state="up" reason="arp-response"/><address addr="192.168.1.8" addrtype="ipv4"/>${body}<ports><port protocol="tcp" portid="443"><state state="open"/><service name="https"/></port></ports></host></nmaprun>`;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ok = (value) => ({ ok: true, status: 200, json: async () => value });

async function setup(t, { state: initial = { devices: [], connections: [] }, respond, onImport } = {}) {
  const dom = new JSDOM(html, { url: "https://netzplaner.test/" });
  const { window } = dom;
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: window.document });
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  const timers = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 1000) { const timer = { callback: () => callback(...args) }; timers.add(timer); return timer; }
    return realSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (timer) => { if (timers.has(timer)) timers.delete(timer); else realClearTimeout(timer); };
  window.FileReader = class {
    readAsText(file) { this.result = file.content; queueMicrotask(() => this.onload()); }
  };
  let state = initial;
  const requests = [], imports = [];
  const scanner = initScanner({ getState: () => state, onImport: (hosts) => { imports.push(hosts); if (onImport) return onImport(hosts); const result = mergeScanHosts(state, hosts); state = result.state; return result; }, fetch: async (url, options) => {
    requests.push({ url, options });
    if (respond) return respond(url, options);
    if (url.endsWith("/status")) return ok({ enabled: true });
    if (url.endsWith("/config")) return ok({ allowedCidrs: ["192.168.1.0/24"], profiles: [{ id: "discovery" }, { id: "ports" }], maxHosts: 256 });
    throw new Error("Unexpected request");
  } });
  t.after(() => {
    scanner.destroy(); dom.window.close();
    globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  });
  const $ = (selector) => { const node = window.document.querySelector(selector); assert.ok(node, selector); return node; };
  return { $, window, requests, imports, scanner, state: () => state,
    async connect() { $("#scan-token").value = token; $("#scan-connect").click(); await flush(); },
    async start(target = "192.168.1.0/24", profile = "discovery") { $("#scan-target").value = target; $("#scan-profile").value = profile; $("#scan-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await flush(); },
    async tick() { const timer = timers.values().next().value; assert.ok(timer, "A poll is scheduled"); timers.delete(timer); await timer.callback(); await flush(); },
    async xml(content = fixture()) { Object.defineProperty($("#scan-xml-input"), "files", { configurable: true, value: [{ size: new TextEncoder().encode(content).length, content }] }); $("#scan-xml-input").dispatchEvent(new window.Event("change", { bubbles: true })); await flush(); }
  };
}

test("scanner initialization is idle and local XML preview needs neither token nor network", async (t) => {
  const app = await setup(t);
  assert.equal(app.requests.length, 0);
  await app.xml();
  assert.equal(app.requests.length, 0); assert.equal(app.imports.length, 0);
  assert.equal(app.$("#scan-results").hidden, false); assert.equal(app.$("#scan-results-body").rows.length, 1);
  app.$('#scan-results-body input[type="text"]').value = "My NAS";
  app.$("#scan-results-body select").value = "server";
  app.$("#scan-import-selected").click();
  assert.equal(app.state().devices.length, 1); assert.equal(app.state().devices[0].name, "My NAS");
  assert.equal(app.state().devices[0].type, "server"); assert.deepEqual(app.state().devices[0].ports, []);
  assert.match(app.state().devices[0].notes, /443\/tcp/); assert.equal(app.$('#scan-results-body input[type="checkbox"]').disabled, true);
  assert.match(app.$("#scan-status").textContent, /1 Geräte übernommen/);
});

test("existing IPs cannot be selected and untrusted XML names remain plain values", async (t) => {
  const old = { id: "d1", ip: "192.168.1.8", name: "Existing", notes: "Keep", ports: [] };
  const app = await setup(t, { state: { devices: [old], connections: [] } });
  await app.xml(fixture('<hostnames><hostname name="&lt;img src=x onerror=alert(1)&gt;"/></hostnames>'));
  assert.equal(app.$("#scan-results-body").querySelector("img"), null);
  assert.equal(app.$('#scan-results-body input[type="checkbox"]').disabled, true);
  assert.equal(app.$("#scan-import-selected").disabled, true);
  assert.match(app.$("#scan-results-body").textContent, /Bereits im Plan/);
  assert.equal(app.state().devices[0], old);
});

test("scanner connects only after click and keeps token out of fields, storage, and request body", async (t) => {
  const app = await setup(t); await app.connect();
  assert.deepEqual(app.requests.map((request) => request.url), ["/api/scan/status", "/api/scan/config"]);
  assert.equal(app.requests[0].options.headers.Authorization, undefined);
  assert.equal(app.requests[1].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(app.$("#scan-token").value, ""); assert.equal(app.window.localStorage.length, 0); assert.equal(app.window.sessionStorage.length, 0);
  assert.equal(app.$("#scan-start").disabled, false); assert.equal(app.requests.some((request) => request.options.method === "POST"), false);
});

test("scan completion unlocks controls and displays reviewable hosts without changing the plan", async (t) => {
  const app = await setup(t, { respond: (url, options) => {
    if (url.endsWith("/status")) return ok({ enabled: true });
    if (url.endsWith("/config")) return ok({ allowedCidrs: ["192.168.1.0/24"], profiles: [{ id: "discovery" }] });
    if (url.endsWith("/jobs")) { assert.deepEqual(JSON.parse(options.body), { target: "192.168.1.0/24", profile: "discovery" }); return ok({ id: "job-1", status: "running" }); }
    return ok({ id: "job-1", status: "completed", target: "192.168.1.0/24", profile: "discovery", hosts: [{ ip: "192.168.1.8", hostname: "nas", ports: [] }] });
  } });
  await app.connect(); await app.start();
  assert.equal(app.$("#scan-target").disabled, true); assert.equal(app.$("#scan-xml-input").disabled, true);
  await app.tick();
  assert.equal(app.$("#scan-target").disabled, false); assert.equal(app.$("#scan-results").hidden, false);
  assert.match(app.$("#scan-results-heading").textContent, /192\.168\.1\.0\/24/);
  assert.match(app.$("#scan-status").textContent, /Scan abgeschlossen/); assert.equal(app.imports.length, 0); assert.equal(app.state().devices.length, 0);
});

test("scan cancellation waits for terminal backend state and never imports results", async (t) => {
  let cancelling = false;
  const app = await setup(t, { respond: (url, options) => {
    if (url.endsWith("/status")) return ok({ enabled: true });
    if (url.endsWith("/config")) return ok({ allowedCidrs: ["192.168.1.0/24"], profiles: [{ id: "discovery" }] });
    if (url.endsWith("/jobs")) return ok({ id: "job-1", status: "running" });
    if (options.method === "DELETE") { cancelling = true; return ok({ id: "job-1", status: "running" }); }
    return ok({ id: "job-1", status: cancelling ? "cancelled" : "running", target: "192.168.1.0/24", profile: "discovery", hosts: [] });
  } });
  await app.connect(); await app.start(); app.$("#scan-cancel").click(); await flush();
  assert.match(app.$("#scan-status").textContent, /Abbruch angefordert/); assert.equal(app.$("#scan-start").disabled, true);
  await app.tick(); assert.match(app.$("#scan-status").textContent, /Scan abgebrochen/);
  assert.equal(app.$("#scan-start").disabled, false); assert.equal(app.imports.length, 0);
});

test("an expired scanner token releases job controls and allows reconnect without claiming cancellation", async (t) => {
  const app = await setup(t, { respond: (url) => {
    if (url.endsWith("/status")) return ok({ enabled: true });
    if (url.endsWith("/config")) return ok({ allowedCidrs: ["192.168.1.0/24"], profiles: [{ id: "discovery" }] });
    if (url.endsWith("/jobs")) return ok({ id: "job-1", status: "running" });
    return { ok: false, status: 401 };
  } });
  await app.connect(); await app.start(); await app.tick();
  assert.equal(app.$("#scan-connect").disabled, false); assert.equal(app.$("#scan-token").disabled, false);
  assert.match(app.$("#scan-status").textContent, /Token ist ungültig/); assert.doesNotMatch(app.$("#scan-status").textContent, /Scan abgebrochen/);
});

test("invalid scan range never submits a job and pagehide clears token and polling", async (t) => {
  const app = await setup(t); await app.connect(); await app.start("192.168.0.0/16");
  assert.equal(app.requests.length, 2); assert.match(app.$("#scan-status").textContent, /maximal 256/);
  await app.start("192.168.1.77/24");
  assert.equal(app.requests.length, 2); assert.match(app.$("#scan-status").textContent, /192\.168\.1\.0\/24 statt/);
  app.window.dispatchEvent(new app.window.Event("pagehide"));
  assert.equal(app.$("#scan-token").value, ""); assert.equal(app.window.localStorage.length, 0);
});

test("failed scan status does not display backend details or claim successful completion", async (t) => {
  const app = await setup(t, { respond: (url) => {
    if (url.endsWith("/status")) return ok({ enabled: true });
    if (url.endsWith("/config")) return ok({ allowedCidrs: ["192.168.1.0/24"], profiles: [{ id: "discovery" }] });
    if (url.endsWith("/jobs")) return ok({ id: "job-1", status: "running" });
    return ok({ id: "job-1", status: "failed", target: "192.168.1.0/24", profile: "discovery", error: "SENSITIVE_PROCESS_DETAILS" });
  } });
  await app.connect(); await app.start(); await app.tick();
  assert.match(app.$("#scan-status").textContent, /fehlgeschlagen/);
  assert.doesNotMatch(app.$("#scan-status").textContent, /SENSITIVE|abgeschlossen/);
  assert.equal(app.$("#scan-results").hidden, true); assert.equal(app.$("#scan-start").disabled, false);
});

test("a scanner timeout is explained, while other or crafted failure texts stay hidden", async (t) => {
  for (const [error, expected] of [["Der Scan wurde nach 180 Sekunden beendet.", /kleineren Bereich/], ["constructor", /Der Scan ist fehlgeschlagen/], [{ text: "SENSITIVE" }, /Der Scan ist fehlgeschlagen/]]) {
    await t.test(JSON.stringify(error), async (st) => {
      const app = await setup(st, { respond: (url) => {
        if (url.endsWith("/status")) return ok({ enabled: true });
        if (url.endsWith("/config")) return ok({ allowedCidrs: ["192.168.1.0/24"], profiles: [{ id: "ports" }] });
        if (url.endsWith("/jobs")) return ok({ id: "job-1", status: "running" });
        return ok({ id: "job-1", status: "failed", target: "192.168.1.0/24", profile: "ports", error });
      } });
      await app.connect(); await app.start("192.168.1.0/24", "ports"); await app.tick();
      assert.match(app.$("#scan-status").textContent, expected);
      assert.equal(app.$("#scan-status").classList.contains("scan-error"), true);
      assert.doesNotMatch(app.$("#scan-status").textContent, /SENSITIVE|function/);
    });
  }
});

test("a rejected scan start names the Host header only for the scanner's origin check", async (t) => {
  for (const [body, expected] of [[{ error: "Origin und Host der Anfrage müssen übereinstimmen." }, /Host-Header/], [{ error: "Das Ziel liegt außerhalb der freigegebenen Scan-Netze." }, /nicht freigegeben/], [null, /nicht freigegeben/]]) {
    await t.test(JSON.stringify(body), async (st) => {
      const app = await setup(st, { respond: (url) => {
        if (url.endsWith("/status")) return ok({ enabled: true });
        if (url.endsWith("/config")) return ok({ allowedCidrs: ["192.168.1.0/24"], profiles: [{ id: "discovery" }] });
        return { ok: false, status: 403, json: async () => { if (!body) throw new SyntaxError("Not JSON"); return body; } };
      } });
      await app.connect(); await app.start();
      assert.match(app.$("#scan-status").textContent, expected);
      assert.equal(app.$("#scan-start").disabled, false);
    });
  }
});

test("a deactivated scanner names a known configuration reason and hides unknown ones", async (t) => {
  for (const [reason, expected] of [["Kein Scan-Netz freigegeben (SCAN_ALLOWED_CIDRS).", /In SCAN_ALLOWED_CIDRS ist kein Netz/], ["SENSITIVE detail", /Container-Konfiguration prüfen/]]) {
    await t.test(reason, async (st) => {
      const app = await setup(st, { respond: () => ok({ enabled: false, reason }) });
      await app.connect();
      assert.match(app.$("#scan-status").textContent, expected);
      assert.doesNotMatch(app.$("#scan-status").textContent, /SENSITIVE/);
      assert.equal(app.requests.length, 1); assert.equal(app.$("#scan-start").disabled, true);
    });
  }
});

test("polling stops after 200 seconds while leaving explicit cancellation available", async (t) => {
  const app = await setup(t, { respond: (url) => {
    if (url.endsWith("/status")) return ok({ enabled: true });
    if (url.endsWith("/config")) return ok({ allowedCidrs: ["192.168.1.0/24"], profiles: [{ id: "discovery" }] });
    return ok({ id: "job-1", status: "running" });
  } });
  await app.connect(); await app.start();
  const now = Date.now;
  Date.now = () => now() + 201000;
  try { await app.tick(); } finally { Date.now = now; }
  assert.equal(app.requests.length, 3); assert.match(app.$("#scan-status").textContent, /kann noch laufen/);
  assert.equal(app.$("#scan-cancel").disabled, false); assert.equal(app.$("#scan-results").hidden, true);
  assert.equal(app.$("#scan-start").disabled, true);
});
