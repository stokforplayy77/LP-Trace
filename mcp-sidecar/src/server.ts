// server.ts — Server MCP sidecar: tepat dua tool, sesuai Bab 4.1 F4.
//
// get_trace_summary: ringkasan agregat dari file JSONL yang sudah
// diredaksi. Tidak pernah membaca data mentah dari browser, tidak
// pernah mengembalikan isi trace mentah.
// annotate_trace: menambahkan satu baris tracer.annotation ke file
// JSONL yang sama. Teks disimpan apa adanya (Bab 3.6 butir 5).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendAnnotation } from "./annotate.js";
import {
  SUMMARY_CATEGORIES,
  computeSummary,
  readTraceFile,
  type SummaryCategory,
} from "./summary.js";

export const TOOL_NAMES = ["get_trace_summary", "annotate_trace"] as const;

const CATEGORY_DESCRIPTIONS: Record<SummaryCategory, string> = {
  navigation: "event Page.* (navigasi)",
  network: "event Network.* kecuali Network.loadingFailed (masuk kategori error)",
  console: "Runtime.consoleAPICalled (konsol)",
  error: "Runtime.exceptionThrown + Network.loadingFailed (error)",
  tracer: "baris internal tracer.* (sesi/anotasi)",
  other: "event lain di luar kategori di atas",
};

function textResult(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export function createMcpServer(tracePath: string): McpServer {
  const server = new McpServer({
    name: "lp-trace-mcp",
    version: "0.1.0",
  });

  server.tool(
    "get_trace_summary",
    "Mendapatkan ringkasan sesi tracing saat ini: jumlah halaman, jumlah permintaan, jumlah error, total durasi. " +
      "Hanya angka agregat, nama host, dan path tanpa query yang dikembalikan; isi trace mentah, teks konsol, URL lengkap, dan nilai header tidak pernah dikembalikan.",
    {
      category: z
        .enum(SUMMARY_CATEGORIES)
        .optional()
        .describe(
          "Filter kategori event yang diringkas. Bila tidak diisi, seluruh file diringkas. " +
            "Kategori yang didukung: navigation, network, console, error, tracer, other. " +
            "Filter berdasarkan isi (teks/URL) tidak didukung.",
        ),
    },
    async ({ category }) => {
      try {
        const read = await readTraceFile(tracePath);
        const summary = computeSummary(read, tracePath, category ?? null);
        return textResult(JSON.stringify(summary, null, 2));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`gagal membaca file trace "${tracePath}": ${message}`);
      }
    },
  );

  server.tool(
    "annotate_trace",
    "Menulis komentar kustom ke trace saat ini (untuk menandai langkah-langkah penting). " +
      "Teks anotasi disimpan apa adanya ke file JSONL; jangan isi anotasi dengan rahasia.",
    {
      text: z
        .string()
        .min(1, "teks anotasi tidak boleh kosong")
        .describe("Teks anotasi yang ditulis apa adanya sebagai baris tracer.annotation."),
      session: z
        .string()
        .optional()
        .describe(
          "Pengenal sesi yang diharapkan. Bila diisi dan berbeda dengan sesi pada file trace, anotasi ditolak agar tidak menandai file yang salah.",
        ),
    },
    async ({ text, session }) => {
      try {
        const result = await appendAnnotation(tracePath, text, session);
        return textResult(
          JSON.stringify(
            {
              annotated: true,
              seq: result.seq,
              session: result.session,
              lightpandaVersion: result.lightpandaVersion,
              ts: result.ts,
              monoMs: result.monoMs,
              tracePath: result.tracePath,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`gagal menulis anotasi: ${message}`);
      }
    },
  );

  return server;
}

export { CATEGORY_DESCRIPTIONS };
