// run-resource-tests.mjs — Uji kebijakan resource + antrean tugas
// (RESOURCE-DESIGN.md). Pola harness sama dengan rangkaian robust:
// build tsc dulu, resolver binary, waitForExit berpenjaga.
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import {
  mkdtemp,
  readFile,
  stat,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVE_PORT = Number(process.env.RESOURCE_SERVE_PORT || 9255);
const HTTP_PORT = Number(process.env.RESOURCE_HTTP_PORT || 8790);
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

function startTracer(args, outFile) {
  return spawn(
    process.execPath,
    [
      join(ROOT, "dist", "cli.js"),
      "--cdp",
      CDP,
      "--output",
      outFile,
      ...args,
    ],
    { stdio: "ignore" },
  );
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

async function waitForHits(hits, path, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (hits.includes(path)) return true;
    await sleep(200);
  }
  return hits.includes(path);
}

async function main() {
  await new Promise((resolve, reject) => {
    execFile(join(ROOT, "node_modules", ".bin", "tsc"), { cwd: ROOT }, (err) => {
      if (err) reject(new Error("build tsc gagal"));
      else resolve();
    });
  });
  const lpBin = await findLightpanda();
  check("binary Lightpanda 1.0.2 ditemukan", lpBin !== null);
  if (lpBin === null) {
    console.log(`\nUji resource: ${passed} lulus, ${failures.length} gagal`);
    process.exit(1);
  }

  const hits = [];
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push(url.pathname);
    if (url.pathname === "/denyut.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><title>Denyut</title>` +
          `<script>let i=0;` +
          `setInterval(()=>{console.log('denyut-'+(i++));},500);setInterval(()=>{fetch('/denyut?n='+Date.now()).catch(()=>{});},1000);` +
          `</script><h1>denyut</h1>`,
      );
    } else if (url.pathname === "/denyut") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>${url.pathname}</title><h1>${url.pathname}</h1>`);
    }
  });
  const workdir = await mkdtemp(join(tmpdir(), "resource-test-"));
  await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
  const serve = startServe(lpBin, SERVE_PORT);
  try {
    await waitForVersion(SERVE_PORT);
    const denyut = `http://127.0.0.1:${HTTP_PORT}/denyut.html`;

    console.log("== uji 1: batas baris ==");
    {
      const out = join(workdir, "rows.jsonl");
      const t = startTracer(
        ["--session", "rows", "--navigate", denyut, "--stay", "--max-rows", "30"],
        out,
      );
      const exit = await waitForExit(t, 30000);
      const { rows, broken } = await readRows(out);
      const ended = rows.find((r) => r.type === "tracer.session_ended");
      const started = rows.find((r) => r.type === "tracer.session_started");
      check("batas baris: tracer keluar 0", exit.code === 0, `code=${exit.code}`);
      check("batas baris: alasan row-limit", ended?.data?.reason === "row-limit", `reason=${ended?.data?.reason}`);
      check(
        "batas baris: error E_RESOURCE_LIMIT max-rows",
        ended?.data?.error?.code === "E_RESOURCE_LIMIT" &&
          ended?.data?.error?.policy === "max-rows",
        JSON.stringify(ended?.data?.error),
      );
      check("batas baris: total baris <= 31", rows.length <= 31, `rows=${rows.length}`);
      check("batas baris: total baris >= 30", rows.length >= 30, `rows=${rows.length}`);
      check("batas baris: tanpa baris rusak", broken === 0, `broken=${broken}`);
      check("batas baris: limits tercatat di session_started", started?.data?.limits?.maxRows === 30, JSON.stringify(started?.data?.limits));
    }

    console.log("== uji 2: batas durasi ==");
    {
      const out = join(workdir, "seconds.jsonl");
      const t0 = Date.now();
      const t = startTracer(
        ["--session", "seconds", "--navigate", denyut, "--stay", "--max-seconds", "3"],
        out,
      );
      const exit = await waitForExit(t, 30000);
      const elapsed = (Date.now() - t0) / 1000;
      const { rows } = await readRows(out);
      const ended = rows.find((r) => r.type === "tracer.session_ended");
      check("batas durasi: tracer keluar 0", exit.code === 0, `code=${exit.code}`);
      check("batas durasi: alasan time-limit", ended?.data?.reason === "time-limit", `reason=${ended?.data?.reason}`);
      check("batas durasi: berakhir ~3 dtk", elapsed >= 3 && elapsed < 10, `elapsed=${elapsed.toFixed(1)}`);
    }

    console.log("== uji 3: batas RSS ==");
    {
      const out = join(workdir, "rss.jsonl");
      const t = startTracer(
        ["--session", "rss", "--navigate", denyut, "--stay", "--max-rss-mb", "1"],
        out,
      );
      const exit = await waitForExit(t, 30000);
      const { rows } = await readRows(out);
      const ended = rows.find((r) => r.type === "tracer.session_ended");
      check("batas RSS: tracer keluar 0", exit.code === 0, `code=${exit.code}`);
      check("batas RSS: alasan rss-limit", ended?.data?.reason === "rss-limit", `reason=${ended?.data?.reason}`);
      check(
        "batas RSS: error E_RESOURCE_LIMIT max-rss-mb",
        ended?.data?.error?.code === "E_RESOURCE_LIMIT" &&
          ended?.data?.error?.policy === "max-rss-mb",
        JSON.stringify(ended?.data?.error),
      );
    }

    console.log("== uji 4: antrean statis ==");
    {
      hits.length = 0;
      const qfile = join(workdir, "queue.jsonl");
      await writeFile(
        qfile,
        [
          JSON.stringify({ url: `http://127.0.0.1:${HTTP_PORT}/a.html`, waitMs: 300 }),
          JSON.stringify({ url: `http://127.0.0.1:${HTTP_PORT}/b.html`, waitMs: 300 }),
          "",
        ].join("\n"),
      );
      const out = join(workdir, "queue.jsonl");
      const t = startTracer(
        ["--session", "queue", "--task-queue", qfile, "--wait-ms", "300"],
        out,
      );
      const exit = await waitForExit(t, 30000);
      const { rows } = await readRows(out);
      const ended = rows.find((r) => r.type === "tracer.session_ended");
      const ia = hits.indexOf("/a.html");
      const ib = hits.indexOf("/b.html");
      check("antrean: tracer keluar 0", exit.code === 0, `code=${exit.code}`);
      check("antrean: /a.html ternavigasi", ia !== -1, `hits=${hits.join(",")}`);
      check("antrean: /b.html ternavigasi sesudah /a.html", ib > ia, `ia=${ia} ib=${ib}`);
      check("antrean: alasan tasks-done", ended?.data?.reason === "tasks-done", `reason=${ended?.data?.reason}`);
      check(
        "antrean: statistik done=2 skipped=0 remaining=0",
        ended?.data?.queue?.done === 2 &&
          ended?.data?.queue?.skipped === 0 &&
          ended?.data?.queue?.remaining === 0,
        JSON.stringify(ended?.data?.queue),
      );
    }

    console.log("== uji 5: antrean + stay + tugas susulan ==");
    {
      hits.length = 0;
      const qfile = join(workdir, "queue-live.jsonl");
      await writeFile(
        qfile,
        JSON.stringify({ url: `http://127.0.0.1:${HTTP_PORT}/a.html`, waitMs: 300 }) + "\n",
      );
      const out = join(workdir, "queue-live-out.jsonl");
      const t = startTracer(
        ["--session", "queue-live", "--task-queue", qfile, "--stay", "--queue-poll-ms", "200", "--wait-ms", "300"],
        out,
      );
      const sawA = await waitForHits(hits, "/a.html");
      check("antrean live: tugas awal dikerjakan", sawA, `hits=${hits.join(",")}`);
      await appendFile(
        qfile,
        [
          "bukan json",
          JSON.stringify({ url: `http://127.0.0.1:${HTTP_PORT}/x.html`, connection: 5 }),
          JSON.stringify({ url: `http://127.0.0.1:${HTTP_PORT}/b.html`, waitMs: 300 }),
        ].join("\n") + "\n",
      );
      const sawB = await waitForHits(hits, "/b.html");
      check("antrean live: tugas susulan dikerjakan", sawB, `hits=${hits.join(",")}`);
      t.kill("SIGINT");
      const exit = await waitForExit(t, 30000);
      const { rows } = await readRows(out);
      const ended = rows.find((r) => r.type === "tracer.session_ended");
      check("antrean live: tracer keluar 0 setelah SIGINT", exit.code === 0, `code=${exit.code}`);
      check(
        "antrean live: done=2 skipped=2 (rusak + connection di luar jangkauan)",
        ended?.data?.queue?.done === 2 && ended?.data?.queue?.skipped === 2,
        JSON.stringify(ended?.data?.queue),
      );
    }

    console.log("== uji 6: validasi CLI ==");
    {
      const runCli = (args) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), ...args], {
            stdio: "ignore",
          });
          waitForExit(child, 10000).then(resolve);
        });
      const qfile = join(workdir, "queue-valid.jsonl");
      await writeFile(qfile, '{"url":"http://127.0.0.1:9/a.html"}\n');
      const base = ["--cdp", CDP, "--output", join(workdir, "valid.jsonl")];
      const e1 = await runCli([...base, "--max-rows", "0"]);
      check("validasi: --max-rows 0 keluar 2", e1.code === 2, `code=${e1.code}`);
      const e2 = await runCli([...base, "--task-queue", qfile, "--navigate", "http://127.0.0.1:9/a.html"]);
      check("validasi: antrean + navigate keluar 2", e2.code === 2, `code=${e2.code}`);
      const e3 = await runCli([...base, "--task-queue", join(workdir, "tidak-ada.jsonl")]);
      check("validasi: antrean hilang keluar 2", e3.code === 2, `code=${e3.code}`);
      const e4 = await runCli([...base, "--queue-poll-ms", "10"]);
      check("validasi: --queue-poll-ms 10 keluar 2", e4.code === 2, `code=${e4.code}`);
    }
  } finally {
    serve.kill("SIGKILL");
    httpServer.close();
  }

  console.log(`\nUji resource: ${passed} lulus, ${failures.length} gagal.`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
