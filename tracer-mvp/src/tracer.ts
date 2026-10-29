// tracer.ts — Orkestrasi sesi tracing (F1/F2): periksa versi, handshake,
// kumpulkan event CDP, tulis JSONL sesuai Lampiran A, tutup dengan anggun.

import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CdpClient,
  HandshakeError,
  enableDomains,
  performHandshake,
} from "./cdp.js";
import { redactEvent } from "./redact.js";
import { BufferedWriter, SizeLimitReached } from "./writer.js";

export interface TracerOptions {
  cdpUrl: string;
  output: string;
  session: string | null;
  includeBodies: boolean;
  maxBytes: number;
  navigateUrls: string[];
  waitMs: number;
  stay: boolean;
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

export async function runTracer(opts: TracerOptions): Promise<TracerOutcome> {
  const session = opts.session ?? generateSessionId();
  const lightpandaVersion = await fetchLightpandaVersion(opts.cdpUrl);

  let limitReached = false;
  const writer = new BufferedWriter(opts.output, opts.maxBytes, (err: SizeLimitReached) => {
    limitReached = true;
    console.error(`lp-tracer: ${err.message}`);
  });
  await writer.open();

  const startMono = performance.now();
  let seq = 0;
  let eventsWritten = 0;
  let ended = false;

  // seq hanya bertambah untuk baris yang benar-benar tertulis, agar
  // nomor urut di file selalu berurutan tanpa lompat.
  const writeRow = (
    type: string,
    data: Record<string, unknown>,
  ): boolean => {
    const nextSeq = seq + 1;
    const row = {
      ts: new Date().toISOString(),
      mono_ms: Math.round(performance.now() - startMono),
      seq: nextSeq,
      session,
      lightpanda_version: lightpandaVersion,
      type,
      data,
    };
    const ok = writer.write(JSON.stringify(row));
    if (ok) {
      seq = nextSeq;
      eventsWritten += 1;
    }
    return ok;
  };

  const writeSessionEnd = (reason: string): boolean => {
    if (ended) return false;
    ended = true;
    const nextSeq = seq + 1;
    const row = {
      ts: new Date().toISOString(),
      mono_ms: Math.round(performance.now() - startMono),
      seq: nextSeq,
      session,
      lightpanda_version: lightpandaVersion,
      type: "tracer.session_ended",
      data: { reason },
    };
    const ok = writer.writeSessionEnd(JSON.stringify(row));
    if (ok) {
      seq = nextSeq;
      eventsWritten += 1;
    }
    return ok;
  };

  // Baris pertama: session_started (ditulis sebelum handshake agar file
  // selalu lengkap sekalipun handshake gagal).
  writeRow("tracer.session_started", {
    cdp: opts.cdpUrl,
    ...(opts.includeBodies ? { includeBodies: true } : {}),
  });

  const client = new CdpClient(opts.cdpUrl);
  let shutdownRequested = false;
  let exitCode = 0;

  const shutdown = async (reason: string, code: number): Promise<void> => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    exitCode = code;
    try {
      client.close();
    } catch {
      /* abaikan */
    }
    writeSessionEnd(reason);
    await writer.close();
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

  // Bila server CDP menutup koneksi, akhiri sesi dengan anggun.
  client.onClose(() => {
    if (!shutdownRequested) {
      console.error("lp-tracer: koneksi CDP ditutup server, mengakhiri sesi.");
      void shutdown("cdp-closed", 0).then(() => process.exit(exitCode));
    }
  });

  try {
    await client.connect();
    await performHandshake(client);
    await enableDomains(client);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`lp-tracer: ${message}`);
    if (e instanceof HandshakeError) {
      console.error(
        "lp-tracer: handshake Target gagal — tracer berhenti tanpa event (lihat Bab 3.3 dokumen perancangan).",
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

  // Rekam event: stempel waktu tracer, redaksi, tulis JSONL.
  client.onEvent((method, params) => {
    if (shutdownRequested || limitReached) return;
    const data = redactEvent(method, params, {
      includeBodies: opts.includeBodies,
    });
    writeRow(method, data);
  });

  // Navigasi yang digerakkan tracer sendiri (flag --navigate). Tanpa
  // flag ini tracer bersifat pasif: menunggu event dari klien lain
  // sampai sinyal tiba.
  if (opts.navigateUrls.length > 0) {
    for (const url of opts.navigateUrls) {
      if (shutdownRequested || limitReached) break;
      try {
        await client.send("Page.navigate", { url });
      } catch (e) {
        console.error(
          `lp-tracer: Page.navigate ke ${url} gagal: ${e instanceof Error ? e.message : String(e)}`,
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
