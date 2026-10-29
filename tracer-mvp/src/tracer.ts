// tracer.ts — Orkestrasi sesi tracing (F1/F2 + multi-endpoint + resume):
// periksa versi, handshake per koneksi, kumpulkan event CDP, tulis JSONL
// sesuai Lampiran A (diperluas MS-DESIGN.md: field endpoint /
// endpoint_index), tutup dengan anggun.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  CdpClient,
  HandshakeError,
  enableDomains,
  performHandshake,
} from "./cdp.js";
import { AgentTraceTailer } from "./agent-trace.js";
import { redactEvent } from "./redact.js";
import { TracerError } from "./errors.js";
import { startLiveServer, type LiveServer } from "./live.js";
import { BufferedWriter, SizeLimitReached } from "./writer.js";

export interface TracerOptions {
  /** Satu kemunculan = satu koneksi CDP (satu target). Boleh mengulang URL yang sama. */
  cdpUrls: string[];
  output: string;
  session: string | null;
  includeBodies: boolean;
  maxBytes: number;
  /** Navigasi ke-i untuk koneksi ke-i (pasangan berurutan). */
  navigateUrls: string[];
  waitMs: number;
  stay: boolean;
  /** Path file trace `agent --trace` upstream yang di-tail (F5); null bila tidak dipakai. */
  agentTrace: string | null;
  /** Bila true, lanjutkan file trace yang ada tanpa menimpa (resume). */
  append: boolean;
  /** Port server SSE live (loopback); null = mode live mati. */
  livePort: number | null;
  /** Jumlah percobaan ulang startup bila endpoint tidak terjangkau (default 0). */
  retries: number;
  /** Jeda dasar antar percobaan ulang, ms (backoff eksponensial, maks 8000). */
  retryDelayMs: number;
  /** Bila true (--survive), penutupan satu koneksi tidak mengakhiri sesi selama masih ada koneksi lain yang hidup; penutupan itu dicatat sebagai baris tracer.connection_closed. Tanpa flag ini, penutupan koneksi mana pun mengakhiri sesi (perilaku MS). */
  survive: boolean;
}

export interface TracerOutcome {
  exitCode: number;
  session: string;
  lightpandaVersion: string;
  eventsWritten: number;
  limitReached: boolean;
}

function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `trace-${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Turunkan basis HTTP dari URL CDP ws(s)://host:port[/path]. */
export function httpBaseFromCdp(cdpUrl: string): string | null {
  try {
    const u = new URL(cdpUrl);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Periksa versi Lightpanda lewat GET /json/version sebelum terhubung.
 * Mengembalikan string versi atau "unknown" bila tidak dapat dibaca
 * (tracer tetap berjalan dalam kasus itu).
 */
export async function fetchLightpandaVersion(
  cdpUrl: string,
  timeoutMs = 3000,
): Promise<string> {
  const base = httpBaseFromCdp(cdpUrl);
  if (!base) return "unknown";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/json/version`, {
      signal: controller.signal,
    });
    if (!res.ok) return "unknown";
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body["Lightpanda-Version"] === "string") {
      return body["Lightpanda-Version"] as string;
    }
    if (typeof body.Browser === "string") {
      const m = /Lightpanda\/([^\s]+)/.exec(body.Browser as string);
      if (m?.[1]) return m[1];
      return body.Browser as string;
    }
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

export interface ResumeState {
  /** Sesi baris terakhir, atau null bila baris terakhir tidak membawa sesi string. */
  session: string | null;
  /** seq baris terakhir yang valid. */
  lastSeq: number;
  /** Jumlah baris tidak kosong dalam file. */
  rowCount: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Baca keadaan resume dari file trace yang ada. Mengembalikan null bila
 * file tidak ada atau kosong. Melempar Error bila baris terakhir tidak
 * dapat di-parse sebagai baris trace valid (objek JSON dengan `type`
 * string dan `seq` angka) — menempel ke ekor yang rusak dilarang.
 */
export async function readResumeState(outputPath: string): Promise<ResumeState | null> {
  let text: string;
  try {
    text = await readFile(outputPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1] as string;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw new TracerError(
      "E_RESUME",
      `resume dibatalkan: baris terakhir ${outputPath} bukan JSON valid; periksa file sebelum melanjutkan sesi ini.`,
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.type !== "string" ||
    typeof parsed.seq !== "number"
  ) {
    throw new TracerError(
      "E_RESUME",
      `resume dibatalkan: baris terakhir ${outputPath} bukan baris trace valid (butuh type string dan seq angka).`,
    );
  }
  return {
    session: typeof parsed.session === "string" ? parsed.session : null,
    lastSeq: parsed.seq,
    rowCount: lines.length,
  };
}

interface RowOrigin {
  endpoint: string;
  endpointIndex: number;
  version: string;
}

export async function runTracer(opts: TracerOptions): Promise<TracerOutcome> {
  if (opts.cdpUrls.length === 0) {
    throw new Error("runTracer membutuhkan minimal satu --cdp.");
  }
  // Versi diambil sebelum sesi dimulai (untuk baris session_started)
  // dan diambil ulang pada tiap percobaan ulang handshake.
  let versions = await Promise.all(
    opts.cdpUrls.map((u) => fetchLightpandaVersion(u)),
  );
  let lightpandaVersion = versions[0] as string;

  // Tentukan sesi + seq awal. Resume diputuskan SEBELUM writer dibuka
  // agar kegagalan validasi tidak menyentuh file sama sekali.
  let session: string;
  let seq = 0;
  let resumed = false;
  let previousRows = 0;
  if (opts.append) {
    const state = await readResumeState(opts.output);
    if (state !== null) {
      if (
        opts.session !== null &&
        state.session !== null &&
        opts.session !== state.session
      ) {
        throw new TracerError(
          "E_RESUME",
          `resume dibatalkan: --session "${opts.session}" berbeda dengan sesi file "${state.session}".`,
        );
      }
      session = opts.session ?? state.session ?? generateSessionId();
      seq = state.lastSeq;
      previousRows = state.rowCount;
      resumed = true;
    } else {
      session = opts.session ?? generateSessionId();
    }
  } else {
    session = opts.session ?? generateSessionId();
  }

  let limitReached = false;
  // Error terstruktur untuk baris session_ended: diisi oleh jalur
  // kegagalan (handshake/cdp-closed/limit) sebelum shutdown().
  let sessionError: Record<string, unknown> | null = null;
  // Mode live dimulai SEBELUM file dibuka: port yang sudah dipakai
  // menggagalkan sesi sebelum file trace disentuh.
  let live: LiveServer | null = null;
  let eventsWritten = 0;
  if (opts.livePort !== null) {
    live = await startLiveServer(
      opts.livePort,
      session,
      opts.cdpUrls,
      () => eventsWritten,
    );
  }
  const writer = new BufferedWriter(
    opts.output,
    opts.maxBytes,
    (err: SizeLimitReached) => {
      limitReached = true;
      sessionError = { code: "E_TRACE_LIMIT", message: err.message };
      console.error(`lp-tracer: [E_TRACE_LIMIT] ${err.message}`);
    },
    opts.append,
  );
  try {
    await writer.open();
  } catch (e) {
    if (live !== null) {
      await live.close();
    }
    throw e;
  }

  const startMono = performance.now();
  // Pasangan jam dinding untuk startMono: dipakai menghitung mono_ms
  // baris agen berjangkar (ts berjangkar - startWallMs, dibatasi 0).
  const startWallMs = Date.now();
  let ended = false;
  let shutdownRequested = false;
  let exitCode = 0;
  let tailer: AgentTraceTailer | null = null;

  // seq hanya bertambah untuk baris yang benar-benar tertulis, agar
  // nomor urut di file selalu berurutan tanpa lompat (termasuk saat resume).
  // timeMs (opsional, hanya baris agen berjangkar): waktu dinding absolut
  // (ms epoch) dari penjangkaran mtime; mono_ms dihitung dari selisihnya
  // dengan startWallMs dan dibatasi bawah 0. Tanpa timeMs, ts/mono_ms
  // memakai waktu baca seperti biasa.
  const writeRow = (
    type: string,
    data: Record<string, unknown>,
    origin: RowOrigin = { endpoint: "", endpointIndex: -1, version: lightpandaVersion },
    timeMs?: number,
  ): boolean => {
    const nextSeq = seq + 1;
    const wallMs = timeMs ?? Date.now();
    const row = {
      ts: new Date(wallMs).toISOString(),
      mono_ms:
        timeMs === undefined
          ? Math.round(performance.now() - startMono)
          : Math.max(0, Math.round(timeMs - startWallMs)),
      seq: nextSeq,
      session,
      lightpanda_version: origin.version,
      endpoint: origin.endpoint,
      endpoint_index: origin.endpointIndex,
      type,
      data,
    };
    const line = JSON.stringify(row);
    const ok = writer.write(line);
    if (ok) {
      seq = nextSeq;
      eventsWritten += 1;
      // Mode live: siarkan baris yang sama persis setelah berhasil ditulis.
      live?.broadcast(line);
    }
    return ok;
  };

  const writeSessionEnd = (
    reason: string,
    extra: Record<string, unknown> = {},
    origin: RowOrigin = { endpoint: "", endpointIndex: -1, version: lightpandaVersion },
  ): boolean => {
    if (ended) return false;
    ended = true;
    const nextSeq = seq + 1;
    const row = {
      ts: new Date().toISOString(),
      mono_ms: Math.round(performance.now() - startMono),
      seq: nextSeq,
      session,
      lightpanda_version: origin.version,
      endpoint: origin.endpoint,
      endpoint_index: origin.endpointIndex,
      type: "tracer.session_ended",
      data: { reason, ...extra },
    };
    const line = JSON.stringify(row);
    const ok = writer.writeSessionEnd(line);
    if (ok) {
      seq = nextSeq;
      eventsWritten += 1;
      live?.broadcast(line);
    }
    return ok;
  };

  // Baris pertama sesi ini: session_started (file baru) atau
  // session_resumed (lanjutkan file lama). Ditulis sebelum handshake
  // agar file selalu lengkap sekalipun handshake gagal.
  if (resumed) {
    writeRow("tracer.session_resumed", {
      previousRows,
      resumedFromSeq: seq + 1,
      output: opts.output,
      cdp: opts.cdpUrls[0],
      endpoints: opts.cdpUrls,
      ...(opts.includeBodies ? { includeBodies: true } : {}),
    });
  } else {
    writeRow("tracer.session_started", {
      cdp: opts.cdpUrls[0],
      endpoints: opts.cdpUrls,
      ...(opts.includeBodies ? { includeBodies: true } : {}),
    });
  }

  // F5: tail file trace agen bila diminta. Dimulai sedini mungkin agar
  // langkah agen yang terjadi selama handshake pun tertangkap.
  if (opts.agentTrace !== null) {
    tailer = new AgentTraceTailer(
      opts.agentTrace,
      (row) => {
        if (shutdownRequested || limitReached) return;
        writeRow(row.type, row.data, undefined, row.tsMs);
      },
      opts.includeBodies,
    );
    tailer.start();
  }

  // Klien dibuat ulang pada tiap percobaan handshake (retry); shutdown
  // selalu menutup kumpulan klien yang sedang aktif.
  let clients: CdpClient[] = [];
  // Koneksi yang masih hidup, sejajar dengan clients; direset pada tiap
  // percobaan connectAll. Dipakai mode --survive untuk menghitung sisa.
  let alive: boolean[] = [];
  // Koneksi yang menutup lebih dulu dan "diselamatkan" mode --survive,
  // sesuai urutan penutupan; dilaporkan di session_ended.
  const closedEndpoints: Array<{ endpoint: string; endpoint_index: number }> = [];
  // Selama handshake, tutup-koneksi adalah bagian dari kegagalan
  // handshake itu sendiri — bukan akhir sesi cdp-closed.
  let handshaking = true;

  const shutdown = async (
    reason: string,
    code: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    exitCode = code;
    for (const c of clients) {
      try {
        c.close();
      } catch {
        /* abaikan */
      }
    }
    let endExtra: Record<string, unknown> = { ...extra };
    if (sessionError !== null) {
      endExtra = { ...endExtra, error: sessionError };
    }
    if (closedEndpoints.length > 0) {
      endExtra = { ...endExtra, closedEndpoints: [...closedEndpoints] };
    }
    if (tailer !== null) {
      const stats = await tailer.stop();
      endExtra = {
        ...endExtra,
        agentLines: stats.lines,
        agentSkipped: stats.skipped,
        agentResets: stats.resets,
      };
    }
    writeSessionEnd(reason, endExtra);
    await writer.close();
    if (live !== null) {
      await live.close();
    }
  };

  // Penutupan anggun: SIGINT/SIGTERM -> flush, session_ended, keluar 0.
  // Sinyal kedua memaksa keluar segera.
  const onSignal = (signal: string): void => {
    if (shutdownRequested) {
      process.exit(130);
    }
    console.error(`lp-tracer: sinyal ${signal} diterima, menutup sesi...`);
    void shutdown(`signal-${signal}`, 0).then(() => process.exit(exitCode));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Satu percobaan koneksi + handshake + enable untuk semua endpoint.
  // Melempar TracerError E_CDP_UNREACHABLE (dapat di-retry) atau
  // TracerError E_HANDSHAKE (fatal langsung). Membuat klien segar dan
  // mendaftarkan handler event/tutup pada tiap percobaan.
  const connectAll = async (isRetry: boolean): Promise<void> => {
    if (isRetry) {
      versions = await Promise.all(
        opts.cdpUrls.map((u) => fetchLightpandaVersion(u)),
      );
      lightpandaVersion = versions[0] as string;
    }
    clients = opts.cdpUrls.map((u) => new CdpClient(u));
    alive = clients.map(() => true);
    // Bila server CDP menutup koneksi SETELAH handshake berhasil:
    // tanpa --survive, akhiri sesi dengan anggun dan sebutkan
    // koneksinya; dengan --survive, catat penutupan sebagai baris
    // penanda dan lanjutkan selama masih ada koneksi yang hidup.
    clients.forEach((client, index) => {
      client.onClose(() => {
        if (!shutdownRequested && !handshaking) {
          const url = opts.cdpUrls[index] as string;
          alive[index] = false;
          const remaining = alive.filter(Boolean).length;
          if (opts.survive && remaining > 0) {
            closedEndpoints.push({ endpoint: url, endpoint_index: index });
            writeRow(
              "tracer.connection_closed",
              { endpoint: url, endpoint_index: index, remaining },
              { endpoint: url, endpointIndex: index, version: versions[index] as string },
            );
            console.error(
              `lp-tracer: koneksi CDP ${url} (indeks ${index}) ditutup server, ${remaining} koneksi tersisa — sesi berlanjut (--survive).`,
            );
            return;
          }
          sessionError = {
            code: "E_CDP_CLOSED",
            endpoint: url,
            endpoint_index: index,
          };
          console.error(
            `lp-tracer: [E_CDP_CLOSED] koneksi CDP ${url} (indeks ${index}) ditutup server, mengakhiri sesi.`,
          );
          void shutdown("cdp-closed", 0, {
            endpoint: url,
            endpoint_index: index,
          }).then(() => process.exit(exitCode));
        }
      });
    });
    for (let i = 0; i < clients.length; i++) {
      const client = clients[i] as CdpClient;
      const url = opts.cdpUrls[i] as string;
      const version = versions[i] as string;
      const origin: RowOrigin = { endpoint: url, endpointIndex: i, version };
      client.onEvent((method, params) => {
        if (shutdownRequested || limitReached) return;
        const data = redactEvent(method, params, {
          includeBodies: opts.includeBodies,
        });
        writeRow(method, data, origin);
      });
      try {
        await client.connect();
        await performHandshake(client);
        await enableDomains(client);
      } catch (e) {
        if (e instanceof TracerError && e.code === "E_CDP_UNREACHABLE") {
          // Teks diawali "handshake gagal..." agar konsisten dengan
          // pesan kegagalan handshake lama (diuji M1 uji 4a).
          throw new TracerError(
            "E_CDP_UNREACHABLE",
            `handshake gagal pada langkah endpoint ${url} (indeks ${i}): ${e.message}`,
            { endpoint: url, endpoint_index: i },
          );
        }
        const message = e instanceof Error ? e.message : String(e);
        const step = e instanceof HandshakeError ? e.step : "handshake";
        throw new TracerError(
          "E_HANDSHAKE",
          `handshake gagal pada langkah endpoint ${url} (indeks ${i}): ${message}`,
          { endpoint: url, endpoint_index: i, step },
        );
      }
    }
  };

  // Handshake semua koneksi; hanya E_CDP_UNREACHABLE yang di-retry
  // (backoff eksponensial). Kegagalan pada koneksi mana pun bersifat
  // fatal dan menyebut endpoint + indeksnya.
  const maxAttempts = opts.retries + 1;
  let handshakeError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await connectAll(attempt > 0);
      handshakeError = null;
      break;
    } catch (e) {
      handshakeError = e;
      for (const c of clients) {
        try {
          c.close();
        } catch {
          /* abaikan */
        }
      }
      const retryable =
        e instanceof TracerError && e.code === "E_CDP_UNREACHABLE";
      if (!retryable || attempt === maxAttempts - 1) break;
      const delay = Math.min(opts.retryDelayMs * 2 ** attempt, 8000);
      console.error(
        `lp-tracer: [E_CDP_UNREACHABLE] ${e.message} — mencoba lagi (percobaan ${attempt + 2}/${maxAttempts}) setelah ${delay} ms.`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  handshaking = false;
  if (handshakeError !== null) {
    const e = handshakeError;
    const message = e instanceof Error ? e.message : String(e);
    const code = e instanceof TracerError ? e.code : "E_HANDSHAKE";
    const details =
      e instanceof TracerError ? e.details : {};
    sessionError = { code, message, ...details };
    console.error(`lp-tracer: [${code}] ${message}`);
    if (code === "E_HANDSHAKE") {
      console.error(
        "lp-tracer: handshake Target gagal — tracer berhenti tanpa event dari koneksi yang gagal (lihat Bab 3.3 dokumen perancangan).",
      );
    } else {
      console.error(
        `lp-tracer: percobaan koneksi habis (${maxAttempts}x) — periksa 'lightpanda serve' berjalan di alamat yang dituju.`,
      );
    }
    await shutdown("handshake-failed", 1);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    return {
      exitCode: 1,
      session,
      lightpandaVersion,
      eventsWritten,
      limitReached,
    };
  }

  // Navigasi yang digerakkan tracer sendiri. Satu --cdp: semua --navigate
  // berurutan pada target yang sama (perilaku M1). Beberapa --cdp:
  // --navigate dipasangkan berurutan, navigasi ke-i untuk koneksi ke-i
  // (validasi jumlah dilakukan CLI). Tanpa flag ini tracer bersifat pasif.
  if (opts.navigateUrls.length > 0) {
    const plan =
      opts.cdpUrls.length === 1
        ? opts.navigateUrls.map((url) => ({ client: clients[0] as CdpClient, url, connIndex: 0 }))
        : opts.navigateUrls.map((url, i) => ({
            client: clients[i] as CdpClient,
            url,
            connIndex: i,
          }));
    for (const { client, url, connIndex } of plan) {
      if (shutdownRequested || limitReached) break;
      try {
        await client.send("Page.navigate", { url });
      } catch (e) {
        console.error(
          `lp-tracer: [E_NAVIGATE] Page.navigate ke ${url} (koneksi ${connIndex}) gagal: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      await new Promise((r) => setTimeout(r, opts.waitMs));
    }
    if (!opts.stay && !shutdownRequested) {
      await shutdown(limitReached ? "size-limit" : "navigations-done", 0);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      return {
        exitCode: 0,
        session,
        lightpandaVersion,
        eventsWritten,
        limitReached,
      };
    }
  }

  if (limitReached) {
    await shutdown("size-limit", 0);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    return {
      exitCode: 0,
      session,
      lightpandaVersion,
      eventsWritten,
      limitReached,
    };
  }

  // Mode pasif: tetap hidup sampai sinyal, koneksi CDP ditutup, atau
  // batas ukuran tercapai. shutdown() dipicu oleh handler sinyal /
  // onClose di atas, atau oleh pemeriksaan limit di bawah.
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (shutdownRequested) {
        clearInterval(check);
        resolve();
      } else if (limitReached) {
        clearInterval(check);
        void shutdown("size-limit", 0).then(() => resolve());
      }
    }, 100);
    check.unref?.();
  });
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  return {
    exitCode,
    session,
    lightpandaVersion,
    eventsWritten,
    limitReached,
  };
}
