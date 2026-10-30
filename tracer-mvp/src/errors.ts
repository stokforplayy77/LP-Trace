// errors.ts — Kode error terbedakan untuk tracer (ERROR-DESIGN.md §1).
//
// Setiap kegagalan runtime membawa kode stabil yang dicetak ke stderr
// sebagai `[KODE] pesan` dan (bila sesi sudah punya file) dicatat di
// `tracer.session_ended` sebagai `data.error`. Tanpa dependensi.

export type TracerErrorCode =
  | "E_CDP_UNREACHABLE"
  | "E_HANDSHAKE"
  | "E_CDP_CLOSED"
  | "E_TRACE_LIMIT"
  | "E_RESOURCE_LIMIT"
  | "E_RESUME"
  | "E_LIVE_PORT"
  | "E_REPLAY"
  | "E_NAVIGATE";

/** Kegagalan runtime tracer dengan kode stabil + detail terstruktur. */
export class TracerError extends Error {
  constructor(
    public readonly code: TracerErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TracerError";
  }
}

/** Bentuk stderr: `[KODE] pesan` untuk TracerError, pesan polos bila bukan. */
export function formatTracerError(e: unknown): string {
  if (e instanceof TracerError) return `[${e.code}] ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
