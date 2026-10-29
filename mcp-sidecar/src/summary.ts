// summary.ts — Agregasi ringkasan trace (Bab 4.1 F4, Bab 3.6).
//
// get_trace_summary hanya membaca file JSONL yang sudah diredaksi saat
// perekaman (oleh tracer M1). Ia TIDAK PERNAH membaca ulang data mentah
// dari browser dan tidak pernah mengembalikan isi trace mentah: hasil
// akhirnya hanya angka agregat, nama host, dan path tanpa query.
// Teks konsol, URL lengkap beserta parameternya, dan nilai header tidak
// pernah masuk ke ringkasan.

import { readFile } from "node:fs/promises";

export interface TraceRow {
  ts: unknown;
  mono_ms: unknown;
  seq: unknown;
  session: unknown;
  lightpanda_version: unknown;
  type: string;
  data: unknown;
  /** URL CDP koneksi asal baris; "" untuk baris bukan-CDP atau trace lama. */
  endpoint: string;
  /** Nomor urut koneksi; -1 untuk baris bukan-CDP atau trace lama. */
  endpoint_index: number;
}

export interface TraceReadResult {
  /** false bila file belum ada (bukan error: ringkasan kosong dikembalikan). */
  exists: boolean;
  rows: TraceRow[];
  /** Jumlah baris yang gagal di-parse atau tidak punya `type` string. */
  skippedLines: number;
}

/** Baca file JSONL baris per baris; baris rusak dilewati dan dihitung. */
export async function readTraceFile(tracePath: string): Promise<TraceReadResult> {
  let text: string;
  try {
    text = await readFile(tracePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, rows: [], skippedLines: 0 };
    }
    throw err;
  }
  const rows: TraceRow[] = [];
  let skippedLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      skippedLines += 1;
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    if (typeof rec["type"] !== "string") {
      skippedLines += 1;
      continue;
    }
    rows.push({
      ts: rec["ts"],
      mono_ms: rec["mono_ms"],
      seq: rec["seq"],
      session: rec["session"],
      lightpanda_version: rec["lightpanda_version"],
      type: rec["type"],
      data: rec["data"],
      endpoint: typeof rec["endpoint"] === "string" ? rec["endpoint"] : "",
      endpoint_index:
        typeof rec["endpoint_index"] === "number" ? rec["endpoint_index"] : -1,
    });
  }
  return { exists: true, rows, skippedLines };
}

export const SUMMARY_CATEGORIES = [
  "navigation",
  "network",
  "console",
  "error",
  "tracer",
  "agent",
  "other",
] as const;

export type SummaryCategory = (typeof SUMMARY_CATEGORIES)[number];

/** Kelompokkan method CDP ke kategori ringkasan. */
export function categoryOf(type: string): SummaryCategory {
  if (type === "Runtime.consoleAPICalled") {
    return "console";
  }
  if (type === "Runtime.exceptionThrown" || type === "Network.loadingFailed") {
    return "error";
  }
  if (type.startsWith("Page.")) {
    return "navigation";
  }
  if (type.startsWith("Network.")) {
    return "network";
  }
  if (type.startsWith("tracer.")) {
    return "tracer";
  }
  if (type.startsWith("agent.")) {
    return "agent";
  }
  return "other";
}

/**
 * Ambil host + path dari sebuah URL, dengan query dan fragment dibuang.
 * Mengembalikan null bila URL tidak dapat di-parse atau tidak punya host,
 * sehingga nilai apa pun yang tersembunyi di query tidak pernah bocor
 * ke ringkasan.
 */
export function safeHostPath(raw: string): { host: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.host === "") {
    return null;
  }
  return { host: url.host, path: url.pathname === "" ? "/" : url.pathname };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pushUrl(out: string[], value: unknown): void {
  if (typeof value === "string" && value !== "") {
    out.push(value);
  }
}

/**
 * Kumpulkan kandidat URL dari sebuah baris, dengan bentuk payload CDP
 * datar maupun bersarang (data.request.url / data.response.url, seperti
 * pada trace nyata M1). Hanya dipakai untuk host/path; URL mentah
 * tidak pernah masuk ke ringkasan.
 */
function urlsFromRow(row: TraceRow): string[] {
  const data = asRecord(row.data);
  if (data === null) {
    return [];
  }
  const out: string[] = [];
  if (row.type === "Page.frameNavigated") {
    const frame = asRecord(data["frame"]);
    if (frame !== null) {
      pushUrl(out, frame["url"]);
    }
    pushUrl(out, data["url"]);
    return out;
  }
  if (row.type === "Network.requestWillBeSent") {
    const request = asRecord(data["request"]);
    if (request !== null) {
      pushUrl(out, request["url"]);
    }
    pushUrl(out, data["url"]);
    pushUrl(out, data["documentURL"]);
    return out;
  }
  if (row.type === "Network.responseReceived") {
    const response = asRecord(data["response"]);
    if (response !== null) {
      pushUrl(out, response["url"]);
    }
    pushUrl(out, data["url"]);
    return out;
  }
  if (row.type === "agent.tool") {
    const page = asRecord(data["page"]);
    if (page !== null) {
      pushUrl(out, page["url"]);
    }
    return out;
  }
  return out;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Agregat langkah agen (F5). Hanya angka dan nama tool; tanpa argumen, hasil, atau URL lengkap. */
export interface AgentSummary {
  /** true bila ada satu baris agent.* atau lebih. */
  present: boolean;
  toolCalls: number;
  errors: number;
  /** Jumlah per nama tool. */
  tools: Record<string, number>;
  modelCalls: number;
  tokens: { input: number; cached: number; cache_creation: number; output: number };
  /** Jumlah baris agent.unknown (tipe upstream belum dikenal). */
  unknownLines: number;
}

/** Agregat per koneksi CDP (multi-endpoint). Baris bukan-CDP tidak masuk ke daftar ini. */
export interface EndpointSummary {
  endpoint: string;
  endpoint_index: number;
  /** Label: URL, ditambah #indeks bila URL yang sama dipakai beberapa koneksi. */
  label: string;
  rows: number;
  requests: number;
  errors: number;
}

/** Error akhir sesi dari baris tracer.session_ended (tahap error). */
export interface SessionErrorSummary {
  code: string;
  message: string;
}

export interface TraceSummary {
  /** true bila tidak ada baris yang diringkas (file kosong/tidak ada, atau filter tanpa hasil). */
  empty: boolean;
  explanation: string | null;
  traceExists: boolean;
  tracePath: string;
  session: string;
  lightpandaVersion: string;
  rows: number;
  skippedLines: number;
  /** Jumlah URL berbeda dari Page.frameNavigated (query dihapus). */
  pages: number;
  /** Jumlah Network.requestWillBeSent. */
  requests: number;
  /** Jumlah Runtime.exceptionThrown + Network.loadingFailed. */
  errors: number;
  errorBreakdown: { exceptions: number; failedRequests: number };
  /** Durasi milidetik dari selisih ts (atau mono_ms bila ts tak tersedia). */
  durationMs: number | null;
  durationSource: "mono_ms" | "ts" | null;
  startedAt: string | null;
  endedAt: string | null;
  eventsByType: Record<string, number>;
  /** Level konsol sebagaimana diterima CDP; "warn" dinormalisasi ke "warning". */
  consoleByLevel: Record<string, number>;
  /** Nama host unik (termasuk port bila ada), tanpa query. */
  hosts: string[];
  /** Path unik tanpa query. */
  paths: string[];
  /** Jumlah baris tracer.annotation. */
  annotations: number;
  /** Agregat langkah agen (F5); nol bila tidak ada baris agent.*. */
  agent: AgentSummary;
  /** Agregat per koneksi CDP (multi-endpoint); kosong untuk trace satu endpoint lama tanpa field endpoint. */
  endpoints: EndpointSummary[];
  /** true bila file memuat baris tracer.session_resumed (sesi dilanjutkan dengan --append). */
  resumed: boolean;
  /** Error dari tracer.session_ended TERAKHIR; null bila sesi berakhir bersih atau tanpa session_ended. */
  sessionError: SessionErrorSummary | null;
  filter: SummaryCategory | null;
}

export function computeSummary(
  read: TraceReadResult,
  tracePath: string,
  filter: SummaryCategory | null,
): TraceSummary {
  const rows =
    filter === null ? read.rows : read.rows.filter((row) => categoryOf(row.type) === filter);

  const first = rows[0] ?? null;
  const last = rows.length > 0 ? (rows[rows.length - 1] as TraceRow) : null;

  const session =
    (first !== null ? asString(first.session) : null) ??
    (last !== null ? asString(last.session) : null) ??
    "unknown";
  const lightpandaVersion =
    (first !== null ? asString(first.lightpanda_version) : null) ??
    (last !== null ? asString(last.lightpanda_version) : null) ??
    "unknown";

  let explanation: string | null = null;
  if (!read.exists) {
    explanation =
      "File trace belum ada: belum ada sesi tracing yang direkam ke file ini. " +
      "Jalankan tracer (lp-tracer) terlebih dahulu, atau periksa path --trace.";
  } else if (rows.length === 0 && filter !== null) {
    explanation = `Tidak ada event pada kategori "${filter}" dalam file trace ini.`;
  } else if (rows.length === 0) {
    explanation = "File trace kosong: belum ada baris yang direkam.";
  }

  const eventsByType: Record<string, number> = {};
  const consoleByLevel: Record<string, number> = {};
  const hosts = new Set<string>();
  const paths = new Set<string>();
  const pageKeys = new Set<string>();
  let requests = 0;
  let exceptions = 0;
  let failedRequests = 0;
  let annotations = 0;
  let agentToolCalls = 0;
  let agentErrors = 0;
  let agentModelCalls = 0;
  let agentUnknownLines = 0;
  let agentPresent = false;
  const agentTools: Record<string, number> = {};
  const agentTokens = { input: 0, cached: 0, cache_creation: 0, output: 0 };
  const endpointAgg = new Map<
    string,
    { endpoint: string; endpoint_index: number; rows: number; requests: number; errors: number }
  >();
  let resumed = false;
  let sessionError: SessionErrorSummary | null = null;
  // Rentang waktu min/maks atas seluruh baris (bukan baris pertama /
  // terakhir urutan file): baris agen berjangkar mtime dapat mendahului
  // session_started dalam urutan file. Untuk file normal hasilnya sama.
  let minTs: number | null = null;
  let maxTs: number | null = null;
  let minMono: number | null = null;
  let maxMono: number | null = null;

  for (const row of rows) {
    eventsByType[row.type] = (eventsByType[row.type] ?? 0) + 1;
    const rowTs = asString(row.ts);
    if (rowTs !== null) {
      const parsedTs = Date.parse(rowTs);
      if (!Number.isNaN(parsedTs)) {
        if (minTs === null || parsedTs < minTs) minTs = parsedTs;
        if (maxTs === null || parsedTs > maxTs) maxTs = parsedTs;
      }
    }
    const rowMono = asNumber(row.mono_ms);
    if (rowMono !== null) {
      if (minMono === null || rowMono < minMono) minMono = rowMono;
      if (maxMono === null || rowMono > maxMono) maxMono = rowMono;
    }
    if (row.type === "tracer.session_resumed") {
      resumed = true;
    }
    if (row.type === "tracer.session_ended") {
      // Yang terakhir menang: file --append bisa memuat session_ended
      // per segmen; tanpa data.error berarti segmen itu berakhir bersih.
      const raw = asRecord(row.data);
      const err = raw !== null ? asRecord(raw["error"]) : null;
      const code = err !== null ? asString(err["code"]) : null;
      const message = err !== null ? (asString(err["message"]) ?? "") : "";
      sessionError = code !== null ? { code, message } : null;
    }
    if (row.endpoint !== "") {
      const key = `${row.endpoint_index}\n${row.endpoint}`;
      let agg = endpointAgg.get(key);
      if (agg === undefined) {
        agg = { endpoint: row.endpoint, endpoint_index: row.endpoint_index, rows: 0, requests: 0, errors: 0 };
        endpointAgg.set(key, agg);
      }
      agg.rows += 1;
      if (row.type === "Network.requestWillBeSent") {
        agg.requests += 1;
      }
      if (row.type === "Runtime.exceptionThrown" || row.type === "Network.loadingFailed") {
        agg.errors += 1;
      }
    }
    if (row.type === "Network.requestWillBeSent") {
      requests += 1;
    }
    if (row.type === "Runtime.exceptionThrown") {
      exceptions += 1;
    }
    if (row.type === "Network.loadingFailed") {
      failedRequests += 1;
    }
    if (row.type === "tracer.annotation") {
      annotations += 1;
    }
    if (row.type === "agent.tool") {
      agentPresent = true;
      agentToolCalls += 1;
      const raw = asRecord(row.data);
      const name = raw !== null ? asString(raw["name"]) : null;
      if (name !== null) {
        agentTools[name] = (agentTools[name] ?? 0) + 1;
      }
      if (raw !== null && raw["error"] === true) {
        agentErrors += 1;
      }
    }
    if (row.type === "agent.end") {
      agentPresent = true;
      const raw = asRecord(row.data);
      if (raw !== null) {
        agentModelCalls += asNumber(raw["model_calls"]) ?? 0;
        const tokens = asRecord(raw["tokens"]);
        if (tokens !== null) {
          agentTokens.input += asNumber(tokens["input"]) ?? 0;
          agentTokens.cached += asNumber(tokens["cached"]) ?? 0;
          agentTokens.cache_creation += asNumber(tokens["cache_creation"]) ?? 0;
          agentTokens.output += asNumber(tokens["output"]) ?? 0;
        }
      }
    }
    if (row.type === "agent.run" || row.type === "agent.unknown") {
      agentPresent = true;
    }
    if (row.type === "agent.unknown") {
      agentUnknownLines += 1;
    }
    if (row.type === "Runtime.consoleAPICalled") {
      const raw = asRecord(row.data);
      const levelRaw = raw !== null ? asString(raw["type"]) : null;
      const level = levelRaw === "warn" ? "warning" : (levelRaw ?? "unknown");
      consoleByLevel[level] = (consoleByLevel[level] ?? 0) + 1;
    }
    for (const rawUrl of urlsFromRow(row)) {
      const parts = safeHostPath(rawUrl);
      if (parts !== null) {
        hosts.add(parts.host);
        paths.add(parts.path);
        if (row.type === "Page.frameNavigated") {
          pageKeys.add(`${parts.host}${parts.path}`);
        }
      }
    }
  }

  let durationMs: number | null = null;
  let durationSource: "mono_ms" | "ts" | null = null;
  if (minTs !== null && maxTs !== null) {
    // Durasi dari ts absolut min/maks (benar lintas proses resume,
    // karena mono_ms mulai dari 0 tiap proses tracer, dan benar untuk
    // baris agen berjangkar yang mendahului sesi); fallback ke mono_ms.
    durationMs = Math.max(0, maxTs - minTs);
    durationSource = "ts";
  } else if (minMono !== null && maxMono !== null) {
    durationMs = Math.max(0, maxMono - minMono);
    durationSource = "mono_ms";
  }

  const endpointIndexCount = new Map<string, number>();
  for (const agg of endpointAgg.values()) {
    endpointIndexCount.set(agg.endpoint, (endpointIndexCount.get(agg.endpoint) ?? 0) + 1);
  }
  const endpoints: EndpointSummary[] = [...endpointAgg.values()]
    .map((agg) => ({
      ...agg,
      label:
        (endpointIndexCount.get(agg.endpoint) ?? 0) > 1
          ? `${agg.endpoint} #${agg.endpoint_index}`
          : agg.endpoint,
    }))
    .sort((a, b) => a.endpoint_index - b.endpoint_index);

  return {
    empty: rows.length === 0,
    explanation,
    traceExists: read.exists,
    tracePath,
    session,
    lightpandaVersion,
    rows: rows.length,
    skippedLines: read.skippedLines,
    pages: pageKeys.size,
    requests,
    errors: exceptions + failedRequests,
    errorBreakdown: { exceptions, failedRequests },
    durationMs,
    durationSource,
    startedAt: minTs !== null ? new Date(minTs).toISOString() : first !== null ? asString(first.ts) : null,
    endedAt: maxTs !== null ? new Date(maxTs).toISOString() : last !== null ? asString(last.ts) : null,
    eventsByType,
    consoleByLevel,
    hosts: [...hosts].sort(),
    paths: [...paths].sort(),
    annotations,
    agent: {
      present: agentPresent,
      toolCalls: agentToolCalls,
      errors: agentErrors,
      tools: agentTools,
      modelCalls: agentModelCalls,
      tokens: agentTokens,
      unknownLines: agentUnknownLines,
    },
    endpoints,
    resumed,
    sessionError,
    filter,
  };
}
