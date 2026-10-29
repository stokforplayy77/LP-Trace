# Desain Uji Ketahanan (ROBUST) — LP-Trace

Tahap terakhir dari kelompok roadmap yang disetujui 2026-10-29: uji
ketahanan. Bukan fitur baru, kecuali satu field ringkasan yang memang
ditunda dari tahap error (lihat §5). Semua uji memakai Lightpanda 1.0.2
sungguhan; tidak ada server CDP palsu di tahap ini.

## 1. Fakta awal

- M0b membuktikan koeksistensi Puppeteer + klien CDP mentah. Playwright
  BELUM pernah dicoba.
- Sesi terpanjang yang pernah diuji sejauh ini hanya beberapa detik
  (navigasi + `--stay` singkat). Tidak ada bukti tracer stabil puluhan
  detik dengan aliran event berlanjut, atau pada halaman dengan ratusan
  permintaan.
- Probe 4/5 (MS): satu target hanya dimiliki satu koneksi; target mati
  bersama koneksi kliennya. Konsekuensi: tracer TIDAK BISA mengamati
  navigasi yang dikemudikan Playwright/Puppeteer — target mereka
  berbeda dan tidak bisa di-attach kedua kali. Koeksistensi berarti
  "berdampingan tanpa gangguan", bukan "mengamati".
- Probe Playwright 2026-10-29 (playwright-core 1.64.1, serve :9250):
  `connectOverCDP` OK (40 ms), 1 konteks, `newPage` OK, `goto` 200,
  `title`/`evaluate` "PW OK", sementara tracer merekam 24 baris di
  koneksi lain (seq bersambung, `session_ended` hadir). Fakta ini yang
  diubah menjadi uji otomatis.

## 2. Ruang lingkup

1. **Koeksistensi Playwright.** Playwright `connectOverCDP` ke proses
   serve yang sama sementara tracer berjalan (`--stay`). Uji: koneksi
   OK, `newPage` OK, `goto` 200, judul terbaca, tracer tetap merekam
   (seq bersambung 1..N, `session_ended` hadir). TIDAK diuji: tracer
   mengamati navigasi Playwright (mustahil, lihat §1).
2. **Sesi panjang.** Halaman berdenyut: `console.log` tiap 500 ms dan
   `fetch` tiap 1 detik, tracer `--stay` 20 detik lalu SIGINT. Uji:
   seq bersambung, `mono_ms` tak pernah turun, `session_ended`
   beralasan `signal`, jumlah baris dan panggilan konsol di atas ambang
   bawah longgar, RSS puncak tracer < 256 MB (Linux; dilewati dengan
   catatan bila `/proc` tak tersedia).
3. **Beban besar.** Satu halaman dengan 100 `fetch` ke URL berbeda
   (101 permintaan termasuk dokumen) plus 60 `<img>`. Uji: tracer
   keluar 0, `requestWillBeSent` ≥ 95 (toleransi untuk penjadwalan
   fetch; angka persis dicatat), seq bersambung, seluruh file
   ter-parse tanpa baris rusak. **Temuan terverifikasi:** Lightpanda
   1.0.2 TIDAK me-fetch `<img>` sama sekali — server lokal mencatat
   0 hit `/img` sementara 40/40 `fetch` sampai (diagnostik
   `/tmp/pw-probe/diag-beban.mjs`). Jumlah `<img>` hanya dicatat
   sebagai info, bukan gate, agar uji tidak rapuh bila perilaku ini
   berubah di Lightpanda mendatang.
4. **Cek HP nyata TIDAK termasuk.** Render/interaksi penampil di HP
   nyata, unduh CSV di browser HP, dan panel live SSE dari HP tetap
   menjadi bagian user (hanya dia yang memegang HP-nya).

## 3. Bukan tujuan

- Screenshot visual; lolos deteksi bot; persistensi target di sisi
  browser (mustahil di serve 1.0.2); observasi lintas-target;
  benchmark overhead baru (gerbang 5% sudah dijaga suite M1 tiap jalan).

## 4. Implementasi uji

- Berkas baru `tracer-mvp/tests/run-robust-tests.mjs`, dijalankan
  pertama dalam rantai `npm test` (sebelum F5) agar gagal cepat bila
  lingkungan tak memenuhi syarat. Resolusi binary sama seperti M1
  (env `LP_BIN`, lalu PATH, lalu `vendor/lightpanda`, lalu
  `/tmp/lp-m1/lightpanda`); gagal keras bila tidak ada.
- `playwright-core` masuk `devDependencies` tracer (pengujian saja;
  tidak ikut terbit). Bila modul tak ter-resolve, uji gagal keras
  dengan pesan "jalankan `npm ci`" — sama seperti binary yang hilang.
- CI tidak berubah: `npm test` sudah menjalankan rantai uji; tidak
  perlu unduh browser Playwright karena yang dipakai hanya
  `connectOverCDP` ke Lightpanda.

## 5. Field error pada ringkasan sidecar (ditunda dari tahap error)

`get_trace_summary` kini memuat `sessionError: {code, message} | null`,
diambil dari baris `tracer.session_ended` TERAKHIR (file `--append`
bisa memuat lebih dari satu `session_ended`, satu per segmen; yang
terakhir menggambarkan akhir segmen terbaru). `null` bila tidak ada
`session_ended` atau tidak ada `data.error`. Tidak ada data mentah
baru yang bocor: kode dan pesan sudah ada di file trace yang
direduksi. Uji di `mcp-sidecar/tests/mcp.test.mjs` (fixture dengan
dan tanpa error). README sidecar diperbarui.
