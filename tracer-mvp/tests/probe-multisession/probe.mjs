// Probe multi-target + persistensi CDP Lightpanda 1.0.2 (tahap multi-sesi).
// Nol dependensi, WebSocket native Node 24. Menjawab:
//  1. Bisakah 2 target dibuat + di-attach dalam 1 koneksi CDP?
//  2. Apakah event kedua sesi terbedakan lewat sessionId?
//  3. Bisakah klien kedua attach ke target yang sudah ada?
//  4. Apakah target bertahan setelah klien pertama putus (reattach)?
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const LP_BIN = process.env.LP_BIN || "/tmp/lp-f5-test/lightpanda";
const SERVE_PORT = 9235;
const HTTP_PORT = 8775;
const CDP = `ws://127.0.0.1:${SERVE_PORT}/`;
const result = { version: null, steps: {}, errors: [] };

const pages = {
  "/a.html":
    "<!doctype html><html><head><title>Halaman A</title></head><body><h1>A</h1></body></html>",
  "/b.html":
    "<!doctype html><html><head><title>Halaman B</title></head><body><h1>B</h1></body></html>",
};
const server = http.createServer((req, res) => {
  const body = pages[req.url];
  if (body === undefined) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(body);
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));

const serve = spawn(LP_BIN, ["serve", "--host", "127.0.0.1", "--port", String(SERVE_PORT)], {
  env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
serve.stderr.on("data", () => {});
serve.stdout.on("data", () => {});

async function waitForVersion() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${SERVE_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("serve tidak siap");
}

class Client {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ws = new WebSocket(url);
    this.open = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`));
        else resolve(msg.result ?? {});
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const versionBody = await waitForVersion();
  result.version = versionBody["Lightpanda-Version"] ?? JSON.stringify(versionBody);

  // --- Klien 1: dua target dalam satu koneksi ---
  const c1 = new Client(CDP);
  await c1.open;
  await c1.send("Target.setDiscoverTargets", { discover: true });
  const before = await c1.send("Target.getTargets");
  result.steps.targetsBefore = (before.targetInfos ?? []).length;

  let t1 = null;
  let t2 = null;
  try {
    t1 = await c1.send("Target.createTarget", { url: "about:blank" });
    result.steps.createTarget1 = { ok: true, targetId: t1.targetId };
  } catch (e) {
    result.steps.createTarget1 = { ok: false, error: String(e.message) };
    result.errors.push(`createTarget1: ${e.message}`);
  }
  try {
    t2 = await c1.send("Target.createTarget", { url: "about:blank" });
    result.steps.createTarget2 = { ok: true, targetId: t2.targetId };
  } catch (e) {
    result.steps.createTarget2 = { ok: false, error: String(e.message) };
    result.errors.push(`createTarget2: ${e.message}`);
  }

  let s1 = null;
  let s2 = null;
  if (t1?.targetId) {
    try {
      const a = await c1.send("Target.attachToTarget", { targetId: t1.targetId, flatten: true });
      s1 = a.sessionId;
      result.steps.attach1 = { ok: true, sessionId: s1 };
    } catch (e) {
      result.steps.attach1 = { ok: false, error: String(e.message) };
      result.errors.push(`attach1: ${e.message}`);
    }
  }
  if (t2?.targetId) {
    try {
      const a = await c1.send("Target.attachToTarget", { targetId: t2.targetId, flatten: true });
      s2 = a.sessionId;
      result.steps.attach2 = { ok: true, sessionId: s2 };
    } catch (e) {
      result.steps.attach2 = { ok: false, error: String(e.message) };
      result.errors.push(`attach2: ${e.message}`);
    }
  }

  if (s1 && s2) {
    for (const s of [s1, s2]) {
      await c1.send("Page.enable", {}, s);
      await c1.send("Network.enable", {}, s);
      await c1.send("Runtime.enable", {}, s);
    }
    await c1.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/a.html` }, s1);
    await c1.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/b.html` }, s2);
    await sleep(2500);
    const ev1 = c1.events.filter((e) => e.sessionId === s1);
    const ev2 = c1.events.filter((e) => e.sessionId === s2);
    const count = (evs, m) => evs.filter((e) => e.method === m).length;
    result.steps.twoSessions = {
      eventsS1: ev1.length,
      eventsS2: ev2.length,
      frameNavigatedS1: count(ev1, "Page.frameNavigated"),
      frameNavigatedS2: count(ev2, "Page.frameNavigated"),
      requestS1: count(ev1, "Network.requestWillBeSent"),
      requestS2: count(ev2, "Network.requestWillBeSent"),
    };
    const eval1 = await c1.send(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      s1,
    );
    const eval2 = await c1.send(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      s2,
    );
    result.steps.locations = {
      s1: eval1.result?.result?.value ?? null,
      s2: eval2.result?.result?.value ?? null,
    };

    // --- Klien 2: attach ke target yang sudah ada (persistensi antar-klien) ---
    const c2 = new Client(CDP);
    await c2.open;
    const targets2 = await c2.send("Target.getTargets");
    result.steps.targetsSeenByClient2 = (targets2.targetInfos ?? []).map((t) => ({
      targetId: t.targetId,
      url: t.url,
      title: t.title,
    }));
    try {
      const a = await c2.send("Target.attachToTarget", { targetId: t1.targetId, flatten: true });
      result.steps.attachExistingByClient2 = { ok: true, sessionId: a.sessionId };
      const ev = await c2.send(
        "Runtime.evaluate",
        { expression: "location.href", returnByValue: true },
        a.sessionId,
      );
      result.steps.existingTargetHref = ev.result?.result?.value ?? null;
    } catch (e) {
      result.steps.attachExistingByClient2 = { ok: false, error: String(e.message) };
      result.errors.push(`attachExisting: ${e.message}`);
    }
    c2.close();

    // --- Putuskan klien 1, lalu reattach dari klien 3 ---
    c1.close();
    await sleep(800);
    const c3 = new Client(CDP);
    await c3.open;
    try {
      const targets3 = await c3.send("Target.getTargets");
      result.steps.targetsAfterClient1Closed = (targets3.targetInfos ?? []).map((t) => ({
        targetId: t.targetId,
        url: t.url,
      }));
      const a = await c3.send("Target.attachToTarget", { targetId: t1.targetId, flatten: true });
      result.steps.reattachAfterDisconnect = { ok: true, sessionId: a.sessionId };
      const ev = await c3.send(
        "Runtime.evaluate",
        { expression: "document.title", returnByValue: true },
        a.sessionId,
      );
      result.steps.reattachedTitle = ev.result?.result?.value ?? null;
    } catch (e) {
      result.steps.reattachAfterDisconnect = { ok: false, error: String(e.message) };
      result.errors.push(`reattach: ${e.message}`);
    }
    c3.close();
  }
} catch (e) {
  result.errors.push(`fatal: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  try {
    serve.kill("SIGTERM");
  } catch {}
  server.close();
  writeFileSync("/tmp/lp-ms/result.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
