# Hasil Error Terbedakan + Retry

Tahap setelah live/replay, dikerjakan 29 Oktober 2026 atas perintah
"Lanjut saja". Desain: `docs/ERROR-DESIGN.md`.

## Yang dibangun

- **Kode error** (`tracer-mvp/src/errors.ts`, baru): kelas
  `TracerError {code, message, details}` + `formatTracerError`.
  Delapan kode: `E_CDP_UNREACHABLE`, `E_HANDSHAKE`, `E_CDP_CLOSED`,
  `E_TRACE_LIMIT`, `E_RESUME`, `E_LIVE_PORT`, `E_REPLAY`,
  `E_NAVIGATE`. Pesan stderr berbentuk `[KODE] pesan`; bila sesi
  sudah punya file, `tracer.session_ended` membawa
  `data.error = {code, message, ...details}`.
- **Retry startup** (`--retry <n>`, default 0; `--retry-delay-ms`,
  default 500, backoff eksponensial maks 8000 ms): mengulang
  seluruh urutan koneksi + handshake + enable dengan klien segar,
  HANYA untuk `E_CDP_UNREACHABLE`. Penolakan handshake langsung
  fatal tanpa retry; tidak ada retry di tengah sesi (pemulihannya
  `--append`). Versi diambil ulang tiap percobaan. Flag diteruskan
  ke mode `--replay`.
- **Perbaikan terkait**: selama handshake, tutup-koneksi diabaikan
  (flag `handshaking`) — sebelumnya tutup-koneksi saat handshake
  bisa mengakhiri sesi dengan exit 0 yang menyesatkan. Exit code
  `E_CDP_CLOSED`/`E_TRACE_LIMIT` tetap 0 (akhir sesi anggun,
  perilaku lama); yang baru adalah kodenya.
- **Teks lama dipertahankan**: port mati tetap menyebut "handshake",
  attach ditolak tetap menyebut `Target.attachToTarget` (uji M1
  lama hijau tanpa perubahan).
- **Sidecar/penampil**: tanpa perubahan kode. Field ringkasan
  `session_ended.error` di sidecar ditunda (bukan ditolak).

## Pengujian (diverifikasi ulang langsung oleh asisten)

- Baru `tests/run-error-tests.mjs`: **25/25** — unit `errors.ts`;
  retry berhasil setelah 2 koneksi gagal; retry habis (kode di
  stderr + `session_ended`, menyebut endpoint); default tanpa
  retry; attach ditolak tanpa retry (`E_HANDSHAKE`); tutup tengah
  sesi (`E_CDP_CLOSED`, keluar 0, tanpa retry); banjir event
  (`E_TRACE_LIMIT`); validasi flag (keluar 2) + resume sesi beda
  (`E_RESUME`); uji live: serve dinyalakan 800 ms setelah tracer,
  `--retry 5` tersambung dan keluar 0.
- Regresi penuh hijau: tracer F5 14/14, MS 37/37, live+replay
  31/31, error+retry 25/25, M1 66/66 (benchmark overhead 0,79%,
  gerbang 5%); penampil 27/27; sidecar 17/17.
- Perbaikan harness pasca-CI: run CI pertama pada head final gagal
  di job Node 24 — server CDP palsu di uji banjir-event menulis ke
  soket yang sudah ditutup klien (`ERR_STREAM_WRITE_AFTER_END`,
  unhandled 'error' event). Bukan bug produk (job Node 22 hijau).
  Diperbaiki: `sendFrame` memeriksa `socket.destroyed` + try/catch,
  interval banjir dibersihkan saat soket tutup, dan `socket.on
  ("error")` ditelan; pengaman yang sama diterapkan ke server palsu
  `run-live-tests.mjs`. Uji error diulang 3x lokal: 25/25 stabil.

## Batasan yang tetap berlaku

- Tidak ada retry perintah CDP individual atau reconnect
  pasca-handshake; target mati bersama koneksinya (fakta probe MS).
- Backoff dibatasi 8000 ms; `--retry` tanpa batas tidak disediakan
  (skrip pembungkus/cron adalah tempat retry jangka panjang).
