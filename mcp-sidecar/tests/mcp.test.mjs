// mcp.test.mjs — Uji M3 lewat klien MCP SDK sungguhan (transport stdio).
//
// Setiap uji men-spawn server sungguhan (node dist/cli.js --trace ...)
// dan memanggil tool lewat Client @modelcontextprotocol/sdk, bukan
// pemanggilan fungsi internal. Jalankan: npm test (build dulu).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

const SERVER = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REAL_FIXTURE = fileURLToPath(
  new URL("../../viewer/tests/fixtures/real-trace.jsonl", import.meta.url),
);

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-mcp-test-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function withClient(tracePath, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, "--trace", tracePath],
    stderr: "pipe",
  });
  const stderr = transport.stderr;
  if (stderr !== null) {
    stderr.resume();
  }
  const client = new Client(
    { name: "m3-test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function callToolJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args ?? {} });
  assert.notEqual(result.isError, true, `tool ${name} mengembalikan error: ${JSON.stringify(result)}`);
  const item = result.content.find((c) => c.type === "text");
  assert.ok(item, `hasil tool ${name} harus berisi konten teks`);
  return JSON.parse(item.text);
}

/** Tool yang ditolak: terima penolakan protokol ATAU hasil isError. */
async function expectToolError(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args ?? {} });
    assert.equal(
      result.isError,
      true,
      `tool ${name} seharusnya ditolak, hasil: ${JSON.stringify(result)}`,
    );
  } catch {
    // Penolakan di tingkat protokol juga merupakan penolakan yang sah.
  }
}

/** Hitungan independen dari file (tidak memakai kode src). */
function independentCounts(text) {
  const rows = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const byType = {};
  for (const row of rows) {
    byType[row.type] = (byType[row.type] ?? 0) + 1;
  }
  const pageKeys = new Set();
  for (const row of rows.filter((r) => r.type === "Page.frameNavigated")) {
    const raw = row.data.frame?.url ?? row.data.url;
    const url = new URL(raw);
    pageKeys.add(url.host + url.pathname);
  }
  const consoleLevels = {};
  for (const row of rows.filter((r) => r.type === "Runtime.consoleAPICalled")) {
    const level = row.data.type === "warn" ? "warning" : row.data.type;
    consoleLevels[level] = (consoleLevels[level] ?? 0) + 1;
  }
  return {
    rows: rows.length,
    byType,
    pages: pageKeys.size,
    requests: byType["Network.requestWillBeSent"] ?? 0,
    exceptions: byType["Runtime.exceptionThrown"] ?? 0,
    failedRequests: byType["Network.loadingFailed"] ?? 0,
    duration: rows[rows.length - 1].mono_ms - rows[0].mono_ms,
    consoleLevels,
    session: rows[0].session,
    version: rows[0].lightpanda_version,
  };
}

test("tools/list tepat dua tool dengan nama persis", async () => {
  await withClient(REAL_FIXTURE, async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["annotate_trace", "get_trace_summary"],
    );
    assert.equal(tools.length, 2);
  });
});

test("tool tak dikenal ditolak", async () => {
  await withClient(REAL_FIXTURE, async (client) => {
    await expectToolError(client, "get_trace", {});
    await expectToolError(client, "list_traces", {});
  });
});

test("get_trace_summary atas fixture nyata cocok dengan hitungan independen", async (t) => {
  const dir = await tmpDir(t);
  const copy = path.join(dir, "trace.jsonl");
  await fs.copyFile(REAL_FIXTURE, copy);
  const expected = independentCounts(await fs.readFile(copy, "utf8"));

  await withClient(copy, async (client) => {
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.equal(summary.empty, false);
    assert.equal(summary.traceExists, true);
    assert.equal(summary.rows, expected.rows);
    assert.equal(summary.rows, 41);
    assert.equal(summary.skippedLines, 0);
    assert.equal(summary.session, expected.session);
    assert.equal(summary.session, "m2-fixture");
    assert.equal(summary.lightpandaVersion, expected.version);
    assert.equal(summary.lightpandaVersion, "1.0.2");
    assert.equal(summary.pages, expected.pages);
    assert.equal(summary.pages, 2);
    assert.equal(summary.requests, expected.requests);
    assert.equal(summary.requests, 4);
    assert.equal(summary.errors, expected.exceptions + expected.failedRequests);
    assert.equal(summary.errors, 3);
    assert.deepEqual(summary.errorBreakdown, { exceptions: 2, failedRequests: 1 });
    assert.equal(summary.durationMs, expected.duration);
    assert.equal(summary.durationMs, 2433);
    assert.equal(summary.durationSource, "mono_ms");
    assert.deepEqual(summary.eventsByType, expected.byType);
    assert.deepEqual(summary.consoleByLevel, expected.consoleLevels);
    assert.deepEqual(summary.consoleByLevel, { log: 1, warning: 1, error: 1 });
    assert.deepEqual(summary.hosts, ["127.0.0.1:8772", "127.0.0.1:9"]);
    assert.ok(summary.paths.includes("/ok.html"));
    assert.ok(summary.paths.includes("/throw.html"));
    assert.ok(summary.paths.includes("/echo"));
    // Tidak ada isi mentah: tanpa query, tanpa teks konsol, tanpa rahasia.
    const blob = JSON.stringify(summary);
    assert.ok(!blob.includes("token="), "ringkasan tidak boleh memuat parameter query");
    assert.ok(!blob.includes("q=hello"), "ringkasan tidak boleh memuat parameter query");
    assert.ok(!blob.includes("M2-SECRET"), "ringkasan tidak boleh memuat rahasia");
    assert.ok(!blob.includes("M2-LOG"), "ringkasan tidak boleh memuat teks konsol");
    assert.ok(!blob.includes("[REDACTED]"), "ringkasan tidak boleh memuat nilai header");
  });
});

test("get_trace_summary atas file kosong dan file tidak ada: ringkasan kosong, bukan error", async (t) => {
  const dir = await tmpDir(t);
  const emptyPath = path.join(dir, "kosong.jsonl");
  await fs.writeFile(emptyPath, "");
  const missingPath = path.join(dir, "tidak-ada.jsonl");

  await withClient(emptyPath, async (client) => {
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.equal(summary.empty, true);
    assert.equal(summary.traceExists, true);
    assert.equal(summary.rows, 0);
    assert.equal(summary.pages, 0);
    assert.equal(summary.requests, 0);
    assert.equal(summary.errors, 0);
    assert.equal(summary.durationMs, null);
    assert.ok(typeof summary.explanation === "string" && summary.explanation.length > 0);
  });

  await withClient(missingPath, async (client) => {
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.equal(summary.empty, true);
    assert.equal(summary.traceExists, false);
    assert.equal(summary.rows, 0);
    assert.ok(typeof summary.explanation === "string" && summary.explanation.length > 0);
  });
});

test("get_trace_summary dengan filter kategori dan penolakan filter isi", async (t) => {
  const dir = await tmpDir(t);
  const copy = path.join(dir, "trace.jsonl");
  await fs.copyFile(REAL_FIXTURE, copy);

  await withClient(copy, async (client) => {
    const errorOnly = await callToolJson(client, "get_trace_summary", { category: "error" });
    assert.equal(errorOnly.filter, "error");
    assert.equal(errorOnly.rows, 3);
    assert.equal(errorOnly.errors, 3);
    assert.equal(errorOnly.requests, 0);
    assert.equal(errorOnly.pages, 0);
    const networkOnly = await callToolJson(client, "get_trace_summary", { category: "network" });
    // 4 requestWillBeSent + 3 responseReceived + 3 loadingFinished = 10;
    // Network.loadingFailed (1) masuk kategori "error", bukan "network".
    assert.equal(networkOnly.rows, 10);
    assert.equal(networkOnly.requests, 4);
    // Kategori tak dikenal ditolak (validasi skema).
    await expectToolError(client, "get_trace_summary", { category: "isi-rahasia" });
  });
});

test("baris rusak dilewati dan dihitung, tidak menggagalkan ringkasan", async (t) => {
  const dir = await tmpDir(t);
  const tracePath = path.join(dir, "trace.jsonl");
  const good1 =
    '{"ts":"2026-10-29T06:00:00.000Z","mono_ms":0,"seq":1,"session":"s1","lightpanda_version":"1.0.2","type":"tracer.session_started","data":{}}';
  const good2 =
    '{"ts":"2026-10-29T06:00:01.000Z","mono_ms":1000,"seq":2,"session":"s1","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"request":{"url":"http://127.0.0.1:8772/ok.html"}}}';
  await fs.writeFile(
    tracePath,
    [good1, "ini bukan json{", '{"tanpaType":true}', "", good2].join("\n") + "\n",
  );

  await withClient(tracePath, async (client) => {
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.equal(summary.rows, 2);
    assert.equal(summary.skippedLines, 2);
    assert.equal(summary.requests, 1);
    assert.equal(summary.durationMs, 1000);
  });
});

test("annotate_trace menambahkan baris seq berlanjut, file lama utuh", async (t) => {
  const dir = await tmpDir(t);
  const copy = path.join(dir, "trace.jsonl");
  await fs.copyFile(REAL_FIXTURE, copy);
  const before = await fs.readFile(copy, "utf8");
  assert.ok(before.endsWith("\n"));

  await withClient(copy, async (client) => {
    const res1 = await callToolJson(client, "annotate_trace", {
      text: "Langkah penting: halaman throw dimuat",
    });
    assert.equal(res1.annotated, true);
    assert.equal(res1.seq, 42);
    assert.equal(res1.session, "m2-fixture");
    assert.equal(res1.lightpandaVersion, "1.0.2");

    const res2 = await callToolJson(client, "annotate_trace", {
      text: "Anotasi kedua",
      session: "m2-fixture",
    });
    assert.equal(res2.seq, 43);

    // Ringkasan pada sesi yang sama langsung melihat anotasi baru.
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.equal(summary.rows, 43);
    assert.equal(summary.annotations, 2);
  });

  const after = await fs.readFile(copy, "utf8");
  assert.ok(after.startsWith(before), "isi lama harus utuh sebagai awalan file");
  const lines = after.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 43);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.seq, 43);
  assert.equal(last.type, "tracer.annotation");
  assert.equal(last.session, "m2-fixture");
  assert.equal(last.lightpanda_version, "1.0.2");
  assert.equal(last.data.text, "Anotasi kedua");
  assert.equal(typeof last.ts, "string");
  assert.equal(typeof last.mono_ms, "number");
  const prev = JSON.parse(lines[lines.length - 2]);
  assert.equal(prev.seq, 42);
  assert.equal(prev.data.text, "Langkah penting: halaman throw dimuat");
});

test("annotate_trace menolak sesi yang tidak cocok", async (t) => {
  const dir = await tmpDir(t);
  const copy = path.join(dir, "trace.jsonl");
  await fs.copyFile(REAL_FIXTURE, copy);
  await withClient(copy, async (client) => {
    await expectToolError(client, "annotate_trace", {
      text: "salah file?",
      session: "sesi-lain",
    });
  });
  const lines = (await fs.readFile(copy, "utf8")).split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 41);
});

test("annotate_trace pada file yang belum ada membuat file dengan seq 1", async (t) => {
  const dir = await tmpDir(t);
  const tracePath = path.join(dir, "baru.jsonl");
  await withClient(tracePath, async (client) => {
    const res = await callToolJson(client, "annotate_trace", {
      text: "Anotasi pertama",
      session: "sesi-baru",
    });
    assert.equal(res.seq, 1);
    assert.equal(res.session, "sesi-baru");
    assert.equal(res.lightpandaVersion, "unknown");
  });
  const lines = (await fs.readFile(tracePath, "utf8")).split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.type, "tracer.annotation");
  assert.equal(row.data.text, "Anotasi pertama");
});

test("ringkasan tidak membocorkan rahasia sintetis dari file trace", async (t) => {
  const dir = await tmpDir(t);
  const tracePath = path.join(dir, "trace.jsonl");
  const secrets = [
    "SYNTHETIC-URL-TOKEN-7f3a9c",
    "SYNTHETIC-KEY-VALUE-41bd",
    "SYNTHETIC-AUTH-HEADER-VALUE",
    "SYNTHETIC-CONSOLE-SECRET-xyz",
  ];
  const rows = [
    {
      ts: "2026-10-29T06:00:00.000Z",
      mono_ms: 0,
      seq: 1,
      session: "secret-test",
      lightpanda_version: "1.0.2",
      type: "tracer.session_started",
      data: {},
    },
    {
      ts: "2026-10-29T06:00:00.100Z",
      mono_ms: 100,
      seq: 2,
      session: "secret-test",
      lightpanda_version: "1.0.2",
      type: "Network.requestWillBeSent",
      data: {
        request: {
          url: `http://127.0.0.1:8772/echo?token=${secrets[0]}&api_key=${secrets[1]}&q=hello`,
          method: "GET",
          headers: { authorization: `Bearer ${secrets[2]}` },
        },
      },
    },
    {
      ts: "2026-10-29T06:00:00.200Z",
      mono_ms: 200,
      seq: 3,
      session: "secret-test",
      lightpanda_version: "1.0.2",
      type: "Runtime.consoleAPICalled",
      data: { type: "log", args: [`bocor: ${secrets[3]}`] },
    },
    {
      ts: "2026-10-29T06:00:01.000Z",
      mono_ms: 1000,
      seq: 4,
      session: "secret-test",
      lightpanda_version: "1.0.2",
      type: "tracer.session_ended",
      data: {},
    },
  ];
  await fs.writeFile(tracePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  await withClient(tracePath, async (client) => {
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.equal(summary.rows, 4);
    assert.equal(summary.requests, 1);
    const blob = JSON.stringify(summary);
    for (const secret of secrets) {
      assert.ok(!blob.includes(secret), `ringkasan membocorkan rahasia: ${secret}`);
    }
    assert.ok(!blob.includes("token="), "ringkasan tidak boleh memuat parameter query");
    assert.ok(!blob.includes("Bearer"), "ringkasan tidak boleh memuat nilai header");
    assert.ok(!blob.includes("bocor:"), "ringkasan tidak boleh memuat teks konsol");
    // Path tetap tercatat tanpa query — bukti query dibuang, bukan barisnya.
    assert.ok(summary.paths.includes("/echo"));
  });
});

test("CLI tanpa --trace keluar bukan nol dengan bantuan yang jelas", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [SERVER], { env: { ...process.env, LP_TRACE_PATH: "" } }),
    (err) => {
      assert.notEqual(err.code, 0);
      assert.match(String(err.stderr), /--trace/);
      return true;
    },
  );
});

test("CLI --help keluar nol dan menyebut kedua tool", async () => {
  const { stdout } = await execFileAsync(process.execPath, [SERVER, "--help"]);
  assert.match(stdout, /get_trace_summary/);
  assert.match(stdout, /annotate_trace/);
});
