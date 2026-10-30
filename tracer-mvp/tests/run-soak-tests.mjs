// run-soak-tests.mjs — Uji rendam (soak) manual, BUKAN bagian rantai
// `npm test` (SOAK-DESIGN.md): sesi denyut selama LP_SOAK_SECONDS
// (default 300) untuk membuktikan memori datar + laju stabil dalam
// durasi yang terlalu panjang untuk CI. Dijalankan manual:
//   LP_BIN=<path binary 1.0.2> node tests/run-soak-tests.mjs
// Build (tsc) dijalankan dulu; gagal keras bila binary tak ditemukan.
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVE_PORT = Number(process.env.SOAK_SERVE_PORT || 9253);
const HTTP_PORT = Number(process.env.SOAK_HTTP_PORT || 8788);
const SECONDS = Math.max(30, Number(process.env.LP_SOAK_SECONDS || 300));
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
  for (const cand of [join(ROOT, "vendor", "lightpanda"), "/tmp/lp-m1/lightpanda"]) {
    try {
      await stat(cand);
      return cand;
    } catch {}
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
    } catch {}
    await sleep(200);
  }
  throw new Error("serve tidak siap");
}

async function waitForExit(child, timeoutMs = 30000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function rowsCount(file) {
  try {
    const text = await readFile(file, "utf8");
    return text.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function readRows(file) {
  const text = await readFile(file, "utf8");
  const rows = [];
  let broken = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      broken++;
    }
  }
  return { rows, broken };
}

async function main() {
  await new Promise((resolve, reject) => {
    execFile(join(ROOT, "node_modules", ".bin", "tsc"), { cwd: ROOT }, (err) => {
      if (err) reject(new Error("build tsc gagal"));
      else resolve();
    });
  });
  const lpBin = await findLightpanda();
  check("binary Lightpanda 1.0.2 ditemukan — set LP_BIN / PATH / vendor/", lpBin !== null);
  if (lpBin === null) {
    console.log(`\n${passed} lulus, ${failures.length} gagal`);
    process.exit(1);
  }
  const { stdout: verOut } = await new Promise((resolve, reject) => {
    execFile(lpBin, ["version"], (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout).trim() })));
  });
  check("binary 1.0.2", verOut === "1.0.2", verOut);

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/denyut.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><title>Denyut</title>` +
          `<script>let i=0;` +
          `setInterval(()=>{console.log('denyut-'+(i++));},500);setInterval(()=>{fetch('/denyut?n='+Date.now()).catch(()=>{});},1000);` +
          `</script><h1>soak</h1>`,
      );
    } else if (url.pathname === "/denyut") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const workdir = await mkdtemp(join(tmpdir(), "soak-test-"));
  const outFile = join(workdir, "soak.jsonl");
  await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
  const serve = startServe(lpBin, SERVE_PORT);
  try {
    await waitForVersion(SERVE_PORT);
    const tracer = spawn(
      process.execPath,
      [
        join(ROOT, "dist", "cli.js"),
        "--cdp",
        CDP,
        "--output",
        outFile,
        "--session",
        "soak",
        "--navigate",
        `http://127.0.0.1:${HTTP_PORT}/denyut.html`,
        "--stay",
      ],
      { stdio: "ignore" },
    );
    // Tunggu >= 3 baris sebelum mulai menghitung durasi soak.
    for (let i = 0; i < 50; i++) {
      if ((await rowsCount(outFile)) >= 3) break;
      await sleep(200);
    }
    check("tracer menulis >= 3 baris sebelum soak", (await rowsCount(outFile)) >= 3);

    // Sampling tiap 5 detik: RSS (Linux) + jumlah baris file.
    const rssSamples = [];
    const rowSamples = [];
    const t0 = Date.now();
    const deadline = t0 + SECONDS * 1000;
    let lastLog = 0;
    while (Date.now() < deadline) {
      if (process.platform === "linux") {
        try {
          const status = await readFile(`/proc/${tracer.pid}/status`, "utf8");
          const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
          if (m) rssSamples.push(Number(m[1]));
        } catch {}
      }
      rowSamples.push(await rowsCount(outFile));
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (elapsed - lastLog >= 30) {
        lastLog = elapsed;
        console.log(`  ... ${elapsed}/${SECONDS} dtk, baris=${rowSamples[rowSamples.length - 1]}`);
      }
      await sleep(5000);
    }
    tracer.kill("SIGINT");
    const exit = await waitForExit(tracer);
    check("soak: tracer keluar 0 setelah SIGINT", exit.code === 0, `code=${exit.code}`);
    const { rows, broken } = await readRows(outFile);
    const consoleRows = rows.filter((r) => r.type === "Runtime.consoleAPICalled").length;
    const denyutReqs = rows.filter(
      (r) =>
        r.type === "Network.requestWillBeSent" &&
        typeof r.data?.request?.url === "string" &&
        r.data.request.url.includes("/denyut"),
    ).length;
    const ended = rows.find((r) => r.type === "tracer.session_ended");
    const maxRssKb = rssSamples.length > 0 ? Math.max(...rssSamples) : null;
    console.log(
      `  soak ${SECONDS} dtk: ${rows.length} baris, ${consoleRows} console, ${denyutReqs} denyut, RSS puncak ${maxRssKb === null ? "tak terukur" : Math.round(maxRssKb / 1024) + " MB"}`,
    );
    const minRows = Math.floor(SECONDS * 5 * 0.7);
    check(`soak: >= ${minRows} baris`, rows.length >= minRows, `rows=${rows.length}`);
    check(`soak: >= ${Math.floor(SECONDS * 2 * 0.7)} panggilan konsol`, consoleRows >= Math.floor(SECONDS * 2 * 0.7), `console=${consoleRows}`);
    check(`soak: >= ${Math.floor(SECONDS * 0.7)} request denyut`, denyutReqs >= Math.floor(SECONDS * 0.7), `denyut=${denyutReqs}`);
    const seqOk = rows.every((r, i) => r.seq === i + 1);
    check("soak: seq bersambung", seqOk);
    check(
      "soak: mono_ms tak turun",
      rows.every((r, i) => i === 0 || r.mono_ms >= rows[i - 1].mono_ms),
    );
    check("soak: session_ended beralasan signal-SIGINT", ended?.data?.reason === "signal-SIGINT", `reason=${ended?.data?.reason}`);
    check("soak: tanpa baris rusak", broken === 0, `broken=${broken}`);
    if (maxRssKb === null) {
      console.log("  DILEWATI: RSS tak terukur di platform ini");
    } else {
      check("soak: RSS puncak < 256 MB", maxRssKb < 256 * 1024, `rss=${Math.round(maxRssKb / 1024)} MB`);
      if (rssSamples.length >= 12) {
        const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
        const early = avg(rssSamples.slice(2, 6));
        const late = avg(rssSamples.slice(-6));
        console.log(`  RSS awal (dtk 10-30): ${Math.round(early / 1024)} MB, akhir (30 dtk terakhir): ${Math.round(late / 1024)} MB`);
        check("soak: RSS akhir <= 1,5x RSS awal (datar)", late <= early * 1.5, `awal=${Math.round(early / 1024)} MB akhir=${Math.round(late / 1024)} MB`);
      } else {
        console.log(`  DILEWATI: sampel RSS hanya ${rssSamples.length} (< 12)`);
      }
    }
    // Laju stabil: jendela 30 detik (6 sampel @ 5 dtk) setelah jendela
    // pertama >= 50% jendela pertama.
    if (rowSamples.length >= 12) {
      const windows = [];
      for (let i = 6; i < rowSamples.length; i += 6) {
        windows.push(rowSamples[i] - rowSamples[i - 6]);
      }
      console.log(`  jendela 30 dtk (baris): ${windows.join(", ")}`);
      const first = windows[0];
      const stable = windows.slice(1).every((w) => w >= first * 0.5);
      check("soak: tiap jendela >= 50% jendela pertama", stable, `jendela=${windows.join(",")}`);
    } else {
      console.log(`  DILEWATI: sampel baris hanya ${rowSamples.length} (< 12)`);
    }
  } finally {
    serve.kill("SIGKILL");
    httpServer.close();
  }

  console.log(`\nUji soak: ${passed} lulus, ${failures.length} gagal.`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
