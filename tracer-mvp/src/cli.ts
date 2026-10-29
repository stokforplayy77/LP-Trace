#!/usr/bin/env node
// cli.ts — Antarmuka baris perintah lp-tracer (F1).
// Flag --navigate/--stay/--wait-ms adalah tambahan di luar Bab 4.1:
// tracer dapat menggerakkan navigasinya sendiri untuk pengujian dan
// benchmark; tanpa flag itu tracer bersifat pasif (mengamati sesi
// sampai sinyal tiba). Lihat README bagian "Perbedaan dari spesifikasi".

import { runTracer } from "./tracer.js";

const VERSION = "0.1.0";
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MIN_MAX_BYTES = 4096;
const DEFAULT_WAIT_MS = 1500;

const HELP = `lp-tracer ${VERSION} — tracer CDP eksternal untuk Lightpanda Browser (M1)

PENGGUNAAN
  lp-tracer --cdp <ws-url> [--cdp <ws-url> ...] --output <file.jsonl> [opsi]

OPSI WAJIB
  --cdp <url>          Endpoint CDP Lightpanda, mis. ws://127.0.0.1:9222.
                       Dapat diulang: tiap kemunculan adalah satu koneksi
                       (satu target). URL yang sama boleh diulang untuk
                       beberapa target pada satu proses serve.
  --output <file>      File trace JSONL yang ditulis (izin 0600)

OPSI
  --session <id>       Pengenal sesi; bila tidak diberikan, dibuat otomatis.
                       Dengan --append, sesi harus sama dengan sesi file lama.
  --append             Lanjutkan file trace yang ada tanpa menimpa (resume):
                       sesi dan nomor urut bersambung. Tanpa flag ini file
                       ditimpa.
  --include-bodies     Rekam postData permintaan (peringatan ditampilkan).
                       Body respons tidak pernah diambil (tracer tidak
                       memanggil Network.getResponseBody).
  --max-bytes <n>      Batas ukuran file trace (default 50 MB, minimum 4096).
                       Bila tercapai, penulisan berhenti; data lama tidak ditimpa.
                       Dengan --append, batas berlaku untuk ukuran total file.
  --navigate <url>     Navigasikan koneksi ke URL ini (dapat diulang).
                       Satu --cdp: navigasi berurutan pada target yang sama.
                       Beberapa --cdp: dipasangkan berurutan, navigasi ke-i
                       untuk koneksi ke-i (jumlah tidak boleh melebihi
                       jumlah --cdp). Tanpa flag ini tracer bersifat pasif.
  --wait-ms <n>        Jeda antar navigasi --navigate (default 1500 ms).
  --stay               Setelah navigasi selesai, tetap berjalan sampai sinyal.
  --agent-trace <file> Baca (tail) file trace agent --trace upstream
                       selama sesi dan tulis langkah agen sebagai baris
                       agent.* pada sumbu waktu yang sama (F5). File boleh
                       belum ada saat tracer mulai.
  --help               Tampilkan bantuan ini.
  --version            Tampilkan versi.

CONTOH
  lp-tracer --cdp ws://127.0.0.1:9222 --output ./trace.jsonl --session "my-agent-run-001"
  lp-tracer --cdp ws://127.0.0.1:9222 --output ./trace.jsonl --navigate http://127.0.0.1:8765/ok.html
  lp-tracer --cdp ws://127.0.0.1:9222 --cdp ws://127.0.0.1:9222 --output ./trace.jsonl --navigate http://127.0.0.1:8765/a.html --navigate http://127.0.0.1:8765/b.html --stay
  lp-tracer --cdp ws://127.0.0.1:9222 --output ./trace.jsonl --append --stay

CATATAN
  Tracer melakukan handshake Target (Bab 3.3) dan mencatat event CDP yang
  sudah diredaksi (Bab 3.6): header sensitif disensor, body tidak direkam
  secara default, argumen konsol dipotong. Domain Log tidak dipakai di MVP.
  Baris agen (F5) diredaksi dengan aturan yang sama: argumen dipotong,
  hasil tool tidak ditulis kecuali --include-bodies.
`;

function fail(message: string): never {
  console.error(`lp-tracer: ${message}`);
  console.error(HELP);
  process.exit(2);
}

interface ParsedArgs {
  cdpUrls: string[];
  output: string | null;
  session: string | null;
  includeBodies: boolean;
  maxBytes: number;
  navigateUrls: string[];
  waitMs: number;
  stay: boolean;
  agentTrace: string | null;
  append: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    cdpUrls: [],
    output: null,
    session: null,
    includeBodies: false,
    maxBytes: DEFAULT_MAX_BYTES,
    navigateUrls: [],
    waitMs: DEFAULT_WAIT_MS,
    stay: false,
    agentTrace: null,
    append: false,
  };
  const takeValue = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      fail(`flag ${flag} membutuhkan nilai.`);
    }
    return v as string;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      case "--version":
        console.log(`lp-tracer ${VERSION}`);
        process.exit(0);
        break;
      case "--cdp":
        args.cdpUrls.push(takeValue(a, i++));
        break;
      case "--append":
        args.append = true;
        break;
      case "--output":
        args.output = takeValue(a, i++);
        break;
      case "--session":
        args.session = takeValue(a, i++);
        break;
      case "--include-bodies":
        args.includeBodies = true;
        break;
      case "--max-bytes": {
        const raw = takeValue(a, i++);
        const n = Number(raw);
        if (!Number.isInteger(n) || n < MIN_MAX_BYTES) {
          fail(`--max-bytes harus bilangan bulat >= ${MIN_MAX_BYTES}, diterima: ${raw}.`);
        }
        args.maxBytes = n;
        break;
      }
      case "--navigate":
        args.navigateUrls.push(takeValue(a, i++));
        break;
      case "--wait-ms": {
        const raw = takeValue(a, i++);
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          fail(`--wait-ms harus bilangan bulat >= 0, diterima: ${raw}.`);
        }
        args.waitMs = n;
        break;
      }
      case "--stay":
        args.stay = true;
        break;
      case "--agent-trace":
        args.agentTrace = takeValue(a, i++);
        break;
      default:
        fail(`argumen tidak dikenal: ${a}.`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cdpUrls.length === 0) fail("--cdp wajib diisi (minimal satu).");
  if (!args.output) fail("--output wajib diisi.");
  if (args.cdpUrls.length > 1 && args.navigateUrls.length > args.cdpUrls.length) {
    fail(
      `--navigate (${args.navigateUrls.length}) lebih banyak dari --cdp (${args.cdpUrls.length}): dengan beberapa --cdp, tiap navigasi dipasangkan dengan satu koneksi.`,
    );
  }
  for (const cdpUrl of args.cdpUrls) {
    if (!/^wss?:\/\//.test(cdpUrl)) {
      fail(`--cdp harus URL WebSocket (ws:// atau wss://), diterima: ${cdpUrl}.`);
    }
  }
  if (args.includeBodies) {
    console.error(
      "PERINGATAN: --include-bodies aktif — isi body permintaan (postData) akan direkam ke file trace. " +
        "Jangan bagikan file trace yang dihasilkan tanpa memeriksa isinya. Body respons tetap tidak diambil.",
    );
  }
  let outcome: Awaited<ReturnType<typeof runTracer>>;
  try {
    outcome = await runTracer({
      cdpUrls: args.cdpUrls,
      output: args.output as string,
      session: args.session,
      includeBodies: args.includeBodies,
      maxBytes: args.maxBytes,
      navigateUrls: args.navigateUrls,
      waitMs: args.waitMs,
      stay: args.stay,
      agentTrace: args.agentTrace,
      append: args.append,
    });
  } catch (e) {
    // Kegagalan sebelum sesi dimulai (mis. validasi resume): pesan rapi, keluar 1.
    console.error(`lp-tracer: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  if (outcome.limitReached) {
    console.error(
      "lp-tracer: batas ukuran trace tercapai; sesi diakhiri agar file tetap utuh.",
    );
  }
  process.exit(outcome.exitCode);
}

main().catch((e: unknown) => {
  console.error(`lp-tracer: kegagalan tak terduga: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
