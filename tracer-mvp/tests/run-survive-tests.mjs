// run-survive-tests.mjs — Uji mode bertahan multi-koneksi (--survive,
// SURVIVE-DESIGN.md). Server CDP palsu memakai pola codec WebSocket
// manual yang sama dengan rangkaian MS/error (Node tidak punya server
// WebSocket bawaan), dengan kontrol tutup per koneksi; satu bagian
// live memakai dua proses `serve` Lightpanda 1.0.2 sungguhan.
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_A_PORT = Number(process.env.SURVIVE_FAKE_A_PORT || 9271);
const FAKE_B_PORT = Number(process.env.SURVIVE_FAKE_B_PORT || 9272);
const SERVE_A_PORT = Number(process.env.SURVIVE_SERVE_A_PORT || 9273);
const SERVE_B_PORT = Number(process.env.SURVIVE_SERVE_B_PORT || 9274);
const HTTP_PORT = Number(process.env.SURVIVE_HTTP_PORT || 8791);

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

// Build dulu agar dist/ sesuai dengan src/ saat ini.
await new Promise((resolve, reject) => {
  const child = spawn(join(ROOT, "node_modules", ".bin", "tsc"), [], { cwd: ROOT });
  child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tsc keluar ${code}`))));
  child.on("error", reject);
});

async function readRows(file) {
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function sessionEnded(rows) {
  return rows.find((r) => r.type === "tracer.session_ended");
}

function markers(rows) {
  return rows.filter((r) => r.type === "tracer.connection_closed");
}

async function waitForRows(file, minRows, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await readRows(file);
    if (rows.length >= minRows) return rows;
    await sleep(250);
  }
  return readRows(file);
}

async function waitForMarker(file, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await readRows(file);
    const m = markers(rows);
    if (m.length > 0) return m;
    await sleep(250);
  }
  return markers(await readRows(file));
}

async function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(new Error("timeout menunggu tracer keluar"));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function startTracer(args, outFile) {
  return spawn(
    process.execPath,
    [join(ROOT, "dist", "cli.js"), "--output", outFile, ...args],
    { stdio: "ignore" },
  );
}

// --- Server CDP palsu: handshake Target + kontrol tutup per soket. ---
function startFakeCdp(port) {
  const sockets = [];
  const emitters = [];
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
      const idx = sockets.length;
      sockets.push(socket);
      socket.on("error", () => {});
      socket.on("close", () => {});
      const key = req.headers["sec-websocket-key"] || "";
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
          accept +
          "\r\n\r\n",
      );
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
      emitters[idx] = emit;
      let buf = Buffer.alloc(0);
      let frag = Buffer.alloc(0);
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
        // Server dipakai ulang antar uji: tiap uji membuka satu koneksi
        // baru per server, jadi "terkini" selalu berarti koneksi uji
        // yang sedang berjalan (soket lama yang sudah mati dibiarkan
        // di daftar tetapi tidak pernah dipakai lagi).
        emitLatest: (method, params) => emitters[emitters.length - 1]?.(method, params),
        closeLatest: () => {
          try {
            sockets[sockets.length - 1]?.destroy();
          } catch {}
        },
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
  for (const cand of [join(ROOT, "vendor", "lightpanda"), "/tmp/lp-m1/lightpanda"]) {
    try {
      await stat(cand);
      return cand;
    } catch {
      /* lanjut */
    }
  }
  return null;
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

const CONSOLE_EVENT = (value) => ({
  type: "log",
  args: [{ type: "string", value }],
});

async function main() {
  const workdir = await mkdtemp(join(tmpdir(), "survive-test-"));
  console.log(`Uji mode bertahan — workdir ${workdir}`);
  const fakeA = await startFakeCdp(FAKE_A_PORT);
  const fakeB = await startFakeCdp(FAKE_B_PORT);

  try {
    // --- Uji 1: default (tanpa --survive) — tutup satu koneksi mengakhiri sesi. ---
    console.log("== uji 1: default, tutup koneksi 0 mengakhiri sesi ==");
    {
      const outFile = join(workdir, "default.jsonl");
      const tracer = startTracer(
        ["--cdp", fakeA.url, "--cdp", fakeB.url, "--session", "survive-default", "--stay"],
        outFile,
      );
      try {
        await waitForRows(outFile, 1);
        fakeA.emitLatest( "Runtime.consoleAPICalled", CONSOLE_EVENT("sebelum-tutup"));
        await waitForRows(outFile, 2);
        fakeA.closeLatest();
        const exit = await waitForExit(tracer);
        const rows = await readRows(outFile);
        const end = sessionEnded(rows);
        check("uji 1a keluar 0", exit.code === 0, `code=${exit.code}`);
        check(
          "uji 1b session_ended cdp-closed menyebut koneksi 0",
          end?.data.reason === "cdp-closed" &&
            end?.data.endpoint === fakeA.url &&
            end?.data.endpoint_index === 0,
        );
        check(
          "uji 1c error E_CDP_CLOSED",
          end?.data.error?.code === "E_CDP_CLOSED",
        );
        check("uji 1d tanpa baris connection_closed", markers(rows).length === 0);
      } finally {
        try {
          tracer.kill("SIGKILL");
        } catch {}
      }
    }

    // --- Uji 2: --survive — sesi berlanjut, penanda + closedEndpoints. ---
    console.log("== uji 2: --survive, tutup koneksi 0 lalu lanjut di koneksi 1 ==");
    {
      const outFile = join(workdir, "survive.jsonl");
      const tracer = startTracer(
        ["--cdp", fakeA.url, "--cdp", fakeB.url, "--session", "survive-on", "--stay", "--survive"],
        outFile,
      );
      try {
        await waitForRows(outFile, 1);
        fakeB.emitLatest( "Runtime.consoleAPICalled", CONSOLE_EVENT("sebelum-tutup"));
        await waitForRows(outFile, 2);
        fakeA.closeLatest();
        const m = await waitForMarker(outFile);
        check("uji 2a baris connection_closed tercatat", m.length === 1);
        check(
          "uji 2b penanda menyebut koneksi 0 + remaining 1",
          m[0]?.data.endpoint === fakeA.url &&
            m[0]?.data.endpoint_index === 0 &&
            m[0]?.data.remaining === 1,
        );
        check(
          "uji 2c penanda membawa endpoint tingkat atas koneksi 0",
          m[0]?.endpoint === fakeA.url && m[0]?.endpoint_index === 0,
        );
        check("uji 2d tracer masih hidup sesudah penutupan", tracer.exitCode === null);
        const before = (await readRows(outFile)).length;
        fakeB.emitLatest( "Runtime.consoleAPICalled", CONSOLE_EVENT("sesudah-tutup"));
        const after = await waitForRows(outFile, before + 1);
        const newRow = after[after.length - 1];
        check(
          "uji 2e event koneksi 1 tercatat sesudah penutupan",
          newRow?.type === "Runtime.consoleAPICalled" && newRow?.endpoint_index === 1,
        );
        tracer.kill("SIGINT");
        const exit = await waitForExit(tracer);
        const rows = await readRows(outFile);
        const end = sessionEnded(rows);
        check("uji 2f keluar 0 lewat SIGINT", exit.code === 0, `code=${exit.code}`);
        check(
          "uji 2g session_ended signal-SIGINT + closedEndpoints [0]",
          end?.data.reason === "signal-SIGINT" &&
            JSON.stringify(end?.data.closedEndpoints) ===
              JSON.stringify([{ endpoint: fakeA.url, endpoint_index: 0 }]),
        );
        check("uji 2h tanpa data.error", end?.data.error === undefined);
      } finally {
        try {
          tracer.kill("SIGKILL");
        } catch {}
      }
    }

    // --- Uji 3: --survive — tutup kedua koneksi mengakhiri sesi. ---
    console.log("== uji 3: --survive, tutup 0 lalu 1 mengakhiri sesi ==");
    {
      const outFile = join(workdir, "survive-both.jsonl");
      const tracer = startTracer(
        ["--cdp", fakeA.url, "--cdp", fakeB.url, "--session", "survive-both", "--stay", "--survive"],
        outFile,
      );
      try {
        await waitForRows(outFile, 1);
        fakeA.closeLatest();
        await waitForMarker(outFile);
        fakeB.closeLatest();
        const exit = await waitForExit(tracer);
        const rows = await readRows(outFile);
        const end = sessionEnded(rows);
        check("uji 3a keluar 0", exit.code === 0, `code=${exit.code}`);
        check(
          "uji 3b session_ended cdp-closed menyebut koneksi 1",
          end?.data.reason === "cdp-closed" &&
            end?.data.endpoint === fakeB.url &&
            end?.data.endpoint_index === 1,
        );
        check("uji 3c error E_CDP_CLOSED", end?.data.error?.code === "E_CDP_CLOSED");
        check(
          "uji 3d closedEndpoints hanya berisi koneksi 0 yang diselamatkan",
          JSON.stringify(end?.data.closedEndpoints) ===
            JSON.stringify([{ endpoint: fakeA.url, endpoint_index: 0 }]),
        );
        check("uji 3e satu penanda (untuk koneksi 0)", markers(rows).length === 1);
      } finally {
        try {
          tracer.kill("SIGKILL");
        } catch {}
      }
    }

    // --- Uji 4: satu koneksi + --survive — perilaku identik dengan default. ---
    console.log("== uji 4: satu koneksi + --survive, tutup mengakhiri sesi tanpa penanda ==");
    {
      const outFile = join(workdir, "survive-single.jsonl");
      const tracer = startTracer(
        ["--cdp", fakeA.url, "--session", "survive-single", "--stay", "--survive"],
        outFile,
      );
      try {
        await waitForRows(outFile, 1);
        fakeA.closeLatest();
        const exit = await waitForExit(tracer);
        const rows = await readRows(outFile);
        const end = sessionEnded(rows);
        check("uji 4a keluar 0", exit.code === 0, `code=${exit.code}`);
        check("uji 4b session_ended cdp-closed", end?.data.reason === "cdp-closed");
        check("uji 4c tanpa baris connection_closed", markers(rows).length === 0);
        check("uji 4d tanpa closedEndpoints", end?.data.closedEndpoints === undefined);
      } finally {
        try {
          tracer.kill("SIGKILL");
        } catch {}
      }
    }

    // --- Uji 5: live — dua serve asli, matikan satu, koneksi lain terus merekam. ---
    console.log("== uji 5: live, matikan serve A, serve B terus merekam ==");
    {
      const lpBin = await findLightpanda();
      check("uji 5a binary Lightpanda 1.0.2 ditemukan", lpBin !== null);
      if (lpBin !== null) {
        const base = `http://127.0.0.1:${HTTP_PORT}`;
        const httpServer = http.createServer((req, res) => {
          if (req.url === "/denyut.html") {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(
              "<!doctype html><title>denyut</title><script>" +
                "let i=0;setInterval(()=>{console.log('denyut-'+(i++));},500);" +
                "setInterval(()=>{fetch('/denyut?n='+Date.now()).catch(()=>{});},1000);" +
                "</script>",
            );
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
        await new Promise((res2) => httpServer.listen(HTTP_PORT, "127.0.0.1", res2));
        const serveA = spawn(lpBin, ["serve", "--host", "127.0.0.1", "--port", String(SERVE_A_PORT)], {
          env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
          stdio: "ignore",
        });
        const serveB = spawn(lpBin, ["serve", "--host", "127.0.0.1", "--port", String(SERVE_B_PORT)], {
          env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
          stdio: "ignore",
        });
        const outFile = join(workdir, "survive-live.jsonl");
        // Tunggu kedua serve siap DULU: tracer mengambil versi di awal
        // dan gagal langsung bila endpoint belum mendengarkan.
        await waitForVersion(SERVE_A_PORT);
        await waitForVersion(SERVE_B_PORT);
        const tracer = startTracer(
          [
            "--cdp",
            `ws://127.0.0.1:${SERVE_A_PORT}`,
            "--cdp",
            `ws://127.0.0.1:${SERVE_B_PORT}`,
            "--session",
            "survive-live",
            "--navigate",
            `${base}/denyut.html`,
            "--navigate",
            `${base}/denyut.html`,
            "--stay",
            "--survive",
          ],
          outFile,
        );
        try {
          // Tunggu baris dari koneksi 1 (indeks B) sebelum membunuh A.
          const start = Date.now();
          let bBefore = 0;
          for (;;) {
            const rows = await readRows(outFile);
            bBefore = rows.filter((r) => r.endpoint_index === 1).length;
            if (bBefore >= 2 || Date.now() - start > 15000) break;
            await sleep(250);
          }
          check("uji 5b baris koneksi B tercatat sebelum A dimatikan", bBefore >= 2, `bBefore=${bBefore}`);
          serveA.kill("SIGTERM");
          const m = await waitForMarker(outFile, 15000);
          check("uji 5c penanda connection_closed untuk koneksi 0", m.length >= 1 && m[0]?.data.endpoint_index === 0);
          check("uji 5d tracer masih hidup sesudah serve A mati", tracer.exitCode === null);
          // Baris koneksi B harus terus bertambah sesudah kematian A.
          const start2 = Date.now();
          let bAfter = bBefore;
          for (;;) {
            const rows = await readRows(outFile);
            bAfter = rows.filter((r) => r.endpoint_index === 1).length;
            if (bAfter >= bBefore + 2 || Date.now() - start2 > 15000) break;
            await sleep(250);
          }
          check(
            "uji 5e baris koneksi B bertambah sesudah A mati",
            bAfter >= bBefore + 2,
            `sebelum=${bBefore} sesudah=${bAfter}`,
          );
          tracer.kill("SIGINT");
          const exit = await waitForExit(tracer);
          const rows = await readRows(outFile);
          const end = sessionEnded(rows);
          check("uji 5f keluar 0 lewat SIGINT", exit.code === 0, `code=${exit.code}`);
          check(
            "uji 5g closedEndpoints menyebut serve A",
            JSON.stringify(end?.data.closedEndpoints) ===
              JSON.stringify([{ endpoint: `ws://127.0.0.1:${SERVE_A_PORT}`, endpoint_index: 0 }]),
          );
        } finally {
          try {
            tracer.kill("SIGKILL");
          } catch {}
          try {
            serveA.kill("SIGKILL");
          } catch {}
          try {
            serveB.kill("SIGKILL");
          } catch {}
          httpServer.close();
        }
      }
    }
  } finally {
    await fakeA.close();
    await fakeB.close();
    await rm(workdir, { recursive: true, force: true });
  }

  console.log(`\nUji bertahan: ${passed} lulus, ${failures.length} gagal.`);
  if (failures.length > 0) {
    console.log(`Gagal: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
