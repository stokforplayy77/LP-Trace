// queue.ts — Antrean tugas navigasi dari file JSONL
// (RESOURCE-DESIGN.md §2). Tugas yang sudah dibaca tidak pernah
// diulang: pembacaan melacak offset byte + fragmen baris terakhir
// yang belum diakhiri newline (fragmen itu baru dianggap tugas
// bila newline-nya tiba, kecuali pada pemuatan awal).

import { readFile } from "node:fs/promises";

export interface QueueTask {
  url: string;
  /** null = pakai --wait-ms. */
  waitMs: number | null;
  /** Indeks koneksi --cdp. */
  connection: number;
}

export interface QueueRead {
  tasks: QueueTask[];
  skipped: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTaskLine(line: string): QueueTask | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const url = parsed["url"];
  if (typeof url !== "string" || url.length === 0) return null;
  let waitMs: number | null = null;
  if (parsed["waitMs"] !== undefined) {
    const w = parsed["waitMs"];
    if (typeof w !== "number" || !Number.isInteger(w) || w < 0) return null;
    waitMs = w;
  }
  let connection = 0;
  if (parsed["connection"] !== undefined) {
    const c = parsed["connection"];
    if (typeof c !== "number" || !Number.isInteger(c) || c < 0) return null;
    connection = c;
  }
  return { url, waitMs, connection };
}

export class TaskQueue {
  private seenBytes = 0;
  private pendingFragment = "";

  constructor(private readonly path: string) {}

  private async readNewLines(commitTail: boolean): Promise<QueueRead> {
    const buf = await readFile(this.path);
    if (buf.length < this.seenBytes) {
      // File menyusut (dipangkas/diganti): jangan jalankan ulang tugas
      // lama; mulai lagi dari isi saat ini.
      this.seenBytes = 0;
      this.pendingFragment = "";
    }
    const chunk = buf.subarray(this.seenBytes);
    const text = this.pendingFragment + chunk.toString("utf8");
    const lines = text.split("\n");
    const tail = lines.pop() as string;
    if (commitTail) {
      if (tail.length > 0) lines.push(tail);
      this.pendingFragment = "";
      this.seenBytes = buf.length;
    } else {
      this.pendingFragment = tail;
      this.seenBytes = buf.length - Buffer.byteLength(tail, "utf8");
    }
    const tasks: QueueTask[] = [];
    let skipped = 0;
    for (const line of lines) {
      if (line.trim() === "") continue;
      const task = parseTaskLine(line);
      if (task === null) skipped++;
      else tasks.push(task);
    }
    return { tasks, skipped };
  }

  /** Baca seluruh isi file saat mulai; baris terakhir tanpa newline tetap dihitung tugas. */
  async loadInitial(): Promise<QueueRead> {
    return this.readNewLines(true);
  }

  /** Baca tugas yang ditambahkan sejak pembacaan terakhir. */
  async pollNew(): Promise<QueueRead> {
    return this.readNewLines(false);
  }
}
