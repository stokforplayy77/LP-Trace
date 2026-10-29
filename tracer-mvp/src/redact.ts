// redact.ts — Redaksi dan pemotongan payload event CDP (Bab 3.6).
// Aturan ini berlaku secara default dan tidak dapat dimatikan diam-diam.
// Satu-satunya pengecualian eksplisit adalah --include-bodies, yang hanya
// memengaruhi postData permintaan (body respons tidak pernah diambil:
// tracer tidak pernah memanggil Network.getResponseBody).

export const REDACTED = "[REDACTED]";
// Penanda untuk nilai parameter URL: tanpa kurung siku, karena "[...]"
// akan diubah menjadi %5B...%5D oleh pengodean URL dan sulit dicari.
export const URL_REDACTED = "REDACTED";
export const BODY_OMITTED = "[BODY-OMITTED]";

// Nama header sensitif (perbandingan tanpa membedakan huruf besar/kecil).
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
]);

// Kata yang menandai parameter URL mirip token.
const TOKEN_WORDS = new Set(["token", "key", "secret", "password", "auth"]);

// Panjang maksimum string generik di dalam payload (di luar aturan konsol).
const MAX_STRING_LEN = 4096;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pecah nama parameter menjadi kata (snake_case, kebab-case, camelCase). */
function splitNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

function isTokenLikeParam(name: string): boolean {
  return splitNameWords(name).some((w) => TOKEN_WORDS.has(w));
}

/** Sensor nilai parameter query yang mirip token; URL lain dikembalikan utuh. */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  let changed = false;
  for (const name of [...url.searchParams.keys()]) {
    if (isTokenLikeParam(name)) {
      // Nilai "REDACTED" tanpa kurung siku (lihat URL_REDACTED).
      url.searchParams.set(name, URL_REDACTED);
      changed = true;
    }
  }
  return changed ? url.toString() : raw;
}

const URL_IN_TEXT = /(https?:\/\/[^\s"'`<>]+)/g;

/** Sensor parameter token pada URL yang muncul di dalam teks bebas. */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (m) => {
    // Lepas tanda baca penutup yang umum menempel pada URL di dalam teks.
    const tail = m.match(/[),.;:]+$/)?.[0] ?? "";
    const core = tail ? m.slice(0, -tail.length) : m;
    return redactUrl(core) + tail;
  });
}

function truncateString(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "…[truncated]" : s;
}

export interface RedactOptions {
  /** Bila true, postData permintaan dipertahankan (dipakai --include-bodies). */
  includeBodies: boolean;
}

/**
 * Jalan rekursif atas payload CDP dan terapkan:
 * - header sensitif -> "[REDACTED]" (nama header tetap dicatat),
 * - URL: parameter mirip token disensor,
 * - postData/body permintaan: dihilangkan kecuali --include-bodies,
 * - string sangat panjang dipotong.
 * Tidak pernah mengubah objek masukan (mengembalikan salinan baru).
 */
export function redactValue(value: unknown, opts: RedactOptions): unknown {
  if (typeof value === "string") {
    return truncateString(redactUrlsInText(value), MAX_STRING_LEN);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, opts));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  // Pasangan {name, value} (mis. header dalam bentuk daftar): sensor
  // nilainya bila namanya header sensitif.
  if (
    typeof value.name === "string" &&
    "value" in value &&
    typeof value.value === "string" &&
    SENSITIVE_HEADERS.has(value.name.toLowerCase())
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === "value" ? REDACTED : redactValue(v, opts);
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower) && typeof v === "string") {
      out[key] = REDACTED;
      continue;
    }
    if (lower === "headers" && isPlainObject(v)) {
      const headers: Record<string, unknown> = {};
      for (const [hk, hv] of Object.entries(v)) {
        headers[hk] =
          SENSITIVE_HEADERS.has(hk.toLowerCase()) && typeof hv === "string"
            ? REDACTED
            : redactValue(hv, opts);
      }
      out[key] = headers;
      continue;
    }
    if (lower === "headerstext" && typeof v === "string") {
      out[key] = v
        .split(/\r?\n/)
        .map((line) => {
          const m = line.match(/^([^:]+):\s*(.*)$/);
          const headerName = m?.[1];
          if (m && headerName !== undefined && SENSITIVE_HEADERS.has(headerName.trim().toLowerCase())) {
            return `${headerName}: ${REDACTED}`;
          }
          return line;
        })
        .join("\n");
      continue;
    }
    if (lower === "url" || lower === "documenturl") {
      out[key] = typeof v === "string" ? redactUrl(v) : redactValue(v, opts);
      continue;
    }
    if (
      (lower === "postdata" || lower === "postdataentries" || lower === "body") &&
      !opts.includeBodies
    ) {
      out[key] = BODY_OMITTED;
      continue;
    }
    if (
      (lower === "postdata" || lower === "body") &&
      opts.includeBodies &&
      typeof v === "string"
    ) {
      out[key] = truncateString(redactUrlsInText(v), MAX_STRING_LEN);
      continue;
    }
    out[key] = redactValue(v, opts);
  }
  return out;
}

// ---- Konsol (aturan Bab 3.6 butir 3) ----

export const CONSOLE_ARG_MAX = 500;
export const CONSOLE_EVENT_MAX = 2000;

/** Serialisasi satu argumen konsol RemoteObject menjadi string. */
function serializeConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (isPlainObject(arg)) {
    if (typeof arg.description === "string") return arg.description;
    if ("value" in arg) {
      try {
        return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
      } catch {
        return String(arg.value);
      }
    }
    if (typeof arg.unserializableValue === "string") return arg.unserializableValue;
    const subtype =
      typeof arg.subtype === "string" ? `:${arg.subtype}` : "";
    return `[${String(arg.type ?? "object")}${subtype}]`;
  }
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Ubah params Runtime.consoleAPICalled menjadi bentuk ringkas:
 * { type, args: string[] } dengan tiap argumen <= 500 karakter dan
 * total argumen <= 2000 karakter. URL di dalam teks argumen disensor.
 * stackTrace (bila ada) dipertahankan dalam bentuk teredaksi/dipotong.
 */
export function redactConsoleEvent(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const rawArgs = Array.isArray(params.args) ? params.args : [];
  const args: string[] = [];
  let budget = CONSOLE_EVENT_MAX;
  for (const raw of rawArgs) {
    if (budget <= 0) break;
    const text = redactUrlsInText(serializeConsoleArg(raw));
    const capped = text.slice(0, Math.min(CONSOLE_ARG_MAX, budget));
    args.push(capped);
    budget -= capped.length;
  }
  const out: Record<string, unknown> = {
    type: params.type,
    args,
  };
  if (params.stackTrace !== undefined) {
    const st = redactValue(params.stackTrace, { includeBodies: false });
    out.stackTrace = truncateString(
      typeof st === "string" ? st : JSON.stringify(st),
      CONSOLE_EVENT_MAX,
    );
  }
  if (typeof params.executionContextId === "number") {
    out.executionContextId = params.executionContextId;
  }
  return out;
}

/**
 * Redaksi tingkat event. Runtime.consoleAPICalled memakai aturan
 * konsol khusus; event lain memakai jalan rekursif generik, dengan
 * field `timing` pada Network.responseReceived dihapus karena tidak
 * dipakai (Keputusan 4: waterfall memakai stempel waktu tracer).
 */
export function redactEvent(
  method: string,
  params: Record<string, unknown>,
  opts: RedactOptions,
): Record<string, unknown> {
  if (method === "Runtime.consoleAPICalled") {
    return redactConsoleEvent(params);
  }
  const data = redactValue(params, opts) as Record<string, unknown>;
  if (
    method === "Network.responseReceived" &&
    isPlainObject(data.response)
  ) {
    const response = { ...(data.response as Record<string, unknown>) };
    delete response.timing;
    data.response = response;
  }
  return data;
}
