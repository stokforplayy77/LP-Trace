// cdp.ts — Klien CDP WebSocket native + handshake Target (Bab 3.3).
// Tanpa dependensi: memakai WebSocket global Node 22+. Seluruh perintah
// setelah attach membawa sessionId; tanpanya Lightpanda menjawab
// BrowserContextNotLoaded (-31998).

import { TracerError } from "./errors.js";

export class HandshakeError extends Error {
  constructor(
    public readonly step: string,
    message: string,
  ) {
    super(`handshake gagal pada langkah ${step}: ${message}`);
    this.name = "HandshakeError";
  }
}

interface PendingEntry {
  resolve: (msg: Record<string, unknown>) => void;
  timer: NodeJS.Timeout;
}

export type CdpEventHandler = (
  method: string,
  params: Record<string, unknown>,
) => void;

export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private eventHandler: CdpEventHandler | null = null;
  private closeHandler: (() => void) | null = null;
  private sessionId: string | null = null;

  constructor(private readonly url: string) {}

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  onEvent(handler: CdpEventHandler): void {
    this.eventHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  connect(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* abaikan */
        }
        reject(
          new TracerError(
            "E_CDP_UNREACHABLE",
            `tidak dapat terhubung ke ${this.url}: timeout ${timeoutMs} ms (apakah 'lightpanda serve' berjalan?)`,
          ),
        );
      }, timeoutMs);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new TracerError(
            "E_CDP_UNREACHABLE",
            `tidak dapat terhubung ke ${this.url} (apakah 'lightpanda serve' berjalan di alamat itu?)`,
          ),
        );
      };
      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (process.env.LP_DEBUG_CDP === "1") {
          console.error(
            `[cdp-debug] id=${String(msg.id ?? "-")} method=${String(msg.method ?? "-")} sessionId=${String(msg.sessionId ?? "-")}`,
          );
        }
        if (typeof msg.id === "number") {
          const entry = this.pending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(msg.id);
            entry.resolve(msg);
          }
          return;
        }
        if (typeof msg.method === "string" && this.eventHandler) {
          const params =
            msg.params && typeof msg.params === "object"
              ? (msg.params as Record<string, unknown>)
              : {};
          this.eventHandler(msg.method, params);
        }
      };
      ws.onclose = () => {
        // Penutupan setelah koneksi terbuka ditangani sebagai akhir sesi
        // oleh pemanggil lewat onClose; penutupan saat connect masih
        // ditangani oleh onerror/timeout di atas.
        this.closeHandler?.();
      };
    });
  }

  /**
   * Kirim satu perintah CDP. sessionId (bila sudah ada) selalu
   * disertakan. Menolak bila ada error CDP atau timeout.
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10000,
  ): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(`tidak dapat mengirim ${method}: koneksi WebSocket tidak terbuka`),
      );
    }
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (this.sessionId) message.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${timeoutMs} ms menunggu jawaban ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          if (msg.error && typeof msg.error === "object") {
            const err = msg.error as Record<string, unknown>;
            reject(
              new Error(
                `${method} ditolak (kode ${String(err.code ?? "?")}): ${String(err.message ?? "error tanpa pesan")}`,
              ),
            );
          } else {
            resolve(msg);
          }
        },
        timer,
      });
      try {
        ws.send(JSON.stringify(message));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* abaikan */
    }
    this.ws = null;
  }
}

export interface HandshakeResult {
  targetId: string;
  sessionId: string;
}

/**
 * Handshake Target Bab 3.3. Langkah 1-3 dijalankan TANPA sessionId
 * (belum ada); langkah 4 menghasilkan sessionId; langkah 5 (enable)
 * dilakukan pemanggil dengan sessionId tersebut. Kegagalan pada
 * langkah 4 (attach) bersifat fatal: melempar HandshakeError.
 */
export async function performHandshake(
  client: CdpClient,
): Promise<HandshakeResult> {
  // Langkah 1: Target.setDiscoverTargets
  try {
    await client.send("Target.setDiscoverTargets", { discover: true });
  } catch (e) {
    throw new HandshakeError(
      "Target.setDiscoverTargets",
      e instanceof Error ? e.message : String(e),
    );
  }

  // Langkah 2: Target.getTargets — pilih target bertipe page bila ada.
  let targetInfos: Array<Record<string, unknown>> = [];
  try {
    const res = await client.send("Target.getTargets");
    const result = res.result as Record<string, unknown> | undefined;
    if (Array.isArray(result?.targetInfos)) {
      targetInfos = result.targetInfos as Array<Record<string, unknown>>;
    }
  } catch (e) {
    throw new HandshakeError(
      "Target.getTargets",
      e instanceof Error ? e.message : String(e),
    );
  }
  const pageTarget = targetInfos.find((t) => t.type === "page");
  let targetId =
    typeof pageTarget?.targetId === "string" ? pageTarget.targetId : null;

  // Langkah 3: bila tidak ada target page, buat target baru.
  if (!targetId) {
    try {
      const res = await client.send("Target.createTarget", {
        url: "about:blank",
      });
      const result = res.result as Record<string, unknown> | undefined;
      if (typeof result?.targetId === "string") {
        targetId = result.targetId;
      }
    } catch (e) {
      throw new HandshakeError(
        "Target.createTarget",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  if (!targetId) {
    throw new HandshakeError(
      "Target.createTarget",
      "tidak ada targetId yang diperoleh (daftar target kosong dan createTarget tidak mengembalikan targetId)",
    );
  }

  // Langkah 4: Target.attachToTarget (fatal bila gagal).
  let sessionId: string | null = null;
  try {
    const res = await client.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const result = res.result as Record<string, unknown> | undefined;
    if (typeof result?.sessionId === "string") {
      sessionId = result.sessionId;
    }
  } catch (e) {
    throw new HandshakeError(
      "Target.attachToTarget",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!sessionId) {
    throw new HandshakeError(
      "Target.attachToTarget",
      "attach berhasil tetapi tidak ada sessionId yang dikembalikan",
    );
  }
  client.setSessionId(sessionId);
  return { targetId, sessionId };
}

/** Langkah 5: kirim enable dengan sessionId yang sudah diset. */
export async function enableDomains(client: CdpClient): Promise<void> {
  for (const method of ["Page.enable", "Network.enable", "Runtime.enable"]) {
    try {
      await client.send(method);
    } catch (e) {
      throw new HandshakeError(
        method,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}
