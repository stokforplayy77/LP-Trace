// run-f5-tests.mjs — Uji unit F5 (tanpa binary Lightpanda).
// Menguji convertAgentLine, redactAgentArgs, dan AgentTraceTailer
// memakai DUA fixture nyata hasil probe (docs/F5-DESIGN.md §1).
// Build (tsc) dijalankan dulu oleh skrip ini, seperti run-m1-tests.mjs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, utimes, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "tests", "fixtures");

// Build dulu agar dist/ sesuai dengan src/ saat ini.
await execFileAsync(join(ROOT, "node_modules", ".bin", "tsc"), { cwd: ROOT });

const { convertAgentLine, redactAgentArgs, AgentTraceTailer, anchorBatchTimes } = await import(
  "../dist/agent-trace.js"
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fixtureLines(name) {
  const text = await readFile(join(FIXTURES, name), "utf8");
  return text.split("\n").filter((l) => l.trim() !== "");
}

/** Tunggu sampai predikat benar, atau gagal setelah timeout. */
async function waitFor(predicate, label, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout menunggu: ${label}`);
    }
    await sleep(50);
  }
}

test("convertAgentLine: fixture script (5 baris) -> run + 3 tool + end", async () => {
  const lines = await fixtureLines("agent-trace-script.jsonl");
  assert.equal(lines.length, 5);
  const rows = lines.map((l) => convertAgentLine(l, false));
  assert.ok(rows.every((r) => r !== null));

  const [run, goto, extract, evaluate, end] = rows;
  assert.equal(run.type, "agent.run");
  assert.deepEqual(run.data, { provider: "none", model: "" });

  assert.equal(goto.type, "agent.tool");
  assert.equal(goto.data.step, 1);
  assert.equal(goto.data.name, "goto");
  assert.equal(goto.data.ms, 4);
  assert.equal(goto.data.agent_t, 9);
  assert.equal(goto.data.error, false);
  assert.equal(goto.data.navigated, true);
  assert.equal(goto.data.result_bytes, 6);
  assert.deepEqual(goto.data.page, {
    url: "http://127.0.0.1:8765/ok.html",
    httpStatus: 200,
    title: "F5 OK",
  });
  // Baris goto upstream TIDAK membawa args: tidak boleh dikarang.
  assert.ok(!("args" in goto.data), "goto tidak boleh punya field args");
  assert.ok(!("result" in goto.data), "tanpa includeBodies, result tidak boleh ada");

  assert.equal(extract.type, "agent.tool");
  assert.equal(extract.data.step, 2);
  assert.equal(extract.data.name, "extract");
  assert.deepEqual(extract.data.args, { schema: '{"title":"title","heading":"h1"}' });

  assert.equal(evaluate.type, "agent.tool");
  assert.equal(evaluate.data.step, 3);
  assert.equal(evaluate.data.name, "evaluate");
  assert.deepEqual(evaluate.data.args, { script: "document.title" });

  assert.equal(end.type, "agent.end");
  assert.deepEqual(end.data, {
    model_calls: 0,
    tool_calls: 3,
    tokens: { input: 0, cached: 0, cache_creation: 0, output: 0 },
  });
});

test("convertAgentLine: fixture results — error + 404 + gating result", async () => {
  const lines = await fixtureLines("agent-trace-results.jsonl");
  assert.equal(lines.length, 4);

  // Tanpa includeBodies: result TIDAK ditulis walau upstream membawanya.
  const rowsOff = lines.map((l) => convertAgentLine(l, false));
  const toolsOff = rowsOff.filter((r) => r.type === "agent.tool");
  assert.equal(toolsOff.length, 2);
  for (const row of toolsOff) {
    assert.ok(!("result" in row.data), "result tidak boleh ada tanpa includeBodies");
    assert.equal(typeof row.data.result_bytes, "number");
  }
  const [gotoOff, extractOff] = toolsOff;
  assert.equal(gotoOff.data.page.httpStatus, 404);
  assert.equal(gotoOff.data.error, false);
  assert.equal(gotoOff.data.navigated, true);
  assert.equal(extractOff.data.error, true);
  assert.equal(extractOff.data.page.title, "");

  // Dengan includeBodies: result ditulis apa adanya (di bawah batas 2000).
  const rowsOn = lines.map((l) => convertAgentLine(l, true));
  const toolsOn = rowsOn.filter((r) => r.type === "agent.tool");
  assert.equal(toolsOn[0].data.result, "loaded");
  assert.ok(
    String(toolsOn[1].data.result).includes("no schema selector matched any element"),
    "result error extract dipertahankan dengan includeBodies",
  );
});

test("convertAgentLine: tipe tak dikenal -> agent.unknown tanpa payload", () => {
  const row = convertAgentLine(
    JSON.stringify({
      type: "model",
      t: 5,
      prompt: "PROMPT-RAHASIA-F5",
      tokens: { input: 99, output: 88 },
      latency_ms: 123,
    }),
    true,
  );
  assert.ok(row);
  assert.equal(row.type, "agent.unknown");
  assert.deepEqual(row.data, { agent_type: "model", agent_t: 5 });
  assert.ok(!JSON.stringify(row).includes("PROMPT-RAHASIA-F5"));
});

test("convertAgentLine: baris rusak -> null, tidak pernah melempar", () => {
  const bad = [
    "",
    "   ",
    "bukan json",
    "[1,2,3]",
    "123",
    "null",
    '"teks"',
    '{"tanpaType":1}',
    '{"type":123}',
    '{"type":""}',
    '{"type":"tool","page":123,"args":"bukan-objek"}',
  ];
  for (const line of bad) {
    if (line === '{"type":"tool","page":123,"args":"bukan-objek"}') {
      // Baris tool dengan page/args berbentuk salah tetap terkonversi
      // dengan nilai default, bukan null.
      const row = convertAgentLine(line, false);
      assert.ok(row);
      assert.equal(row.type, "agent.tool");
      assert.deepEqual(row.data.page, { url: "", httpStatus: null, title: "" });
      assert.ok(!("args" in row.data));
      continue;
    }
    assert.equal(convertAgentLine(line, false), null, `baris harus null: ${line}`);
  }
  // Baris end tanpa field: angka default 0, tidak melempar.
  const endRow = convertAgentLine('{"type":"end"}', false);
  assert.ok(endRow);
  assert.deepEqual(endRow.data.tokens, { input: 0, cached: 0, cache_creation: 0, output: 0 });
});

test("convertAgentLine: URL halaman disensor, judul dipotong 200 karakter", () => {
  const row = convertAgentLine(
    JSON.stringify({
      type: "tool",
      t: 1,
      step: 1,
      name: "goto",
      ms: 1,
      result_bytes: 1,
      error: false,
      navigated: true,
      page: {
        url: "http://127.0.0.1:9/x?token=TOKEN-RAHASIA-F5&api_key=KEY-RAHASIA-F5&q=hello",
        httpStatus: 200,
        title: "J" + "u".repeat(300),
      },
    }),
    false,
  );
  assert.ok(row);
  const page = row.data.page;
  assert.ok(!String(page.url).includes("TOKEN-RAHASIA-F5"));
  assert.ok(!String(page.url).includes("KEY-RAHASIA-F5"));
  assert.ok(String(page.url).includes("token=REDACTED"));
  assert.ok(String(page.url).includes("api_key=REDACTED"));
  assert.ok(String(page.url).includes("q=hello"));
  assert.equal(page.title.length, 200 + "…[truncated]".length);
  assert.ok(String(page.title).endsWith("…[truncated]"));
});

test("redactAgentArgs: kunci mirip rahasia -> [REDACTED], nilai dipotong 500", () => {
  const out = redactAgentArgs({
    apiKey: "NILAI-APIKEY-RAHASIA",
    api_key: "NILAI-API-KEY-RAHASIA",
    accessToken: "NILAI-TOKEN-RAHASIA",
    password: "NILAI-PASSWORD-RAHASIA",
    auth: "NILAI-AUTH-RAHASIA",
    secret: "NILAI-SECRET-RAHASIA",
    selector: "h1",
    longText: "x".repeat(600),
    urlText: "lihat https://contoh.test/p?token=TOKEN-DI-TEKS&q=ok",
    count: 3,
    flag: true,
    nested: { selector: "h1", note: "y".repeat(600) },
  });
  assert.equal(out.apiKey, "[REDACTED]");
  assert.equal(out.api_key, "[REDACTED]");
  assert.equal(out.accessToken, "[REDACTED]");
  assert.equal(out.password, "[REDACTED]");
  assert.equal(out.auth, "[REDACTED]");
  assert.equal(out.secret, "[REDACTED]");
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes("NILAI-"));
  assert.equal(out.selector, "h1");
  assert.equal(String(out.longText).length, 500 + "…[truncated]".length);
  assert.ok(String(out.urlText).includes("token=REDACTED"));
  assert.ok(String(out.urlText).includes("q=ok"));
  assert.equal(out.count, 3);
  assert.equal(out.flag, true);
  assert.equal(out.nested.selector, "h1");
  assert.equal(String(out.nested.note).length, 500 + "…[truncated]".length);
});

test("redactAgentArgs: kunci mirip rahasia BERSARANG -> [REDACTED] utuh, tipe apa pun", () => {
  const input = {
    config: {
      api_key: "SK-BERSARANG-1",
      nested: { accessToken: "TOKEN-BERSARANG-2", keep: "tetap" },
    },
    list: [
      { password: "PASS-BERSARANG-3" },
      { label: "aman", token: 12345 },
      "teks-biasa",
    ],
    tokenObj: { sub: "SUB-BERSARANG-4", sub2: "SUB-BERSARANG-5" },
    tokenArr: ["ARR-BERSARANG-6", "ARR-BERSARANG-7"],
    secretFlag: true,
    secretNull: null,
    // Perilaku lama yang harus dipertahankan: header sensitif dan
    // parameter URL di dalam struktur bersarang tetap disensor oleh
    // redactValue, dan nilai biasa dipertahankan.
    opts: {
      headers: { authorization: "Bearer HEADER-BERSARANG", "x-custom": "ok" },
      endpoint: "https://contoh.test/x?api_key=KEY-DI-URL&q=ok",
      note: "biasa",
    },
  };
  const out = redactAgentArgs(input);
  assert.equal(out.config.api_key, "[REDACTED]");
  assert.equal(out.config.nested.accessToken, "[REDACTED]");
  assert.equal(out.config.nested.keep, "tetap");
  assert.equal(out.list[0].password, "[REDACTED]");
  assert.equal(out.list[1].token, "[REDACTED]");
  assert.equal(out.list[1].label, "aman");
  assert.equal(out.list[2], "teks-biasa");
  assert.deepEqual(out.tokenObj, "[REDACTED]");
  assert.deepEqual(out.tokenArr, "[REDACTED]");
  assert.equal(out.secretFlag, "[REDACTED]");
  assert.equal(out.secretNull, "[REDACTED]");
  assert.equal(out.opts.headers.authorization, "[REDACTED]");
  assert.equal(out.opts.headers["x-custom"], "ok");
  assert.ok(String(out.opts.endpoint).includes("api_key=REDACTED"));
  assert.ok(String(out.opts.endpoint).includes("q=ok"));
  assert.equal(out.opts.note, "biasa");
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes("BERSARANG"), "tidak boleh ada rahasia bersarang tersisa");
  assert.ok(!blob.includes("HEADER-BERSARANG"));
  // Masukan tidak diubah (redaksi mengembalikan salinan baru).
  assert.equal(input.config.api_key, "SK-BERSARANG-1");
  assert.equal(input.list[0].password, "PASS-BERSARANG-3");
});

test("redactAgentArgs: sarang sangat dalam dibatasi tanpa melempar", () => {
  let deep = { apiKey: "SK-PALING-DALAM" };
  for (let i = 0; i < 40; i++) deep = { level: deep };
  const out = redactAgentArgs(deep);
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes("SK-PALING-DALAM"), "rahasia di dasar sarang harus disensor");
  assert.ok(blob.includes("[REDACTED]"), "sarang di luar batas harus disensor");
});

test("convertAgentLine: argumen bersarang rahasia tidak bocor ke baris trace", () => {
  const row = convertAgentLine(
    JSON.stringify({
      type: "tool",
      t: 1,
      step: 1,
      name: "extract",
      ms: 1,
      result_bytes: 1,
      error: false,
      navigated: false,
      page: { url: "http://127.0.0.1:9/x", httpStatus: 200, title: "" },
      args: { config: { credentials: { apiKey: "SK-JALUR-LENGKAP" } } },
    }),
    false,
  );
  assert.ok(row);
  assert.equal(row.data.args.config.credentials.apiKey, "[REDACTED]");
  assert.ok(!JSON.stringify(row).includes("SK-JALUR-LENGKAP"));
});

test("convertAgentLine: result dipotong 2000 karakter bila includeBodies", () => {
  const row = convertAgentLine(
    JSON.stringify({
      type: "tool",
      t: 1,
      step: 1,
      name: "extract",
      ms: 1,
      result_bytes: 3000,
      result: "R".repeat(3000),
      error: false,
      navigated: false,
      page: { url: "http://127.0.0.1:9/x", httpStatus: 200, title: "" },
    }),
    true,
  );
  assert.ok(row);
  assert.equal(String(row.data.result).length, 2000 + "…[truncated]".length);
});

// ---------- Tailer: file temp sungguhan + fake handler ----------

test("tailer: bulk read fixture utuh, tanpa duplikasi antar polling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-tailer-"));
  try {
    const file = join(dir, "agent.jsonl");
    const fixture = await readFile(join(FIXTURES, "agent-trace-script.jsonl"), "utf8");
    await writeFile(file, fixture);
    const rows = [];
    const tailer = new AgentTraceTailer(file, (r) => rows.push(r), false);
    try {
      tailer.start();
      await waitFor(() => rows.length >= 6, "bulk read 6 baris (attached + 5)");
      const countAfterFirst = rows.length;
      await sleep(700);
      assert.equal(rows.length, countAfterFirst, "polling ulang tidak boleh menduplikasi");
      assert.equal(rows[0].type, "tracer.agent_attached");
      assert.deepEqual(
        rows.slice(1).map((r) => r.type),
        ["agent.run", "agent.tool", "agent.tool", "agent.tool", "agent.end"],
      );
      const stats = await tailer.stop();
      assert.equal(stats.lines, 5);
      assert.equal(stats.skipped, 0);
      assert.equal(stats.resets, 0);
    } finally {
      await tailer.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailer: append antar polling + baris parsial tanpa newline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-tailer-"));
  try {
    const file = join(dir, "agent.jsonl");
    await writeFile(file, '{"type":"run","t":0,"provider":"none","model":""}\n');
    const rows = [];
    const tailer = new AgentTraceTailer(file, (r) => rows.push(r), false);
    try {
      tailer.start();
      await waitFor(() => rows.some((r) => r.type === "agent.run"), "baris run");
      // Baris parsial: belum diakhiri newline -> belum diteruskan.
      const toolLine = JSON.stringify({
        type: "tool",
        t: 9,
        step: 1,
        name: "goto",
        ms: 4,
        result_bytes: 6,
        error: false,
        navigated: true,
        page: { url: "http://127.0.0.1:9/x", httpStatus: 200, title: "T" },
      });
      await writeFile(file, toolLine.slice(0, 20), { flag: "a" });
      await sleep(600);
      assert.ok(!rows.some((r) => r.type === "agent.tool"), "baris parsial belum boleh diteruskan");
      // Lengkapi + newline -> baris diteruskan utuh.
      await writeFile(file, toolLine.slice(20) + "\n", { flag: "a" });
      await waitFor(() => rows.some((r) => r.type === "agent.tool"), "baris tool lengkap");
      assert.equal(rows.filter((r) => r.type === "agent.tool").length, 1);
      const stats = await tailer.stop();
      assert.equal(stats.lines, 2);
      assert.equal(stats.skipped, 0);
    } finally {
      await tailer.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailer: reset saat file menyusut (ditulis ulang agen baru)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-tailer-"));
  try {
    const file = join(dir, "agent.jsonl");
    const fixture = await readFile(join(FIXTURES, "agent-trace-script.jsonl"), "utf8");
    await writeFile(file, fixture);
    const rows = [];
    const tailer = new AgentTraceTailer(file, (r) => rows.push(r), false);
    try {
      tailer.start();
      await waitFor(() => rows.length >= 6, "bulk read pertama");
      // Timpa dengan file lebih pendek: satu baris run baru.
      await writeFile(file, '{"type":"run","t":0,"provider":"openai","model":"m1"}\n');
      await waitFor(() => rows.some((r) => r.type === "tracer.agent_reset"), "baris reset");
      await waitFor(
        () =>
          rows.filter((r) => r.type === "agent.run" && r.data.provider === "openai").length === 1,
        "baris run baru setelah reset",
      );
      const stats = await tailer.stop();
      assert.ok(stats.resets >= 1, `resets=${stats.resets}`);
      assert.equal(stats.lines, 6, `lines=${stats.lines}`);
    } finally {
      await tailer.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailer: baris rusak dilewati dan dihitung", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-tailer-"));
  try {
    const file = join(dir, "agent.jsonl");
    await writeFile(
      file,
      [
        '{"type":"run","t":0,"provider":"none","model":""}',
        "ini bukan json",
        '{"tanpaType":true}',
        '{"type":"tool","t":1,"step":1,"name":"goto","ms":1,"result_bytes":1,"error":false,"navigated":true,"page":{"url":"http://127.0.0.1:9/x","httpStatus":200,"title":""}}',
        "",
      ].join("\n") + "\n",
    );
    const rows = [];
    const tailer = new AgentTraceTailer(file, (r) => rows.push(r), false);
    try {
      tailer.start();
      await waitFor(() => rows.length >= 3, "attached + 2 baris baik");
      const stats = await tailer.stop();
      assert.equal(stats.lines, 2);
      assert.equal(stats.skipped, 2);
    } finally {
      await tailer.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailer: file belum ada saat mulai, lalu dibuat agen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-tailer-"));
  try {
    const file = join(dir, "belum-ada.jsonl");
    const rows = [];
    const tailer = new AgentTraceTailer(file, (r) => rows.push(r), false);
    try {
      tailer.start();
      await sleep(600);
      // Hanya baris attached; tidak crash, tidak ada baris agen.
      assert.equal(rows.length, 1);
      assert.equal(rows[0].type, "tracer.agent_attached");
      const fixture = await readFile(join(FIXTURES, "agent-trace-script.jsonl"), "utf8");
      await writeFile(file, fixture);
      await waitFor(() => rows.length >= 6, "baris agen setelah file dibuat");
      const stats = await tailer.stop();
      assert.equal(stats.lines, 5);
      assert.equal(stats.skipped, 0);
    } finally {
      await tailer.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailer: stop() memproses sisa tanpa newline sebagai baris terakhir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-tailer-"));
  try {
    const file = join(dir, "agent.jsonl");
    const line = '{"type":"run","t":0,"provider":"none","model":""}'; // tanpa \n
    await writeFile(file, line);
    const rows = [];
    const tailer = new AgentTraceTailer(file, (r) => rows.push(r), false);
    try {
      tailer.start();
      await sleep(600);
      assert.ok(!rows.some((r) => r.type === "agent.run"), "tanpa newline, polling belum meneruskan");
      const stats = await tailer.stop();
      assert.ok(rows.some((r) => r.type === "agent.run"), "stop() memproses sisa buffer");
      assert.equal(stats.lines, 1);
    } finally {
      await tailer.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailer: gating includeBodies pada file fixture results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-tailer-"));
  try {
    const fixture = await readFile(join(FIXTURES, "agent-trace-results.jsonl"), "utf8");
    const fileOff = join(dir, "off.jsonl");
    const fileOn = join(dir, "on.jsonl");
    await writeFile(fileOff, fixture);
    await writeFile(fileOn, fixture);

    const rowsOff = [];
    const tailerOff = new AgentTraceTailer(fileOff, (r) => rowsOff.push(r), false);
    try {
      tailerOff.start();
      await waitFor(() => rowsOff.length >= 5, "tailer off selesai");
      const statsOff = await tailerOff.stop();
      assert.equal(statsOff.lines, 4);
      for (const row of rowsOff.filter((r) => r.type === "agent.tool")) {
        assert.ok(!("result" in row.data));
      }
    } finally {
      await tailerOff.stop();
    }

    const rowsOn = [];
    const tailerOn = new AgentTraceTailer(fileOn, (r) => rowsOn.push(r), true);
    try {
      tailerOn.start();
      await waitFor(() => rowsOn.length >= 5, "tailer on selesai");
      const statsOn = await tailerOn.stop();
      assert.equal(statsOn.lines, 4);
      const tools = rowsOn.filter((r) => r.type === "agent.tool");
      assert.equal(tools[0].data.result, "loaded");
      assert.ok(String(tools[1].data.result).includes("no schema selector matched"));
    } finally {
      await tailerOn.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- Penjangkaran mtime (ANCHOR-DESIGN.md) ----------

test("anchorBatchTimes: penyebaran batch normal dari mtime", () => {
  const out = anchorBatchTimes([0, 9, 10, 11, 11], 1_000_000, 1_000_500);
  assert.deepEqual(out, [999_989, 999_998, 999_999, 1_000_000, 1_000_000]);
});

test("anchorBatchTimes: satu baris mendarat pada mtime; t hilang -> null per baris", () => {
  assert.deepEqual(anchorBatchTimes([500], 2_000_000, 2_000_100), [2_000_000]);
  assert.deepEqual(anchorBatchTimes([0, null, 100], 3_000_000, 3_000_100), [2_999_900, null, 3_000_000]);
  assert.deepEqual(anchorBatchTimes([null, null], 3_000_000, 3_000_100), [null, null]);
  assert.deepEqual(anchorBatchTimes([], 3_000_000, 3_000_100), []);
});

test("anchorBatchTimes: t menurun -> seluruh batch fallback; mtime masa depan -> jangkar pada waktu baca", () => {
  assert.deepEqual(anchorBatchTimes([0, 5000, 100], 4_000_000, 4_000_100), [null, null, null]);
  assert.deepEqual(anchorBatchTimes([0, 100], 9_999_999, 1_000_000), [999_900, 1_000_000]);
  assert.deepEqual(anchorBatchTimes([-5, 100], 5_000_000, 5_000_100), [null, 5_000_000]);
});

test("convertAgentLine: agentT mentah untuk penjangkaran, terpisah dari data.agent_t", () => {
  const run = convertAgentLine('{"type":"run","t":0,"provider":"none","model":""}', false);
  assert.equal(run.agentT, 0);
  const tool = convertAgentLine(
    '{"type":"tool","t":42,"step":1,"name":"goto","ms":4,"result_bytes":1,"error":false,"navigated":true,"page":{}}',
    false,
  );
  assert.equal(tool.agentT, 42);
  assert.equal(tool.data.agent_t, 42);
  const noT = convertAgentLine('{"type":"run","provider":"none","model":""}', false);
  assert.equal(noT.agentT, null);
  assert.deepEqual(noT.data, { provider: "none", model: "" });
  const badT = convertAgentLine('{"type":"tool","t":"cepat","step":1,"name":"x","page":{}}', false);
  assert.equal(badT.agentT, null);
  assert.equal(badT.data.agent_t, 0);
});

test("tailer: file lama (mtime dimundurkan) -> baris berjangkar pada waktu asli", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-anchor-"));
  try {
    const file = join(dir, "agent.jsonl");
    const fixture = await readFile(join(FIXTURES, "agent-trace-script.jsonl"), "utf8");
    await writeFile(file, fixture);
    const backdated = new Date(Date.now() - 60_000);
    await utimes(file, backdated, backdated);
    const mtimeMs = (await stat(file)).mtimeMs;
    const rows = [];
    const tailer = new AgentTraceTailer(file, (r) => rows.push(r), false);
    try {
      tailer.start();
      await waitFor(() => rows.length >= 6, "tailer jangkar selesai");
      await tailer.stop();
      assert.equal(rows[0].type, "tracer.agent_attached");
      assert.equal(rows[0].tsMs, undefined);
      const agentRows = rows.slice(1);
      assert.equal(agentRows.length, 5);
      const tLast = 11;
      for (const r of agentRows) {
        const expected = mtimeMs - (tLast - (r.agentT ?? 0));
        assert.ok(
          Math.abs(r.tsMs - expected) < 5,
          `tsMs ${r.tsMs} harus ≈ ${expected} (agentT ${r.agentT})`,
        );
      }
      const tsList = agentRows.map((r) => r.tsMs);
      assert.deepEqual(tsList, [...tsList].sort((a, b) => a - b));
    } finally {
      await tailer.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailer: batch satu tulis tersebar sesuai selisih t, bukan menumpuk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-anchor-"));
  try {
    const file = join(dir, "agent.jsonl");
    await writeFile(file, "");
    const rows = [];
    const tailer = new AgentTraceTailer(file, (r) => rows.push(r), false);
    try {
      tailer.start();
      await sleep(300);
      await writeFile(
        file,
        [
          '{"type":"run","t":0,"provider":"none","model":""}',
          '{"type":"tool","t":1000,"step":1,"name":"goto","ms":1,"result_bytes":1,"error":false,"navigated":true,"page":{}}',
          '{"type":"tool","t":3000,"step":2,"name":"evaluate","ms":1,"result_bytes":1,"error":false,"navigated":false,"page":{}}',
          "",
        ].join("\n"),
      );
      await waitFor(() => rows.length >= 4, "tailer batch tumbuh selesai");
      await tailer.stop();
      const agentRows = rows.filter((r) => r.type.startsWith("agent."));
      assert.equal(agentRows.length, 3);
      const [run, first, second] = agentRows;
      assert.ok(Math.abs(first.tsMs - run.tsMs - 1000) < 5, `selisih harus 1000, dapat ${first.tsMs - run.tsMs}`);
      assert.ok(Math.abs(second.tsMs - run.tsMs - 3000) < 5, `selisih harus 3000, dapat ${second.tsMs - run.tsMs}`);
      const mtimeMs = (await stat(file)).mtimeMs;
      assert.ok(Math.abs(second.tsMs - mtimeMs) < 5, "baris terakhir batch mendarat pada mtime");
    } finally {
      await tailer.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailer: t menurun dalam satu batch -> tanpa jangkar (waktu baca)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-anchor-"));
  try {
    const file = join(dir, "agent.jsonl");
    await writeFile(
      file,
      [
        '{"type":"run","t":0,"provider":"none","model":""}',
        '{"type":"tool","t":5000,"step":1,"name":"goto","ms":1,"result_bytes":1,"error":false,"navigated":true,"page":{}}',
        '{"type":"tool","t":100,"step":2,"name":"evaluate","ms":1,"result_bytes":1,"error":false,"navigated":false,"page":{}}',
        "",
      ].join("\n"),
    );
    const rows = [];
    const tailer = new AgentTraceTailer(file, (r) => rows.push(r), false);
    try {
      tailer.start();
      await waitFor(() => rows.length >= 4, "tailer t-menurun selesai");
      await tailer.stop();
      const agentRows = rows.filter((r) => r.type.startsWith("agent."));
      assert.equal(agentRows.length, 3);
      assert.ok(agentRows.every((r) => r.tsMs === undefined), "tidak ada baris yang dijangkar");
      assert.deepEqual(agentRows.map((r) => r.agentT), [0, 5000, 100]);
    } finally {
      await tailer.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
