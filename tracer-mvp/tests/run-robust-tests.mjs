// run-robust-tests.mjs — Uji ketahanan terhadap Lightpanda 1.0.2 sungguhan:
//  1. koeksistensi Playwright (connectOverCDP) berdampingan dengan tracer,
//  2. sesi panjang 20 detik dengan aliran event berlanjut + batas RSS,
//  3. beban besar: 100 fetch dalam satu halaman (plus 60 <img> yang
//     Lightpanda 1.0.2 terbukti tidak pernah fetch — temuan, bukan gate).
// Keluar bukan nol bila ada pemeriksaan gagal. Binary Lightpanda dicari
// lewat env LP_BIN, PATH, vendor/lightpanda, atau /tmp/lp-m1/lightpanda.
// playwright-core wajib ada (devDependency): gagal keras bila tak ditemukan.
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVE_PORT = Number(process.env.ROBUST_SERVE_PORT || 9251);
const HTTP_PORT = Number(process.env.ROBUST_HTTP_PORT || 8786);
const CDP = `ws://127.0.0.1:${SERVE_PORT}`;
const LONG_MS = 20000;

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

// Build (tsc) dijalankan dulu, seperti run-version-tests.mjs dan
// run-m1-tests.mjs: di checkout bersih (CI), dist/ belum ada karena
// gitignore, dan spawn dist/cli.js yang tidak ada mati seketika —
// tanpa build, seluruh rangkaian ini gagal di CI padahal tracernya
// sehat (pelajaran 29 Okt 2026: badge CI "failing" dari sini).
const buildCode = await new Promise((resolve) => {
  const child = spawn(join(ROOT, "node_modules", ".bin", "tsc"), [], { cwd: ROOT });
  child.on("close", (code) => resolve(code));
  child.on("error", () => resolve(1));
});
check("build tsc bersih", buildCode === 0);
if (buildCode !== 0) {
  console.error("Uji robust: build gagal, berhenti.");
  process.exit(1);
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

function startServe(lpBin, port) {
  return spawn(lpBin, ["serve", "--host", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
    stdio: "ignore",
  });
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

function startTracer(args, outFile) {
  const child = spawn(
    process.execPath,
    [join(ROOT, "dist", "cli.js"), "--cdp", CDP, "--output", outFile, ...args],
    { stdio: "ignore" },
  );
  return child;
}

async function waitForExit(child, timeoutMs = 30000) {
  // Anak bisa sudah keluar sebelum pemanggil sempat memasang listener
  // (mis. dist/cli.js tidak ada sehingga spawn mati seketika): tanpa
  // penjaga ini, event 'exit' terlewat dan penantian menggantung
  // sampai timeout — persis gejala CI 29 Okt 2026.
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

async function waitForRows(outFile, minRows, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = await readFile(outFile, "utf8");
      const n = text.split("\n").filter(Boolean).length;
      if (n >= minRows) return n;
    } catch {
      /* belum ada */
    }
    await sleep(250);
  }
  return 0;
}

async function rowsCount(outFile) {
  try {
    const text = await readFile(outFile, "utf8");
    return text.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function readRows(outFile) {
  const text = await readFile(outFile, "utf8");
  const rows = [];
  let broken = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      broken += 1;
    }
  }
  return { rows, broken };
}

function seqContiguous(rows) {
  return rows.every((r, i) => r.seq === i + 1);
}

function monoNonDecreasing(rows) {
  for (let i = 1; i < rows.length; i++) {
    if (typeof rows[i].mono_ms !== "number" || typeof rows[i - 1].mono_ms !== "number") return false;
    if (rows[i].mono_ms < rows[i - 1].mono_ms) return false;
  }
  return true;
}

function makeHttpServer() {
  const gif = Buffer.from("R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/pw.html" || url.pathname === "/denyut.html") {
      const isDenyut = url.pathname === "/denyut.html";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><title>${isDenyut ? "Denyut" : "PW OK"}</title>` +
          `<script>let i=0;` +
          (isDenyut
            ? `setInterval(()=>{console.log('denyut-'+(i++));},500);setInterval(()=>{fetch('/denyut?n='+Date.now()).catch(()=>{});},1000);`
            : `console.log('pw-hi');fetch('/api.json').then(r=>r.json()).then(()=>console.log('pw-api'));`) +
          `</script><h1>robust</h1>`,
      );
    } else if (url.pathname === "/beban.html") {
      const imgs = Array.from({ length: 60 }, (_, i) => `<img src="/img?n=${i}" alt="">`).join("");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><title>Beban</title>${imgs}` +
          `<script>Promise.all(Array.from({length:100},(_,i)=>fetch('/api?n='+i).then(r=>r.text()).catch(()=>''))).then(()=>{document.title='Beban selesai';});</script>`,
      );
    } else if (url.pathname === "/img") {
      res.writeHead(200, { "content-type": "image/gif" });
      res.end(gif);
    } else if (url.pathname === "/api.json" || url.pathname === "/api" || url.pathname === "/denyut") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return server;
}

async function sampleRssKb(pid, stopFlag, samples) {
  // Linux saja; di platform lain kembalikan null (pemeriksaan dilewati).
  if (process.platform !== "linux") return null;
  let max = 0;
  while (!stopFlag.done) {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
      if (m) max = Math.max(max, Number(m[1]));
    } catch {
      break;
    }
    samples.push(max);
    await sleep(1000);
  }
  return max;
}

const lpBin = await findLightpanda();
check("binary Lightpanda 1.0.2 ditemukan — set LP_BIN / PATH / vendor/", lpBin !== null);
if (lpBin === null) {
  console.log(`\n${passed} lulus, ${failures.length} gagal`);
  process.exit(1);
}
const versionBody = await (async () => {
  const probe = startServe(lpBin, SERVE_PORT);
  try {
    return await waitForVersion(SERVE_PORT);
  } finally {
    probe.kill("SIGKILL");
  }
})();
console.log(`  serve siap, Lightpanda-Version: ${versionBody["Lightpanda-Version"]}`);

const workdir = await mkdtemp(join(tmpdir(), "robust-test-"));
const httpServer = makeHttpServer();
await new Promise((resolve) => httpServer.listen(HTTP_PORT, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${HTTP_PORT}`;

let serveProc = null;
try {
  // ---------- Uji 1: koeksistensi Playwright ----------
  console.log("== uji 1: koeksistensi Playwright ==");
  let chromium = null;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    check("playwright-core tersedia (devDependency, jalankan npm ci)", false);
  }
  if (chromium !== null) {
    const outFile = join(workdir, "pw.jsonl");
    serveProc = startServe(lpBin, SERVE_PORT);
    await waitForVersion(SERVE_PORT);
    const tracer = startTracer(
      ["--session", "robust-pw", "--navigate", `${base}/pw.html`, "--stay"],
      outFile,
    );
    await waitForRows(outFile, 3);
    check("tracer menulis >= 3 baris sebelum Playwright", (await rowsCount(outFile)) >= 3);
    let pw = { connect: false, goto: false, title: null };
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${SERVE_PORT}`, {
        timeout: 20000,
      });
      pw.connect = true;
      const page = await browser.newPage();
      const resp = await page.goto(`${base}/pw.html`, { timeout: 15000, waitUntil: "load" });
      pw.goto = resp !== null && resp.status() === 200;
      pw.title = await page.title();
      await browser.close().catch(() => {});
    } catch (e) {
      console.log(`  Playwright gagal: ${String(e.message ?? e).slice(0, 300)}`);
    }
    check("Playwright connectOverCDP tersambung", pw.connect);
    check("Playwright goto 200 + judul terbaca", pw.goto && pw.title === "PW OK", `title=${pw.title}`);
    tracer.kill("SIGINT");
    const exit = await waitForExit(tracer);
    check("tracer keluar 0 setelah SIGINT", exit.code === 0, `code=${exit.code}`);
    const { rows, broken } = await readRows(outFile);
    check("trace Playwright: seq bersambung", seqContiguous(rows), `rows=${rows.length}`);
    check("trace Playwright: session_ended hadir", rows.some((r) => r.type === "tracer.session_ended"));
    check("trace Playwright: tanpa baris rusak", broken === 0, `broken=${broken}`);
    serveProc.kill("SIGKILL");
    serveProc = null;
    await sleep(500);
  }

  // ---------- Uji 2: sesi panjang 20 detik ----------
  console.log("== uji 2: sesi panjang ==");
  {
    const outFile = join(workdir, "panjang.jsonl");
    serveProc = startServe(lpBin, SERVE_PORT);
    await waitForVersion(SERVE_PORT);
    const tracer = startTracer(
      ["--session", "robust-panjang", "--navigate", `${base}/denyut.html`, "--stay"],
      outFile,
    );
    await waitForRows(outFile, 3);
    check("tracer menulis >= 3 baris sebelum sesi panjang", (await rowsCount(outFile)) >= 3);
    const stopFlag = { done: false };
    const rssPromise = sampleRssKb(tracer.pid, stopFlag, []);
    await sleep(LONG_MS);
    stopFlag.done = true;
    const maxRssKb = await rssPromise;
    tracer.kill("SIGINT");
    const exit = await waitForExit(tracer);
    check("sesi panjang: tracer keluar 0 setelah SIGINT", exit.code === 0, `code=${exit.code}`);
    const { rows, broken } = await readRows(outFile);
    const consoleRows = rows.filter((r) => r.type === "Runtime.consoleAPICalled").length;
    const ended = rows.find((r) => r.type === "tracer.session_ended");
    console.log(`  sesi panjang: ${rows.length} baris, ${consoleRows} console, RSS puncak ${maxRssKb === null ? "tak terukur" : Math.round(maxRssKb / 1024) + " MB"}`);
    check("sesi panjang: >= 40 baris", rows.length >= 40, `rows=${rows.length}`);
    check("sesi panjang: >= 20 panggilan konsol", consoleRows >= 20, `console=${consoleRows}`);
    check("sesi panjang: seq bersambung", seqContiguous(rows));
    check("sesi panjang: mono_ms tak turun", monoNonDecreasing(rows));
    check("sesi panjang: session_ended beralasan signal-SIGINT", ended?.data?.reason === "signal-SIGINT", `reason=${ended?.data?.reason}`);
    check("sesi panjang: tanpa baris rusak", broken === 0, `broken=${broken}`);
    if (maxRssKb === null) {
      console.log("  DILEWATI: RSS tak terukur di platform ini");
    } else {
      check("sesi panjang: RSS puncak < 256 MB", maxRssKb < 256 * 1024, `rss=${Math.round(maxRssKb / 1024)} MB`);
    }
    serveProc.kill("SIGKILL");
    serveProc = null;
    await sleep(500);
  }

  // ---------- Uji 3: beban besar ----------
  console.log("== uji 3: beban besar ==");
  {
    const outFile = join(workdir, "beban.jsonl");
    serveProc = startServe(lpBin, SERVE_PORT);
    await waitForVersion(SERVE_PORT);
    const tracer = startTracer(
      ["--session", "robust-beban", "--navigate", `${base}/beban.html`, "--wait-ms", "4000"],
      outFile,
    );
    const exit = await waitForExit(tracer, 60000);
    check("beban besar: tracer keluar 0", exit.code === 0, `code=${exit.code}`);
    const { rows, broken } = await readRows(outFile);
    const req = rows.filter((r) => r.type === "Network.requestWillBeSent").length;
    const fin = rows.filter((r) => r.type === "Network.loadingFinished").length;
    const imgReq = rows.filter(
      (r) => r.type === "Network.requestWillBeSent" && String(r.data?.request?.url ?? "").includes("/img?"),
    ).length;
    console.log(`  beban besar: ${rows.length} baris, requestWillBeSent=${req}, loadingFinished=${fin}, imgReq=${imgReq} (info: Lightpanda 1.0.2 tidak me-fetch <img>)`);
    check("beban besar: requestWillBeSent >= 95 (dari 101 fetch+dokumen)", req >= 95, `req=${req}`);
    check("beban besar: loadingFinished >= 95", fin >= 95, `fin=${fin}`);
    check("beban besar: seq bersambung", seqContiguous(rows));
    check("beban besar: tanpa baris rusak", broken === 0, `broken=${broken}`);
    serveProc.kill("SIGKILL");
    serveProc = null;
  }
} finally {
  if (serveProc) serveProc.kill("SIGKILL");
  httpServer.close();
}

console.log(`\nUji ketahanan: ${passed} lulus, ${failures.length} gagal`);
if (failures.length > 0) {
  console.log("GAGAL:", failures.join(", "));
  process.exit(1);
}
