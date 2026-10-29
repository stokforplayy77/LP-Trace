// lockfile.ts — Kunci file antar-proses berbasis O_EXCL ("wx").
//
// Protokol (lihat docs/LOCK-DESIGN.md): kunci adalah file berdampingan
// `<trace>.lock` yang dibuat atomik dengan open("wx"). Pemegang menulis
// PID + stempel waktu ke dalamnya dan memegang handle sampai release().
// Kunci yang lebih tua dari ambang basi dianggap ditinggalkan pemegang
// yang crash dan boleh dicuri. Tanpa dependensi, tanpa flock.

import { open, readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

export class LockAcquisitionError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, message: string) {
    super(message);
    this.name = "LockAcquisitionError";
    this.lockPath = lockPath;
  }
}

export interface LockOptions {
  /** Batas total menunggu kunci, ms (default 5000). */
  timeoutMs?: number;
  /** Jeda antar percobaan, ms (default 50). */
  retryMs?: number;
  /** Umur lockfile yang dianggap basi dan boleh dicuri, ms (default 10000). */
  staleMs?: number;
}

export interface AcquiredLock {
  /** Jalur lockfile yang dipegang. */
  lockPath: string;
  /** Lepaskan kunci (idempotent): tutup handle lalu hapus lockfile. */
  release(): Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Jalur kunci untuk sebuah file trace (path dikanonikalisasi dulu). */
export function lockPathFor(tracePath: string): string {
  return `${resolve(tracePath)}.lock`;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

export async function acquireLock(
  lockPath: string,
  opts: LockOptions = {},
): Promise<AcquiredLock> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retryMs = opts.retryMs ?? 50;
  const staleMs = opts.staleMs ?? 10000;
  const deadline = Date.now() + timeoutMs;
  const holder = `pid=${process.pid}\ntime=${new Date().toISOString()}\n`;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(holder, "utf8");
      } catch {
        // Gagal menulis isi bukan kegagalan kunci; kunci tetap sah.
      }
      let released = false;
      return {
        lockPath,
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          try {
            await handle.close();
          } catch {
            /* abaikan */
          }
          try {
            await unlink(lockPath);
          } catch (err) {
            if (!isEnoent(err)) throw err;
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new Error(`tidak bisa membuat lock file "${lockPath}": ${(err as Error).message}`, {
          cause: err,
        });
      }
      // Lockfile ada: periksa apakah basi (pemegang crash) atau masih segar.
      let stale = false;
      try {
        const info = await stat(lockPath);
        stale = Date.now() - info.mtimeMs > staleMs;
      } catch (statErr) {
        if (isEnoent(statErr)) {
          continue; // Kunci lenyap di antara EEXIST dan stat: coba lagi segera.
        }
        throw statErr;
      }
      if (stale) {
        try {
          await unlink(lockPath);
        } catch (unlinkErr) {
          if (!isEnoent(unlinkErr)) throw unlinkErr;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        let holderInfo = "";
        try {
          const content = await readFile(lockPath, "utf8");
          const first = content.split("\n")[0] ?? "";
          if (first !== "") holderInfo = ` (pemegang: ${first})`;
        } catch {
          /* abaikan: isi kunci tidak terbaca */
        }
        throw new LockAcquisitionError(
          lockPath,
          `file trace sedang dikunci oleh proses lain${holderInfo}; kunci "${lockPath}" tidak didapat dalam ${timeoutMs} ms. Coba lagi sesaat lagi.`,
        );
      }
      await sleep(retryMs);
    }
  }
}
