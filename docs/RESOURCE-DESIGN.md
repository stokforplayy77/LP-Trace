# Desain kebijakan resource + antrean tugas (0.1.10)

Tanggal: 30 Oktober 2026. Cakupan: `tracer-mvp` saja
(penampil dan sidecar tidak berubah: alasan `session_ended`
baru dan kode error baru tampil lewat jalur generik yang
sudah ada). Latar: soak 300 detik membuktikan RSS datar
(69 -> 40 MB) dan laju stabil, tetapi tracer tidak punya
batas eksplisit selain `--max-bytes` dan tidak punya cara
menjalankan daftar navigasi yang bisa ditambah saat sesi
berjalan. Fitur ini menutup keduanya, semuanya opt-in:
tanpa flag baru, perilaku sama persis seperti 0.1.9.

## 1. Kebijakan resource

Tiga batas per sesi, masing-masing opt-in:

| Flag | Arti | Trip |
| --- | --- | --- |
| `--max-rows <n>` | Jumlah baris total dalam file (dengan `--append`: baris lama + baris sesi ini, termasuk `session_started`/`session_resumed`; konsisten dengan akuntansi `--max-bytes` di `writer.ts`) | `row-limit` |
| `--max-seconds <n>` | Durasi sesi dalam detik, dihitung dari awal sesi | `time-limit` |
| `--max-rss-mb <n>` | RSS proses tracer sendiri (VmRSS), disampel tiap 1 detik | `rss-limit` |

Aturan umum:

- Validasi: bilangan bulat >= 1, selain itu CLI keluar 2
  (seperti validasi flag lain). `--max-rss-mb` hanya
  Linux (`/proc/self/status`); di platform lain CLI
  menolak flag itu sejak awal (fail-fast, bukan diam
  tidak ditegakkan) dengan pesan yang jelas.
- Saat batas tercapai, sesi berakhir dengan anggun:
  `session_ended` memakai `reason` di atas, keluar 0
  (sama seperti `size-limit`), dan file tetap utuh.
  Baris `session_ended` selalu ditulis memakai cadangan
  seperti `writeSessionEnd` (tidak dihitung ke batas).
- `session_ended` membawa `error: {code:
  "E_RESOURCE_LIMIT", policy, limit, observed}` (kode
  baru, lihat §4) dan `session_started`/`session_resumed`
  membawa `limits` berisi kebijakan yang aktif saja.
- Pemicu pertama menang: bila `--max-bytes` tercapai
  lebih dulu, alasan tetap `size-limit` +
  `E_TRACE_LIMIT`; bila kebijakan baru tercapai lebih
  dulu, alasan dan error-nya yang dipakai. Tidak ada
  kebijakan yang menimpa `sessionError` yang sudah ada.
- Pemeriksaan baris dilakukan di `writeRow` sesudah
  baris berhasil ditulis (jadi tidak ada baris yang
  lolos setelah batas); pemeriksaan waktu/RSS oleh
  timer 1 detik dan diperiksa juga di jeda antar-tugas
  antrean, agar sesi `--stay` yang sepi event tetap
  berakhir tepat waktu.

## 2. Antrean tugas

`--task-queue <file>`: file JSONL, satu tugas per baris:

```json
{"url": "http://127.0.0.1:8765/a.html", "waitMs": 1500, "connection": 0}
```

- `url` wajib string tak kosong; `waitMs` opsional
  (default `--wait-ms`); `connection` opsional (default
  0, memilih koneksi `--cdp` ke-i, seperti pasangan
  `--navigate`). Field lain diabaikan.
- Baris kosong dilewati. Baris JSON rusak, bentuk
  salah, atau `connection` di luar jangkauan: dilewati,
  dihitung sebagai `skipped`, diperingatkan ke stderr,
  TIDAK PERNAH fatal di tengah sesi.
- File harus ada saat tracer mulai (gagal cepat bila
  tidak ada). Tugas dijalankan berurutan memakai jalur
  `Page.navigate` yang sama dengan `--navigate`
  (toleransi `E_NAVIGATE` sama: gagal dinavigasi,
  lanjut tugas berikut).
- Tanpa `--stay`: kerjakan tugas yang ada saat mulai,
  lalu akhiri dengan `tasks-done`. Dengan `--stay`:
  awasi file (`--queue-poll-ms`, default 500, minimum
  50) dan kerjakan tugas yang ditambahkan selama sesi
  berjalan; sesi berakhir oleh sinyal atau batas
  kebijakan. Tugas yang sudah dikerjakan tidak pernah
  diulang (pelacakan offset byte file).
- Bila file terhapus di tengah pengawasan: peringatkan
  sekali, hentikan pengawasan, sesi berlanjut pasif
  sampai sinyal/batas.
- Konflik ditolak CLI sejak awal: `--task-queue` +
  `--navigate`, dan `--task-queue` + `--replay`
  (replay menggerakkan navigasinya sendiri).
- Statistik antrean (`done`, `remaining`, `skipped`)
  dilaporkan di `session_ended` bila mode antrean aktif.
- Kebijakan resource berlaku juga di mode antrean dan
  di mode `--replay` (diteruskan lewat `runTracer`,
  seperti `--max-bytes`); `--task-queue` tidak
  diteruskan ke replay.

## 3. Bukan bagian cakupan

- Rotasi file, kompresi, atau penghapusan trace lama.
- Batas CPU, batas bandwidth, atau pembatasan laju
  event per detik (laju soak sudah stabil ~5 baris/dtk;
  tidak ada bukti kebutuhan).
- Antrean masuk lewat HTTP/SSE (permukaan baru);
  antrean file cukup untuk agen yang menambahkan tugas.
- Perubahan format baris selain field aditif
  (`limits`, `error`, statistik antrean di
  `session_ended`).

## 4. Kode error baru

`E_RESOURCE_LIMIT` (lihat `docs/ERROR-DESIGN.md`):
batas kebijakan resource tercapai; keluar 0, sesi
berakhir, file utuh. Detail: `policy`, `limit`,
`observed`.

## 5. Pengujian

Rangkaian baru `tests/run-resource-tests.mjs` (di rantai
`npm test`, memakai pola harness yang sama: build `tsc`
dulu, resolver binary, `waitForExit` berpenjaga):

1. `--max-rows` kecil: `session_ended` beralasan
   `row-limit`, keluar 0, total baris <= batas + 1
   (`session_ended`), error `E_RESOURCE_LIMIT`.
2. `--max-seconds` 3 dengan `--stay`: berakhir ~3 dtk,
   alasan `time-limit`, keluar 0.
3. `--max-rss-mb` 1: trip pada sampel pertama, alasan
   `rss-limit` (RSS proses Node jauh di atas 1 MB).
4. Antrean statis 2 tugas: kedua URL ternavigasi,
   alasan `tasks-done`, keluar 0.
5. Antrean + `--stay` + tugas ditambahkan: tugas susulan
   ikut dikerjakan, lalu SIGINT mengakhiri sesi.
6. Baris antrean rusak + `connection` di luar jangkauan:
   dilewati dan dihitung `skipped`, tugas valid tetap
   jalan.
7. Validasi CLI: `--max-rows 0`, `--task-queue` +
   `--navigate`, dan `--max-rss-mb` di platform
   non-Linux (bila berlaku) keluar 2.

Regresi penuh (tracer + penampil + sidecar) harus hijau;
tidak ada perubahan perilaku tanpa flag baru.
