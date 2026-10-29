// run-live-tests.mjs — Uji live mode (SSE) + record/replay (LIVE-DESIGN.md).
// Uji unit memakai dist/ yang sudah di-build; uji e2e memakai server CDP
// palsu yang menerima handshake; satu bagian live memakai Lightpanda
// 1.0.2 sungguhan dan dilewati bila binary tidak ditemukan.
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_A_PORT = Number(process.env.LIVE_FAKE_A_PORT || 9252);
const FAKE_B_PORT = Number(process.env.LIVE_FAKE_B_PORT || 9253);
const LIVE_PORT = Number(process.env.LIVE_PORT || 9251);
const SERVE_PORT = Number(process.env.LIVE_SERVE_PORT || 9254);
const HTTP_PORT = Number(process.env.LIVE_HTTP_PORT || 8782);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
let passed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function runToCompletion(argv, { env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function readRows(file) {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// --- Server CDP palsu: terima handshake; tiap Page.navigate memancarkan
// frameNavigated + `requestsPerNavigate` Network.requestWillBeSent. ---
function startFakeCdp(port, opts = {}) {
  const { requestsPerNavigate = 1 } = opts;
  const sockets = new Set();
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ Browser: "Lightpanda/1.0.2", "Lightpanda-Version": "1.0.2" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on("upgrade", (req, socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      const key = req.headers["sec-websocket-key"] || "";
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
          accept +
          "\r\n\r\n",
      );
      let buf = Buffer.alloc(0);
      let frag = Buffer.alloc(0);
      // Soket klien boleh putus kapan saja; server uji tidak boleh crash.
      socket.on("error", () => {});
      const sendFrame = (opcode, payload) => {
        if (socket.destroyed) return;
        const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        let header;
        if (data.length < 126) {
          header = Buffer.from([0x80 | opcode, data.length]);
        } else if (data.length < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x80 | opcode;
          header[1] = 126;
          header.writeUInt16BE(data.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x80 | opcode;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt(data.length), 2);
        }
        try {
          socket.write(Buffer.concat([header, data]));
        } catch {
          /* soket sudah putus: abaikan */
        }
      };
      const emit = (method, params) => {
        sendFrame(1, JSON.stringify({ method, params, sessionId: "SID-1" }));
      };
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) break;
          const b0 = buf[0];
          const b1 = buf[1];
          const fin = (b0 & 0x80) !== 0;
          const op = b0 & 0x0f;
          let len = b1 & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) break;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          const masked = (b1 & 0x80) !== 0;
          let maskKey = null;
          if (masked) {
            if (buf.length < off + 4) break;
            maskKey = buf.subarray(off, off + 4);
            off += 4;
          }
          if (buf.length < off + len) break;
          let payload = buf.subarray(off, off + len);
          if (maskKey) {
            payload = Buffer.from(payload);
            for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
          }
          buf = buf.subarray(off + len);
          if (op === 9) {
            sendFrame(0xa, payload);
            continue;
          }
          if (op === 8) {
            socket.end();
            continue;
          }
          frag = Buffer.concat([frag, payload]);
          if (!fin) continue;
          const text = frag.toString("utf8");
          frag = Buffer.alloc(0);
          let msg;
          try {
            msg = JSON.parse(text);
          } catch {
            continue;
          }
          const reply = (obj) => sendFrame(1, JSON.stringify(obj));
          if (msg.method === "Target.setDiscoverTargets") {
            reply({ id: msg.id, result: {} });
          } else if (msg.method === "Target.getTargets") {
            reply({ id: msg.id, result: { targetInfos: [] } });
          } else if (msg.method === "Target.createTarget") {
            reply({ id: msg.id, result: { targetId: "FID-FAKE" } });
          } else if (msg.method === "Target.attachToTarget") {
            reply({ id: msg.id, result: { sessionId: "SID-1" } });
          } else if (msg.method === "Page.navigate") {
            const url = msg.params?.url;
            reply({ id: msg.id, result: {} });
            setTimeout(() => {
              emit("Page.frameNavigated", { frame: { url } });
              for (let k = 0; k < requestsPerNavigate; k++) {
                emit("Network.requestWillBeSent", {
                  requestId: `REQ-${k}`,
                  request: { url, method: "GET" },
                  type: "Document",
                });
              }
            }, 30);
          } else {
            reply({ id: msg.id, result: {} });
          }
        }
      });
    });
    server.listen(port, "127.0.0.1", () =>
      resolve({
        url: `ws://127.0.0.1:${port}`,
        close: () =>
          new Promise((res2) => {
            for (const s of sockets) {
              try {
                s.destroy();
              } catch {}
            }
            server.close(() => res2());
          }),
      }),
    );
  });
}

/** Kumpulkan event SSE sampai session_ended diterima atau timeout. */
async function collectSse(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data !== "") events.push({ event, data });
        if (event === "message") {
          try {
            const row = JSON.parse(data);
            if (row.type === "tracer.session_ended") {
              try {
                await reader.cancel();
              } catch {}
              clearTimeout(timer);
              return events;
            }
          } catch {}
        }
      }
    }
  } catch {
    // Abort/timeout: kembalikan apa yang terkumpul.
  } finally {
    clearTimeout(timer);
  }
  return events;
}

async function findLightpanda() {
  if (process.env.LP_BIN) return process.env.LP_BIN;
  const onPath = await new Promise((resolve) => {
    execFile("which", ["lightpanda"], (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
  if (onPath) return onPath;
  for (const fallback of ["/tmp/lp-m1/lightpanda", "/tmp/lp-f5-test/lightpanda"]) {
    try {
      await stat(fallback);
      return fallback;
    } catch {}
  }
  return null;
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), "live-test-"));
  console.log(`Uji live + replay — workdir ${workDir}`);

  console.log("== build ==");
  const build = await runToCompletion([join(ROOT, "node_modules", ".bin", "tsc")], {
    timeoutMs: 120000,
  });
  check("build tsc bersih (exit 0)", build.code === 0, build.stderr.slice(0, 300));

  const cli = join(ROOT, "dist", "cli.js");
  const { extractReplaySteps, groupRequestsByStep, safeHost } = await import("../dist/replay.js");

  // --- Uji 1: unit ekstraksi langkah ---
  console.log("== uji 1: extractReplaySteps ==");
  const mkNav = (url, parentId) => ({
    type: "Page.frameNavigated",
    data: { frame: { url, ...(parentId ? { parentId } : {}) } },
  });
  check(
    "uji 1a urutan + buang about:blank + gabung duplikat berurutan",
    JSON.stringify(
      extractReplaySteps([
        mkNav("about:blank"),
        mkNav("http://127.0.0.1:1/a.html"),
        mkNav("http://127.0.0.1:1/a.html"),
        mkNav("http://127.0.0.1:1/b.html"),
        mkNav("http://127.0.0.1:1/a.html"),
      ]),
    ) ===
      JSON.stringify([
        "http://127.0.0.1:1/a.html",
        "http://127.0.0.1:1/b.html",
        "http://127.0.0.1:1/a.html",
      ]),
  );
  check(
    "uji 1b sub-frame (parentId) diabaikan, fallback data.url dipakai",
    JSON.stringify(
      extractReplaySteps([
        mkNav("http://127.0.0.1:1/frame.html", "PARENT-1"),
        { type: "Page.frameNavigated", data: { url: "http://127.0.0.1:1/fallback.html" } },
      ]),
    ) === JSON.stringify(["http://127.0.0.1:1/fallback.html"]),
  );
  check("uji 1c tanpa navigasi -> langkah kosong", extractReplaySteps([]).length === 0);
  check("uji 1d safeHost", safeHost("http://127.0.0.1:9/x?q=1") === "127.0.0.1:9" && safeHost("bukan url") === null);

  // --- Uji 2: unit pengelompokan per jendela ---
  console.log("== uji 2: groupRequestsByStep ==");
  const grouped = groupRequestsByStep([
    { type: "Network.requestWillBeSent", data: { request: { url: "http://127.0.0.1:1/pre.html" } } },
    mkNav("http://127.0.0.1:1/a.html"),
    { type: "Network.requestWillBeSent", data: { request: { url: "http://127.0.0.1:1/a.html" } } },
    { type: "Network.requestWillBeSent", data: { request: { url: "http://h.test/a.css" } } },
    mkNav("http://127.0.0.1:1/b.html"),
    { type: "Network.requestWillBeSent", data: { request: { url: "http://127.0.0.1:1/b.html" } } },
  ]);
  check(
    "uji 2 jendela + host + total",
    grouped.totalRequests === 4 &&
      grouped.windows.length === 2 &&
      grouped.windows[0].requests === 2 &&
      grouped.windows[0].hosts.length === 2 &&
      grouped.windows[1].requests === 1,
    JSON.stringify(grouped),
  );

  // --- Uji 3: SSE + health + CORS (server palsu) ---
  console.log("== uji 3: SSE live ==");
  const fakeA = await startFakeCdp(FAKE_A_PORT, { requestsPerNavigate: 1 });
  const out3 = join(workDir, "live.jsonl");
  const child = spawn("node", [
    cli,
    "--cdp",
    fakeA.url,
    "--output",
    out3,
    "--session",
    "live-1",
    "--live-port",
    String(LIVE_PORT),
    "--navigate",
    "http://127.0.0.1:1/a.html",
    "--navigate",
    "http://127.0.0.1:1/b.html",
    "--wait-ms",
    "1500",
    "--stay",
  ]);
  let childStderr = "";
  child.stderr.on("data", (d) => {
    childStderr += d;
  });
  try {
    // Tunggu /health menjawab.
    let health = null;
    for (let i = 0; i < 30 && health === null; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${LIVE_PORT}/health`);
        if (res.ok) health = await res.json();
      } catch {}
      if (health === null) await sleep(200);
    }
    check("uji 3a /health menjawab", health !== null && health.session === "live-1", JSON.stringify(health));
    const healthRes = await fetch(`http://127.0.0.1:${LIVE_PORT}/health`);
    check(
      "uji 3b header CORS ada",
      healthRes.headers.get("access-control-allow-origin") === "*",
      healthRes.headers.get("access-control-allow-origin") ?? "null",
    );
    const eventsP = collectSse(`http://127.0.0.1:${LIVE_PORT}/events`, 12000);
    await sleep(2500);
    try {
      child.kill("SIGINT");
    } catch {}
    const events = await eventsP;
    const hello = events.find((e) => e.event === "hello");
    check(
      "uji 3c hello membawa sesi",
      hello !== undefined && JSON.parse(hello.data).session === "live-1",
      JSON.stringify(hello),
    );
    const rows3 = events.filter((e) => e.event === "message").map((e) => JSON.parse(e.data));
    check(
      "uji 3d SSE menerima frameNavigated + session_ended",
      rows3.some((r) => r.type === "Page.frameNavigated") &&
        rows3.some((r) => r.type === "tracer.session_ended"),
      rows3.map((r) => r.type).join(","),
    );
    check(
      "uji 3e baris SSE membawa endpoint/indeks",
      rows3.some((r) => r.type === "Network.requestWillBeSent" && r.endpoint === fakeA.url && r.endpoint_index === 0),
      JSON.stringify(rows3.slice(0, 3)),
    );
    const exitCode = await new Promise((res) => child.on("close", res));
    check("uji 3f tracer keluar 0 setelah SIGINT", exitCode === 0, `code=${exitCode} stderr=${childStderr.slice(0, 200)}`);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {}
    await fakeA.close();
  }

  // --- Uji 4: port live dipakai -> keluar 1, file tidak dibuat ---
  console.log("== uji 4: port live bentrok ==");
  const blocker = http.createServer((req, res) => res.end());
  await new Promise((r) => blocker.listen(LIVE_PORT, "127.0.0.1", r));
  const fakeB = await startFakeCdp(FAKE_B_PORT, {});
  const out4 = join(workDir, "blocked.jsonl");
  const r4 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeB.url,
    "--output",
    out4,
    "--live-port",
    String(LIVE_PORT),
    "--navigate",
    "http://127.0.0.1:1/a.html",
  ]);
  check(
    "uji 4 keluar bukan nol dan menyebut port",
    r4.code !== 0 && /9229|9251|port/.test(r4.stderr),
    `code=${r4.code} stderr=${r4.stderr.slice(0, 200)}`,
  );
  let out4Exists = true;
  try {
    await stat(out4);
  } catch {
    out4Exists = false;
  }
  check("uji 4 file trace tidak dibuat", out4Exists === false);
  blocker.close();
  await fakeB.close();

  // --- Uji 5: replay cocok (server palsu deterministik) ---
  console.log("== uji 5: replay cocok ==");
  const fakeC = await startFakeCdp(FAKE_A_PORT, { requestsPerNavigate: 1 });
  const orig5 = join(workDir, "orig.jsonl");
  const r5a = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeC.url,
    "--output",
    orig5,
    "--session",
    "rec-1",
    "--navigate",
    "http://127.0.0.1:1/a.html",
    "--navigate",
    "http://127.0.0.1:1/b.html",
    "--wait-ms",
    "100",
  ]);
  check("uji 5a rekam keluar 0", r5a.code === 0, `code=${r5a.code} stderr=${r5a.stderr.slice(0, 200)}`);
  const replay5 = join(workDir, "replay.jsonl");
  const report5Path = join(workDir, "report5.json");
  const r5b = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeC.url,
    "--output",
    replay5,
    "--replay",
    orig5,
    "--replay-report",
    report5Path,
    "--wait-ms",
    "100",
  ]);
  check("uji 5b replay keluar 0", r5b.code === 0, `code=${r5b.code} stderr=${r5b.stderr.slice(0, 300)}`);
  const report5 = JSON.parse(r5b.stdout);
  check(
    "uji 5c laporan cocok 2 langkah",
    report5.match === true &&
      report5.steps.length === 2 &&
      report5.steps.every((s) => s.originalRequests === 1 && s.replayRequests === 1),
    r5b.stdout.slice(0, 400),
  );
  const report5File = JSON.parse(await readFile(report5Path, "utf8"));
  check("uji 5d file laporan sama dengan stdout", JSON.stringify(report5File) === JSON.stringify(report5));
  const replayRows5 = await readRows(replay5);
  check(
    "uji 5e sesi replay berawalan replay-",
    replayRows5[0].session === "replay-rec-1",
    replayRows5[0]?.session,
  );
  await fakeC.close();

  // --- Uji 6: replay tidak cocok (jumlah request berbeda) ---
  console.log("== uji 6: replay tidak cocok ==");
  const fakeD = await startFakeCdp(FAKE_B_PORT, { requestsPerNavigate: 2 });
  const replay6 = join(workDir, "replay6.jsonl");
  const r6 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeD.url,
    "--output",
    replay6,
    "--replay",
    orig5,
    "--wait-ms",
    "100",
  ]);
  check("uji 6a replay keluar 0 walau tidak cocok", r6.code === 0, `code=${r6.code} stderr=${r6.stderr.slice(0, 200)}`);
  const report6 = JSON.parse(r6.stdout);
  check(
    "uji 6b laporan TIDAK COCOK dan menyebut langkah",
    report6.match === false && report6.steps.some((s) => s.originalRequests === 1 && s.replayRequests === 2),
    r6.stdout.slice(0, 300),
  );
  await fakeD.close();

  // --- Uji 7: validasi replay ---
  console.log("== uji 7: validasi replay ==");
  const fakeE = await startFakeCdp(FAKE_A_PORT, {});
  const r7a = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeE.url,
    "--output",
    join(workDir, "x.jsonl"),
    "--replay",
    orig5,
    "--navigate",
    "http://127.0.0.1:1/a.html",
  ]);
  check("uji 7a replay + navigate -> keluar 2", r7a.code === 2, `code=${r7a.code}`);
  const r7b = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeE.url,
    "--cdp",
    fakeE.url,
    "--output",
    join(workDir, "x.jsonl"),
    "--replay",
    orig5,
  ]);
  check("uji 7b replay + 2 cdp -> keluar 2", r7b.code === 2, `code=${r7b.code}`);
  const r7c = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeE.url,
    "--output",
    join(workDir, "x.jsonl"),
    "--replay",
    join(workDir, "tidak-ada.jsonl"),
  ]);
  check(
    "uji 7c file replay hilang -> keluar bukan nol",
    r7c.code !== 0 && /replay gagal membaca/.test(r7c.stderr),
    `code=${r7c.code} stderr=${r7c.stderr.slice(0, 200)}`,
  );
  const emptyTrace = join(workDir, "kosong.jsonl");
  await writeFile(emptyTrace, '{"ts":"2026-10-29T07:00:00.000Z","mono_ms":0,"seq":1,"session":"s","lightpanda_version":"1.0.2","type":"tracer.session_started","data":{}}\n', "utf8");
  const r7d = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeE.url,
    "--output",
    join(workDir, "x.jsonl"),
    "--replay",
    emptyTrace,
  ]);
  check(
    "uji 7d tanpa navigasi -> keluar bukan nol",
    r7d.code !== 0 && /tidak ada navigasi/.test(r7d.stderr),
    `code=${r7d.code} stderr=${r7d.stderr.slice(0, 200)}`,
  );
  await fakeE.close();

  // --- Uji 8 (live): Lightpanda sungguhan — SSE + replay ---
  console.log("== uji 8: live SSE + replay ==");
  const lpBin = await findLightpanda();
  if (!lpBin) {
    console.log("  SKIP uji 8: binary Lightpanda tidak ditemukan (LP_BIN/PATH/tmp).");
  } else {
    const httpServer = http.createServer((req, res) => {
      const title = req.url.includes("/b.html") ? "Halaman B" : "Halaman A";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`);
    });
    await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
    const serve = spawn(lpBin, ["serve", "--host", "127.0.0.1", "--port", String(SERVE_PORT)], {
      env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = async () => {
      const d = Date.now() + 15000;
      while (Date.now() < d) {
        try {
          const res = await fetch(`http://127.0.0.1:${SERVE_PORT}/json/version`);
          if (res.ok) return true;
        } catch {}
        await sleep(300);
      }
      return false;
    };
    check("uji 8 serve siap", await ready());
    const cdp = `ws://127.0.0.1:${SERVE_PORT}`;
    const out8 = join(workDir, "live-real.jsonl");
    const child8 = spawn("node", [
      cli,
      "--cdp",
      cdp,
      "--output",
      out8,
      "--session",
      "live-real",
      "--live-port",
      String(LIVE_PORT),
      "--navigate",
      `http://127.0.0.1:${HTTP_PORT}/a.html`,
      "--navigate",
      `http://127.0.0.1:${HTTP_PORT}/b.html`,
      "--wait-ms",
      "1500",
      "--stay",
    ]);
    child8.stderr.resume();
    try {
      let health8 = null;
      for (let i = 0; i < 30 && health8 === null; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${LIVE_PORT}/health`);
          if (res.ok) health8 = await res.json();
        } catch {}
        if (health8 === null) await sleep(200);
      }
      check("uji 8a /health live menjawab", health8 !== null, JSON.stringify(health8));
      const events8P = collectSse(`http://127.0.0.1:${LIVE_PORT}/events`, 12000);
      await sleep(2500);
      try {
        child8.kill("SIGINT");
      } catch {}
      const events8 = await events8P;
      const rows8 = events8.filter((e) => e.event === "message").map((e) => JSON.parse(e.data));
      check(
        "uji 8b SSE live menerima navigasi + session_ended",
        rows8.some((r) => r.type === "Page.frameNavigated" && r.data.frame?.url?.endsWith("/b.html")) &&
          rows8.some((r) => r.type === "tracer.session_ended"),
        rows8.map((r) => r.type).join(","),
      );
      const exit8 = await new Promise((res) => child8.on("close", res));
      check("uji 8c tracer live keluar 0", exit8 === 0, `code=${exit8}`);
      const replay8 = join(workDir, "replay-real.jsonl");
      const r8 = await runToCompletion([
        "node",
        cli,
        "--cdp",
        cdp,
        "--output",
        replay8,
        "--replay",
        out8,
        "--wait-ms",
        "500",
      ]);
      check("uji 8d replay live keluar 0", r8.code === 0, `code=${r8.code} stderr=${r8.stderr.slice(0, 300)}`);
      const report8 = JSON.parse(r8.stdout);
      check(
        "uji 8e replay 2 halaman lokal COCOK",
        report8.match === true && report8.steps.length === 2,
        r8.stdout.slice(0, 400),
      );
    } finally {
      try {
        child8.kill("SIGKILL");
      } catch {}
      try {
        serve.kill("SIGTERM");
      } catch {}
      httpServer.close();
    }
  }

  console.log(`\nUji live+replay: ${passed} lulus, ${failures.length} gagal.`);
  if (failures.length > 0) {
    console.log(`Gagal: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
