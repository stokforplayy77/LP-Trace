// Probe domain Log di Lightpanda 1.0.2 (mentah, tanpa tracer).
// Menjawab: bentuk payload Log.entryAdded, sumber/level apa saja yang
// muncul, apakah panggilan console.* juga dicerminkan Log (duplikasi),
// dan arti field timestamp. Dijalankan: node probe.mjs (butuh binary
// Lightpanda 1.0.2 lewat LP_BIN / PATH / vendor/lightpanda).
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

async function findBinary() {
  const candidates = [];
  if (process.env.LP_BIN) candidates.push(process.env.LP_BIN);
  try {
    const { stdout } = await execFileAsync("which", ["lightpanda"]);
    if (stdout.trim()) candidates.push(stdout.trim());
  } catch {}
  candidates.push(join(ROOT, "vendor", "lightpanda"));
  candidates.push("/tmp/lp-m1/lightpanda");
  for (const c of candidates) {
    try {
      const { stdout } = await execFileAsync(c, ["version"]);
      if (stdout.trim() === "1.0.2") return c;
    } catch {}
  }
  throw new Error("binary Lightpanda 1.0.2 tidak ditemukan");
}

const HTTP_PORT = 8791;
const SERVE_PORT = 9251;
const CDP = `ws://127.0.0.1:${SERVE_PORT}/`;

const html = `<!doctype html><title>LOG probe</title><script>
console.log("LOG hello");
console.warn("LOG warn");
console.error("LOG err");
console.debug("LOG debug");
console.info("LOG info");
fetch("http://127.0.0.1:9/log-fetch").catch(() => {});
setTimeout(() => { throw new Error("LOG throw"); }, 100);
setTimeout(() => { Promise.reject(new Error("LOG reject")); }, 200);
</script><img src="http://127.0.0.1:9/log-img.png">`;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

const lpBin = await findBinary();
const serve = spawn(lpBin, ["serve", "--host", "127.0.0.1", "--port", String(SERVE_PORT)], {
  env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
  stdio: "ignore",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idSeq = 1;
const pending = new Map();
const events = [];
let ws;

function send(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const id = idSeq++;
    pending.set(id, { resolve, reject });
    const msg = { id, method, params: params ?? {} };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
}

async function waitForWs(url, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    try {
      const s = new WebSocket(url);
      await new Promise((resolve, reject) => {
        s.onopen = resolve;
        s.onerror = reject;
      });
      return s;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error("timeout menunggu CDP");
      await sleep(200);
    }
  }
}

try {
  ws = await waitForWs(CDP);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  await send("Target.setDiscoverTargets", { discover: true });
  const { targetInfos } = await send("Target.getTargets", {});
  void targetInfos;
  const created = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  for (const m of ["Page.enable", "Network.enable", "Runtime.enable", "Log.enable"]) {
    await send(m, {}, sessionId);
  }
  await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/log.html` }, sessionId);
  await sleep(3000);
  ws.close();

  const byMethod = {};
  for (const e of events) byMethod[e.method] = (byMethod[e.method] ?? 0) + 1;
  const logEntries = events.filter((e) => e.method === "Log.entryAdded");
  const consoleCalls = events.filter((e) => e.method === "Runtime.consoleAPICalled");
  const failed = events.filter((e) => e.method === "Network.loadingFailed");
  const result = {
    binary: lpBin,
    counts: byMethod,
    logEntries: logEntries.map((e) => e.params),
    loadingFailed: failed.map((e) => e.params),
    consoleCalls: consoleCalls.map((e) => ({
      type: e.params.type,
      args: (e.params.args ?? []).map((a) => a.value),
    })),
  };
  await writeFile(join(HERE, "probe-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ counts: byMethod, logCount: logEntries.length }, null, 2));
  for (const e of logEntries) console.log("LOG:", JSON.stringify(e.params));
} finally {
  try { ws?.close(); } catch {}
  serve.kill("SIGKILL");
  httpServer.close();
}
