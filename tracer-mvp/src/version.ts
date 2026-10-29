// version.ts — Versi paket dari package.json (sumber tunggal kebenaran).
//
// JANGAN hardcode versi di sini: angka di package.json adalah yang
// diterbitkan ke npm, dan CLI harus melaporkannya apa adanya.
// Fallback "0.0.0-dev" hanya bila package.json tidak terbaca (layout
// build yang tidak biasa); dalam paket terbitan file itu selalu ada
// di samping folder dist/.
import { readFileSync } from "node:fs";

function readPackageVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Jatuh ke fallback di bawah.
  }
  return "0.0.0-dev";
}

export const VERSION = readPackageVersion();
