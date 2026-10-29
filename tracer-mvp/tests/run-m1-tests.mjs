// run-m1-tests.mjs — Uji end-to-end M1 terhadap Lightpanda 1.0.2 sungguhan.
// Keluar bukan nol bila ada pemeriksaan gagal. Menjalankan:
//  1. handshake + skema JSONL,  2. event inti,  3. redaksi,
//  4. kegagalan handshake (port mati + server CDP palsu yang menolak attach),
//  5. SIGINT -> session_ended,  6. benchmark tercatat,  7. batas ukuran.
// Nol dependensi. Binary Lightpanda dicari lewat env LP_BIN, PATH, atau
// /tmp/lp-m1/lightpanda. Build (tsc) dijalankan dulu oleh skrip ini.
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import { createHash } from "node:crypto";
import {
  chmod,
  readFile,
  stat,
  writeFile,
  mkdtemp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVE_PORT = Number(process.env.M1_SERVE_PORT || 9231);
const HTTP_PORT = Number(process.env.M1_HTTP_PORT || 8771);
const FAKE_PORT = Number(process.env.M1_FAKE_PORT || 9239);
const CDP = `ws://127.0.0.1:${SERVE_PORT}`;

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

async function findLightpanda() {
  if (process.env.LP_BIN) return process.env.LP_BIN;
  const onPath = await new Promise((resolve) => {
    execFile("which", ["lightpanda"], (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
  if (onPath) return onPath;
  const fallback = "/tmp/lp-m1/lightpanda";
  try {
    await stat(fallback);
    return fallback;
  } catch {
    return null;
  }
}

function runToCompletion(argv, { env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
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
      reject(new Error(`timeout ${timeoutMs} ms: ${argv.join(" ")}`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function startServe(lpBin, port) {
  const child = spawn(lpBin, ["serve", "--host", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
    stdio: "ignore",
  });
  return child;
}

async function waitForVersion(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* belum siap */
    }
    await sleep(250);
  }
  throw new Error(`serve port ${port} tidak siap`);
}

function kill(child) {
  try {
    child.kill("SIGKILL");
  } catch {}
}

// ---- Halaman uji lokal ----
const SECRET_AUTH = "SECRET_AUTH_TOKEN_9f3a";
const SECRET_URL_TOKEN = "SECRET_URL_TOKEN_7b1c";
const SECRET_API_KEY = "SECRET_API_KEY_4d2e";
const SECRET_BODY = "SECRET_BODY_8e5f";
const LONG_MARKER = "LONGARG-MARKER";

const okHtml = `<!doctype html><html><head><title>m1 ok</title></head><body>
<script>console.log('M1-OK');</script><p>ok</p></body></html>`;
const throwHtml = `<!doctype html><html><head><title>m1 throw</title></head><body>
<script>console.log('M1-LOG'); console.warn('M1-WARN'); console.error('M1-ERROR');</script>
<script>throw new Error('M1-UNCAUGHT-LOAD');</script>
<script>Promise.reject(new Error('M1-UNHANDLED'));</script>
<script>fetch('http://127.0.0.1:9/m1-fail').catch(()=>{});</script>
<p>throw</p></body></html>`;
const secretHtml = `<!doctype html><html><head><title>m1 secret</title></head><body>
<script>
fetch('/echo?token=${SECRET_URL_TOKEN}&api_key=${SECRET_API_KEY}&q=hello', {
  headers: { 'Authorization': 'Bearer ${SECRET_AUTH}' }
}).catch(()=>{});
fetch('/echo', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ${SECRET_AUTH}', 'Content-Type': 'text/plain' },
  body: '${SECRET_BODY}'
}).catch(()=>{});
console.log('${LONG_MARKER}-' + 'A'.repeat(600));
</script><p>secret</p></body></html>`;

function startHttpServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(okHtml);
    } else if (req.url === "/throw.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(throwHtml);
    } else if (req.url === "/secret.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(secretHtml);
    } else if (req.url?.startsWith("/echo")) {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(HTTP_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---- Server CDP palsu: menolak Target.attachToTarget ----
function startFakeCdp(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on("upgrade", (req, socket) => {
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
          if (fin) {
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
              reply({
                id: msg.id,
                error: { code: -32000, message: "fake attach failed" },
              });
            } else {
              reply({ id: msg.id, result: {} });
            }
          }
        }
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function readRows(file) {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), "m1-test-"));
  console.log(`Uji M1 — workdir ${workDir}`);

  // 0. Build.
  console.log("== build ==");
  const build = await runToCompletion(
    [join(ROOT, "node_modules", ".bin", "tsc")],
    { timeoutMs: 120000 },
  );
  check("build tsc bersih (exit 0)", build.code === 0, build.stderr.slice(0, 300));

  const lpBin = await findLightpanda();
  check("binary Lightpanda 1.0.2 ditemukan", lpBin !== null, "set LP_BIN / PATH / /tmp/lp-m1/lightpanda");
  if (!lpBin) throw new Error("binary Lightpanda tidak ditemukan");

  const cli = [process.execPath, join(ROOT, "dist", "cli.js")];
  const httpServer = await startHttpServer();
  const serve = startServe(lpBin, SERVE_PORT);
  try {
    const versionBody = await waitForVersion(SERVE_PORT);
    const version = versionBody["Lightpanda-Version"];
    console.log(`  serve siap, Lightpanda-Version: ${version}`);

    // ---- Uji 1: handshake + skema ----
    console.log("== uji 1: handshake + skema JSONL ==");
    const trace1 = join(workDir, "trace1.jsonl");
    const r1 = await runToCompletion([
      ...cli,
      "--cdp",
      CDP,
      "--output",
      trace1,
      "--session",
      "m1-test-1",
      "--navigate",
      `http://127.0.0.1:${HTTP_PORT}/ok.html`,
      "--navigate",
      `http://127.0.0.1:${HTTP_PORT}/throw.html`,
      "--wait-ms",
      "1200",
    ]);
    check("uji 1 tracer keluar 0", r1.code === 0, `stderr: ${r1.stderr.slice(0, 200)}`);
    const rows1 = await readRows(trace1);
    check("uji 1 seq berurutan dari 1", rows1.every((r, i) => r.seq === i + 1));
    check(
      "uji 1 field skema lengkap di semua baris",
      rows1.every(
        (r) =>
          typeof r.ts === "string" &&
          typeof r.mono_ms === "number" &&
          typeof r.seq === "number" &&
          typeof r.session === "string" &&
          typeof r.lightpanda_version === "string" &&
          typeof r.type === "string" &&
          typeof r.data === "object" &&
          r.data !== null,
      ),
    );
    check("uji 1 session_started pertama", rows1[0].type === "tracer.session_started");
    check("uji 1 session_ended terakhir", rows1[rows1.length - 1].type === "tracer.session_ended");
    check("uji 1 session konsisten", rows1.every((r) => r.session === "m1-test-1"));
    check("uji 1 versi 1.0.2 tercatat", rows1.every((r) => r.lightpanda_version === "1.0.2"));
    check(
      "uji 1 mono_ms tidak menurun",
      rows1.every((r, i) => i === 0 || r.mono_ms >= rows1[i - 1].mono_ms),
    );
    check("uji 1 domain Log tidak dipakai", rows1.every((r) => !r.type.startsWith("Log.")));
    const mode = (await stat(trace1)).mode & 0o777;
    check("uji 1 izin file 0600", mode === 0o600, `mode=${mode.toString(8)}`);

    // ---- Uji 2: event inti ----
    console.log("== uji 2: event inti ==");
    const types = rows1.map((r) => r.type);
    const count = (t) => types.filter((x) => x === t).length;
    check("uji 2 frameNavigated >= 2", count("Page.frameNavigated") >= 2);
    check("uji 2 requestWillBeSent >= 2", count("Network.requestWillBeSent") >= 2);
    check("uji 2 exceptionThrown >= 1", count("Runtime.exceptionThrown") >= 1);
    const exc = rows1.find((r) => r.type === "Runtime.exceptionThrown");
    check(
      "uji 2 exception mengandung M1-UNCAUGHT-LOAD",
      exc !== undefined &&
        JSON.stringify(exc.data).includes("M1-UNCAUGHT-LOAD"),
    );
    const consoleTypes = new Set(
      rows1.filter((r) => r.type === "Runtime.consoleAPICalled").map((r) => r.data.type),
    );
    check("uji 2 konsol log tercatat", consoleTypes.has("log"));
    check('uji 2 konsol warning tercatat (CDP: "warning")', consoleTypes.has("warning"));
    check("uji 2 konsol error tercatat", consoleTypes.has("error"));
    const failed = rows1.find((r) => r.type === "Network.loadingFailed");
    check(
      "uji 2 loadingFailed CouldntConnect",
      failed !== undefined && failed.data.errorText === "CouldntConnect",
    );

    // ---- Uji 3: redaksi ----
    console.log("== uji 3: redaksi ==");
    const trace3 = join(workDir, "trace3.jsonl");
    const r3 = await runToCompletion([
      ...cli,
      "--cdp",
      CDP,
      "--output",
      trace3,
      "--session",
      "m1-test-3",
      "--navigate",
      `http://127.0.0.1:${HTTP_PORT}/secret.html`,
      "--wait-ms",
      "1500",
    ]);
    check("uji 3 tracer keluar 0", r3.code === 0, `stderr: ${r3.stderr.slice(0, 200)}`);
    const raw3 = await readFile(trace3, "utf8");
    check("uji 3 nilai Authorization tidak mentah", !raw3.includes(SECRET_AUTH));
    check("uji 3 nilai token URL tidak mentah", !raw3.includes(SECRET_URL_TOKEN));
    check("uji 3 nilai api_key URL tidak mentah", !raw3.includes(SECRET_API_KEY));
    check("uji 3 body POST tidak mentah", !raw3.includes(SECRET_BODY));
    check("uji 3 ada penanda [REDACTED] pada header", (raw3.match(/\[REDACTED\]/g) || []).length >= 2);
    check("uji 3 parameter token URL disensor (REDACTED)", raw3.includes("token=REDACTED"));
    check("uji 3 parameter api_key URL disensor (REDACTED)", raw3.includes("api_key=REDACTED"));
    check("uji 3 nama header authorization tetap ada", /"authorization"/i.test(raw3));
    check("uji 3 parameter non-sensitif q=hello utuh", raw3.includes("q=hello"));
    check("uji 3 ada penanda [BODY-OMITTED]", raw3.includes("[BODY-OMITTED]"));
    const rows3 = await readRows(trace3);
    const longArg = rows3.find(
      (r) =>
        r.type === "Runtime.consoleAPICalled" &&
        JSON.stringify(r.data.args || []).includes(LONG_MARKER),
    );
    check("uji 3 argumen konsol panjang ditemukan", longArg !== undefined);
    if (longArg) {
      const argText = String(longArg.data.args[0] || "");
      check("uji 3 tiap argumen konsol <= 500 karakter", argText.length <= 500, `len=${argText.length}`);
      const totalArgs = longArg.data.args.reduce((s, a) => s + String(a).length, 0);
      check("uji 3 total argumen satu event <= 2000 karakter", totalArgs <= 2000, `total=${totalArgs}`);
    }
    const srcFiles = ["src/redact.ts", "src/cdp.ts", "src/tracer.ts", "src/cli.ts", "src/writer.ts"];
    let getResponseBodyCallFound = false;
    for (const f of srcFiles) {
      const src = await readFile(join(ROOT, f), "utf8");
      // Cari pemanggilan sungguhan, bukan sekadar penyebutan di komentar:
      // literal "Network.getResponseBody" atau pola getResponseBody(.
      if (
        src.includes('"Network.getResponseBody"') ||
        /getResponseBody\s*\(/.test(src)
      ) {
        getResponseBodyCallFound = true;
      }
    }
    check("uji 3 kode tidak pernah memanggil Network.getResponseBody", !getResponseBodyCallFound);

    // ---- Uji 4: kegagalan handshake ----
    console.log("== uji 4: kegagalan handshake ==");
    const r4a = await runToCompletion([
      ...cli,
      "--cdp",
      "ws://127.0.0.1:9/",
      "--output",
      join(workDir, "trace4a.jsonl"),
      "--session",
      "m1-test-4a",
    ]);
    check("uji 4a port mati keluar bukan nol", r4a.code !== 0, `code=${r4a.code}`);
    check(
      "uji 4a pesan menyebut handshake",
      /handshake/i.test(r4a.stderr),
      `stderr: ${r4a.stderr.slice(0, 200)}`,
    );
    const fake = await startFakeCdp(FAKE_PORT);
    try {
      const r4b = await runToCompletion([
        ...cli,
        "--cdp",
        `ws://127.0.0.1:${FAKE_PORT}/`,
        "--output",
        join(workDir, "trace4b.jsonl"),
        "--session",
        "m1-test-4b",
      ]);
      check("uji 4b attach ditolak keluar bukan nol", r4b.code !== 0, `code=${r4b.code}`);
      check(
        "uji 4b pesan menyebut langkah Target.attachToTarget",
        r4b.stderr.includes("Target.attachToTarget"),
        `stderr: ${r4b.stderr.slice(0, 300)}`,
      );
    } finally {
      fake.close();
    }

    // ---- Uji 5: SIGINT ----
    console.log("== uji 5: SIGINT ==");
    const trace5 = join(workDir, "trace5.jsonl");
    const child5 = spawn(process.execPath, [
      ...cli.slice(1),
      "--cdp",
      CDP,
      "--output",
      trace5,
      "--session",
      "m1-test-5",
    ]);
    let child5Stderr = "";
    child5.stderr.on("data", (d) => {
      child5Stderr += d;
    });
    const exit5 = new Promise((resolve) => child5.on("exit", (code) => resolve(code)));
    // Tunggu session_started tertulis (flush berkala 250 ms).
    let started = false;
    for (let i = 0; i < 40; i++) {
      try {
        const t = await readFile(trace5, "utf8");
        if (t.includes("tracer.session_started")) {
          started = true;
          break;
        }
      } catch {
        /* belum ada file */
      }
      await sleep(250);
    }
    check("uji 5 session_started tertulis sebelum SIGINT", started);
    child5.kill("SIGINT");
    const code5 = await Promise.race([
      exit5,
      sleep(10000).then(() => {
        try {
          child5.kill("SIGKILL");
        } catch {}
        return "timeout";
      }),
    ]);
    check("uji 5 keluar 0 setelah SIGINT", code5 === 0, `code=${String(code5)} stderr=${child5Stderr.slice(0, 200)}`);
    const rows5 = await readRows(trace5);
    check("uji 5 session_ended tertulis", rows5[rows5.length - 1].type === "tracer.session_ended");
    check("uji 5 seq berurutan (tidak ada baris terpotong)", rows5.every((r, i) => r.seq === i + 1));

    // ---- Uji 7: batas ukuran (dijalankan sebelum benchmark agar cepat) ----
    console.log("== uji 7: batas ukuran ==");
    const trace7 = join(workDir, "trace7.jsonl");
    const r7 = await runToCompletion([
      ...cli,
      "--cdp",
      CDP,
      "--output",
      trace7,
      "--session",
      "m1-test-7",
      "--max-bytes",
      "4096",
      "--navigate",
      `http://127.0.0.1:${HTTP_PORT}/throw.html`,
      "--wait-ms",
      "1200",
    ]);
    const size7 = (await stat(trace7)).size;
    check("uji 7 ukuran file tidak melampaui batas", size7 <= 4096, `size=${size7}`);
    check("uji 7 pesan batas ukuran ditampilkan", /batas ukuran/i.test(r7.stderr), `stderr: ${r7.stderr.slice(0, 200)}`);
    const rows7 = await readRows(trace7);
    check("uji 7 session_ended tetap tertulis", rows7[rows7.length - 1].type === "tracer.session_ended");
    check("uji 7 seq berurutan", rows7.every((r, i) => r.seq === i + 1));
  } finally {
    kill(serve);
    httpServer.close();
    await sleep(500);
  }

  // ---- Uji 6: benchmark berjalan dan angkanya tercatat ----
  console.log("== uji 6: benchmark ==");
  const bench = await runToCompletion(
    [process.execPath, join(ROOT, "tests", "benchmark.mjs")],
    {
      env: { LP_BIN: lpBin, BENCH_SERVE_PORT: "9233", BENCH_HTTP_PORT: "8773" },
      timeoutMs: 300000,
    },
  );
  check("uji 6 benchmark selesai (exit 0)", bench.code === 0, bench.stderr.slice(0, 300));
  let benchReport = null;
  try {
    benchReport = JSON.parse(await readFile(join(ROOT, "benchmark-result.json"), "utf8"));
  } catch {
    /* ditangani oleh check */
  }
  check("uji 6 benchmark-result.json ada dan valid", benchReport !== null);
  if (benchReport) {
    check("uji 6 median tanpa tracer > 0", benchReport.noTracer?.medianMs > 0);
    check("uji 6 median dengan tracer > 0", benchReport.tracer?.medianMs > 0);
    check("uji 6 overheadPct berupa angka", typeof benchReport.overheadPct === "number");
    check("uji 6 vonis tercatat", benchReport.verdict === "LULUS" || benchReport.verdict === "GAGAL");
    console.log(
      `  benchmark: tanpa tracer ${benchReport.noTracer.medianMs} ms | dengan tracer ${benchReport.tracer.medianMs} ms | overhead ${benchReport.overheadPct}% | ${benchReport.verdict}`,
    );
  }

  console.log(`\n${passed} lulus, ${failures.length} gagal${failures.length ? `: ${failures.join(", ")}` : ""}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("Rangkaian uji GAGAL:", e.message);
  process.exit(1);
});
