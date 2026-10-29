# LOCK-HASIL — Kunci file anotasi antar-proses (0.1.7)

Tanggal: 29 Oktober 2026. Cakupan: `mcp-sidecar`
(`src/lockfile.ts` baru, `src/annotate.ts`) + pengerasan kunci
daftar penampil (3 baris di `+page.svelte`). Tracer tidak
berubah. Desain: `docs/LOCK-DESIGN.md`.

## Yang dibangun

- `src/lockfile.ts` (baru): protokol lockfile O_EXCL tanpa
  dependensi. `acquireLock(lockPath, {timeoutMs: 5000,
  retryMs: 50, staleMs: 10000})` membuat `<trace>.lock` dengan
  `open("wx")`, menulis PID + stempel waktu pemegang, dan
  mengembalikan `release()` idempotent (tutup handle lalu
  hapus lockfile, dipanggil dari `finally`). Lockfile basi
  (> 10 detik, pemegang crash) dicuri; lockfile segar yang
  tidak didapat dalam 5 detik melempar `LockAcquisitionError`
  yang menyebut jalur kunci dan PID pemegang bila terbaca.
  Error selain `EEXIST` (mis. direktori read-only) langsung
  dilempar dengan konteks jalur kunci. `lockPathFor()`
  mengkanonikalisasi path dulu (`resolve()`), agar ejaan
  relatif/absolut untuk file yang sama memakai kunci yang
  sama.
- `src/annotate.ts`: `appendAnnotationInner` kini memegang
  kunci selama seluruh baca → hitung seq → tambah baris.
  Rantai promise dalam proses dipertahankan sebagai lapis
  pertama. Header komentar diperbarui: klaim lama "seq tidak
  pernah bentrok" hanya benar dalam satu proses; kini kedua
  lapis dijelaskan beserta residu terhadap tracer yang hidup.
  Jalur error `server.ts` tidak berubah — throw dari
  `appendAnnotation` sudah menjadi hasil tool `isError`
  dengan pesan jelas, sehingga kegagalan kunci sampai ke
  klien MCP sebagai penolakan tool yang rapi, bukan crash.
- Penampil: tiga blok `{#each}` (timeline, konsol, agen)
  mengunci dengan `seq + "-" + indeks-dalam-daftar`, bukan
  `seq` saja. Tanpa animasi/transisi pada daftar-daftar itu,
  perilaku visual saat `seq` unik tidak berubah; saat `seq`
  duplikat (jendela residu tracer, file edit tangan), tidak
  ada lagi baris yang hilang/tertukar karena kunci duplikat.

## Uji

Sidecar 25/25 (19 lama + 6 baru), lewat klien MCP SDK
sungguhan + unit lockfile langsung:

- Unit: peroleh + lepas menghapus lockfile dan mencatat PID;
  perolehan kedua menunggu lalu berhasil sesudah lepas;
  kunci basi (mtime 60 detik lalu) dicuri; kunci segar +
  timeout 200 ms → `LockAcquisitionError` menyebut jalur;
  `lockPathFor` menormalkan path relatif.
- Lintas proses lewat tool: dua klien MCP (dua proses
  server) menganotasi file yang sama, 20 panggilan bersamaan
  → semua berhasil, 20 `seq` berbeda berurutan 42..61,
  seluruh file 61 baris bebas duplikat `seq`, tidak ada
  lockfile tersisa.
- Lockfile segar dibuat manual → tool gagal rapi (`isError`,
  pesan menyebut "dikunci"), file tidak berubah (41 baris);
  sesudah lockfile dihapus, anotasi berikutnya berhasil
  seq 42.
- Regresi penuh hijau: tracer 23+4+17+37+31+25+28+66
  (benchmark overhead 0,51%, gate 5%), penampil 27/27
  (build + `svelte-check` bersih).

## Batas yang tersisa (didokumentasikan, bukan diperbaiki)

- Tracer tidak memakai kunci (jalur panas, blast radius):
  `seq` duplikat dengan baris tracer masih mungkin dalam
  jendela satu interval flush (250 ms). Penampil menoleransi,
  ringkasan tidak terpengaruh.
- `get_trace_summary` tetap tanpa kunci (baca saja).
- Symlink/hardlink ke file yang sama memakai kunci berbeda
  (path `resolve()` tidak menyelesaikan symlink).
