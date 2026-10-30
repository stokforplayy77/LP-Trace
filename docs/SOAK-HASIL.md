# Hasil sesi panjang 60 detik + soak 300 detik

Tanggal: 30 Oktober 2026. Desain: `docs/SOAK-DESIGN.md`.
Kode produk TIDAK berubah; tidak ada rilis npm untuk
perubahan ini (preseden perbaikan harness CI 29 Oktober 2026).

## Yang diubah

- `tests/run-robust-tests.mjs` uji 2: 20 -> 60 detik.
  `sampleRssKb` kini mencatat nilai RSS tiap detik (bukan
  running max) agar pertumbuhan dapat dinilai. Pemeriksaan
  baru: request denyut >= 45, pertumbuhan RSS (rata-rata
  10 sampel terakhir <= 1,5x rata-rata detik 10-20), dan
  laju stabil (paruh kedua >= 50% paruh pertama).
- `tests/run-soak-tests.mjs` (baru, manual, bukan rantai
  CI): sesi denyut selama `LP_SOAK_SECONDS` (default 300),
  sampling RSS + jumlah baris tiap 5 detik, jendela laju
  30 detik, pemeriksaan akuntansi/pertumbuhan yang sama
  dengan skala proporsional.

## Hasil 60 detik (rangkaian robust, 30 Oktober 2026)

**26/26 lulus** (dari 23): 319 baris, 120 konsol,
61 denyut, RSS puncak 70 MB (< 256 MB), RSS awal 54 MB ->
akhir 30 MB (datar, menurun), paruh kedua stabil,
seq bersambung, `mono_ms` tak turun, `session_ended`
`signal-SIGINT`, tanpa baris rusak.

## Hasil soak 300 detik (manual, 30 Oktober 2026)

**14/14 lulus**: 1519 baris, 600 konsol, 301 denyut,
RSS puncak 70 MB (< 256 MB), RSS awal (detik 10-30)
69 MB -> akhir (30 detik terakhir) 40 MB (datar,
menurun — bukan kebocoran), jendela 30 detik:
146, 150, 150, 153, 151, 150, 150, 150, 150 baris
(sangat stabil, ~5 baris/detik sesuai laju denyut),
seq bersambung, `mono_ms` tak turun, `session_ended`
`signal-SIGINT`, tanpa baris rusak, keluar 0.

## Batas yang tersisa

- Durasi maksimum yang dibuktikan: 300 detik. Sesi
  berjam-jam/semalam belum diuji.
- RSS hanya terukur di Linux (`/proc`); di platform lain
  pemeriksaan dilewati dengan pesan.
- Soak memakai satu koneksi, tanpa SSE live dan tanpa
  batas `--max-bytes`; kombinasi itu belum diuji rendam.
- CPU selama soak tidak diukur terpisah (tercakup
  benchmark Bab 3.7).
