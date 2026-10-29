# Desain kunci file anotasi (lockfile)

Tanggal: 29 Oktober 2026. Cakupan: `mcp-sidecar` (protokol kunci
+ `annotate_trace`) dan pengerasan kunci daftar penampil. Tracer
tidak berubah.

## 1. Lubang yang diperbaiki

`annotate_trace` bekerja baca-lalu-tambah: baca seluruh file,
hitung `seq = max(seq) + 1` dari baris terakhir, lalu tambah satu
baris. Serialisasi yang ada (`writeChain` di `annotate.ts`) hanya
berlaku di dalam SATU proses sidecar. Dua proses sidecar (dua
klien MCP, atau sidecar + proses lain yang memanggil tool yang
sama) yang menganotasi file yang sama secara bersamaan dapat
membaca ekor yang sama dan menulis `seq` yang sama.

`seq` duplikat bukan sekadar kosmetik: penampil memakai `row.seq`
sebagai kunci blok `{#each}` pada tiga daftar (timeline, konsol,
agen) — kunci duplikat membuat satu baris tidak tampil atau
menampilkan isi baris lain. Ringkasan sidecar sendiri tidak
bergantung pada keunikan `seq` (agregasi memakai hitungan, dan
`scanExisting` mengambil `max(seq)` sehingga anotasi berikutnya
tetap pulih), tetapi penampil tidak boleh bergantung pada janji
yang tidak dijamin penulis file.

## 2. Keputusan

- **Lockfile berdampingan, per file trace.** Jalur kunci =
  `resolve(tracePath) + ".lock"` (path dikanonikalisasi dulu,
  agar ejaan relatif/absolut yang berbeda untuk file yang sama
  memakai kunci yang sama). Dibuat dengan `open(path, "wx")`
  (O_CREAT|O_EXCL) — atomik di POSIX dan Windows, tanpa
  dependensi baru, tanpa daemon, tanpa `flock` (tidak ada di
  Node stdlib).
- **Kunci dipegang selama seluruh seksi kritis** baca → hitung
  seq → tambah baris, lalu dilepas di `finally`. Rantai promise
  dalam proses dipertahankan (murah, dan menertibkan antrean
  lokal sebelum mencapai kunci).
- **Kunci basi bisa dicuri.** Isi lockfile: PID + stempel waktu
  ISO pemegang. Bila lockfile lebih tua dari ambang basi
  (10 detik), pemegang dianggap mati (crash sebelum melepas)
  dan kunci dicuri: hapus lalu coba lagi. Seksi kritis anotasi
  hanya satu baca + satu tambah (milidetik), sehingga pemegang
  hidup tidak pernah memegang kunci 10 detik — pencurian tidak
  dapat mengganggu pemegang yang hidup dalam praktiknya.
- **Gagal dengan pesan jelas, bukan menggantung.** Bila kunci
  tidak didapat dalam 5 detik (interval coba 50 ms), panggil
  tool gagal dengan pesan yang menyebut jalur kunci dan PID
  pemegang (bila terbaca) — klien MCP menerima hasil tool
  `isError`, bukan crash server. Anotasi yang gagal tidak
  menulis apa pun.
- **Tracer TIDAK ikut memakai kunci.** Alasannya blast radius:
  tracer menulis lewat buffer 250 ms pada jalur panas; kunci
  pada tiap flush berisiko menunda/menggagalkan perekaman bila
  protokol kunci bermasalah. Konsekuensinya jujur dan didokumentasikan
  (§4): jendela residu di bawah satu interval flush di mana
  `seq` duplikat dengan baris tracer masih mungkin. Jendela itu
  kini tidak lagi merusak tampilan, karena kunci daftar
  penampil diperkeras (§5).

## 3. Protokol (`mcp-sidecar/src/lockfile.ts`)

```
acquireLock(lockPath, { timeoutMs: 5000, retryMs: 50, staleMs: 10000 })
  -> { release(): Promise<void> }
```

- Coba `open(lockPath, "wx")`; bila berhasil, tulis isi
  `"pid=<pid>\ntime=<iso>\n"`, pegang handle tetap terbuka
  sampai `release()`.
- Bila `EEXIST`: `stat` lockfile; bila `mtimeMs` lebih tua dari
  `staleMs`, `unlink` (abaikan `ENOENT` — pemegang lain
  mungkin baru saja melepas) dan coba lagi segera; bila masih
  segar, tidur `retryMs` dan coba lagi sampai `timeoutMs`.
- Error selain `EEXIST` (mis. `EACCES` direktori read-only)
  langsung dilempar dengan konteks jalur kunci — tidak
  diputar-ulang, karena memutarnya tidak akan mengubah hasil.
- `release()` idempotent: tutup handle (abaikan error), lalu
  `unlink` (abaikan `ENOENT`). Dipanggil dari `finally`, jadi
  kunci selalu dibersihkan pada jalur sukses maupun gagal di
  dalam seksi kritis. Crash proses (SIGKILL) meninggalkan
  lockfile basi yang pulih sendiri lewat aturan basi.

## 4. Residu yang didokumentasikan (bukan diperbaiki tahap ini)

- Tracer yang sedang merekam dapat men-flush baris dengan
  `seq` yang ditetapkan di memori sebelum anotasi membaca
  file; bila flush itu mendarat sesudah anotasi, `seq`
  duplikat mungkin terjadi. Penampil menoleransinya (§5) dan
  ringkasan tidak terpengaruh. Menghilangkannya butuh kunci
  pada flush tracer — ditolak pada tahap ini (§2).
- `get_trace_summary` tetap tanpa kunci (baca saja; baris
  terakhir yang terpotong saat dibaca bersamaan dengan
  penulisan sudah dihitung sebagai baris malformed oleh
  pembaca yang ada).
- Dua ejaan path yang menunjuk file berbeda secara
  `resolve()` tetapi sama secara fisik (symlink/hardlink)
  memakai kunci berbeda. Bukan kasus yang didukung.

## 5. Pengerasan penampil (pendamping)

Tiga blok `{#each}` di `viewer/src/routes/+page.svelte`
mengunci dengan `row.seq` / `entry.row.seq`. Diubah menjadi
kunci komposit `seq + "-" + indeks-dalam-daftar`, sehingga
kunci selalu unik sekalipun file mengandung `seq` duplikat
(dari jendela residu §4, file hasil edit tangan, atau trace
lama). Tidak ada animasi/transisi pada daftar-daftar itu,
sehingga perubahan kunci tidak mengubah perilaku visual saat
`seq` unik — hanya menghilangkan kegagalan saat `seq`
duplikat.

## 6. Uji

- Unit `lockfile.ts`: peroleh + lepas menghapus lockfile;
  perolehan kedua menunggu lalu berhasil sesudah lepas;
  lockfile basi (mtime dimundurkan) dicuri; lockfile segar +
  timeout pendek → `LockAcquisitionError` yang menyebut jalur;
  `release()` ganda aman; lockfile berisi PID pemegang.
- Anotasi lintas proses lewat tool sungguhan: dua klien MCP
  (dua proses server) menganotasi file yang sama secara
  bersamaan (20 panggilan) → semua berhasil, 20 `seq`
  berbeda dan berurutan, tidak ada lockfile tersisa.
- Lock segar yang dibuat manual sebelum panggilan tool →
  tool gagal rapi (`isError`) dengan pesan kunci, file tidak
  berubah, dan panggilan berikutnya berhasil sesudah lockfile
  basi/dihapus.
- Regresi: seluruh rangkaian tracer + sidecar + penampil.
