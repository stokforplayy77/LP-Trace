// Probe 5: DUA koneksi WebSocket ke SATU endpoint serve — apakah masing-masing
// bisa createTarget + attach sendiri (multi-target per proses serve,
// satu target per koneksi)? Ini menentukan apakah --cdp yang sama bisa
// diulang untuk multi-sesi.
import http from "node:http";
import { spawn } from "node:child_process";

const LP_BIN = process.env.LP_BIN || "/tmp/lp-f5-test/lightpanda";
const HTTP_PORT = 8779;
const SERVE_PORT = 9240;
const server = http.createServer((req, res) => {
  const title = req.url.includes("/b.html") ? "Halaman B" : "Halaman A";
  const h = req.url.includes("/b.html") ? "B" : "A";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${h}</h1></body></html>`);
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
  const tA = await a.send("Target.createTarget", { url: "about:blank" });
  const attA = await a.send("Target.attachToTarget", { targetId: tA.targetId, flatten: true });
  await a.send("Page.enable", {}, attA.sessionId);
  await a.send("Runtime.enable", {}, attA.sessionId);
  await a.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/a.html` }, attA.sessionId);

  const b = makeClient();
  await b.open;
  let tB = null;
  let attB = null;
  try {
    tB = await b.send("Target.createTarget", { url: "about:blank" });
    out.createTargetB = { ok: true, targetId: tB.targetId };
  } catch (e) {
    out.createTargetB = { ok: false, error: String(e.message) };
  }
  if (tB) {
    try {
      attB = await b.send("Target.attachToTarget", { targetId: tB.targetId, flatten: true });
      out.attachB = { ok: true, sessionId: attB.sessionId };
    } catch (e) {
      out.attachB = { ok: false, error: String(e.message) };
    }
  }
  if (attB) {
    await b.send("Page.enable", {}, attB.sessionId);
    await b.send("Runtime.enable", {}, attB.sessionId);
    await b.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/b.html` }, attB.sessionId);
    await sleep(2000);
    const hrefA = await a.send(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      attA.sessionId,
    );
    const hrefB = await b.send(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      attB.sessionId,
    );
    out.hrefA = hrefA.result?.value ?? null;
    out.hrefB = hrefB.result?.value ?? null;
    out.eventsA = a.events.length;
    out.eventsB = b.events.length;
    out.frameNavA = a.events.filter((e) => e.method === "Page.frameNavigated").length;
    out.frameNavB = b.events.filter((e) => e.method === "Page.frameNavigated").length;
    out.targetIdA = tA.targetId;
    out.targetIdB = tB.targetId;
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
