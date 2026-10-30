// policy.ts — Kebijakan resource per sesi (RESOURCE-DESIGN.md §1).
//
// Tiga batas opt-in: jumlah baris, durasi, dan RSS proses sendiri.
// Tanpa batas yang diaktifkan, kebijakan ini tidak melakukan apa pun
// (perilaku 0.1.9 tidak berubah). Pemicu pertama menang; penentuan
// alasan akhir ada di tracer.ts.

import { readFileSync } from "node:fs";

export type ResourcePolicyKind = "max-rows" | "max-seconds" | "max-rss-mb";

export interface ResourcePolicyConfig {
  maxRows: number | null;
  maxSeconds: number | null;
  maxRssMb: number | null;
}

export interface PolicyTrip {
  policy: ResourcePolicyKind;
  limit: number;
  observed: number;
}

const RSS_PATH = "/proc/self/status";

/** Baca RSS proses sendiri (KiB) dari /proc; null bila tak terbaca. */
export function readRssKb(): number | null {
  try {
    const status = readFileSync(RSS_PATH, "utf8");
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    return m?.[1] ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export class ResourcePolicy {
  private readonly startMonoMs: number;

  constructor(
    private readonly cfg: ResourcePolicyConfig,
    startMonoMs: number,
  ) {
    this.startMonoMs = startMonoMs;
  }

  get active(): boolean {
    return (
      this.cfg.maxRows !== null ||
      this.cfg.maxSeconds !== null ||
      this.cfg.maxRssMb !== null
    );
  }

  /** Objek `limits` untuk baris session_started/resumed (hanya yang aktif). */
  describe(): Record<string, number> {
    const out: Record<string, number> = {};
    if (this.cfg.maxRows !== null) out.maxRows = this.cfg.maxRows;
    if (this.cfg.maxSeconds !== null) out.maxSeconds = this.cfg.maxSeconds;
    if (this.cfg.maxRssMb !== null) out.maxRssMb = this.cfg.maxRssMb;
    return out;
  }

  /** Periksa batas baris; total = baris lama + baris sesi ini. */
  checkRows(totalRows: number): PolicyTrip | null {
    if (this.cfg.maxRows === null) return null;
    if (totalRows >= this.cfg.maxRows) {
      return { policy: "max-rows", limit: this.cfg.maxRows, observed: totalRows };
    }
    return null;
  }

  /** Periksa batas durasi; nowMonoMs memakai jam monotonik yang sama dengan startMonoMs. */
  checkTime(nowMonoMs: number): PolicyTrip | null {
    if (this.cfg.maxSeconds === null) return null;
    const elapsedSeconds = (nowMonoMs - this.startMonoMs) / 1000;
    if (elapsedSeconds >= this.cfg.maxSeconds) {
      return {
        policy: "max-seconds",
        limit: this.cfg.maxSeconds,
        observed: Math.floor(elapsedSeconds),
      };
    }
    return null;
  }

  /** Sampel RSS dan periksa batasnya; null bila tak ada batas atau tak terbaca. */
  sampleRss(): PolicyTrip | null {
    if (this.cfg.maxRssMb === null) return null;
    const kb = readRssKb();
    if (kb === null) return null;
    const mb = kb / 1024;
    if (mb >= this.cfg.maxRssMb) {
      return {
        policy: "max-rss-mb",
        limit: this.cfg.maxRssMb,
        observed: Math.round(mb),
      };
    }
    return null;
  }
}

/** Alasan session_ended untuk tiap pemicu kebijakan. */
export function reasonForTrip(trip: PolicyTrip): string {
  switch (trip.policy) {
    case "max-rows":
      return "row-limit";
    case "max-seconds":
      return "time-limit";
    case "max-rss-mb":
      return "rss-limit";
  }
}
