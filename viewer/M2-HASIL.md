# Hasil M2 — Penampil Trace MVP (29 Oktober 2026)

Penampil dibangun sesuai Dokumen Perancangan v1.1 (F3 + Bab 3.4),
setelah M1 dinyatakan LULUS gerbang benchmark. Pengujian memakai
Lightpanda **1.0.2** sungguhan dan tracer M1 yang sudah di-build.
Binary Lightpanda dihapus setelah pengujian; semua proses serve/server
dihentikan setelah pengujian.

## Yang dibangun

Folder `viewer/` (repo mandiri untuk pemakaian pribadi):

- `src/lib/trace.ts` — logika murni: parsing JSONL (baris rusak dilewati
  + dihitung), kategori event, waterfall dari `mono_ms`, filter konsol
  dan pencarian, ekspor CSV + HAR subset best-effort.
- `src/routes/+page.svelte` — UI satu halaman: pemilih file, tombol
  contoh, metadata sesi, filter kategori/level, pencarian, Timeline
  relatif detik ke-0, Waterfall Jaringan, Panel Konsol, ekspor CSV/HAR,
  catatan redaksi.
- `src/routes/+layout.ts` (+layout.svelte) — prerender statis.
- `vite.config.ts` — konfigurasi SvelteKit 3 + adapter-static
  (lihat penyimpangan 1).
- `tests/trace.test.mjs` — 14 pemeriksaan otomatis (`npm test`).
- `tests/fixtures/real-trace.jsonl` — trace nyata M1 (41 baris).
- `static/sample.jsonl` — contoh sintetis M1.
- `smoke-empty.png`, `smoke-loaded.png`, `smoke-real-trace.png` —
  screenshot uji asap Chromium headless.
- `README.md`, `package.json` (SvelteKit 3.1.0, Svelte 5.57.3,
  adapter-static 4.0.0, TypeScript 6, Vite 8; tanpa dependensi runtime
  tambahan selain framework).

Tidak dibangun (sesuai batas tugas): sidecar MCP M3, publikasi
npm/Docker. Dokumen v1.1 (.md/.pdf) dan folder `tracer-mvp/` tidak
diubah (tracer hanya dijalankan untuk menghasilkan trace uji).

## Hasil uji otomatis (`npm test`) — 14 pemeriksaan, 14 lulus

| Uji | Hasil |
|---|---|
| Parse contoh M1 (11 baris, 0 dilewati) | Lulus |
| Baris rusak dilewati + dihitung, tidak crash | Lulus |
| `parseTraceLine` baris kosong/non-objek -> null | Lulus |
| Kategori tracer/error/konsol/navigasi/network/lainnya | Lulus |
| Waterfall: durasi dari `mono_ms` tracer | Lulus |
| Waterfall: tanpa `loadingFinished` -> total null | Lulus |
| Level konsol: `warning` dipertahankan, `warn` dinormalisasi | Lulus |
| Filter konsol per level | Lulus |
| Pencarian pada URL dan teks konsol | Lulus |
| Filter kategori | Lulus |
| Ringkasan exception dari `exceptionDetails` | Lulus |
| CSV: header + escaping koma/kutip | Lulus |
| HAR subset: dns/connect/ssl -1, ukuran -1, ada komentar | Lulus |
| Bentuk mentah CDP bersarang (`request`/`response`) | Lulus (regresi, lihat "Perbaikan selama M2") |

`svelte-check`: 0 error, 0 warning. Build `vite build` bersih ke
folder `build/`.

## Trace nyata (fixture)

Dihasilkan dengan tracer M1 yang sudah di-build + Lightpanda 1.0.2
(`./lightpanda version` -> `1.0.2`, telemetri mati, serve
127.0.0.1:9223) dan server uji lokal (pola m0b-server.mjs,
`/ok.html` + `/throw.html` + `/echo`, port 8772):

```bash
node dist/cli.js --cdp ws://127.0.0.1:9222 --output viewer/tests/fixtures/real-trace.jsonl \
  --session "m2-fixture" \
  --navigate http://127.0.0.1:8772/ok.html \
  --navigate http://127.0.0.1:8772/throw.html --wait-ms 1200
```

Hasil: 41 baris, 0 dilewati, `seq` 1..41 berurutan, sesi
`m2-fixture`, versi 1.0.2. Hitungan event: `tracer.session_started` 1,
`frameStartedNavigating` 2, `frameStartedLoading` 2,
`requestWillBeSent` 4, `responseReceived` 3, `executionContextsCleared`
3, `frameNavigated` 2, `targetInfoChanged` 4,
`executionContextCreated` 2, `documentUpdated` 2, `loadingFinished` 3,
`consoleAPICalled` 3 (`log`/`warning`/`error`), `domContentEventFired`
2, `loadEventFired` 2, `frameStoppedLoading` 2, `loadingFailed` 1
(`CouldntConnect`), `exceptionThrown` 2, `session_ended` 1.
Waterfall: 4 entri (ok.html, fetch port tertutup gagal, echo,
throw.html). Redaksi terverifikasi pada fixture: nilai rahasia
(`M2-SECRET-TOKEN`, `M2-SECRET-AUTH`) tidak muncul mentah; URL echo
tercatat sebagai `token=REDACTED`.

## Uji asap build + serve (Chromium headless sungguhan)

- `GET /` -> 200, `GET /sample.jsonl` -> 200 (python http.server dari
  folder `build/`).
- Chromium headless (Playwright `chromium_headless_shell`, karena
  binary `/opt/meta-chromium/chrome` di sandbox ini menolak start —
  lihat penyimpangan 4) dikendalikan lewat CDP:
  - Klik "Muat trace contoh": timeline 4, waterfall 1 baris, konsol 1
    item, metadata benar (sesi, versi 1.0.2, 4 baris, rentang 1.851
    dtk) — `SMOKE LULUS`, screenshot `smoke-loaded.png` dibaca dan
    tampilannya benar.
  - Set file fixture nyata lewat `DOM.setFileInputFiles`: timeline 41,
    waterfall 4 baris, konsol 5 item, nama file + metadata benar —
    `SMOKE FIXTURE NYATA LULUS`, screenshot `smoke-real-trace.png`
    dibaca dan tampilannya benar (termasuk token tersensor dan
    `loadingFailed` merah).

## Perbaikan selama M2 (bug yang ditemukan dan diperbaiki)

1. **URL waterfall kosong pada trace nyata.** Penyebab: payload CDP
   mentah membawa URL/metode di dalam `data.request` dan
   status/mimeType di dalam `data.response`, sementara penampil hanya
   membaca field datar. Diperbaiki dengan ekstraksi dua bentuk
   (langsung + bersarang) di `src/lib/trace.ts`, ditutup uji regresi,
   lalu fixture divalidasi ulang (4 entri waterfall lengkap).
2. **Ekspektasi uji pencarian keliru.** Uji awal mengharapkan 3 baris
   cocok untuk URL, padahal baris `loadingFinished` hanya membawa
   `requestId`. Ekspektasi diperbaiki menjadi 2 dengan komentar —
   kode tidak diubah.
3. **Pola `node --test tests/`** gagal (Node menganggap direktori
   sebagai berkas). Skrip test diubah menjadi
   `node --test tests/*.test.mjs`.

## Penyimpangan dari spesifikasi (tercatat)

1. **Konfigurasi SvelteKit 3.** `svelte.config.js` tidak lagi dipakai
   upstream; konfigurasi adapter-static disampaikan lewat plugin
   `sveltekit()` di `vite.config.ts`. Stack tetap SvelteKit +
   adapter-static (Bab 3.4); hanya lokasi konfigurasinya berubah.
2. **Alias `$lib` dihapus di SvelteKit 3.** Import memakai jalur
   relatif (`../lib/trace`); alias `#lib` tidak ter-resolve pada setup
   ini.
3. **`tsconfig.json` memakai `extends: "$app/tsconfig"`** sesuai
   persyaratan SvelteKit 3 (bukan `.svelte-kit/tsconfig.json`).
4. **Binary Chromium sandbox tidak dapat dipakai.** Binary
   `/opt/meta-chromium/chrome` menolak start ("Hatch WebGL domain
   policy is required"). Uji asap memakai `chromium_headless_shell`
   dari cache Playwright — tetap browser Chromium sungguhan yang
   dikendalikan lewat CDP, hanya binernya berbeda.
5. **HAR diterapkan** sebagai subset best-effort (bukan ditiadakan),
   dilabeli demikian pada tombol dan di dalam berkas HAR.
6. **Pencarian memfilter seluruh tampilan** (timeline, waterfall, dan
   konsol memakai baris terfilter yang sama), konsisten dengan ekspor
   "tampilan saat ini" pada F3.

## Yang tidak diklaim

Tampilan di HP/perangkat nyata (belum diuji), pembukaan lewat
`file://` (tidak dijanjikan), Playwright, timing/DNS/TLS/ukuran byte,
dan domain `Log` sebagai sumber MVP.

## Perintah pengulangan

```bash
# 1. Uji logika + build
npm install && npm test && npm run build
# 2. Jalankan (server statis lokal)
npx serve build
# 3. Trace nyata (butuh binary Lightpanda 1.0.2 + tracer M1 ter-build;
#    lihat perintah pada bagian "Trace nyata" di atas, lalu hapus binary)
```

## Kesiapan M3

M2 siap menjadi fondasi M3: format JSONL dan redaksi sudah stabil
(M1), penampil membuktikan file trace dapat dibaca dan divisualisasi
tanpa backend. M3 (sidecar MCP: `get_trace_summary` +
`annotate_trace`) dapat membaca file JSONL yang sama; tidak ada
perubahan format yang dibutuhkan dari M2.
