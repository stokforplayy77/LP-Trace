// run-error-tests.mjs — Uji kode error terbedakan + retry startup
// (ERROR-DESIGN.md). Uji e2e memakai server CDP palsu yang dapat
// dibuat flaky (gagal koneksi / tolak attach / tutup soket / banjir
// event); satu bagian live memakai Lightpanda 1.0.2 sungguhan.
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_PORT = Number(process.env.ERR_FAKE_PORT || 9262);
const SERVE_PORT = Number(process.env.ERR_SERVE_PORT || 9264);
const HTTP_PORT = Number(process.env.ERR_HTTP_PORT || 8783);

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

function sessionEnded(rows) {
  return rows.find((r) => r.type === "tracer.session_ended");
}

// --- Server CDP palsu dengan mode kegagalan yang dapat diatur. ---
function startFakeCdp(port, opts = {}) {
  const { failConnects = 0, rejectAttach = false, closeAfterMs = 0, burstEvents = 0 } = opts;
  let connects = 0;
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
      connects += 1;
      if (connects <= failConnects) {
        socket.destroy();
        return;
      }
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
      const sendFrame = (opcode, payload) => {
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
        socket.write(Buffer.concat([header, data]));
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
            if (rejectAttach) {
              reply({ id: msg.id, error: { code: -31998, message: "BrowserContextNotLoaded" } });
              return;
            }
            reply({ id: msg.id, result: { sessionId: "SID-1" } });
            if (closeAfterMs > 0) {
              setTimeout(() => {
                try {
                  socket.destroy();
                } catch {}
              }, closeAfterMs);
            }
            if (burstEvents > 0) {
              let n = 0;
              const iv = setInterval(() => {
                n += 1;
                emit("Runtime.consoleAPICalled", {
                  type: "log",
                  args: [{ type: "string", value: `banjir-${n} `.repeat(12) }],
                });
                if (n >= burstEvents) clearInterval(iv);
              }, 5);
            }
          } else if (msg.method === "Page.navigate") {
            reply({ id: msg.id, result: {} });
            setTimeout(() => {
              emit("Page.frameNavigated", { frame: { url: msg.params?.url } });
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
  const workDir = await mkdtemp(join(tmpdir(), "err-test-"));
  console.log(`Uji error + retry — workdir ${workDir}`);
  const cli = join(ROOT, "dist", "cli.js");

  // --- Uji 1: unit errors.ts ---
  console.log("== uji 1: errors.ts ==");
  const { TracerError, formatTracerError } = await import("../dist/errors.js");
  const te = new TracerError("E_HANDSHAKE", "contoh", { step: "Target.attachToTarget" });
  check(
    "uji 1a TracerError membawa kode/detail",
    te.code === "E_HANDSHAKE" && te.details.step === "Target.attachToTarget" && te.name === "TracerError",
  );
  check(
    "uji 1b formatTracerError",
    formatTracerError(te) === "[E_HANDSHAKE] contoh" &&
      formatTracerError(new Error("polos")) === "polos" &&
      formatTracerError("teks") === "teks",
  );

  // --- Uji 2: retry berhasil setelah 2 koneksi gagal ---
  console.log("== uji 2: retry berhasil ==");
  const fake2 = await startFakeCdp(FAKE_PORT, { failConnects: 2 });
  const out2 = join(workDir, "retry-ok.jsonl");
  const r2 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fake2.url,
    "--output",
    out2,
    "--session",
    "err-2",
    "--retry",
    "3",
    "--retry-delay-ms",
    "100",
    "--navigate",
    "http://127.0.0.1:1/a.html",
    "--wait-ms",
    "100",
  ]);
  check("uji 2a keluar 0", r2.code === 0, `code=${r2.code} stderr=${r2.stderr.slice(0, 300)}`);
  check(
    "uji 2b stderr mencatat 2 percobaan ulang",
    (r2.stderr.match(/mencoba lagi/g) || []).length === 2,
    r2.stderr.slice(0, 300),
  );
  const rows2 = await readRows(out2);
  check(
    "uji 2c sesi selesai navigations-done tanpa error",
    sessionEnded(rows2)?.data.reason === "navigations-done" && sessionEnded(rows2)?.data.error === undefined,
    JSON.stringify(sessionEnded(rows2)?.data),
  );
  await fake2.close();

  // --- Uji 3: retry habis -> E_CDP_UNREACHABLE di stderr + session_ended ---
  console.log("== uji 3: retry habis ==");
  const fake3 = await startFakeCdp(FAKE_PORT, { failConnects: 5 });
  const out3 = join(workDir, "retry-habis.jsonl");
  const r3 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fake3.url,
    "--output",
    out3,
    "--session",
    "err-3",
    "--retry",
    "2",
    "--retry-delay-ms",
    "100",
  ]);
  check("uji 3a keluar 1", r3.code === 1, `code=${r3.code}`);
  check(
    "uji 3b stderr [E_CDP_UNREACHABLE] + menyebut handshake + percobaan habis",
    /\[E_CDP_UNREACHABLE\]/.test(r3.stderr) &&
      /handshake/i.test(r3.stderr) &&
      /percobaan koneksi habis/.test(r3.stderr),
    r3.stderr.slice(0, 300),
  );
  const rows3 = await readRows(out3);
  check(
    "uji 3c session_ended membawa error E_CDP_UNREACHABLE + endpoint",
    sessionEnded(rows3)?.data.reason === "handshake-failed" &&
      sessionEnded(rows3)?.data.error?.code === "E_CDP_UNREACHABLE" &&
      sessionEnded(rows3)?.data.error?.endpoint === fake3.url,
    JSON.stringify(sessionEnded(rows3)?.data),
  );
  await fake3.close();

  // --- Uji 4: default tanpa retry pada port mati ---
  console.log("== uji 4: default tanpa retry ==");
  const out4 = join(workDir, "tanpa-retry.jsonl");
  const r4 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    "ws://127.0.0.1:9/",
    "--output",
    out4,
    "--session",
    "err-4",
  ]);
  check("uji 4a keluar 1", r4.code === 1, `code=${r4.code}`);
  check(
    "uji 4b tanpa baris mencoba lagi + tetap menyebut handshake",
    !/mencoba lagi/.test(r4.stderr) && /handshake/i.test(r4.stderr),
    r4.stderr.slice(0, 200),
  );

  // --- Uji 5: attach ditolak -> E_HANDSHAKE, TANPA retry ---
  console.log("== uji 5: attach ditolak ==");
  const fake5 = await startFakeCdp(FAKE_PORT, { rejectAttach: true });
  const out5 = join(workDir, "attach-tolak.jsonl");
  const r5 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fake5.url,
    "--output",
    out5,
    "--session",
    "err-5",
    "--retry",
    "3",
    "--retry-delay-ms",
    "100",
  ]);
  check("uji 5a keluar 1", r5.code === 1, `code=${r5.code}`);
  check(
    "uji 5b [E_HANDSHAKE] + Target.attachToTarget + tanpa mencoba lagi",
    /\[E_HANDSHAKE\]/.test(r5.stderr) &&
      r5.stderr.includes("Target.attachToTarget") &&
      !/mencoba lagi/.test(r5.stderr),
    r5.stderr.slice(0, 300),
  );
  const rows5 = await readRows(out5);
  check(
    "uji 5c session_ended error E_HANDSHAKE",
    sessionEnded(rows5)?.data.error?.code === "E_HANDSHAKE",
    JSON.stringify(sessionEnded(rows5)?.data),
  );
  await fake5.close();

  // --- Uji 6: tutup di tengah sesi -> E_CDP_CLOSED, keluar 0, tanpa retry ---
  console.log("== uji 6: cdp-closed ==");
  const fake6 = await startFakeCdp(FAKE_PORT, { closeAfterMs: 300 });
  const out6 = join(workDir, "closed.jsonl");
  const r6 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fake6.url,
    "--output",
    out6,
    "--session",
    "err-6",
    "--retry",
    "3",
    "--retry-delay-ms",
    "100",
    "--stay",
  ]);
  check("uji 6a keluar 0", r6.code === 0, `code=${r6.code} stderr=${r6.stderr.slice(0, 200)}`);
  check(
    "uji 6b [E_CDP_CLOSED] tanpa mencoba lagi",
    /\[E_CDP_CLOSED\]/.test(r6.stderr) && !/mencoba lagi/.test(r6.stderr),
    r6.stderr.slice(0, 300),
  );
  const rows6 = await readRows(out6);
  check(
    "uji 6c session_ended cdp-closed + error E_CDP_CLOSED",
    sessionEnded(rows6)?.data.reason === "cdp-closed" &&
      sessionEnded(rows6)?.data.error?.code === "E_CDP_CLOSED",
    JSON.stringify(sessionEnded(rows6)?.data),
  );
  await fake6.close();

  // --- Uji 7: banjir event -> limit dengan kode ---
  console.log("== uji 7: batas ukuran ==");
  const fake7 = await startFakeCdp(FAKE_PORT, { burstEvents: 60 });
  const out7 = join(workDir, "limit.jsonl");
  const r7 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fake7.url,
    "--output",
    out7,
    "--session",
    "err-7",
    "--max-bytes",
    "4096",
    "--stay",
  ]);
  check("uji 7a keluar 0", r7.code === 0, `code=${r7.code}`);
  check("uji 7b stderr [E_TRACE_LIMIT]", /\[E_TRACE_LIMIT\]/.test(r7.stderr), r7.stderr.slice(0, 200));
  const rows7 = await readRows(out7);
  check(
    "uji 7c session_ended size-limit + error E_TRACE_LIMIT",
    sessionEnded(rows7)?.data.reason === "size-limit" &&
      sessionEnded(rows7)?.data.error?.code === "E_TRACE_LIMIT",
    JSON.stringify(sessionEnded(rows7)?.data),
  );
  await fake7.close();

  // --- Uji 8: validasi flag + resume ---
  console.log("== uji 8: validasi + resume ==");
  const r8a = await runToCompletion([
    "node",
    cli,
    "--cdp",
    "ws://127.0.0.1:9/",
    "--output",
    join(workDir, "v.jsonl"),
    "--retry",
    "-1",
  ]);
  check("uji 8a --retry -1 -> keluar 2", r8a.code === 2, `code=${r8a.code}`);
  const r8b = await runToCompletion([
    "node",
    cli,
    "--cdp",
    "ws://127.0.0.1:9/",
    "--output",
    join(workDir, "v.jsonl"),
    "--retry-delay-ms",
    "abc",
  ]);
  check("uji 8b --retry-delay-ms abc -> keluar 2", r8b.code === 2, `code=${r8b.code}`);
  const resumeFile = join(workDir, "resume.jsonl");
  await writeFile(
    resumeFile,
    JSON.stringify({
      ts: "2026-10-29T07:00:00.000Z",
      mono_ms: 0,
      seq: 1,
      session: "sesi-A",
      lightpanda_version: "1.0.2",
      type: "tracer.session_started",
      data: {},
    }) + "\n",
    "utf8",
  );
  const r8c = await runToCompletion([
    "node",
    cli,
    "--cdp",
    "ws://127.0.0.1:9/",
    "--output",
    resumeFile,
    "--session",
    "sesi-B",
    "--append",
  ]);
  check(
    "uji 8c resume sesi beda -> keluar 1 + [E_RESUME]",
    r8c.code === 1 && /\[E_RESUME\]/.test(r8c.stderr),
    `code=${r8c.code} stderr=${r8c.stderr.slice(0, 200)}`,
  );

  // --- Uji 9 (live): serve dinyalakan belakangan, retry menyambung ---
  console.log("== uji 9: live retry vs serve terlambat ==");
  const lpBin = await findLightpanda();
  if (!lpBin) {
    console.log("  SKIP uji 9: binary Lightpanda tidak ditemukan (LP_BIN/PATH/tmp).");
  } else {
    const httpServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><head><title>A</title></head><body><h1>A</h1></body></html>");
    });
    await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
    const out9 = join(workDir, "live-retry.jsonl");
    const tracerP = runToCompletion([
      "node",
      cli,
      "--cdp",
      `ws://127.0.0.1:${SERVE_PORT}`,
      "--output",
      out9,
      "--session",
      "err-9",
      "--retry",
      "5",
      "--retry-delay-ms",
      "500",
      "--navigate",
      `http://127.0.0.1:${HTTP_PORT}/a.html`,
      "--wait-ms",
      "200",
    ]);
    await sleep(800);
    const serve = spawn(lpBin, ["serve", "--host", "127.0.0.1", "--port", String(SERVE_PORT)], {
      env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const r9 = await tracerP;
      check("uji 9a tracer keluar 0 setelah serve bangun", r9.code === 0, `code=${r9.code} stderr=${r9.stderr.slice(0, 300)}`);
      check("uji 9b stderr mencatat percobaan ulang", /mencoba lagi/.test(r9.stderr), r9.stderr.slice(0, 200));
      const rows9 = await readRows(out9);
      check(
        "uji 9c navigasi terekam + tanpa error di session_ended",
        rows9.some((r) => r.type === "Page.frameNavigated") &&
          sessionEnded(rows9)?.data.error === undefined,
        JSON.stringify(sessionEnded(rows9)?.data),
      );
    } finally {
      try {
        serve.kill("SIGTERM");
      } catch {}
      httpServer.close();
    }
  }

  console.log(`\nUji error+retry: ${passed} lulus, ${failures.length} gagal.`);
  if (failures.length > 0) {
    console.log(`Gagal: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
