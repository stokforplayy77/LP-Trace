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
  lp-tracer --cdp <ws-url> --output <file.jsonl> [opsi]

OPSI WAJIB
  --cdp <url>          Endpoint CDP Lightpanda, mis. ws://127.0.0.1:9222
  --output <file>      File trace JSONL yang ditulis (izin 0600)

OPSI
  --session <id>       Pengenal sesi; bila tidak diberikan, dibuat otomatis
  --include-bodies     Rekam postData permintaan (peringatan ditampilkan).
                       Body respons tidak pernah diambil (tracer tidak
                       memanggil Network.getResponseBody).
  --max-bytes <n>      Batas ukuran file trace (default 50 MB, minimum 4096).
                       Bila tercapai, penulisan berhenti; data lama tidak ditimpa.
  --navigate <url>     Navigasikan target tracer ke URL ini (dapat diulang).
                       Tanpa flag ini tracer bersifat pasif.
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
  lp-tracer --cdp ws://127.0.0.1:9222 --output ./trace.jsonl --agent-trace ./agent-trace.jsonl --stay

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
  cdpUrl: string | null;
  output: string | null;
  session: string | null;
  includeBodies: boolean;
  maxBytes: number;
  navigateUrls: string[];
  waitMs: number;
  stay: boolean;
  agentTrace: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    cdpUrl: null,
    output: null,
    session: null,
    includeBodies: false,
    maxBytes: DEFAULT_MAX_BYTES,
    navigateUrls: [],
    waitMs: DEFAULT_WAIT_MS,
    stay: false,
    agentTrace: null,
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
        args.cdpUrl = takeValue(a, i++);
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
  if (!args.cdpUrl) fail("--cdp wajib diisi.");
  if (!args.output) fail("--output wajib diisi.");
  const cdpUrl = args.cdpUrl as string;
  if (!/^wss?:\/\//.test(cdpUrl)) {
    fail(`--cdp harus URL WebSocket (ws:// atau wss://), diterima: ${cdpUrl}.`);
  }
  if (args.includeBodies) {
    console.error(
      "PERINGATAN: --include-bodies aktif — isi body permintaan (postData) akan direkam ke file trace. " +
        "Jangan bagikan file trace yang dihasilkan tanpa memeriksa isinya. Body respons tetap tidak diambil.",
    );
  }
  const outcome = await runTracer({
    cdpUrl,
    output: args.output as string,
    session: args.session,
    includeBodies: args.includeBodies,
    maxBytes: args.maxBytes,
    navigateUrls: args.navigateUrls,
    waitMs: args.waitMs,
    stay: args.stay,
    agentTrace: args.agentTrace,
  });
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
