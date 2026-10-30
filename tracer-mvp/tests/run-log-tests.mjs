// run-log-tests.mjs — Uji domain Log (LOG-DESIGN.md).
// Server CDP palsu (pola run-ms-tests.mjs) + satu bagian live memakai
// Lightpanda 1.0.2 sungguhan, dilewati bila binary tidak ditemukan.
// Build (tsc) dijalankan dulu oleh skrip ini.
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_PORT = Number(process.env.LOG_FAKE_PORT || 9245);
const SERVE_PORT = Number(process.env.LOG_SERVE_PORT || 9246);
const HTTP_PORT = Number(process.env.LOG_HTTP_PORT || 8782);

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

// --- Server CDP palsu (menerima handshake; dapat menolak satu method) ---
function startFakeCdp(port, opts = {}) {
  const { failMethod = null, emitLog = true } = opts;
  const sockets = new Set();
  let emitFn = null;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            Browser: "Lightpanda/1.0.2",
            "Lightpanda-Version": "1.0.2",
            "Protocol-Version": "1.3",
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on("upgrade", (req, socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
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
        } catch {}
      };
      const emit = (method, params) => {
        sendFrame(1, JSON.stringify({ method, params, sessionId: "SID-1" }));
      };
      emitFn = emit;
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
          if (msg.method === failMethod) {
            reply({ id: msg.id, error: { code: -32000, message: `fake ${failMethod} failed` } });
          } else if (msg.method === "Target.setDiscoverTargets") {
            reply({ id: msg.id, result: {} });
          } else if (msg.method === "Target.getTargets") {
            reply({ id: msg.id, result: { targetInfos: [] } });
          } else if (msg.method === "Target.createTarget") {
            reply({ id: msg.id, result: { targetId: "FID-FAKE" } });
          } else if (msg.method === "Target.attachToTarget") {
            reply({ id: msg.id, result: { sessionId: "SID-1" } });
            if (emitLog) {
              setTimeout(() => {
                emit("Network.requestWillBeSent", {
                  requestId: "REQ-LOG-1",
                  request: { url: "http://127.0.0.1:9/log-fetch", method: "GET" },
                  type: "Fetch",
                });
                emit("Network.loadingFailed", {
                  requestId: "REQ-LOG-1",
                  timestamp: 100,
                  type: "Fetch",
                  errorText: "CouldntConnect",
                  canceled: false,
                });
                emit("Log.entryAdded", {
                  entry: {
                    source: "network",
                    level: "error",
                    text: "Failed to load resource: net::ERR_CONNECTION_REFUSED — see http://127.0.0.1:9/log-fetch?token=SECRET123&x=1 " + "p".repeat(5000),
                    timestamp: Date.now(),
                    url: "http://127.0.0.1:9/log-fetch?token=SECRET123",
                    networkRequestId: "REQ-LOG-1",
                  },
                });
              }, 50);
            }
          } else {
            reply({ id: msg.id, result: {} });
          }
        }
      });
    });
    server.listen(port, "127.0.0.1", () =>
      resolve({
        url: `ws://127.0.0.1:${port}`,
        emit: (method, params) => emitFn?.(method, params),
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

async function findLightpanda() {
  if (process.env.LP_BIN) return process.env.LP_BIN;
  const onPath = await new Promise((resolve) => {
    execFile("which", ["lightpanda"], (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
  if (onPath) return onPath;
  for (const fallback of [join(ROOT, "vendor", "lightpanda"), "/tmp/lp-m1/lightpanda"]) {
    try {
      await stat(fallback);
      return fallback;
    } catch {}
  }
  return null;
}

async function main() {
  await new Promise((resolve, reject) => {
    execFile(join(ROOT, "node_modules", ".bin", "tsc"), { cwd: ROOT }, (err) => {
      if (err) reject(new Error("build tsc gagal"));
      else resolve();
    });
  });
  const { redactEvent } = await import("../dist/redact.js");
  const cli = [process.execPath, join(ROOT, "dist", "cli.js")];

  console.log("== uji Log: redaksi generik pada payload Log.entryAdded ==");
  const redacted = redactEvent(
    "Log.entryAdded",
    {
      entry: {
        source: "network",
        level: "error",
        text: "lihat http://x.test/?token=SECRET123 " + "q".repeat(5000),
        timestamp: 1793325895443,
        url: "http://127.0.0.1:9/a?api_key=SECRET123",
        networkRequestId: "REQ-LOG-1",
      },
    },
    { includeBodies: false },
  );
  const entryText = redacted.entry.text;
  check("Log teks: parameter token tersensor", !String(entryText).includes("SECRET123"), String(entryText).slice(0, 120));
  check(
    "Log teks: terpotong 4096 + penanda",
    String(entryText).length <= 4108 && String(entryText).endsWith("…[truncated]"),
    `len=${String(entryText).length}`,
  );
  check("Log url: api_key tersensor, host utuh", String(redacted.entry.url).includes("127.0.0.1") && !String(redacted.entry.url).includes("SECRET123"), String(redacted.entry.url));
  check("Log networkRequestId dipertahankan", redacted.entry.networkRequestId === "REQ-LOG-1");
  check("Log timestamp dipertahankan", redacted.entry.timestamp === 1793325895443);

  console.log("== uji Log: server palsu — entri tercatat + Log.enable ditolak = fatal ==");
  const workDir = await mkdtemp(join(tmpdir(), "log-test-"));
  const fake = await startFakeCdp(FAKE_PORT);
  try {
    const trace1 = join(workDir, "trace1.jsonl");
    const r1 = await runToCompletion([
      ...cli,
      "--cdp",
      fake.url,
      "--output",
      trace1,
      "--session",
      "log-fake",
      "--navigate",
      "http://127.0.0.1:1/fake.html",
      "--wait-ms",
      "1200",
    ]);
    check("Log fake: tracer keluar 0", r1.code === 0, `code=${r1.code} stderr=${r1.stderr.slice(0, 200)}`);
    const rows1 = await readRows(trace1);
    const logRows = rows1.filter((r) => r.type === "Log.entryAdded");
    check("Log fake: 1 baris Log.entryAdded", logRows.length === 1, `ditemukan ${logRows.length}`);
    check(
      "Log fake: source/level network/error",
      logRows[0]?.data?.entry?.source === "network" && logRows[0]?.data?.entry?.level === "error",
      JSON.stringify(logRows[0]?.data),
    );
    check(
      "Log fake: networkRequestId cocok dengan loadingFailed",
      rows1.some((r) => r.type === "Network.loadingFailed" && r.data?.requestId === logRows[0]?.data?.entry?.networkRequestId),
    );
    check("Log fake: teks tersensor + terpotong", !JSON.stringify(logRows[0]).includes("SECRET123") && String(logRows[0]?.data?.entry?.text).length <= 4108 && String(logRows[0]?.data?.entry?.text).endsWith("…[truncated]"));
    check("Log fake: endpoint tercatat", logRows[0]?.endpoint === fake.url && logRows[0]?.endpoint_index === 0);
  } finally {
    await fake.close();
  }

  const fakeFail = await startFakeCdp(FAKE_PORT, { failMethod: "Log.enable", emitLog: false });
  try {
    const trace2 = join(workDir, "trace2.jsonl");
    const r2 = await runToCompletion([
      ...cli,
      "--cdp",
      fakeFail.url,
      "--output",
      trace2,
      "--session",
      "log-fake-fail",
      "--navigate",
      "http://127.0.0.1:1/fake.html",
      "--wait-ms",
      "500",
    ]);
    check("Log fake: Log.enable ditolak -> keluar 1", r2.code === 1, `code=${r2.code}`);
    check("Log fake: stderr menyebut Log.enable", r2.stderr.includes("Log.enable"), r2.stderr.slice(0, 200));
  } finally {
    await fakeFail.close();
  }

  console.log("== uji Log: live Lightpanda 1.0.2 ==");
  const lpBin = await findLightpanda();
  if (lpBin === null) {
    console.log("  LEWATI: binary Lightpanda 1.0.2 tidak ditemukan (LP_BIN/PATH/vendor).");
  } else {
    const { stdout: verOut } = await new Promise((resolve, reject) => {
      execFile(lpBin, ["version"], (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout).trim() })));
    });
    check("Log live: binary 1.0.2", verOut === "1.0.2", verOut);
    if (verOut === "1.0.2") {
      const httpServer = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>LOG</title><script>
console.log("LOG hello");
fetch("http://127.0.0.1:9/log-live").catch(() => {});
</script>`);
      });
      await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
      const serve = spawn(lpBin, ["serve", "--host", "127.0.0.1", "--port", String(SERVE_PORT)], {
        env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
        stdio: "ignore",
      });
      try {
        const trace3 = join(workDir, "trace3.jsonl");
        const child = spawn(process.execPath, [
          ...cli.slice(1),
          "--cdp",
          `ws://127.0.0.1:${SERVE_PORT}/`,
          "--output",
          trace3,
          "--session",
          "log-live",
          "--stay",
          "--navigate",
          `http://127.0.0.1:${HTTP_PORT}/log.html`,
        ]);
        let childStderr = "";
        child.stderr.on("data", (d) => {
          childStderr += d;
        });
        const exitP = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
        try {
          let seen = false;
          for (let i = 0; i < 40; i++) {
            try {
              const t = await readFile(trace3, "utf8");
              if (t.includes("Log.entryAdded")) {
                seen = true;
                break;
              }
            } catch {}
            await sleep(250);
          }
          check("Log live: Log.entryAdded tertail", seen);
        } finally {
          child.kill("SIGINT");
          const code = await Promise.race([
            exitP,
            sleep(10000).then(() => {
              try {
                child.kill("SIGKILL");
              } catch {}
              return "timeout";
            }),
          ]);
          check("Log live: tracer keluar 0", code === 0, `code=${String(code)} stderr=${childStderr.slice(0, 200)}`);
        }
        const rows3 = await readRows(trace3);
        const logRows = rows3.filter((r) => r.type === "Log.entryAdded");
        check("Log live: >= 1 entri Log", logRows.length >= 1, `ditemukan ${logRows.length}`);
        check(
          "Log live: source network + level error",
          logRows.every((r) => r.data?.entry?.source === "network" && r.data?.entry?.level === "error"),
          JSON.stringify(logRows.map((r) => r.data?.entry)),
        );
        check(
          "Log live: networkRequestId cocok dengan loadingFailed",
          logRows.every((r) =>
            rows3.some((x) => x.type === "Network.loadingFailed" && x.data?.requestId === r.data?.entry?.networkRequestId),
          ),
        );
        check(
          "Log live: consoleAPICalled tetap tercatat (Log bukan pengganti)",
          rows3.some((r) => r.type === "Runtime.consoleAPICalled"),
        );
      } finally {
        serve.kill("SIGKILL");
        httpServer.close();
      }
    }
  }

  console.log(`\nUji Log: ${passed} lulus, ${failures.length} gagal.`);
  if (failures.length > 0) {
    console.log(`GAGAL: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
