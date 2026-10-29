// benchmark.mjs — Benchmark overhead Bab 3.7 (gerbang M1).
// Median wall-clock 5 ulangan dengan tracer vs 5 ulangan tanpa tracer,
// Lightpanda 1.0.2 yang sama, beban kerja dan urutan navigasi yang sama,
// telemetri dimatikan di kedua sisi. CPU tracer dihitung terpisah.
// Menulis benchmark-result.json di root proyek. Keluar 0 bila selesai
// (vonis ada di file hasil); keluar bukan nol bila benchmark gagal jalan.
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import { stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LP_BIN =
  process.env.LP_BIN || (await findOnPath("lightpanda")) || "/tmp/lp-m1/lightpanda";
const SERVE_PORT = Number(process.env.BENCH_SERVE_PORT || 9233);
const HTTP_PORT = Number(process.env.BENCH_HTTP_PORT || 8773);
const REPS = Number(process.env.BENCH_REPS || 5);
const WAIT_MS = Number(process.env.BENCH_WAIT_MS || 1200);

async function findOnPath(name) {
  return new Promise((resolve) => {
    execFile("which", [name], (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ---- Server demo lokal (beban kerja tetap) ----
const okHtml = `<!doctype html><html><head><title>bench ok</title></head><body>
<script>console.log('BENCH-OK');</script><p>ok</p></body></html>`;
const throwHtml = `<!doctype html><html><head><title>bench throw</title></head><body>
<script>console.log('BENCH-LOG'); console.warn('BENCH-WARN'); console.error('BENCH-ERROR');</script>
<script>throw new Error('BENCH-UNCAUGHT');</script>
<script>fetch('http://127.0.0.1:9/bench-fail').catch(()=>{});</script>
<p>throw</p></body></html>`;
const multiHtml = `<!doctype html><html><head><title>bench multi</title>
<script src="/s1.js"></script><script src="/s2.js"></script><script src="/s3.js"></script></head><body>
<script>console.log('BENCH-MULTI'); fetch('/echo').catch(()=>{});</script><p>multi</p></body></html>`;
const jsFile = (n) => `console.log('BENCH-SCRIPT-${n}');`;

const httpServer = http.createServer((req, res) => {
  if (req.url === "/ok.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(okHtml);
  } else if (req.url === "/throw.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(throwHtml);
  } else if (req.url === "/multi.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(multiHtml);
  } else if (req.url === "/echo") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  } else if (/^\/s[123]\.js$/.test(req.url || "")) {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(jsFile(req.url));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const URLS = [
  `http://127.0.0.1:${HTTP_PORT}/ok.html`,
  `http://127.0.0.1:${HTTP_PORT}/throw.html`,
  `http://127.0.0.1:${HTTP_PORT}/multi.html`,
  `http://127.0.0.1:${HTTP_PORT}/ok.html`,
];

async function waitForVersion(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const body = await res.json();
        return body["Lightpanda-Version"] || "unknown";
      }
    } catch {
      /* belum siap */
    }
    await sleep(250);
  }
  throw new Error(`serve di port ${port} tidak siap dalam ${timeoutMs} ms`);
}

function startServe(port) {
  const child = spawn(LP_BIN, ["serve", "--host", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
    stdio: "ignore",
  });
  return child;
}

function kill(child) {
  try {
    child.kill("SIGKILL");
  } catch {
    /* abaikan */
  }
}

/** Baca waktu CPU (utime+stime, detik) proses dari /proc/<pid>/stat. */
async function readCpuSeconds(pid) {
  try {
    const { readFile } = await import("node:fs/promises");
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const utime = Number(afterComm[11]);
    const stime = Number(afterComm[12]);
    return (utime + stime) / 100;
  } catch {
    return null;
  }
}

function runChild(argv, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    const t0 = performance.now();
    let lastCpu = null;
    const sampler = setInterval(async () => {
      const cpu = await readCpuSeconds(child.pid);
      if (cpu !== null) lastCpu = cpu;
    }, 100);
    child.on("error", (e) => {
      clearInterval(sampler);
      reject(e);
    });
    child.on("exit", (code) => {
      clearInterval(sampler);
      resolve({ code, wallMs: performance.now() - t0, cpuSeconds: lastCpu });
    });
  });
}

async function main() {
  console.log(`Benchmark: binary ${LP_BIN}, ${REPS} ulangan, wait ${WAIT_MS} ms`);
  await new Promise((resolve) => httpServer.listen(HTTP_PORT, "127.0.0.1", resolve));
  const cdp = `ws://127.0.0.1:${SERVE_PORT}`;
  const results = { noTracer: [], tracer: [], tracerCpu: [], tracerBytes: [] };

  // Sisi tanpa tracer.
  let serve = startServe(SERVE_PORT);
  try {
    const version = await waitForVersion(SERVE_PORT);
    console.log(`  serve siap, Lightpanda-Version: ${version}`);
    for (let i = 0; i < REPS; i++) {
      const r = await runChild([
        process.execPath,
        join(ROOT, "tests", "bench-driver.mjs"),
        "--cdp",
        cdp,
        "--urls",
        URLS.join(","),
        "--wait-ms",
        String(WAIT_MS),
      ]);
      if (r.code !== 0) throw new Error(`bench-driver ulangan ${i + 1} keluar ${r.code}`);
      results.noTracer.push(Math.round(r.wallMs));
      console.log(`  tanpa tracer #${i + 1}: ${Math.round(r.wallMs)} ms`);
    }
  } finally {
    kill(serve);
    await sleep(500);
  }

  // Sisi dengan tracer (serve baru, kondisi sama).
  serve = startServe(SERVE_PORT);
  try {
    await waitForVersion(SERVE_PORT);
    for (let i = 0; i < REPS; i++) {
      const outFile = join(ROOT, `bench-trace-${i + 1}.jsonl`);
      const r = await runChild(
        [
          process.execPath,
          join(ROOT, "dist", "cli.js"),
          "--cdp",
          cdp,
          "--output",
          outFile,
          "--session",
          `bench-${i + 1}`,
          ...URLS.flatMap((u) => ["--navigate", u]),
          "--wait-ms",
          String(WAIT_MS),
        ],
        { LP_DEBUG_CDP: "" },
      );
      if (r.code !== 0) throw new Error(`tracer ulangan ${i + 1} keluar ${r.code}`);
      results.tracer.push(Math.round(r.wallMs));
      results.tracerCpu.push(r.cpuSeconds);
      results.tracerBytes.push((await stat(outFile)).size);
      console.log(
        `  dengan tracer #${i + 1}: ${Math.round(r.wallMs)} ms (CPU tracer ${r.cpuSeconds === null ? "?" : r.cpuSeconds.toFixed(2)} dtk, trace ${(await stat(outFile)).size} byte)`,
      );
    }
  } finally {
    kill(serve);
    httpServer.close();
  }

  const medianNoTracer = median(results.noTracer);
  const medianTracer = median(results.tracer);
  const overheadPct = ((medianTracer - medianNoTracer) / medianNoTracer) * 100;
  const verdict = overheadPct <= 5 ? "LULUS" : "GAGAL";
  const report = {
    generatedAt: new Date().toISOString(),
    lightpandaVersion: "1.0.2",
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    telemetry: "off (LIGHTPANDA_DISABLE_TELEMETRY=true di kedua sisi)",
    workload: { urls: URLS, waitMs: WAIT_MS, reps: REPS },
    noTracer: { timesMs: results.noTracer, medianMs: medianNoTracer },
    tracer: {
      timesMs: results.tracer,
      medianMs: medianTracer,
      cpuSecondsPerRep: results.tracerCpu,
      traceBytesPerRep: results.tracerBytes,
    },
    overheadPct: Math.round(overheadPct * 100) / 100,
    gatePct: 5,
    verdict,
  };
  await writeFile(join(ROOT, "benchmark-result.json"), JSON.stringify(report, null, 2));
  console.log(
    `\nMedian tanpa tracer: ${medianNoTracer} ms | median dengan tracer: ${medianTracer} ms | overhead: ${overheadPct.toFixed(2)}% | vonis: ${verdict}`,
  );
}

main().catch((e) => {
  console.error("Benchmark GAGAL:", e.message);
  process.exit(1);
});
