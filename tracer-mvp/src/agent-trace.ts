// agent-trace.ts — Tailer file trace `agent --trace` upstream (F5).
//
// File trace agen berisi satu JSON per baris (lihat docs/F5-DESIGN.md):
// baris "run", "tool" (satu per tool call), dan "end". Tailer membaca
// file ini selagi tracer berjalan dan mengubah tiap baris menjadi baris
// trace JSONL (namespace agent.*). Waktu tiap baris dijangkar pada
// mtime file per batch (lihat docs/ANCHOR-DESIGN.md): baris terakhir
// batch mendarat pada mtime, baris sebelumnya tersebar mundur sesuai
// selisih `t`-nya — sehingga langkah agen dari file yang sudah selesai
// sebelum tracer mulai tetap tampil pada waktu aslinya, bukan menumpuk
// pada waktu baca. Bila batch tidak dapat dijangkar, baris memakai
// waktu baca (perilaku F5 lama).
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
  /**
   * Nilai `t` mentah upstream (ms relatif sejak sesi agen dimulai) bila
   * berupa angka berhingga >= 0; null bila tidak ada/tidak valid.
   * Dipakai tailer untuk penjangkaran mtime; `data.agent_t` tetap
   * memakai fallback 0 lama dan tidak berubah.
   */
  agentT: number | null;
  /**
   * Waktu dinding berjangkar (ms epoch) bila batch baris ini dijangkar
   * pada mtime file; tidak ada berarti pemanggil memakai waktu baca.
   */
  tsMs?: number;
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
 * Nilai `t` mentah untuk penjangkaran: angka berhingga >= 0, atau null
 * bila tidak ada/tidak valid. Berbeda dengan fallback 0 pada
 * `data.agent_t` — baris tanpa `t` tidak boleh dijangkar seolah-olah
 * bermula pada awal sesi.
 */
function rawAgentT(parsed: Record<string, unknown>): number | null {
  const t = parsed.t;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : null;
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
  const anchorT = rawAgentT(parsed);

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
    return { type: "agent.tool", data, agentT: anchorT };
  }
  if (type === "run") {
    return {
      type: "agent.run",
      data: { provider: asString(parsed.provider), model: asString(parsed.model) },
      agentT: anchorT,
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
      agentT: anchorT,
    };
  }
  return { type: "agent.unknown", data: { agent_type: type, agent_t: agentT }, agentT: anchorT };
}

/**
 * Jangkar waktu absolut (ms epoch) untuk satu batch baris agen dari
 * mtime file. Baris terakhir batch mendarat pada jangkar
 * `min(mtimeMs, readTimeMs)`; baris sebelumnya tersebar mundur sesuai
 * selisih `t`-nya. Mengembalikan null per baris (= pakai waktu baca)
 * bila baris itu tidak punya `t` yang dapat dipakai, dan null untuk
 * SELURUH batch bila urutan `t` menurun (batch melintasi batas sesi)
 * atau tidak ada satu pun `t` yang valid. Fungsi murni, untuk diuji
 * langsung. Lihat docs/ANCHOR-DESIGN.md §3.
 */
export function anchorBatchTimes(
  agentTs: ReadonlyArray<number | null>,
  mtimeMs: number,
  readTimeMs: number,
): (number | null)[] {
  const none = (): (number | null)[] => agentTs.map(() => null);
  // Hanya `t` berhingga >= 0 yang dapat dijangkar; sisanya null per baris.
  const cleaned = agentTs.map((t) =>
    typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : null,
  );
  const valid: number[] = [];
  for (const t of cleaned) {
    if (t !== null) valid.push(t);
  }
  if (valid.length === 0) return none();
  for (let i = 1; i < valid.length; i++) {
    if ((valid[i] as number) < (valid[i - 1] as number)) return none();
  }
  const anchor = Math.min(mtimeMs, readTimeMs);
  const last = valid[valid.length - 1] as number;
  return cleaned.map((t) => (t === null ? null : anchor - (last - t)));
}

/**
 * Tailer file trace agen. File boleh belum ada saat start() dipanggil.
 * Handler dipanggil untuk tiap baris hasil konversi, termasuk baris
 * penanda tracer.agent_attached / tracer.agent_reset. Baris agen yang
 * dibaca dalam satu polling dijangkar pada mtime file (lihat
 * anchorBatchTimes); baris penanda dan sisa buffer pada stop() memakai
 * waktu baca.
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
    this.onRow({ type: "tracer.agent_attached", data: { path: this.path }, agentT: null });
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
      this.onRow({ type: "tracer.agent_reset", data: { path: this.path }, agentT: null });
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

  /**
   * Emisikan satu batch baris dari satu polling, dijangkar pada mtime
   * file. Baris yang tidak dapat dikonversi dihitung dilewati; baris
   * yang tidak dapat dijangkar tetap diemisikan tanpa tsMs (waktu baca).
   */
  private emitBatch(lines: string[], mtimeMs: number): void {
    const converted: AgentTraceRow[] = [];
    for (const line of lines) {
      if (line === "") continue;
      const row = convertAgentLine(line, this.includeBodies);
      if (row === null) {
        this.stats.skipped += 1;
        continue;
      }
      converted.push(row);
    }
    if (converted.length === 0) return;
    const readTimeMs = Date.now();
    const anchored = anchorBatchTimes(
      converted.map((r) => r.agentT),
      mtimeMs,
      readTimeMs,
    );
    for (let i = 0; i < converted.length; i++) {
      const row = converted[i] as AgentTraceRow;
      const tsMs = anchored[i];
      if (tsMs !== null && tsMs !== undefined) row.tsMs = tsMs;
      this.stats.lines += 1;
      this.onRow(row);
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    let size: number;
    let mtimeMs: number;
    try {
      const info = await stat(this.path);
      size = info.size;
      mtimeMs = info.mtimeMs;
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
    this.emitBatch(lines, mtimeMs);
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
