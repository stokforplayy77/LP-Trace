# Desain sesi panjang 60 detik + soak

Tanggal: 30 Oktober 2026. Cakupan: HANYA uji (kode produk tidak
berubah). Melanjutkan uji ketahanan ROBUST, yang memakai sesi
20 detik (119 baris, RSS puncak 69 MB, batas 256 MB).

## 1. Dua tingkat, dua tempat

- **60 detik di rangkaian CI** (uji 2 `run-robust-tests.mjs`,
  20 -> 60 detik): biaya CI naik ~40 detik, masih wajar untuk
  setiap push. Membuktikan sesi satu menit penuh tetap
  sehat: seq bersambung, `mono_ms` tak turun, event terus
  mengalir sampai akhir, memori datar.
- **Soak 300 detik manual** (`run-soak-tests.mjs`, BUKAN
  bagian rantai `npm test`): 5 menit terlalu lama untuk
  setiap push CI. Dijalankan manual dengan
  `LP_SOAK_SECONDS` (default 300) dan hasilnya dicatat di
  `SOAK-HASIL.md`. Skrip dilewati dengan pesan bila binary
  tidak ditemukan — ia tidak boleh menggagalkan CI yang
  tidak menyediakannya.

## 2. Metode (sama di kedua tingkat)

Halaman denyut yang sudah ada: `console.log` tiap 500 ms +
`fetch('/denyut')` tiap 1000 ms. Tracer `--stay`, dimatikan
dengan SIGINT di akhir. Yang diperiksa:

- **Akuntansi event**: jumlah konsol dan jumlah request
  denyut memenuhi batas bawah (60 detik: konsol >= 90,
  request denyut >= 45; soak: skala proporsional dengan
  durasi, toleransi batas awal/akhir).
- **Kontinuitas**: seq bersambung, `mono_ms` tak turun,
  tanpa baris rusak, `session_ended` beralasan
  `signal-SIGINT`.
- **Memori (Linux saja, `/proc/<pid>/status` VmRSS)**:
  puncak < 256 MB (batas lama, dipertahankan), DAN
  pertumbuhan datar: rata-rata RSS 10 sampel terakhir
  <= 1,5x rata-rata RSS jendela 10-20 detik (setelah
  pemanasan startup). Faktor 1,5 longgar dengan sengaja:
  yang dicari adalah kebocoran tak terbatas, bukan
  fluktuasi GC/alokasi awal. Bila sampel < 30 (platform
  atau waktu tak memungkinkan), pemeriksaan pertumbuhan
  dilewati dengan pesan, bukan gagal.
- **Laju stabil (soak saja)**: jumlah baris per jendela
  30 detik; tiap jendela setelah jendela pertama >= 50%
  dari jendela pertama (menangkap writer yang makin
  tertinggal, bukan angka pasti).

## 3. Yang TIDAK diuji di sini

- Sesi berjam-jam / semalam (biaya waktu; 300 detik sudah
  membedakan kebocoran linear dari noise startup).
- CPU tracer selama soak (sudah tercakup benchmark Bab 3.7
  tiap rilis; soak fokus pada memori + kontinuitas).
- Mode live SSE / multi-endpoint selama soak (kombinasi
  yang belum diminta; soak memakai satu koneksi).
- Perilaku `--max-bytes` selama soak (batas ukuran diuji
  terpisah di M1; soak memakai file tanpa batas).

## 4. Rilis

Perubahan HANYA uji + dokumen: TIDAK ada bump versi, tag,
atau rilis npm (preseden perbaikan harness CI 29 Oktober
2026). Perubahan masuk `main` lewat push biasa; CI
menjalankan rangkaian 60 detik. CHANGELOG mencatatnya di
`[Unreleased]`.
