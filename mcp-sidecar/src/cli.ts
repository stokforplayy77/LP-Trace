#!/usr/bin/env node
// cli.ts — Titik masuk server MCP stdio lp-trace-mcp (M3).
//
// Transport stdio: stdin/stdout dipakai protokol MCP (JSON-RPC), sehingga
// SEMUA log/pesan bantuan harus ke stderr. File trace dibaca dari flag
// --trace atau variabel lingkungan LP_TRACE_PATH.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

const VERSION = "0.1.0";

const HELP = `lp-trace-mcp ${VERSION} — sidecar MCP untuk trace Lightpanda (M3)

PENGGUNAAN
  lp-trace-mcp --trace <file.jsonl>

OPSI WAJIB (salah satu)
  --trace <file>     File trace JSONL yang dibaca sidecar. Dapat juga
                     diisi lewat variabel lingkungan LP_TRACE_PATH.
  --help             Tampilkan bantuan ini.
  --version          Tampilkan versi.

TOOL MCP (tepat dua, sesuai Dokumen Perancangan v1.1 F4)
  get_trace_summary  Ringkasan agregat saja: jumlah halaman, permintaan,
                     error, total durasi, hitungan per kategori/level.
                     Tidak pernah mengembalikan isi trace mentah.
  annotate_trace     Menambahkan baris tracer.annotation ke file JSONL.
                     Teks disimpan apa adanya; jangan isi rahasia.

CONTOH KONFIGURASI KLIEN (stdio)
  {
    "mcpServers": {
      "lp-trace": {
        "command": "node",
        "args": ["<path-ke-mcp-sidecar>/dist/cli.js", "--trace", "<path-ke-trace>/trace.jsonl"]
      }
    }
  }
`;

function fail(message: string): never {
  process.stderr.write(`lp-trace-mcp: ${message}\n\n${HELP}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { tracePath: string | undefined } {
  let tracePath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--trace") {
      const value = argv[i + 1];
      if (value === undefined || value === "") {
        fail("--trace membutuhkan nilai path file.");
      }
      tracePath = value;
      i += 1;
    } else if (arg.startsWith("--trace=")) {
      const value = arg.slice("--trace=".length);
      if (value === "") {
        fail("--trace membutuhkan nilai path file.");
      }
      tracePath = value;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === "--version") {
      process.stdout.write(`lp-trace-mcp ${VERSION}\n`);
      process.exit(0);
    } else {
      fail(`argumen tidak dikenal: ${arg}`);
    }
  }
  return { tracePath };
}

async function main(): Promise<void> {
  const { tracePath: flagPath } = parseArgs(process.argv.slice(2));
  const envPath = process.env["LP_TRACE_PATH"];
  const tracePath = flagPath ?? (envPath !== undefined && envPath !== "" ? envPath : undefined);
  if (tracePath === undefined) {
    fail("--trace tidak diberikan dan variabel lingkungan LP_TRACE_PATH tidak disetel.");
  }

  const server = createMcpServer(tracePath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`lp-trace-mcp ${VERSION} berjalan (trace: ${tracePath})\n`);

  const shutdown = (): void => {
    void server.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lp-trace-mcp: gagal memulai: ${message}\n`);
  process.exit(1);
});
