// Probe 2: dua proses serve (port berbeda) + persistensi target antar-klien.
// Menjawab: (A) apakah 1 klien bisa mengendalikan 2 serve sekaligus dan
// membedakan event-nya; (B) apakah target bertahan setelah klien putus
// sehingga tracer bisa reattach dan melanjutkan sesi yang sama.
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const LP_BIN = process.env.LP_BIN || "/tmp/lp-f5-test/lightpanda";
const HTTP_PORT = 8776;
const PORTS = [9236, 9237];
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

const serves = PORTS.map((port) =>
  spawn(LP_BIN, ["serve", "--host", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
for (const s of serves) {
  s.stderr.on("data", () => {});
  s.stdout.on("data", () => {});
}

async function waitForVersion(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`serve ${port} tidak siap`);
}

class Client {
  constructor(url) {
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

async function attachAndNavigate(port, url) {
  const c = new Client(`ws://127.0.0.1:${port}/`);
  await c.open;
  await c.send("Target.setDiscoverTargets", { discover: true });
  const t = await c.send("Target.createTarget", { url: "about:blank" });
  const a = await c.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const s = a.sessionId;
  await c.send("Page.enable", {}, s);
  await c.send("Network.enable", {}, s);
  await c.send("Runtime.enable", {}, s);
  await c.send("Page.navigate", { url }, s);
  return { client: c, targetId: t.targetId, sessionId: s };
}

try {
  const v = await waitForVersion(PORTS[0]);
  result.version = v["Lightpanda-Version"] ?? "?";
  await waitForVersion(PORTS[1]);

  // --- A: dua serve sekaligus dari satu klien pengendali ---
  const e1 = await attachAndNavigate(PORTS[0], `http://127.0.0.1:${HTTP_PORT}/a.html`);
  const e2 = await attachAndNavigate(PORTS[1], `http://127.0.0.1:${HTTP_PORT}/b.html`);
  await sleep(2500);
  const href = async (e) =>
    (
      await e.client.send(
        "Runtime.evaluate",
        { expression: "location.href", returnByValue: true },
        e.sessionId,
      )
    ).result?.result?.value ?? null;
  result.steps.twoServes = {
    target1: e1.targetId,
    target2: e2.targetId,
    session1: e1.sessionId,
    session2: e2.sessionId,
    events1: e1.client.events.length,
    events2: e2.client.events.length,
    frameNav1: e1.client.events.filter((x) => x.method === "Page.frameNavigated").length,
    frameNav2: e2.client.events.filter((x) => x.method === "Page.frameNavigated").length,
    href1: await href(e1),
    href2: await href(e2),
  };

  // --- B: klien pertama putus, klien baru reattach ke target yang sama ---
  const target1 = e1.targetId;
  e1.client.close();
  e2.client.close();
  await sleep(800);
  const c3 = new Client(`ws://127.0.0.1:${PORTS[0]}/`);
  await c3.open;
  try {
    const list = await c3.send("Target.getTargets");
    result.steps.targetsAfterDisconnect = (list.targetInfos ?? []).map((t) => ({
      targetId: t.targetId,
      url: t.url,
      title: t.title,
    }));
    const a = await c3.send("Target.attachToTarget", { targetId: target1, flatten: true });
    result.steps.reattach = { ok: true, sessionId: a.sessionId };
    const ev = await c3.send(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      a.sessionId,
    );
    result.steps.reattachedTitle = ev.result?.result?.value ?? null;
  } catch (e) {
    result.steps.reattach = { ok: false, error: String(e.message) };
    result.errors.push(`reattach: ${e.message}`);
  }
  c3.close();
} catch (e) {
  result.errors.push(`fatal: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  for (const s of serves) {
    try {
      s.kill("SIGTERM");
    } catch {}
  }
  server.close();
  writeFileSync("/tmp/lp-ms/result2.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
