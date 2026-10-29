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

import { acquireLock, lockPathFor, LockAcquisitionError } from "../dist/lockfile.js";

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
    assert.equal(summary.durationSource, "ts");
    assert.deepEqual(summary.endpoints, []);
    assert.equal(summary.resumed, false);
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

test("versi CLI dan server MCP sama dengan versi package.json", async () => {
  const pkg = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const { stdout } = await execFileAsync(process.execPath, [
    SERVER,
    "--version",
  ]);
  assert.equal(stdout.trim(), `lp-trace-mcp ${pkg.version}`);
  await withClient(REAL_FIXTURE, async (client) => {
    const serverVersion = client.getServerVersion();
    assert.equal(serverVersion?.name, "lp-trace-mcp");
    assert.equal(serverVersion?.version, pkg.version);
  });
});

// ---------- F5: agregat agen ----------

test("F5 get_trace_summary: field agent dari baris CDP + agen", async (t) => {
  const dir = await tmpDir(t);
  const tracePath = path.join(dir, "trace.jsonl");
  // Baris agent.tool membawa argumen bernilai rahasia sintetis dan URL
  // lengkap berparameter token — ringkasan tidak boleh memuat keduanya.
  const secretArg = "SYNTHETIC-AGENT-ARG-SECRET-9z";
  const secretToken = "SYNTHETIC-AGENT-TOKEN-5q";
  const rows = [
    {
      ts: "2026-10-29T06:00:00.000Z",
      mono_ms: 0,
      seq: 1,
      session: "f5-mcp",
      lightpanda_version: "1.0.2",
      type: "tracer.session_started",
      data: {},
    },
    {
      ts: "2026-10-29T06:00:00.050Z",
      mono_ms: 50,
      seq: 2,
      session: "f5-mcp",
      lightpanda_version: "1.0.2",
      type: "Network.requestWillBeSent",
      data: {
        request: { url: "http://127.0.0.1:8772/ok.html", method: "GET" },
      },
    },
    {
      ts: "2026-10-29T06:00:00.100Z",
      mono_ms: 100,
      seq: 3,
      session: "f5-mcp",
      lightpanda_version: "1.0.2",
      type: "agent.run",
      data: { provider: "none", model: "" },
    },
    {
      ts: "2026-10-29T06:00:00.110Z",
      mono_ms: 110,
      seq: 4,
      session: "f5-mcp",
      lightpanda_version: "1.0.2",
      type: "agent.tool",
      data: {
        step: 1,
        name: "goto",
        ms: 4,
        agent_t: 9,
        error: false,
        navigated: true,
        result_bytes: 6,
        args: { value: secretArg },
        page: {
          url: `http://127.0.0.1:8772/ok.html?token=${secretToken}&x=1`,
          httpStatus: 200,
          title: "F5 OK",
        },
      },
    },
    {
      ts: "2026-10-29T06:00:00.120Z",
      mono_ms: 120,
      seq: 5,
      session: "f5-mcp",
      lightpanda_version: "1.0.2",
      type: "agent.tool",
      data: {
        step: 2,
        name: "extract",
        ms: 0,
        agent_t: 10,
        error: false,
        navigated: false,
        result_bytes: 38,
        page: { url: "http://127.0.0.1:8772/ok.html", httpStatus: 200, title: "F5 OK" },
      },
    },
    {
      ts: "2026-10-29T06:00:00.130Z",
      mono_ms: 130,
      seq: 6,
      session: "f5-mcp",
      lightpanda_version: "1.0.2",
      type: "agent.tool",
      data: {
        step: 3,
        name: "evaluate",
        ms: 2,
        agent_t: 11,
        error: true,
        navigated: false,
        result_bytes: 342,
        page: { url: "http://127.0.0.1:8772/missing.html", httpStatus: 404, title: "" },
      },
    },
    {
      ts: "2026-10-29T06:00:00.140Z",
      mono_ms: 140,
      seq: 7,
      session: "f5-mcp",
      lightpanda_version: "1.0.2",
      type: "agent.unknown",
      data: { agent_type: "model", agent_t: 12 },
    },
    {
      ts: "2026-10-29T06:00:00.150Z",
      mono_ms: 150,
      seq: 8,
      session: "f5-mcp",
      lightpanda_version: "1.0.2",
      type: "agent.end",
      data: {
        model_calls: 2,
        tool_calls: 3,
        tokens: { input: 10, cached: 2, cache_creation: 1, output: 5 },
      },
    },
    {
      ts: "2026-10-29T06:00:01.000Z",
      mono_ms: 1000,
      seq: 9,
      session: "f5-mcp",
      lightpanda_version: "1.0.2",
      type: "tracer.session_ended",
      data: { reason: "signal-SIGINT" },
    },
  ];
  await fs.writeFile(tracePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  await withClient(tracePath, async (client) => {
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.equal(summary.rows, 9);
    assert.equal(summary.requests, 1);
    assert.deepEqual(summary.agent, {
      present: true,
      toolCalls: 3,
      errors: 1,
      tools: { goto: 1, extract: 1, evaluate: 1 },
      modelCalls: 2,
      tokens: { input: 10, cached: 2, cache_creation: 1, output: 5 },
      unknownLines: 1,
    });
    assert.equal(summary.eventsByType["agent.tool"], 3);
    assert.equal(summary.eventsByType["agent.unknown"], 1);
    // Host/path dari URL halaman agen tercatat tanpa query.
    assert.ok(summary.hosts.includes("127.0.0.1:8772"));
    assert.ok(summary.paths.includes("/ok.html"));
    assert.ok(summary.paths.includes("/missing.html"));
    // Tidak ada kebocoran: nilai argumen rahasia, token URL, URL lengkap.
    const blob = JSON.stringify(summary);
    assert.ok(!blob.includes(secretArg), "ringkasan memuat nilai argumen agen");
    assert.ok(!blob.includes(secretToken), "ringkasan memuat token URL agen");
    assert.ok(!blob.includes("token="), "ringkasan memuat parameter query");
    assert.ok(!blob.includes("ok.html?token"), "ringkasan memuat URL lengkap");
  });
});

test("F5 get_trace_summary dengan filter agent hanya mengembalikan baris agen", async (t) => {
  const dir = await tmpDir(t);
  const tracePath = path.join(dir, "trace.jsonl");
  const rows = [
    {
      ts: "2026-10-29T06:00:00.000Z",
      mono_ms: 0,
      seq: 1,
      session: "f5-filter",
      lightpanda_version: "1.0.2",
      type: "tracer.session_started",
      data: {},
    },
    {
      ts: "2026-10-29T06:00:00.050Z",
      mono_ms: 50,
      seq: 2,
      session: "f5-filter",
      lightpanda_version: "1.0.2",
      type: "Network.requestWillBeSent",
      data: { request: { url: "http://127.0.0.1:8772/ok.html" } },
    },
    {
      ts: "2026-10-29T06:00:00.100Z",
      mono_ms: 100,
      seq: 3,
      session: "f5-filter",
      lightpanda_version: "1.0.2",
      type: "agent.run",
      data: { provider: "none", model: "" },
    },
    {
      ts: "2026-10-29T06:00:00.110Z",
      mono_ms: 110,
      seq: 4,
      session: "f5-filter",
      lightpanda_version: "1.0.2",
      type: "agent.tool",
      data: {
        step: 1,
        name: "goto",
        ms: 4,
        agent_t: 9,
        error: false,
        navigated: true,
        result_bytes: 6,
        page: { url: "http://127.0.0.1:8772/ok.html", httpStatus: 200, title: "F5 OK" },
      },
    },
    {
      ts: "2026-10-29T06:00:00.120Z",
      mono_ms: 120,
      seq: 5,
      session: "f5-filter",
      lightpanda_version: "1.0.2",
      type: "agent.end",
      data: {
        model_calls: 0,
        tool_calls: 1,
        tokens: { input: 0, cached: 0, cache_creation: 0, output: 0 },
      },
    },
  ];
  await fs.writeFile(tracePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  await withClient(tracePath, async (client) => {
    const agentOnly = await callToolJson(client, "get_trace_summary", { category: "agent" });
    assert.equal(agentOnly.filter, "agent");
    assert.equal(agentOnly.rows, 3);
    assert.equal(agentOnly.agent.present, true);
    assert.equal(agentOnly.agent.toolCalls, 1);
    assert.equal(agentOnly.requests, 0);
    assert.equal(agentOnly.pages, 0);
    const networkOnly = await callToolJson(client, "get_trace_summary", { category: "network" });
    assert.equal(networkOnly.rows, 1);
    assert.equal(networkOnly.agent.present, false);
    assert.equal(networkOnly.agent.toolCalls, 0);
  });
});

test("F5 field agent nol pada trace tanpa baris agen", async () => {
  await withClient(REAL_FIXTURE, async (client) => {
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.equal(summary.rows, 41);
    assert.deepEqual(summary.agent, {
      present: false,
      toolCalls: 0,
      errors: 0,
      tools: {},
      modelCalls: 0,
      tokens: { input: 0, cached: 0, cache_creation: 0, output: 0 },
      unknownLines: 0,
    });
  });
});

test("MS ringkasan: agregat per endpoint + resumed pada trace multi-endpoint", async (t) => {
  const dir = await tmpDir(t);
  const tracePath = path.join(dir, "multi.jsonl");
  const row = (seq, ts, mono_ms, type, endpoint, endpoint_index, data) =>
    JSON.stringify({
      ts,
      mono_ms,
      seq,
      session: "ms-sidecar",
      lightpanda_version: "1.0.2",
      endpoint,
      endpoint_index,
      type,
      data,
    });
  const lines = [
    row(1, "2026-10-29T07:00:00.000Z", 0, "tracer.session_started", "", -1, {
      cdp: "ws://127.0.0.1:9222",
      endpoints: ["ws://127.0.0.1:9222", "ws://127.0.0.1:9222"],
    }),
    row(2, "2026-10-29T07:00:00.100Z", 100, "Network.requestWillBeSent", "ws://127.0.0.1:9222", 0, {
      request: { url: "http://127.0.0.1:8771/a.html" },
    }),
    row(3, "2026-10-29T07:00:00.200Z", 200, "Network.requestWillBeSent", "ws://127.0.0.1:9222", 1, {
      request: { url: "http://127.0.0.1:8771/b.html" },
    }),
    row(4, "2026-10-29T07:00:00.300Z", 300, "Runtime.exceptionThrown", "ws://127.0.0.1:9222", 1, {
      exceptionDetails: { text: "Uncaught" },
    }),
    row(5, "2026-10-29T07:00:00.400Z", 400, "tracer.session_ended", "", -1, { reason: "navigations-done" }),
    row(6, "2026-10-29T07:00:00.500Z", 0, "tracer.session_resumed", "", -1, {
      previousRows: 5,
      resumedFromSeq: 6,
    }),
    row(7, "2026-10-29T07:00:00.600Z", 100, "Network.requestWillBeSent", "ws://127.0.0.1:9222", 0, {
      request: { url: "http://127.0.0.1:8771/a.html" },
    }),
  ];
  await fs.writeFile(tracePath, lines.join("\n") + "\n", "utf8");
  await withClient(tracePath, async (client) => {
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.equal(summary.rows, 7);
    assert.equal(summary.requests, 3);
    assert.equal(summary.errors, 1);
    assert.equal(summary.resumed, true);
    assert.equal(summary.durationMs, 600);
    assert.equal(summary.durationSource, "ts");
    assert.deepEqual(summary.endpoints, [
      {
        endpoint: "ws://127.0.0.1:9222",
        endpoint_index: 0,
        label: "ws://127.0.0.1:9222 #0",
        rows: 2,
        requests: 2,
        errors: 0,
      },
      {
        endpoint: "ws://127.0.0.1:9222",
        endpoint_index: 1,
        label: "ws://127.0.0.1:9222 #1",
        rows: 2,
        requests: 1,
        errors: 1,
      },
    ]);
  });
});

test("MS anotasi: baris anotasi membawa field endpoint kosong/-1", async (t) => {
  const dir = await tmpDir(t);
  const tracePath = path.join(dir, "trace.jsonl");
  await fs.writeFile(
    tracePath,
    '{"ts":"2026-10-29T07:00:00.000Z","mono_ms":0,"seq":1,"session":"s1","lightpanda_version":"1.0.2","endpoint":"ws://127.0.0.1:9222","endpoint_index":0,"type":"tracer.session_started","data":{}}\n',
    "utf8",
  );
  await withClient(tracePath, async (client) => {
    const result = await callToolJson(client, "annotate_trace", { text: "catatan uji" });
    assert.equal(result.seq, 2);
    const rows = (await fs.readFile(tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(rows[1].type, "tracer.annotation");
    assert.equal(rows[1].endpoint, "");
    assert.equal(rows[1].endpoint_index, -1);
  });
});

test("ANCHOR durasi: rentang min/maks ts, baris agen berjangkar mendahului sesi", async (t) => {
  const dir = await tmpDir(t);
  const tracePath = path.join(dir, "anchor.jsonl");
  const row = (seq, ts, mono_ms, type, data) =>
    JSON.stringify({
      ts,
      mono_ms,
      seq,
      session: "anchor-sidecar",
      lightpanda_version: "1.0.2",
      endpoint: "",
      endpoint_index: -1,
      type,
      data,
    });
  await fs.writeFile(
    tracePath,
    [
      row(1, "2026-10-29T07:00:05.000Z", 0, "tracer.session_started", {}),
      row(2, "2026-10-29T07:00:00.000Z", 0, "agent.tool", { agent_t: 0 }),
      row(3, "2026-10-29T07:00:02.000Z", 0, "agent.tool", { agent_t: 2000 }),
      row(4, "2026-10-29T07:00:06.000Z", 1000, "tracer.session_ended", {}),
      "",
    ].join("\n"),
    "utf8",
  );
  await withClient(tracePath, async (client) => {
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.equal(summary.durationMs, 6000);
    assert.equal(summary.durationSource, "ts");
    assert.equal(summary.startedAt, "2026-10-29T07:00:00.000Z");
    assert.equal(summary.endedAt, "2026-10-29T07:00:06.000Z");
  });
});

test("ROBUST sessionError: dari session_ended terakhir, null bila berakhir bersih", async (t) => {
  const dir = await tmpDir(t);
  const row = (seq, mono_ms, type, data) =>
    JSON.stringify({
      ts: "2026-10-29T07:00:00.000Z",
      mono_ms,
      seq,
      session: "robust-sidecar",
      lightpanda_version: "1.0.2",
      endpoint: "",
      endpoint_index: -1,
      type,
      data,
    });
  // Segmen 1 berakhir dengan error, segmen 2 bersih -> null (terakhir menang).
  const cleanLast = path.join(dir, "clean-last.jsonl");
  await fs.writeFile(
    cleanLast,
    [
      row(1, 0, "tracer.session_started", {}),
      row(2, 100, "tracer.session_ended", {
        reason: "cdp-closed",
        error: { code: "E_CDP_CLOSED", message: "koneksi CDP ditutup" },
      }),
      row(3, 0, "tracer.session_resumed", { previousRows: 2, resumedFromSeq: 3 }),
      row(4, 100, "tracer.session_ended", { reason: "navigations-done" }),
    ].join("\n") + "\n",
    "utf8",
  );
  await withClient(cleanLast, async (client) => {
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.equal(summary.sessionError, null);
  });
  // Segmen 1 bersih, segmen 2 berakhir dengan error -> error tampil.
  const errorLast = path.join(dir, "error-last.jsonl");
  await fs.writeFile(
    errorLast,
    [
      row(1, 0, "tracer.session_started", {}),
      row(2, 100, "tracer.session_ended", { reason: "navigations-done" }),
      row(3, 0, "tracer.session_resumed", { previousRows: 2, resumedFromSeq: 3 }),
      row(4, 100, "tracer.session_ended", {
        reason: "size-limit",
        error: { code: "E_TRACE_LIMIT", message: "batas ukuran tercapai" },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  await withClient(errorLast, async (client) => {
    const summary = await callToolJson(client, "get_trace_summary", {});
    assert.deepEqual(summary.sessionError, {
      code: "E_TRACE_LIMIT",
      message: "batas ukuran tercapai",
    });
  });
});

// --- Kunci file antar-proses (LOCK-DESIGN.md) ---

test("lockfile: peroleh + lepas menghapus lockfile dan mencatat PID", async (t) => {
  const dir = await tmpDir(t);
  const lockPath = path.join(dir, "trace.jsonl.lock");
  const lock = await acquireLock(lockPath);
  assert.equal(lock.lockPath, lockPath);
  const content = await fs.readFile(lockPath, "utf8");
  assert.match(content, new RegExp(`pid=${process.pid}`));
  await lock.release();
  await assert.rejects(fs.access(lockPath));
  await lock.release(); // lepas ganda aman
  await assert.rejects(fs.access(lockPath));
});

test("lockfile: perolehan kedua menunggu sampai kunci dilepas", async (t) => {
  const dir = await tmpDir(t);
  const lockPath = path.join(dir, "trace.jsonl.lock");
  const first = await acquireLock(lockPath);
  const secondPromise = acquireLock(lockPath, { timeoutMs: 3000, retryMs: 20 });
  await new Promise((r) => setTimeout(r, 200));
  await first.release();
  const second = await secondPromise;
  await second.release();
  await assert.rejects(fs.access(lockPath));
});

test("lockfile: kunci basi dicuri, kunci segar menolak tepat waktu", async (t) => {
  const dir = await tmpDir(t);
  const stalePath = path.join(dir, "basi.jsonl.lock");
  await fs.writeFile(stalePath, "pid=99999\ntime=lama\n");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(stalePath, old, old);
  const stolen = await acquireLock(stalePath, { staleMs: 10_000 });
  await stolen.release();

  const freshPath = path.join(dir, "segar.jsonl.lock");
  await fs.writeFile(freshPath, "pid=99999\ntime=baru\n");
  await assert.rejects(
    acquireLock(freshPath, { timeoutMs: 200, retryMs: 20, staleMs: 10_000 }),
    (err) => err instanceof LockAcquisitionError && err.lockPath === freshPath,
  );
  await fs.unlink(freshPath);
});

test("lockfile: lockPathFor menormalkan path relatif", () => {
  const lockPath = lockPathFor("sub/../trace.jsonl");
  assert.ok(path.isAbsolute(lockPath));
  assert.ok(lockPath.endsWith("trace.jsonl.lock"));
});

test("annotate_trace lintas proses: 20 panggilan bersamaan, seq unik berurutan", async (t) => {
  const dir = await tmpDir(t);
  const copy = path.join(dir, "trace.jsonl");
  await fs.copyFile(REAL_FIXTURE, copy);

  await withClient(copy, async (clientA) => {
    await withClient(copy, async (clientB) => {
      const calls = [];
      for (let i = 0; i < 10; i++) {
        calls.push(callToolJson(clientA, "annotate_trace", { text: `A-${i}` }));
        calls.push(callToolJson(clientB, "annotate_trace", { text: `B-${i}` }));
      }
      const results = await Promise.all(calls);
      const seqs = results.map((r) => r.seq);
      assert.equal(new Set(seqs).size, 20, "semua seq harus berbeda");
      assert.deepEqual(
        [...seqs].sort((a, b) => a - b),
        Array.from({ length: 20 }, (_, i) => 42 + i),
        "seq harus berurutan 42..61",
      );
    });
  });

  await assert.rejects(fs.access(`${copy}.lock`), "tidak boleh ada lockfile tersisa");
  const lines = (await fs.readFile(copy, "utf8")).split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 61);
  const allSeqs = lines.map((l) => JSON.parse(l).seq);
  assert.equal(new Set(allSeqs).size, 61, "seluruh file harus bebas seq duplikat");
});

test("annotate_trace gagal rapi bila lockfile segar sudah ada", async (t) => {
  const dir = await tmpDir(t);
  const copy = path.join(dir, "trace.jsonl");
  await fs.copyFile(REAL_FIXTURE, copy);
  const lockPath = `${copy}.lock`;
  await fs.writeFile(lockPath, "pid=99999\ntime=baru\n");

  await withClient(copy, async (client) => {
    const result = await client.callTool({
      name: "annotate_trace",
      arguments: { text: "tertahan kunci" },
    });
    assert.equal(result.isError, true);
    const item = result.content.find((c) => c.type === "text");
    assert.match(item.text, /dikunci/);
  });
  const lines = (await fs.readFile(copy, "utf8")).split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 41, "panggilan yang gagal tidak boleh menulis");

  await fs.unlink(lockPath);
  await withClient(copy, async (client) => {
    const res = await callToolJson(client, "annotate_trace", { text: "sesudah kunci hilang" });
    assert.equal(res.seq, 42);
  });
});
