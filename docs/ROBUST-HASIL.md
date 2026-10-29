# Hasil Uji Ketahanan (ROBUST) — 29 Oktober 2026

Tahap terakhir kelompok roadmap. Desain: `docs/ROBUST-DESIGN.md`.
Semua uji memakai Lightpanda 1.0.2 sungguhan dan binary yang diunduh
ulang lewat `scripts/download-lightpanda.sh` (`/tmp` sempat terhapus
antar-sesi; `vendor/lightpanda` kini menjadi lokasi binary yang
dipakai, dan resolver uji ketahanan memeriksanya).

## Yang diuji

1. **Koeksistensi Playwright** (`playwright-core` 1.64.1, kini
   `devDependency` tracer). `connectOverCDP` ke proses serve yang sama
   sementara tracer berjalan: koneksi OK (40 ms), 1 konteks, `newPage`
   OK, `goto` 200, judul + `evaluate` "PW OK". Tracer merekam
   24 baris di koneksinya sendiri (seq bersambung, `session_ended`
   hadir). Batas jujur: tracer TIDAK mengamati navigasi Playwright —
   target Playwright berbeda dan attach kedua ditolak (Probe 4/5).
2. **Sesi panjang.** Halaman berdenyut (konsol tiap 500 ms, fetch tiap
   1 detik), tracer `--stay` 20 detik lalu SIGINT: 119 baris,
   40 panggilan konsol, seq bersambung, `mono_ms` tak turun,
   `session_ended` beralasan `signal-SIGINT`, RSS puncak 69 MB
   (batas 256 MB, Linux).
3. **Beban besar.** Halaman dengan 100 `fetch` + 60 `<img>`: tepat
   101/101 permintaan (dokumen + fetch), seq bersambung, tanpa baris
   rusak. **Temuan:** Lightpanda 1.0.2 tidak me-fetch `<img>` sama
   sekali — server lokal mencatat 0 hit `/img` sementara 40/40 fetch
   sampai pada diagnostik awal. Jumlah `<img>` hanya dicatat sebagai
   info, bukan gate.
4. **Field `sessionError` di sidecar** (ditunda dari tahap error):
   `get_trace_summary` kini memuat `{code, message} | null` dari
   `tracer.session_ended` terakhir; file `--append` dengan segmen
   bersih terakhir menghasilkan `null` (terakhir menang). Tidak ada
   data mentah baru yang bocor.

## Uji

- Tracer `npm test`: ketahanan 20/20, versi 4/4, F5 14/14, MS 37/37,
  live+replay 31/31, error+retry 25/25, M1 66/66 (benchmark overhead
  0,06%, gerbang 5%).
- Sidecar: 19/19 (18 lama + 1 `sessionError`, lewat klien MCP SDK
  sungguhan). Satu error TypeScript sempat lolos saat penulisan
  (`err` possibly null di `summary.ts`) — tertangkap `tsc` pada
  `npm test`, diperbaiki, lalu 19/19 hijau. Tidak ada file yang
  di-push sebelum suite ini hijau.
- Penampil: 27/27, `svelte-check` bersih (tidak berubah di tahap ini).

## Catatan CI 29 Oktober 2026 (perbaikan harness, setelah rilis 0.1.4)

- Run CI untuk commit 0.1.4 (`a8e4f76c`) gagal di kedua job uji
  (Node 22 + 24) dengan gejala `timeout menunggu tracer keluar` pada
  uji 1 rangkaian ini. Penyebabnya harness, bukan tracer: rangkaian
  ini satu-satunya yang tidak menjalankan build `tsc` dulu, sehingga
  di checkout bersih CI `dist/cli.js` tidak ada, proses anak mati
  seketika, dan `waitForExit` — yang memasang listener `exit` sesudah
  proses mati — menggantung sampai timeout 30 detik. Direproduksi
  lokal dengan `dist/` dihapus (gejala identik), lalu diperbaiki:
  build `tsc` di awal rangkaian, penjaga proses-sudah-keluar di
  `waitForExit`, dan pemeriksaan jumlah baris eksplisit. Rangkaian
  menjadi 23 pemeriksaan, seluruh rantai tracer hijau dari `dist/`
  yang dihapus. Tidak ada perubahan kode produk; tidak perlu rilis
  npm baru.

## Batas yang tersisa

- Sesi panjang diuji 20 detik, bukan 60 detik atau berjam-jam; RSS
  hanya terukur di Linux.
- Cek HP nyata tetap menjadi bagian user: luapan horizontal, unduh
  CSV, dan panel live SSE dari browser HP belum dilaporkan.
- Playwright yang diuji hanya `connectOverCDP` (tanpa unduh browser);
  perilaku Playwright lain (mis. `launch` Chromium sendiri) tidak
  relevan — Lightpanda bukan Chromium.
