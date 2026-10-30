# Hasil penangkapan domain Log (0.1.9)

Tanggal: 30 Oktober 2026. Desain: `docs/LOG-DESIGN.md`.

## Yang dibangun

- **Tracer** (`src/cdp.ts`): `enableDomains` menambahkan
  `Log.enable` (kegagalan enable tetap fatal, konsisten dengan
  tiga domain lain). Tidak ada allowlist event dan tidak ada
  kasus khusus redaksi: `Log.entryAdded` mengalir lewat jalur
  generik dan mengalami redaksi URL + potong 4096 karakter
  (+ penanda `…[truncated]`) dari `redactValue`.
- **Penampil** (`src/lib/trace.ts`, `+page.svelte`):
  `Log.entryAdded` masuk kategori `konsol`; Panel Konsol
  menampilkannya dengan pemetaan level (verbose/info -> log)
  dan lencana sumber (`log/network`); ringkasan
  `[source/level] text`; `groupWaterfall` menautkan teks Log
  ke baris waterfall lewat `networkRequestId`
  (`logText`), ditampilkan pada baris yang gagal.
- **Sidecar** (`src/summary.ts`, `src/server.ts`): agregat
  baru `log: {present, entries, byLevel, sources}` dengan
  level/sumber mentah CDP; `Log.entryAdded` masuk kategori
  `console`; hitungan `errors` tidak berubah (entri Log error
  adalah kegagalan yang sama dengan `loadingFailed`).

## Probe (30 Oktober 2026, Lightpanda 1.0.2)

`tests/probe-log/` membuktikan: `Log.entryAdded` hanya untuk
fetch yang gagal (`source: network`, `level: error`);
5 `consoleAPICalled` dan 2 `exceptionThrown` TIDAK
menghasilkan entri Log (tidak ada duplikasi); `networkRequestId`
sama dengan `requestId` `loadingFailed` untuk fetch yang sama;
`timestamp` entri adalah epoch milidetik jam dinding (tidak
dipakai untuk pengurutan); level/sumber lain belum terverifikasi
dan ditangani generik.

## Uji

- Suite baru `tests/run-log-tests.mjs`: **20/20** — unit
  redaksi generik (token tersensor, potong + penanda,
  `networkRequestId`/`timestamp` utuh); server palsu (entri
  tercatat + endpoint benar; `Log.enable` ditolak -> keluar 1
  menyebut `Log.enable`); live serve asli (entri hadir,
  korelasi `networkRequestId` cocok, `consoleAPICalled` tetap
  tercatat).
- Regresi penuh: tracer robust 23, version 4, F5 24, MS 37,
  live 31, error 25, survive 28, Log 20, M1 74 (benchmark
  overhead **0,51%**, batas 5%); penampil 30/30
  (`svelte-check` 0 error/warning); sidecar 28/28.
- Koreksi saat pengujian: dua ekspektasi uji Log memakai batas
  4096 tanpa penanda — perilaku `truncateString` yang benar
  adalah potong 4096 + `…[truncated]` (total 4108); ekspektasi
  diperbaiki, bukan produk. Satu ekspektasi lama M1 ("domain
  Log tidak dipakai") kedaluwarsa oleh fitur ini dan diganti
  pemeriksaan struktur baris Log (bila ada).

## Batas yang tersisa

- Teks Log adalah teks bebas: rahasia yang tertulis bebas di
  dalam teks tidak dapat disensor per kunci (residu yang sama
  dengan teks `result` agen).
- Level `verbose`/`info`/`warning` dan sumber selain `network`
  belum terverifikasi di Lightpanda 1.0.2; penampil/sidecar
  menanganinya generik tanpa mengasumsikan perilakunya.
- `entry.timestamp` direkam apa adanya, tidak dipakai.
