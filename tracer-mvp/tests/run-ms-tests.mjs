// run-ms-tests.mjs — Uji multi-endpoint + resume (MS-DESIGN.md).
// Sebagian besar uji memakai server CDP palsu yang MENERIMA handshake
// (tanpa dependensi, pola yang sama dengan uji 4 M1) agar deterministik
// tanpa binary; satu bagian live memakai Lightpanda 1.0.2 sungguhan dan
// dilewati bila binary tidak ditemukan. Build (tsc) dijalankan dulu.
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_A_PORT = Number(process.env.MS_FAKE_A_PORT || 9242);
const FAKE_B_PORT = Number(process.env.MS_FAKE_B_PORT || 9243);
const FAKE_C_PORT = Number(process.env.MS_FAKE_C_PORT || 9244);
const SERVE_PORT = Number(process.env.MS_SERVE_PORT || 9241);
const HTTP_PORT = Number(process.env.MS_HTTP_PORT || 8781);

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

// --- Server CDP palsu (menerima handshake) ---
function startFakeCdp(port, opts = {}) {
  const { failAttach = false, eventUrl = "http://127.0.0.1:1/fake.html", eventCount = 1 } = opts;
  const navigations = [];
  let connCount = 0;
  const sockets = new Set();
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
      const key = req.headers["sec-websocket-key"] || "";
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
          accept +
          "\r\n\r\n",
      );
      const connIndex = connCount++;
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
            if (failAttach) {
              reply({ id: msg.id, error: { code: -32000, message: "fake attach failed" } });
            } else {
              reply({ id: msg.id, result: { sessionId: "SID-1" } });
              setTimeout(() => {
                for (let k = 0; k < eventCount; k++) {
                  emit("Network.requestWillBeSent", {
                    requestId: `REQ-${connIndex}-${k}`,
                    request: { url: eventUrl, method: "GET" },
                    type: "Document",
                  });
                }
              }, 50);
            }
          } else if (msg.method === "Page.navigate") {
            navigations.push({ connIndex, url: msg.params?.url });
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
        navigations,
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
  const workDir = await mkdtemp(join(tmpdir(), "ms-test-"));
  console.log(`Uji multi-endpoint + resume — workdir ${workDir}`);

  console.log("== build ==");
  const build = await runToCompletion([join(ROOT, "node_modules", ".bin", "tsc")], {
    timeoutMs: 120000,
  });
  check("build tsc bersih (exit 0)", build.code === 0, build.stderr.slice(0, 300));

  const cli = join(ROOT, "dist", "cli.js");

  // --- Uji 1: URL sama diulang, navigasi berpasangan ---
  console.log("== uji 1: dua koneksi ke URL sama ==");
  const fakeA = await startFakeCdp(FAKE_A_PORT, {
    eventUrl: "http://127.0.0.1:1/sama.html",
    eventCount: 1,
  });
  const out1 = join(workDir, "multi-same.jsonl");
  const r1 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeA.url,
    "--cdp",
    fakeA.url,
    "--output",
    out1,
    "--session",
    "ms-1",
    "--navigate",
    "http://127.0.0.1:1/a.html",
    "--navigate",
    "http://127.0.0.1:1/b.html",
    "--wait-ms",
    "100",
  ]);
  check("uji 1 keluar 0", r1.code === 0, `code=${r1.code} stderr=${r1.stderr.slice(0, 200)}`);
  const rows1 = await readRows(out1);
  check(
    "uji 1 seq berurutan dari 1",
    rows1.every((r, i) => r.seq === i + 1),
    rows1.map((r) => r.seq).join(","),
  );
  check(
    "uji 1 session_started membawa 2 endpoints",
    Array.isArray(rows1[0].data.endpoints) && rows1[0].data.endpoints.length === 2,
    JSON.stringify(rows1[0]?.data),
  );
  const reqRows1 = rows1.filter((r) => r.type === "Network.requestWillBeSent");
  check("uji 1 dua event request (satu per koneksi)", reqRows1.length === 2, `n=${reqRows1.length}`);
  check(
    "uji 1 endpoint_index 0 dan 1, endpoint sama",
    reqRows1.length === 2 &&
      reqRows1[0].endpoint_index === 0 &&
      reqRows1[1].endpoint_index === 1 &&
      reqRows1[0].endpoint === fakeA.url &&
      reqRows1[1].endpoint === fakeA.url,
    JSON.stringify(reqRows1.map((r) => [r.endpoint_index, r.endpoint])),
  );
  const navRows1 = rows1.filter((r) => r.type === "Page.frameNavigated");
  check("uji 1 dua frameNavigated", navRows1.length === 2, `n=${navRows1.length}`);
  check(
    "uji 1 navigasi berpasangan per koneksi",
    navRows1.length === 2 &&
      navRows1[0].data.frame.url === "http://127.0.0.1:1/a.html" &&
      navRows1[0].endpoint_index === 0 &&
      navRows1[1].data.frame.url === "http://127.0.0.1:1/b.html" &&
      navRows1[1].endpoint_index === 1,
    JSON.stringify(navRows1.map((r) => [r.endpoint_index, r.data.frame?.url])),
  );
  check(
    "uji 1 server mencatat navigasi per koneksi",
    fakeA.navigations.length === 2 &&
      fakeA.navigations[0].connIndex === 0 &&
      fakeA.navigations[0].url === "http://127.0.0.1:1/a.html" &&
      fakeA.navigations[1].connIndex === 1 &&
      fakeA.navigations[1].url === "http://127.0.0.1:1/b.html",
    JSON.stringify(fakeA.navigations),
  );
  check(
    "uji 1 baris tracer.* bertanda endpoint kosong/-1",
    rows1[0].endpoint === "" && rows1[0].endpoint_index === -1,
    JSON.stringify([rows1[0].endpoint, rows1[0].endpoint_index]),
  );
  await fakeA.close();

  // --- Uji 2: dua URL berbeda ---
  console.log("== uji 2: dua URL berbeda ==");
  const fakeB1 = await startFakeCdp(FAKE_B_PORT, {
    eventUrl: "http://127.0.0.1:1/satu.html",
    eventCount: 1,
  });
  const fakeB2 = await startFakeCdp(FAKE_C_PORT, {
    eventUrl: "http://127.0.0.1:1/dua.html",
    eventCount: 1,
  });
  const out2 = join(workDir, "multi-diff.jsonl");
  const r2b = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeB1.url,
    "--cdp",
    fakeB2.url,
    "--output",
    out2,
    "--session",
    "ms-2",
    "--navigate",
    "http://127.0.0.1:1/satu.html",
    "--wait-ms",
    "100",
  ]);
  check("uji 2 keluar 0", r2b.code === 0, `code=${r2b.code} stderr=${r2b.stderr.slice(0, 200)}`);
  const rows2 = await readRows(out2);
  const reqRows2 = rows2.filter((r) => r.type === "Network.requestWillBeSent");
  check(
    "uji 2 event ditandai endpoint masing-masing",
    reqRows2.length === 2 &&
      reqRows2.some((r) => r.endpoint === fakeB1.url && r.data.request.url === "http://127.0.0.1:1/satu.html") &&
      reqRows2.some((r) => r.endpoint === fakeB2.url && r.data.request.url === "http://127.0.0.1:1/dua.html"),
    JSON.stringify(reqRows2.map((r) => [r.endpoint, r.data.request?.url])),
  );
  await fakeB1.close();
  await fakeB2.close();

  // --- Uji 3: --navigate lebih banyak dari --cdp ---
  console.log("== uji 3: validasi pasangan navigate ==");
  const r3 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    "ws://127.0.0.1:9",
    "--cdp",
    "ws://127.0.0.1:9",
    "--output",
    join(workDir, "x.jsonl"),
    "--navigate",
    "http://127.0.0.1:1/a.html",
    "--navigate",
    "http://127.0.0.1:1/b.html",
    "--navigate",
    "http://127.0.0.1:1/c.html",
  ]);
  check(
    "uji 3 keluar bukan nol dan menyebut --navigate/--cdp",
    r3.code !== 0 && /--navigate/.test(r3.stderr) && /--cdp/.test(r3.stderr),
    `code=${r3.code} stderr=${r3.stderr.slice(0, 200)}`,
  );

  // Uji 3b: satu --cdp + dua --navigate = navigasi berurutan pada target sama (kompatibilitas M1).
  const fakeSingle = await startFakeCdp(FAKE_C_PORT, { eventCount: 0 });
  const r3b = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeSingle.url,
    "--output",
    join(workDir, "single-multi-nav.jsonl"),
    "--navigate",
    "http://127.0.0.1:1/a.html",
    "--navigate",
    "http://127.0.0.1:1/b.html",
    "--wait-ms",
    "100",
  ]);
  check(
    "uji 3b satu cdp + dua navigate keluar 0, keduanya ke koneksi 0",
    r3b.code === 0 &&
      fakeSingle.navigations.length === 2 &&
      fakeSingle.navigations.every((n) => n.connIndex === 0),
    `code=${r3b.code} nav=${JSON.stringify(fakeSingle.navigations)}`,
  );
  await fakeSingle.close();

  // --- Uji 4: handshake gagal di koneksi kedua = fatal, menyebut endpoint ---
  console.log("== uji 4: handshake gagal koneksi kedua ==");
  const fakeOk = await startFakeCdp(FAKE_B_PORT, { eventCount: 0 });
  const fakeBad = await startFakeCdp(FAKE_C_PORT, { failAttach: true, eventCount: 0 });
  const out4 = join(workDir, "fail2.jsonl");
  const r4 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeOk.url,
    "--cdp",
    fakeBad.url,
    "--output",
    out4,
    "--session",
    "ms-4",
  ]);
  check("uji 4 keluar bukan nol", r4.code !== 0, `code=${r4.code}`);
  check(
    "uji 4 pesan menyebut endpoint kedua",
    r4.stderr.includes(fakeBad.url),
    r4.stderr.slice(0, 300),
  );
  const rows4 = await readRows(out4);
  check(
    "uji 4 session_ended handshake-failed tetap ditulis",
    rows4.some((r) => r.type === "tracer.session_ended" && r.data.reason === "handshake-failed"),
    JSON.stringify(rows4.map((r) => r.type)),
  );
  await fakeOk.close();
  await fakeBad.close();

  // --- Uji 5-9: resume ---
  console.log("== uji 5-9: resume --append ==");
  const { readResumeState } = await import("../dist/tracer.js");
  const fakeR = await startFakeCdp(FAKE_A_PORT, {
    eventUrl: "http://127.0.0.1:1/resume.html",
    eventCount: 1,
  });
  const mkRow = (seq, type, data, extra = {}) => ({
    ts: "2026-10-29T07:00:00.000Z",
    mono_ms: seq * 10,
    seq,
    session: "s-resume",
    lightpanda_version: "1.0.2",
    endpoint: "",
    endpoint_index: -1,
    type,
    data,
    ...extra,
  });
  const oldLines = [
    JSON.stringify(mkRow(1, "tracer.session_started", { cdp: fakeR.url, endpoints: [fakeR.url] })),
    JSON.stringify(
      mkRow(2, "Network.requestWillBeSent", { request: { url: "http://127.0.0.1:1/lama.html" } }, { endpoint: fakeR.url, endpoint_index: 0 }),
    ),
    JSON.stringify(mkRow(3, "tracer.session_ended", { reason: "navigations-done" })),
  ];
  const oldText = oldLines.join("\n") + "\n";

  // Uji 5: append normal.
  const out5 = join(workDir, "resume.jsonl");
  await writeFile(out5, oldText, "utf8");
  const r5 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeR.url,
    "--output",
    out5,
    "--session",
    "s-resume",
    "--append",
    "--navigate",
    "http://127.0.0.1:1/baru.html",
    "--wait-ms",
    "100",
  ]);
  check("uji 5 keluar 0", r5.code === 0, `code=${r5.code} stderr=${r5.stderr.slice(0, 200)}`);
  const rows5 = await readRows(out5);
  const newText5 = await readFile(out5, "utf8");
  check("uji 5 isi lama dipertahankan sebagai awalan", newText5.startsWith(oldText));
  check(
    "uji 5 seq bersambung 1..7 (resumed + event + frameNavigated + ended)",
    rows5.length === 7 && rows5.every((r, i) => r.seq === i + 1),
    rows5.map((r) => r.seq).join(","),
  );
  check(
    "uji 5 session_resumed seq 4 dengan data benar",
    rows5[3].type === "tracer.session_resumed" &&
      rows5[3].data.previousRows === 3 &&
      rows5[3].data.resumedFromSeq === 4,
    JSON.stringify(rows5[3]),
  );
  check(
    "uji 5 semua baris satu sesi",
    rows5.every((r) => r.session === "s-resume"),
    rows5.map((r) => r.session).join(","),
  );

  // Uji 6: sesi berbeda ditolak, file tidak berubah.
  const out6 = join(workDir, "resume-mismatch.jsonl");
  await writeFile(out6, oldText, "utf8");
  const r6 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeR.url,
    "--output",
    out6,
    "--session",
    "sesi-lain",
    "--append",
    "--navigate",
    "http://127.0.0.1:1/baru.html",
  ]);
  check(
    "uji 6 keluar bukan nol dan menyebut perbedaan sesi",
    r6.code !== 0 && /berbeda/.test(r6.stderr),
    `code=${r6.code} stderr=${r6.stderr.slice(0, 200)}`,
  );
  check("uji 6 file tidak berubah", (await readFile(out6, "utf8")) === oldText);

  // Uji 7: ekor rusak ditolak, file tidak berubah.
  const out7 = join(workDir, "resume-corrupt.jsonl");
  await writeFile(out7, oldText + "{bukan json\n", "utf8");
  const r7 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeR.url,
    "--output",
    out7,
    "--append",
    "--navigate",
    "http://127.0.0.1:1/baru.html",
  ]);
  check(
    "uji 7 keluar bukan nol dan menyebut ekor rusak",
    r7.code !== 0 && /resume dibatalkan/.test(r7.stderr),
    `code=${r7.code} stderr=${r7.stderr.slice(0, 200)}`,
  );
  check(
    "uji 7 file tidak berubah",
    (await readFile(out7, "utf8")) === oldText + "{bukan json\n",
  );

  // Uji 8: file kosong = mulai segar.
  const out8 = join(workDir, "resume-empty.jsonl");
  await writeFile(out8, "", "utf8");
  const r8 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeR.url,
    "--output",
    out8,
    "--session",
    "ms-8",
    "--append",
    "--navigate",
    "http://127.0.0.1:1/baru.html",
    "--wait-ms",
    "100",
  ]);
  const rows8 = await readRows(out8);
  check(
    "uji 8 file kosong mulai dari session_started seq 1",
    r8.code === 0 && rows8[0].type === "tracer.session_started" && rows8[0].seq === 1,
    `code=${r8.code} first=${JSON.stringify(rows8[0])}`,
  );

  // Uji 9: batas ukuran menghitung isi lama.
  const fakeMany = await startFakeCdp(FAKE_B_PORT, {
    eventUrl: "http://127.0.0.1:1/banyak.html",
    eventCount: 30,
  });
  const out9 = join(workDir, "resume-limit.jsonl");
  const filler = JSON.stringify(
    mkRow(1, "tracer.session_started", { cdp: fakeMany.url, endpoints: [fakeMany.url], pad: "x".repeat(2800) }),
  );
  await writeFile(out9, filler + "\n", "utf8");
  const oldSize9 = (await stat(out9)).size;
  const r9 = await runToCompletion([
    "node",
    cli,
    "--cdp",
    fakeMany.url,
    "--output",
    out9,
    "--append",
    "--max-bytes",
    "4200",
    "--navigate",
    "http://127.0.0.1:1/baru.html",
    "--wait-ms",
    "100",
  ]);
  const size9 = (await stat(out9)).size;
  const rows9 = await readRows(out9);
  const eventRows9 = rows9.filter((r) => r.type === "Network.requestWillBeSent");
  check(
    "uji 9 ukuran total tidak melampaui batas",
    size9 <= 4200,
    `old=${oldSize9} new=${size9}`,
  );
  check(
    "uji 9 penulisan berhenti sebelum 30 event (limit bekerja)",
    eventRows9.length < 30,
    `n=${eventRows9.length}`,
  );
  await fakeMany.close();
  await fakeR.close();

  // Uji 10: readResumeState unit.
  console.log("== uji 10: readResumeState ==");
  const missing = await readResumeState(join(workDir, "tidak-ada.jsonl"));
  check("uji 10 file hilang -> null", missing === null);
  const emptyState = await readResumeState(out8);
  check(
    "uji 10 file berisi -> sesi + seq terakhir",
    emptyState !== null && emptyState.session === "ms-8",
    JSON.stringify(emptyState),
  );
  let corruptThrew = false;
  try {
    await readResumeState(out7);
  } catch {
    corruptThrew = true;
  }
  check("uji 10 ekor rusak -> melempar", corruptThrew);

  // --- Uji 11 (live): Lightpanda sungguhan, URL sama diulang + resume ---
  console.log("== uji 11: live multi-endpoint + resume ==");
  const lpBin = await findLightpanda();
  if (!lpBin) {
    console.log("  SKIP uji 11: binary Lightpanda tidak ditemukan (LP_BIN/PATH/tmp).");
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
    check("uji 11 serve siap", await ready());
    const cdp = `ws://127.0.0.1:${SERVE_PORT}`;
    const out11 = join(workDir, "live-multi.jsonl");
    const r11 = await runToCompletion([
      "node",
      cli,
      "--cdp",
      cdp,
      "--cdp",
      cdp,
      "--output",
      out11,
      "--session",
      "ms-live",
      "--navigate",
      `http://127.0.0.1:${HTTP_PORT}/a.html`,
      "--navigate",
      `http://127.0.0.1:${HTTP_PORT}/b.html`,
      "--wait-ms",
      "500",
    ]);
    check("uji 11 keluar 0", r11.code === 0, `code=${r11.code} stderr=${r11.stderr.slice(0, 300)}`);
    const rows11 = await readRows(out11);
    const nav11 = rows11.filter((r) => r.type === "Page.frameNavigated");
    check(
      "uji 11 dua frameNavigated dari koneksi berbeda",
      nav11.length >= 2 &&
        nav11.some((r) => r.data.frame?.url === `http://127.0.0.1:${HTTP_PORT}/a.html` && r.endpoint_index === 0) &&
        nav11.some((r) => r.data.frame?.url === `http://127.0.0.1:${HTTP_PORT}/b.html` && r.endpoint_index === 1),
      JSON.stringify(nav11.map((r) => [r.endpoint_index, r.data.frame?.url])),
    );
    const count11 = rows11.length;
    const r11b = await runToCompletion([
      "node",
      cli,
      "--cdp",
      cdp,
      "--output",
      out11,
      "--append",
      "--navigate",
      `http://127.0.0.1:${HTTP_PORT}/a.html`,
      "--wait-ms",
      "500",
    ]);
    check("uji 11b resume keluar 0", r11b.code === 0, `code=${r11b.code} stderr=${r11b.stderr.slice(0, 300)}`);
    const rows11b = await readRows(out11);
    check(
      "uji 11b session_resumed bersambung setelah baris lama",
      rows11b.length > count11 &&
        rows11b[count11].type === "tracer.session_resumed" &&
        rows11b[count11].seq === count11 + 1 &&
        rows11b.every((r) => r.session === "ms-live"),
      `count=${count11} new=${rows11b.length} at=${JSON.stringify(rows11b[count11])}`,
    );
    try {
      serve.kill("SIGTERM");
    } catch {}
    httpServer.close();
  }

  console.log(`\nUji MS: ${passed} lulus, ${failures.length} gagal.`);
  if (failures.length > 0) {
    console.log(`Gagal: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
