// annotate.ts — Menulis baris tracer.annotation ke file JSONL yang sama
// dengan yang ditulis tracer dan dibaca penampil (Bab 4.1 F4, Bab 3.6
// butir 5).
//
// Anotasi disimpan APA ADANYA: sidecar tidak menyensor, memotong, atau
// memvalidasi isi teks anotasi. Tanggung jawab isi ada pada pemanggil;
// README menyatakan larangan mengisi anotasi dengan rahasia.
//
// Penulisan bersifat append-only: isi file yang sudah ada tidak pernah
// diubah atau ditulis ulang. Penulisan antar pemanggilan tool diserialkan
// dengan rantai promise sederhana agar dua anotasi tidak berebut nomor
// seq yang sama.

import { appendFile, readFile } from "node:fs/promises";

export interface AnnotationResult {
  seq: number;
  session: string;
  lightpandaVersion: string;
  ts: string;
  monoMs: number;
  tracePath: string;
}

interface LastRowInfo {
  lastSeq: number;
  firstSession: string | null;
  lastSession: string | null;
  lastVersion: string | null;
  firstTsMs: number | null;
  lastMonoMs: number | null;
  endsWithNewline: boolean;
  exists: boolean;
}

function scanExisting(text: string, exists: boolean): LastRowInfo {
  const info: LastRowInfo = {
    lastSeq: 0,
    firstSession: null,
    lastSession: null,
    lastVersion: null,
    firstTsMs: null,
    lastMonoMs: null,
    endsWithNewline: text === "" || text.endsWith("\n"),
    exists,
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    const seq = typeof rec["seq"] === "number" ? rec["seq"] : null;
    if (seq !== null && Number.isFinite(seq)) {
      info.lastSeq = Math.max(info.lastSeq, Math.floor(seq));
    }
    const session = typeof rec["session"] === "string" ? rec["session"] : null;
    if (session !== null) {
      if (info.firstSession === null) {
        info.firstSession = session;
      }
      info.lastSession = session;
    }
    const version =
      typeof rec["lightpanda_version"] === "string" ? rec["lightpanda_version"] : null;
    if (version !== null) {
      info.lastVersion = version;
    }
    if (info.firstTsMs === null && typeof rec["ts"] === "string") {
      const parsedTs = Date.parse(rec["ts"]);
      if (!Number.isNaN(parsedTs)) {
        info.firstTsMs = parsedTs;
      }
    }
    if (typeof rec["mono_ms"] === "number" && Number.isFinite(rec["mono_ms"])) {
      info.lastMonoMs = rec["mono_ms"];
    }
  }
  return info;
}

async function appendAnnotationInner(
  tracePath: string,
  text: string,
  expectedSession: string | undefined,
): Promise<AnnotationResult> {
  let existing = "";
  let exists = true;
  try {
    existing = await readFile(tracePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      exists = false;
      existing = "";
    } else {
      throw err;
    }
  }

  const info = scanExisting(existing, exists);
  const fileSession = info.lastSession ?? info.firstSession;
  if (
    expectedSession !== undefined &&
    fileSession !== null &&
    fileSession !== expectedSession
  ) {
    throw new Error(
      `Sesi trace "${fileSession}" tidak cocok dengan sesi yang diminta "${expectedSession}"; anotasi tidak ditulis agar tidak menandai file trace yang salah.`,
    );
  }

  const now = Date.now();
  const ts = new Date(now).toISOString();
  let monoMs: number;
  if (info.firstTsMs !== null) {
    monoMs = Math.max(info.lastMonoMs ?? 0, now - info.firstTsMs);
  } else {
    monoMs = info.lastMonoMs ?? 0;
  }
  const session = fileSession ?? expectedSession ?? "unknown";
  const lightpandaVersion = info.lastVersion ?? "unknown";
  const seq = info.lastSeq + 1;

  const row = {
    ts,
    mono_ms: monoMs,
    seq,
    session,
    lightpanda_version: lightpandaVersion,
    type: "tracer.annotation",
    data: { text },
  };
  const prefix = exists && existing !== "" && !info.endsWithNewline ? "\n" : "";
  await appendFile(tracePath, prefix + JSON.stringify(row) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  return { seq, session, lightpandaVersion, ts, monoMs, tracePath };
}

// Rantai serialisasi penulisan: anotasi kedua menunggu anotasi pertama
// selesai membaca + menulis, sehingga seq tidak pernah bentrok.
let writeChain: Promise<unknown> = Promise.resolve();

export function appendAnnotation(
  tracePath: string,
  text: string,
  expectedSession?: string,
): Promise<AnnotationResult> {
  const run = writeChain.then(() => appendAnnotationInner(tracePath, text, expectedSession));
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
