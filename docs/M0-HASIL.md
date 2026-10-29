# Hasil M0 — Verifikasi CDP Lightpanda (29 Okt 2026, 12:44 WIB)

Diuji langsung di sandbox Linux x86_64 dengan binary nightly
`1.1.0-nightly.11275+78bbb64db` (binary dihapus setelah uji; unduh ulang
dari rilis nightly bila ingin mengulang). Telemetry dimatikan
(`LIGHTPANDA_DISABLE_TELEMETRY=true`).

Perintah ulang:
```bash
./lightpanda serve --host 127.0.0.1 --port 9222
node m0-probe.mjs --cdp ws://127.0.0.1:9222 --url https://example.com
```

## Temuan kunci

1. **Koneksi mentah ke endpoint browser GAGAL untuk Network/Runtime.**
   Tanpa attach target, `Network.enable`, `Runtime.enable`, dan
   `Page.navigate` menjawab `BrowserContextNotLoaded` (kode -31998).
   Desain tracer WAJIB melakukan handshake Target dulu:
   `Target.setDiscoverTargets` → `Target.getTargets` →
   `Target.createTarget` (bila daftar kosong) →
   `Target.attachToTarget {flatten:true}` → semua perintah memakai
   `sessionId` yang dikembalikan. Inilah yang dilakukan Puppeteer/
   Playwright di balik layar; klien CDP mentah yang melewatkan langkah
   ini tidak akan menerima event apa pun.

2. **Setelah attach: Network + Console TERBUKTI.**
   `Page.frameNavigated` 1, `Network.requestWillBeSent` 2,
   `Network.responseReceived` 2, `Network.loadingFinished` 2,
   `Runtime.consoleAPICalled` 2. `Page.enable`, `Network.enable`,
   `Runtime.enable`, `Log.enable` semuanya diterima.

3. **`Runtime.exceptionThrown` BELUM terbukti.**
   `Runtime.evaluate` dengan `throw new Error(...)` tidak menghasilkan
   event `exceptionThrown` pada uji ini (kemungkinan throw dari
   `evaluate` dilaporkan sebagai hasil evaluasi, bukan event uncaught
   halaman). Uji lanjutan yang dibutuhkan: halaman yang melempar
   exception saat load (script inline), bukan via `evaluate`.

4. **`Log.enable` diterima, tapi `Log.entryAdded` 0.**
   Jangan klaim event Log bekerja sebelum ada pemicu yang menghasilkannya.
   Untuk MVP, andalkan `Runtime.consoleAPICalled` saja.

5. **Detail timing Chrome TIDAK ada.**
   `response.timing` berisi -1 untuk dns/connect/ssl/send/receive, dan
   `encodedDataLength: 0`. Waterfall HARUS dibangun dari timestamp
   tracer sendiri (saat `requestWillBeSent` / `responseReceived` /
   `loadingFinished` diterima), bukan dari field `timing` CDP.
   Durasi per-request bisa dihitung; breakdown DNS/TLS tidak bisa.

6. **Koneksi CDP kedua bisa open** dan tidak mematikan koneksi pertama
   pada nightly ini (`--cdp-max-connections` default 16). Uji attach
   target kedua secara penuh belum dilakukan — masih perlu diuji
   bersama Puppeteer/Playwright sungguhan sebelum mengklaim tracer
   bisa jalan berdampingan dengan driver agent.

7. **Bonus: `DOM.documentUpdated` terlihat** (1x). Jejak perubahan DOM
   kasar mungkin bisa didapat, tapi bukan diff DOM yang detail.

## File bukti

- `m0-probe.mjs` — skrip probe tanpa dependensi (Node 22+).
- `m0-result.json` — matriks lengkap + handshake + verdict.
- `m0-events.jsonl` — sampel event (dipotong 500 karakter).
