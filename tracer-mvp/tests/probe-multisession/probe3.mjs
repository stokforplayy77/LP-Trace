// Probe 3 (kecil): bentuk mentah respons Runtime.evaluate + payload frameNavigated.
import http from "node:http";
import { spawn } from "node:child_process";

const LP_BIN = process.env.LP_BIN || "/tmp/lp-f5-test/lightpanda";
const HTTP_PORT = 8777;
const SERVE_PORT = 9238;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><html><head><title>Halaman A</title></head><body><h1>A</h1></body></html>");
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
const ws = new WebSocket(`ws://127.0.0.1:${SERVE_PORT}/`);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
const events = [];
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`));
    else resolve(msg);
  } else if (msg.method) events.push(msg);
};
const send = (method, params = {}, sessionId) => {
  const id = nextId++;
  const p = { id, method, params };
  if (sessionId) p.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(p));
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send("Target.setDiscoverTargets", { discover: true });
const t = await send("Target.createTarget", { url: "about:blank" });
const a = await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true });
const s = a.result.sessionId;
await send("Page.enable", {}, s);
await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/a.html` }, s);
await sleep(2000);
const raw = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, s);
console.log("EVALUATE_RAW:", JSON.stringify(raw));
const fn = events.find((e) => e.method === "Page.frameNavigated");
console.log("FRAMENAV:", JSON.stringify(fn));
try {
  serve.kill("SIGTERM");
} catch {}
server.close();
ws.close();
process.exit(0);
