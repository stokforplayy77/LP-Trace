# Desain perbandingan dua trace di penampil (0.1.11)

Tanggal: 30 Oktober 2026. Cakupan: `viewer` saja
(tracer dan sidecar tidak berubah; format baris tidak
berubah). Tujuan: menjawab "apa yang berubah antara dua
run" — sebelum/sesudah perubahan kode, sebelum/sesudah
perbaikan — tanpa membuka dua tab dan membandingkan
manual.

## 1. Cara pakai

- Trace A = file yang sudah dimuat seperti biasa
  (pemilih file / contoh / — bukan baris live).
- Trace B = file kedua lewat pemilih "Bandingkan dengan
  file .jsonl" di bagian pemuat. Memuat B tidak
  memutuskan live dan tidak mengubah panel yang ada;
  panel yang ada tetap menampilkan trace A (atau baris
  live bila tersambung).
- Bagian "Perbandingan Trace" muncul bila A dan B
  sama-sama termuat; tombol "Hapus perbandingan"
  mengosongkan B. Memuat ulang A tidak menghapus B.
- Perbandingan memakai SELURUH baris kedua file
  (filter/pencarian tidak diterapkan) — supaya
  "hanya di B" benar-benar berarti tidak ada di file A,
  bukan tersaring. Hal ini dinyatakan di bagian tersebut.

## 2. Isi perbandingan

### 2.1 Ringkasan berdampingan

Tabel metrik | A | B | selisih (B − A):

- Baris, durasi total (dari `ts` terawal–terakhir,
  seperti `durationMs`), sesi, versi Lightpanda.
- Jumlah per kategori (`categoryOf`): navigasi,
  network, konsol, error, tracer, agen, lainnya.
- Permintaan network (entri waterfall), gagal
  (`failed`), entri konsol, exception, langkah agen.

Selisih durasi/jumlah ditampilkan dengan tanda; selisih
0 ditampilkan apa adanya (bukan disembunyikan).

### 2.2 Diff waterfall

Entri `groupWaterfall` dipasangkan berdasarkan kunci
`metode + URL`, kemunculan ke-n dipasangkan dengan
kemunculan ke-n (duplikat URL yang sama tidak saling
menukar pasangan). Setiap pasangan membawa status A/B,
total A/B, dan selisih total (null bila salah satu
tidak punya durasi — mis. melintasi batas resume —
ditampilkan "—", bukan 0).

Urutan: pasangan di kedua file dulu (selisih absolut
terbesar dulu), lalu hanya-di-A (urut URL), lalu
hanya-di-B (urut URL). Lencana kehadiran: "di kedua
file" / "hanya di A" / "hanya di B". Perubahan status
(200 -> 404, selesai -> gagal) terlihat dari kolom
status A/B.

### 2.3 Diff konsol

Entri `consoleEntries` dibandingkan sebagai multiset
berkunci `level + teks`: kunci yang lebih sering di A
masuk "hanya di A" sebanyak selisih kemunculannya,
dan sebaliknya. Daftar dibatasi 100 entri per sisi
dengan catatan jumlah selebihnya. Teks yang sama
dengan level berbeda dihitung kunci berbeda.

## 3. Bukan bagian cakupan

- Overlay dua timeline dalam satu sumbu (panel
  Timeline tetap milik satu trace; perbandingan
  berbentuk tabel).
- Diff baris-per-baris (seq) — `seq` dan `mono_ms`
  tidak sebanding antar-run; yang dibandingkan adalah
  agregat dan kunci semantik (URL, teks konsol).
- Ekspor CSV/HAR hasil perbandingan (ekspor tetap
  milik tampilan trace A saat ini).
- Perbandingan dengan baris live (live adalah aliran,
  bukan file utuh; bandingkan file hasil rekamannya).
- Normalisasi URL (query string dianggap bagian dari
  kunci apa adanya).

## 4. Implementasi

- Logika murni di `src/lib/trace.ts` (dapat diuji
  `node:test` seperti fungsi lain): `compareSummaries`,
  `diffWaterfall`, `diffConsole` + tipe-tipenya.
- UI di `src/routes/+page.svelte`: pemilih file B,
  bagian perbandingan, tabel dibungkus `.table-wrap`
  (gulir horizontal di HP, seperti waterfall).
- Uji: pasangan waterfall (cocok/duplikat/hanya-satu-
  sisi/status berubah/durasi null), diff konsol
  (multiset, level berbeda), ringkasan (kategori +
  durasi + sesi berbeda).
- Dokumen: bagian baru di `viewer/README.md`;
  CHANGELOG 0.1.11. Deploy trial VPS diperbarui
  (direktori statis yang sama, layanan tidak diubah).
