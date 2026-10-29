# Hasil Live Mode + Record/Replay

Tahap setelah MS, dikerjakan 29 Oktober 2026 atas perintah "Lanjut saja"
setelah laporan MS. Desain: `docs/LIVE-DESIGN.md`.

## Yang dibangun

- **Tracer** (`tracer-mvp/src/live.ts`, baru): server SSE loopback
  127.0.0.1 lewat flag `--live-port <n>` — `GET /events` (hello +
  baris JSONL yang sama persis setelah berhasil ditulis + heartbeat
  15 detik), `GET /health`, header CORS. Dimulai sebelum file dibuka
  (port bentrok = fatal tanpa menyentuh file), ditutup setelah
  `session_ended` disiarkan. Disambung ke `tracer.ts`/`cli.ts`
  (flag juga lolos ke mode replay dan `--append`/`--agent-trace`).
- **Replay** (`tracer-mvp/src/replay.ts`, baru): flag `--replay`
  pada `lp-tracer` — ekstrak navigasi tingkat atas (hanya
  `frameNavigated` tanpa `parentId`, buang `about:blank`, gabung
  duplikat berurutan), jalankan ulang lewat `runTracer` yang sama,
  kelompokkan `requestWillBeSent` per jendela langkah, bandingkan
  jumlah request + himpunan host. Laporan JSON ke stdout,
  `--replay-report` menulis file yang sama; ringkasan manusiawi ke
  stderr. `--stay` diabaikan dalam mode replay (replay harus selesai).
  Validasi: tepat satu `--cdp`, menolak `--navigate`/`--agent-trace`
  (keluar 2); file hilang/tanpa navigasi = fatal keluar 1.
- **Penampil**: helper `parseLiveEvent` di `trace.ts` + panel Mode
  Live di `+page.svelte` (EventSource, Sambung/Putus/Jeda, status +
  hitungan; baris live menggantikan tampilan file; memuat file
  memutuskan sambungan live; `onDestroy` menutup koneksi). Seluruh
  tampilan turunan dipakai ulang tanpa perubahan logika.
- **Sidecar**: tanpa perubahan kode — `get_trace_summary` membaca
  ulang file tiap panggilan sehingga sudah mengikuti file yang
  tumbuh; README mencatatnya beserta batasan balapan `seq` pada
  `annotate_trace` bersamaan dengan tracer.

## Pengujian (diverifikasi ulang langsung oleh asisten)

- Tracer `npm test` (F5 + MS + live + M1) hijau penuh: F5 14/14,
  MS 37/37, **live+replay 31/31** (baru, `tests/run-live-tests.mjs`),
  M1 66/66; benchmark overhead **0,43%** (gerbang 5%),
  `benchmark-result.json` diperbarui run ini.
- Uji live mencakup: SSE `/health` + CORS + hello + penerimaan
  `frameNavigated`/`session_ended` + keluar 0 setelah SIGINT (server
  palsu dan Lightpanda 1.0.2 sungguhan); port bentrok → keluar bukan
  nol + file tidak dibuat; replay cocok (palsu deterministik dan 2
  halaman lokal sungguhan), replay tidak cocok terdeteksi (1 vs 2
  request per navigasi), 4 validasi replay, unit ekstraksi/jendela.
- Penampil: **27/27** (25 lama + 2 baru untuk `parseLiveEvent` dan
  aliran baris SSE ke waterfall/filter); `svelte-check` 0
  error/warning, `vite build` bersih. Panel SSE di browser belum
  diuji lewat smoke browser — dinyatakan jujur di README penampil.
- Sidecar: 17/17 (tidak berubah).

## Batasan yang tetap berlaku

- SSE hanya loopback, tanpa autentikasi — alat lokal; tidak ada
  batas antrean per klien lambat di v1.
- Replay hanya navigasi tingkat atas; tanpa interaksi, tanpa body
  respons, tanpa perbandingan waktu. Reload URL yang sama berurutan
  digabung menjadi satu langkah.
- Halaman ber-iframe: navigasi sub-frame tidak dihitung sebagai
  langkah (filter `parentId`) — tetapi request sub-frame tetap
  masuk ke jendela langkah induknya.
