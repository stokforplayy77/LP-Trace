// Probe 4: apakah klien CDP kedua bisa attach ke target yang SUDAH
// di-attach klien pertama, dan apakah navigasi dari klien kedua
// terlihat oleh klien pertama. (Menentukan driver uji live multi-endpoint.)
import http from "node:http";
import { spawn } from "node:child_process";

const LP_BIN = process.env.LP_BIN || "/tmp/lp-f5-test/lightpanda";
const HTTP_PORT = 8778;
const SERVE_PORT = 9239;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><html><head><title>Probe4</title></head><body><h1>P4</h1></body></html>");
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
const serve = spawn(LP_BIN, ["serve", "--host", "127.0.0.1", "--port", String(SERVE_PORT)], {
  env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
serve.stderr.on("data", () => {});
serve.stdout.on("data", () => {});
async function waitReady() {
  const d = Date.now() + 15000;
  while (Date.now() < d) {
    try {
      const r = await fetch(`http://127.0.0.1:${SERVE_PORT}/json/version`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("serve tidak siap");
}
await waitReady();

function makeClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${SERVE_PORT}/`);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`));
      else resolve(msg.result ?? {});
    } else if (msg.method) events.push(msg);
  };
  const open = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    const p = { id, method, params };
    if (sessionId) p.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(p));
    });
  };
  return {
    open,
    send,
    events,
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
try {
  const a = makeClient();
  await a.open;
  await a.send("Target.setDiscoverTargets", { discover: true });
  const t = await a.send("Target.createTarget", { url: "about:blank" });
  out.targetId = t.targetId;
  const attA = await a.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  out.sessionA = attA.sessionId;
  await a.send("Page.enable", {}, attA.sessionId);
  await a.send("Runtime.enable", {}, attA.sessionId);

  const b = makeClient();
  await b.open;
  try {
    const attB = await b.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    out.secondAttach = { ok: true, sessionId: attB.sessionId };
    await b.send("Page.enable", {}, attB.sessionId);
    await b.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/p4.html` }, attB.sessionId);
    await sleep(2000);
    out.eventsSeenByA = a.events.filter((e) => e.method === "Page.frameNavigated").length;
    out.eventsSeenByB = b.events.filter((e) => e.method === "Page.frameNavigated").length;
    const ev = await b.send(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      attB.sessionId,
    );
    out.titleViaB = ev.result?.result?.value ?? ev.result?.value ?? null;
  } catch (e) {
    out.secondAttach = { ok: false, error: String(e.message) };
  }
  b.close();
  a.close();
} catch (e) {
  out.fatal = String(e.message ?? e);
} finally {
  console.log(JSON.stringify(out, null, 2));
  try {
    serve.kill("SIGTERM");
  } catch {}
  server.close();
  process.exit(0);
}
