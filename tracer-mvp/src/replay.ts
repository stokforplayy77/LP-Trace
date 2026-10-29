// replay.ts — Record/replay: jalankan ulang navigasi dari sebuah file trace
// dan bandingkan bentuk jaringannya (LIVE-DESIGN.md §2).
//
// BUKAN replay respons atau interaksi: yang di-re-drive hanyalah urutan
// URL navigasi tingkat atas; yang dibandingkan hanyalah jumlah request
// dan himpunan host per jendela langkah. Konten live berubah, jadi
// ketidakcocokan belum tentu regresi (dinyatakan di laporan).

import { readFile, writeFile } from "node:fs/promises";
import { TracerError } from "./errors.js";
import { runTracer, type TracerOutcome } from "./tracer.js";

export type RowObject = Record<string, unknown>;

function asRecord(value: unknown): RowObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RowObject)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Host dari sebuah URL, atau null bila tidak dapat di-parse. */
export function safeHost(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.host === "" ? null : url.host;
  } catch {
    return null;
  }
}

/**
 * Ekstrak langkah navigasi tingkat atas dari baris-baris trace, sesuai
 * urutan file. Hanya `Page.frameNavigated` TANPA parentId (frame utama);
 * URL dari `data.frame.url` (fallback `data.url`); `about:blank`
 * dibuang; URL identik yang berurutan digabung menjadi satu langkah.
 */
export function extractReplaySteps(rows: RowObject[]): string[] {
  const steps: string[] = [];
  for (const row of rows) {
    if (row["type"] !== "Page.frameNavigated") continue;
    const data = asRecord(row["data"]);
    if (data === null) continue;
    const frame = asRecord(data["frame"]);
    if (frame !== null && frame["parentId"] !== undefined && frame["parentId"] !== null) {
      continue; // sub-frame, bukan navigasi tingkat atas
    }
    const url =
      (frame !== null ? asString(frame["url"]) : null) ?? asString(data["url"]);
    if (url === null || url === "about:blank") continue;
    if (steps.length > 0 && steps[steps.length - 1] === url) continue;
    steps.push(url);
  }
  return steps;
}

export interface StepWindow {
  requests: number;
  hosts: string[];
}

export interface GroupedRequests {
  /** Satu jendela per frameNavigated tingkat atas, sesuai urutan file. */
  windows: StepWindow[];
  /** Seluruh Network.requestWillBeSent dalam file (termasuk sebelum navigasi pertama). */
  totalRequests: number;
}

/**
 * Kelompokkan request per jendela langkah: jendela i = baris setelah
 * frameNavigated tingkat atas ke-i sampai sebelum frameNavigated
 * berikutnya. Request sebelum navigasi pertama tidak masuk jendela
 * mana pun (tetap dihitung di totalRequests).
 */
export function groupRequestsByStep(rows: RowObject[]): GroupedRequests {
  const windows: Array<{ requests: number; hosts: Set<string> }> = [];
  let totalRequests = 0;
  let current = -1;
  for (const row of rows) {
    const data = asRecord(row["data"]);
    if (row["type"] === "Page.frameNavigated" && data !== null) {
      const frame = asRecord(data["frame"]);
      if (frame === null || frame["parentId"] === undefined || frame["parentId"] === null) {
        current += 1;
        windows.push({ requests: 0, hosts: new Set<string>() });
      }
      continue;
    }
    if (row["type"] !== "Network.requestWillBeSent") continue;
    totalRequests += 1;
    if (current < 0 || data === null) continue;
    const win = windows[current] as { requests: number; hosts: Set<string> };
    win.requests += 1;
    const request = asRecord(data["request"]);
    const rawUrl = (request !== null ? asString(request["url"]) : null) ?? asString(data["url"]);
    if (rawUrl !== null) {
      const host = safeHost(rawUrl);
      if (host !== null) win.hosts.add(host);
    }
  }
  return {
    windows: windows.map((w) => ({ requests: w.requests, hosts: [...w.hosts].sort() })),
    totalRequests,
  };
}

/** Parse file JSONL; baris kosong/rusak dilewati dan dihitung. */
export async function readTraceRows(
  tracePath: string,
): Promise<{ rows: RowObject[]; skippedLines: number }> {
  const text = await readFile(tracePath, "utf8");
  const rows: RowObject[] = [];
  let skippedLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    const rec = asRecord(parsed);
    if (rec === null || typeof rec["type"] !== "string") {
      skippedLines += 1;
      continue;
    }
    rows.push(rec);
  }
  return { rows, skippedLines };
}

export interface ReplayStepComparison {
  index: number;
  url: string;
  originalRequests: number;
  replayRequests: number;
  originalHosts: string[];
  replayHosts: string[];
  match: boolean;
}

export interface ReplayReport {
  original: { path: string; session: string; steps: number; requests: number; skippedLines: number };
  replay: { path: string; session: string; requests: number; skippedLines: number };
  steps: ReplayStepComparison[];
  match: boolean;
  notes: string[];
}

export interface ReplayOptions {
  cdpUrl: string;
  replayPath: string;
  output: string;
  session: string | null;
  includeBodies: boolean;
  maxBytes: number;
  waitMs: number;
  append: boolean;
  livePort: number | null;
  retries: number;
  retryDelayMs: number;
  survive: boolean;
  reportPath: string | null;
}

export interface ReplayOutcome {
  exitCode: number;
  report: ReplayReport | null;
}

const REPLAY_NOTES = [
  "Replay menjalankan ulang navigasi tingkat atas saja; klik/isi form dan body respons tidak direkam tracer sehingga tidak dapat di-replay.",
  "Konten live berubah: ketidakcocokan jumlah request/host belum tentu regresi; periksa langkah yang berbeda sebelum menyimpulkan.",
  "Sumbu waktu (mono_ms/ts) tidak dibandingkan karena tidak sebanding antar-run.",
];

export async function runReplay(opts: ReplayOptions): Promise<ReplayOutcome> {
  let input: { rows: RowObject[]; skippedLines: number };
  try {
    input = await readTraceRows(opts.replayPath);
  } catch (e) {
    throw new TracerError(
      "E_REPLAY",
      `replay gagal membaca ${opts.replayPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const steps = extractReplaySteps(input.rows);
  if (steps.length === 0) {
    throw new TracerError(
      "E_REPLAY",
      `replay dibatalkan: tidak ada navigasi tingkat atas (Page.frameNavigated) dalam ${opts.replayPath}.`,
    );
  }
  const originalSession =
    input.rows.length > 0 ? (asString(input.rows[0]?.["session"]) ?? "unknown") : "unknown";
  const replaySession = opts.session ?? `replay-${originalSession}`;

  const outcome: TracerOutcome = await runTracer({
    cdpUrls: [opts.cdpUrl],
    output: opts.output,
    session: replaySession,
    includeBodies: opts.includeBodies,
    maxBytes: opts.maxBytes,
    navigateUrls: steps,
    waitMs: opts.waitMs,
    stay: false,
    agentTrace: null,
    append: opts.append,
    livePort: opts.livePort,
    retries: opts.retries,
    retryDelayMs: opts.retryDelayMs,
    survive: opts.survive,
  });
  if (outcome.exitCode !== 0) {
    return { exitCode: outcome.exitCode, report: null };
  }

  const replayed = await readTraceRows(opts.output);
  const origGrouped = groupRequestsByStep(input.rows);
  const replayGrouped = groupRequestsByStep(replayed.rows);

  const comparisons: ReplayStepComparison[] = steps.map((url, i) => {
    const orig = origGrouped.windows[i] ?? { requests: 0, hosts: [] as string[] };
    const repl = replayGrouped.windows[i] ?? { requests: 0, hosts: [] as string[] };
    const hostsEqual =
      orig.hosts.length === repl.hosts.length &&
      orig.hosts.every((h) => repl.hosts.includes(h));
    return {
      index: i,
      url,
      originalRequests: orig.requests,
      replayRequests: repl.requests,
      originalHosts: orig.hosts,
      replayHosts: repl.hosts,
      match: orig.requests === repl.requests && hostsEqual,
    };
  });

  const report: ReplayReport = {
    original: {
      path: opts.replayPath,
      session: originalSession,
      steps: steps.length,
      requests: origGrouped.totalRequests,
      skippedLines: input.skippedLines,
    },
    replay: {
      path: opts.output,
      session: replaySession,
      requests: replayGrouped.totalRequests,
      skippedLines: replayed.skippedLines,
    },
    steps: comparisons,
    match: comparisons.every((c) => c.match),
    notes: REPLAY_NOTES,
  };

  if (opts.reportPath !== null) {
    await writeFile(opts.reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  return { exitCode: 0, report };
}
