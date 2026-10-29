// agent-trace.ts — Tailer file trace `agent --trace` upstream (F5).
//
// File trace agen berisi satu JSON per baris (lihat docs/F5-DESIGN.md):
// baris "run", "tool" (satu per tool call), dan "end". Tailer membaca
// file ini selagi tracer berjalan dan mengubah tiap baris menjadi baris
// trace JSONL (namespace agent.*) dengan stempel waktu tracer, sehingga
// langkah agen tampil pada sumbu waktu yang sama dengan event CDP.
//
// Bentuk baris panggilan model TIDAK terverifikasi (probe tanpa LLM):
// tipe baris yang belum dikenal diubah menjadi agent.unknown TANPA
// payload, agar teks prompt tidak pernah bocor ke file trace.

import { open, stat, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
  REDACTED,
  isTokenLikeParam,
  redactUrl,
  redactUrlsInText,
  redactValue,
  truncateString,
} from "./redact.js";

export const AGENT_POLL_MS = 250;
const MAX_PARTIAL_BYTES = 64 * 1024;
const MAX_READ_BYTES_PER_POLL = 4 * 1024 * 1024;
const AGENT_TITLE_MAX = 200;
const AGENT_ARG_MAX = 500;
const AGENT_RESULT_MAX = 2000;
// Kedalaman maksimum struktur argumen yang ditelusuri. Di luar batas
// ini nilainya dianggap tidak terverifikasi dan disensor, agar file
// trace yang dibuat-buat dengan sarang ribuan tingkat tidak membuat
// penelusuran rekursif kehabisan stack.
const AGENT_MAX_DEPTH = 32;

export interface AgentTraceRow {
  type: string;
  data: Record<string, unknown>;
}

export interface AgentTraceStats {
  lines: number;
  skipped: number;
  resets: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asFiniteNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Potong semua string di dalam nilai rekursif sampai maxLen. */
function truncateDeep(value: unknown, maxLen: number): unknown {
  if (typeof value === "string") return truncateString(value, maxLen);
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, maxLen));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, maxLen);
  return out;
}

/**
 * Telusuri nilai argumen secara rekursif (objek + array): nilai pada
 * kunci mirip rahasia diganti [REDACTED] utuh pada KEDALAMAN BERAPA
 * PUN dan untuk TIPE NILAI APA PUN. Sebelum perbaikan ini, aturan
 * tersebut hanya berlaku untuk kunci tingkat atas yang bernilai
 * string, sehingga rahasia bersarang (mis. args.config.api_key atau
 * args.headers[0].value di bawah kunci mirip rahasia) lolos apa adanya
 * ke file trace. Mengembalikan salinan baru; masukan tidak diubah.
 */
function redactSecretKeysDeep(value: unknown, depth: number): unknown {
  if (depth > AGENT_MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((v) => redactSecretKeysDeep(v, depth + 1));
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = isTokenLikeParam(key)
      ? REDACTED
      : redactSecretKeysDeep(v, depth + 1);
  }
  return out;
}

/**
 * Redaksi argumen tool agen: kunci dipertahankan, nilai string disensor
 * URL-nya dan dipotong 500 karakter; nilai pada kunci mirip rahasia
 * diganti [REDACTED] utuh pada kedalaman berapa pun (lihat
 * redactSecretKeysDeep). Aturan header/URL/postData generik dari
 * redactValue tetap berlaku untuk struktur bersarang yang bukan kunci
 * mirip rahasia (mis. headers.authorization).
 */
export function redactAgentArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const scrubbed = redactSecretKeysDeep(args, 0);
  const redacted = redactValue(scrubbed, { includeBodies: false });
  return truncateDeep(redacted, AGENT_ARG_MAX) as Record<string, unknown>;
}

function convertPage(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) return { url: "", httpStatus: null, title: "" };
  return {
    url: typeof raw.url === "string" ? redactUrl(raw.url) : "",
    httpStatus: typeof raw.httpStatus === "number" ? raw.httpStatus : null,
    title:
      typeof raw.title === "string"
        ? truncateString(raw.title, AGENT_TITLE_MAX)
        : "",
  };
}

/**
 * Ubah satu baris file trace agen menjadi baris trace lp-trace, atau
 * null bila baris dilewati (bukan JSON / bukan objek / tanpa `type`).
 * Tidak pernah melempar untuk input apa pun.
 */
export function convertAgentLine(
  line: string,
  includeBodies: boolean,
): AgentTraceRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const type = parsed.type;
  if (typeof type !== "string" || type === "") return null;
  const agentT = asFiniteNumber(parsed.t, 0);

  if (type === "tool") {
    const data: Record<string, unknown> = {
      step: asFiniteNumber(parsed.step, 0),
      name: asString(parsed.name),
      ms: asFiniteNumber(parsed.ms, 0),
      agent_t: agentT,
      error: parsed.error === true,
      navigated: parsed.navigated === true,
      result_bytes: asFiniteNumber(parsed.result_bytes, 0),
      page: convertPage(parsed.page),
    };
    if (isPlainObject(parsed.args)) {
      data.args = redactAgentArgs(parsed.args);
    }
    if (includeBodies && typeof parsed.result === "string") {
      data.result = truncateString(
        redactUrlsInText(parsed.result),
        AGENT_RESULT_MAX,
      );
    }
    return { type: "agent.tool", data };
  }
  if (type === "run") {
    return {
      type: "agent.run",
      data: { provider: asString(parsed.provider), model: asString(parsed.model) },
    };
  }
  if (type === "end") {
    const rawTokens = isPlainObject(parsed.tokens) ? parsed.tokens : {};
    return {
      type: "agent.end",
      data: {
        model_calls: asFiniteNumber(parsed.model_calls, 0),
        tool_calls: asFiniteNumber(parsed.tool_calls, 0),
        tokens: {
          input: asFiniteNumber(rawTokens.input, 0),
          cached: asFiniteNumber(rawTokens.cached, 0),
          cache_creation: asFiniteNumber(rawTokens.cache_creation, 0),
          output: asFiniteNumber(rawTokens.output, 0),
        },
      },
    };
  }
  return { type: "agent.unknown", data: { agent_type: type, agent_t: agentT } };
}

/**
 * Tailer file trace agen. File boleh belum ada saat start() dipanggil.
 * Handler dipanggil untuk tiap baris hasil konversi, termasuk baris
 * penanda tracer.agent_attached / tracer.agent_reset.
 */
export class AgentTraceTailer {
  private handle: FileHandle | null = null;
  private offset = 0;
  private hadContent = false;
  private partial = "";
  private partialBytes = 0;
  private decoder = new StringDecoder("utf8");
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly stats: AgentTraceStats = { lines: 0, skipped: 0, resets: 0 };

  constructor(
    private readonly path: string,
    private readonly onRow: (row: AgentTraceRow) => void,
    private readonly includeBodies: boolean,
  ) {}

  start(): void {
    this.onRow({ type: "tracer.agent_attached", data: { path: this.path } });
    this.timer = setInterval(() => {
      void this.poll().catch(() => {
        // Kegagalan polling (mis. file terkunci sesaat) ditoleransi:
        // polling berikutnya mencoba lagi; shutdown tetap berhenti.
      });
    }, AGENT_POLL_MS);
    this.timer.unref?.();
    void this.poll().catch(() => undefined);
  }

  private async closeHandle(): Promise<void> {
    if (this.handle !== null) {
      const h = this.handle;
      this.handle = null;
      try {
        await h.close();
      } catch {
        /* abaikan */
      }
    }
  }

  private resetState(emitMarker: boolean): void {
    void this.closeHandle();
    this.offset = 0;
    this.partial = "";
    this.partialBytes = 0;
    this.decoder = new StringDecoder("utf8");
    if (emitMarker) {
      this.stats.resets += 1;
      this.onRow({ type: "tracer.agent_reset", data: { path: this.path } });
    }
  }

  private emitLine(text: string): void {
    const row = convertAgentLine(text, this.includeBodies);
    if (row === null) {
      this.stats.skipped += 1;
      return;
    }
    this.stats.lines += 1;
    this.onRow(row);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File belum ada (atau dihapus lalu dibuat ulang): tunggu.
        if (this.hadContent) {
          this.hadContent = false;
          this.resetState(true);
        }
        return;
      }
      return;
    }
    if (size < this.offset) {
      // File ditimpa agen baru: mulai dari awal.
      this.resetState(true);
    }
    if (size === this.offset) return;
    if (this.handle === null) {
      try {
        this.handle = await open(this.path, "r");
      } catch {
        return;
      }
    }
    const toRead = Math.min(size - this.offset, MAX_READ_BYTES_PER_POLL);
    const buf = Buffer.alloc(toRead);
    let bytesRead = 0;
    try {
      const res = await this.handle.read(buf, 0, toRead, this.offset);
      bytesRead = res.bytesRead;
    } catch {
      return;
    }
    if (bytesRead === 0) return;
    this.offset += bytesRead;
    this.hadContent = true;
    const text = this.decoder.write(buf.subarray(0, bytesRead));
    this.partial += text;
    this.partialBytes += Buffer.byteLength(text, "utf8");
    if (this.partialBytes > MAX_PARTIAL_BYTES && !this.partial.includes("\n")) {
      // Satu baris tanpa newline yang terlalu panjang: buang, jangan
      // biarkan buffer tumbuh tanpa batas.
      this.partial = "";
      this.partialBytes = 0;
      this.stats.skipped += 1;
      return;
    }
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    this.partialBytes = Buffer.byteLength(this.partial, "utf8");
    for (const line of lines) {
      if (line === "") continue;
      this.emitLine(line);
    }
  }

  /** Hentikan polling; proses sisa buffer sebagai baris terakhir bila valid. */
  async stop(): Promise<AgentTraceStats> {
    if (this.stopped) return { ...this.stats };
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const tail = this.partial + this.decoder.end();
    this.partial = "";
    if (tail.trim() !== "") {
      this.emitLine(tail);
    }
    await this.closeHandle();
    return { ...this.stats };
  }
}
