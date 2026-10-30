// live.ts — Server SSE loopback untuk mode live (LIVE-DESIGN.md §1.1).
//
// Opt-in lewat --live-port. Bind hanya 127.0.0.1: alat lokal, tidak
// terekspos ke jaringan. Menyiarkan setiap baris JSONL yang berhasil
// ditulis tracer (objek yang sama, sudah teredaksi) plus endpoint
// /health. Tanpa dependensi.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TracerError } from "./errors.js";

export interface LiveServer {
  readonly port: number;
  /** Siarkan satu baris JSONL (string) ke semua klien SSE yang tersambung. */
  broadcast(line: string): void;
  /** Akhiri semua koneksi SSE dan tutup server. */
  close(): Promise<void>;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// PNA (Private Network Access, W3C): browser Chromium mengirim preflight
// dengan `Access-Control-Request-Private-Network: true` saat halaman dari
// address space yang kurang privat (mis. HTTPS publik) mengakses server
// loopback ini. Jawab dengan `Access-Control-Allow-Private-Network: true`
// HANYA bila diminta, supaya respons biasa tidak mengklaim izin PNA.
// Catatan: konteks insecure (HTTP dari IP publik) tetap diblokir Chrome
// apa pun jawaban preflight — lihat docs/PNA-DESIGN.md.
function corsHeaders(req: IncomingMessage): Record<string, string> {
  if (req.headers["access-control-request-private-network"] === "true") {
    return { ...CORS_HEADERS, "Access-Control-Allow-Private-Network": "true" };
  }
  return CORS_HEADERS;
}

export async function startLiveServer(
  port: number,
  session: string,
  endpoints: string[],
  getRowsWritten: () => number,
): Promise<LiveServer> {
  const startedAt = Date.now();
  const clients = new Set<ServerResponse>();

  const sendTo = (res: ServerResponse, chunk: string): boolean => {
    try {
      res.write(chunk);
      return true;
    } catch {
      return false;
    }
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { ...corsHeaders(req), "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          session,
          rowsWritten: getRowsWritten(),
          endpoints,
          uptimeMs: Date.now() - startedAt,
        }),
      );
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, {
        ...corsHeaders(req),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders?.();
      const hello = JSON.stringify({ session, endpoints });
      sendTo(res, `event: hello\ndata: ${hello}\n\n`);
      clients.add(res);
      const remove = () => clients.delete(res);
      res.on("close", remove);
      res.on("error", remove);
      return;
    }
    res.writeHead(404, { ...corsHeaders(req), "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const heartbeat = setInterval(() => {
    for (const res of [...clients]) {
      if (!sendTo(res, ": ping\n\n")) {
        clients.delete(res);
      }
    }
  }, 15000);
  heartbeat.unref?.();

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => {
      reject(
        new TracerError(
          "E_LIVE_PORT",
          `server live gagal dibuka di 127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)} (apakah port sudah dipakai?)`,
        ),
      );
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    port,
    broadcast(line: string): void {
      for (const res of [...clients]) {
        if (!sendTo(res, `data: ${line}\n\n`)) {
          clients.delete(res);
        }
      }
    },
    close(): Promise<void> {
      clearInterval(heartbeat);
      for (const res of [...clients]) {
        try {
          res.end();
        } catch {
          /* abaikan */
        }
      }
      clients.clear();
      return new Promise<void>((resolve) => {
        try {
          server.closeAllConnections?.();
        } catch {
          /* abaikan */
        }
        server.close(() => resolve());
        // Pengaman: jangan gantung selamanya bila koneksi bandel.
        setTimeout(() => resolve(), 1000).unref?.();
      });
    },
  };
}
