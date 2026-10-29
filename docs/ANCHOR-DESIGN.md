# Desain penjangkaran mtime untuk korelasi agen (F5 lanjutan)

Tanggal: 30 Oktober 2026. Cakupan: `tracer-mvp` (tailer +
`writeRow`), penyesuaian semantik waktu min/maks pada penampil
dan sidecar. Bentuk file trace agen upstream tidak berubah dan
tidak ada asumsi baru tentang baris panggilan model.

## 1. Masalah (F5)

Sejak F5, baris `agent.*` dicap dengan waktu BACA tracer
(`ts`/`mono_ms` saat tailer polling). Bila tracer berjalan
bersamaan dengan agen, itu cukup akurat (galat ≤ interval
polling 250 ms). Tetapi bila file trace agen sudah selesai —
atau sudah berisi baris — sebelum tracer mulai (kasus
post-hoc: agen berjalan dulu, tracer men-tail file lama),
seluruh langkah agen menumpuk pada waktu baca: `agent_t`
relatif benar, tetapi `ts`-nya salah bermenit-menit. Dokumen
F5 mencatat ini sebagai keterbatasan jujur dan menunda
penjangkaran mtime sebagai pekerjaan lanjutan. Tahap ini
mengerjakannya.

## 2. Keputusan: jangkar per batch dari mtime

Satu-satunya jam absolut yang dimiliki file trace agen adalah
`mtime` filesystem-nya: waktu tulis terakhir. Field `t` pada
tiap baris adalah milidetik relatif sejak sesi agen dimulai.
Gabungan keduanya merekonstruksi waktu absolut tiap baris:

```
ts(baris) = mtime_batch - (t_terakhir_batch - t_baris)
```

dengan `mtime_batch` = mtime file pada snapshot `stat()` yang
sama dengan pemeriksaan ukuran batch itu, dan `t_terakhir_batch`
= nilai `t` terbesar pada batch tersebut. Baris terakhir batch
mendarat tepat pada mtime; baris sebelumnya tersebar mundur
sesuai selisih `t`-nya. Ini bekerja untuk KEDUA kasus:

- Post-hoc: file selesai ditulis 10 menit lalu, mtime-nya
  10 menit lalu → seluruh langkah direkonstruksi pada waktu
  aslinya, sebelum `session_started` tracer.
- Live: batch yang dibaca pada satu polling tersebar sesuai
  `t`, bukan menumpuk pada waktu polling.

Penjangkaran dihitung PER BATCH dan tidak menyimpan status
antar batch: tiap batch memakai mtime snapshot-nya sendiri.
File yang ditimpa (reset) otomatis mendapat jangkar baru
karena batch berikutnya membaca dari awal dengan mtime baru.

## 3. Aturan rinci

Fungsi murni `anchorBatchTimes(agentTs, mtimeMs, readTimeMs)`
mengembalikan waktu absolut (ms epoch) per baris, atau `null`
(= pakai waktu baca, perilaku F5 lama) untuk baris itu:

- `agentT` tiap baris = nilai `t` mentah bila berupa angka
  berhingga ≥ 0, selain itu `null`. Perhatian: `data.agent_t`
  pada baris hasil konversi TETAP memakai fallback 0 lama —
  skema data tidak berubah; `agentT` untuk penjangkaran
  dibawa pada field terpisah di `AgentTraceRow`, bukan di
  `data`.
- Baris tanpa `t` yang dapat dipakai → `null` untuk baris itu
  saja; baris lain dalam batch tetap dijangkar.
- Bila urutan `t` yang valid dalam batch MENURUN (file dipakai
  ulang dua sesi tanpa ditimpa, atau `t` rusak) → SELURUH
  batch `null` (fallback waktu baca). Alasannya: penurunan
  berarti batch melintasi batas sesi, dan satu mtime tidak
  dapat menempatkan dua sesi sekaligus.
- Jangkar = `min(mtimeMs, readTimeMs)`: mtime di masa depan
  (jam filesystem melompat) merosot anggun menjadi penjangkaran
  pada waktu baca, bukan waktu masa depan.
- `mono_ms` baris berjangkar = `ts - startWallMs` sesi tracer,
  dibatasi bawah 0. Baris agen dari sesi yang mendahului
  tracer mendapat `mono_ms` 0 (jam relatif tracer tidak dapat
  mewakili waktu sebelum prosesnya ada); `ts`-nya tetap
  eksak. `mono_ms` baris tanpa jangkar dihitung seperti biasa
  dari jam monotonik tracer.
- Baris penanda `tracer.agent_attached` / `tracer.agent_reset`
  tidak dijangkar: mereka mencatat kejadian tailer, bukan
  langkah agen → selalu waktu baca.
- Sisa buffer pada `stop()` tidak dijangkar (tidak ada snapshot
  mtime untuknya) → waktu baca.

## 4. Asumsi dan batas galat

- `t` diasumsikan sebagai waktu EMISI baris (satu-satunya
  tafsir yang didukung file). Bila upstream menulis `t`
  sebagai waktu MULAI langkah, galat per baris ≤ durasi
  langkah itu (`ms`); bentuk `t` untuk baris panggilan model
  tetap tidak terverifikasi (probe tanpa LLM), dan baris tak
  dikenal tetap tanpa payload.
- Galat penjangkaran ≤ satu interval polling + penundaan
  flush penulis upstream pada baris terakhir batch. Bila
  upstream menahan buffer sampai keluar proses, mtime =
  waktu keluar; rekonstruksi tetap benar selama `t`
  mencerminkan waktu langkah, karena hanya baris terakhir
  yang menempel pada mtime.
- `atime`/`ctime` tidak dipakai: keduanya tidak bermakna
  waktu tulis konten. Jam yang dipakai seluruhnya jam sistem
  yang sama (mtime file vs `Date.now()`), tanpa sinkronisasi
  lintas mesin.

## 5. Penampil dan sidecar: semantik min/maks

Baris berjangkar dapat mendahului `session_started` dalam
urutan file. Dua fungsi waktu yang memakai baris pertama /
terakhir urutan file diubah menjadi min/maks atas seluruh
baris, agar detik ke-0 dan durasi tetap bermakna:

- Penampil `relativeSeconds` / `durationMs`: nol = `ts`
  terawal, durasi = `ts` terakhir − `ts` terawal (fallback
  `mono_ms` min/maks). Untuk file normal (ts tak menurun
  dalam urutan file) hasilnya IDENTIK dengan sebelumnya.
- Sidecar `durationMs` / `startedAt` / `endedAt`: rentang
  min/maks yang sama. Identitas sesi dan versi tetap dari
  baris pertama/terakhir urutan file (bukan waktu).
- Waterfall tidak berubah (hanya baris CDP, durasi dari
  `mono_ms`).

## 6. Uji

- Unit fungsi murni: penyebaran batch normal; satu baris;
  `t` hilang/negatif → `null` per baris; penurunan `t` →
  seluruh batch `null`; mtime masa depan → jangkar pada
  waktu baca; batch kosong → kosong.
- Tailer langsung (pola uji F5): file dengan mtime
  dimundurkan 60 detik → baris `agent.*` membawa `tsMs`
  ≈ mtime − selisih `t` (±2 detik), `agentT` utuh;
  penanda attached/reset tanpa `tsMs`; file yang tumbuh
  saat tailer berjalan → batch dua baris satu tulis
  tersebar sesuai selisih `t`-nya (±1 detik), bukan
  menumpuk.
- CLI ujung-ke-ujung (bagian live F5): file agen lama +
  serve asli → baris agen dalam file trace hasil memiliki
  `ts` mendahului `session_started`, `mono_ms` ≥ 0, dan
  urutan `ts` sejalan urutan `t`.
- Penampil: `relativeSeconds`/`durationMs` pada file
  dengan baris agen mendahului sesi — semua relatif ≥ 0,
  baris terawal = 0, durasi = rentang penuh.
- Sidecar: ringkasan atas file yang sama — `durationMs`
  rentang penuh, `startedAt` = ts terawal.
- Regresi penuh ketiga paket.

## 7. Non-tujuan

- Mengubah `t` upstream atau menebak waktu baris panggilan
  model yang belum terverifikasi.
- Mengunci file agen atau mengasumsikan penulis tunggal.
- Mengubah `writeRow` untuk baris non-agen (jalur waktu
  baca tidak berubah).
- Menjadikan `mono_ms` baris berjangkar negatif.
