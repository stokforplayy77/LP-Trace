# Changelog

Seluruh perubahan penting proyek ini dicatat di sini. Format mengikuti
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.12] - 2026-10-30

### Added

- Dukungan preflight Private Network Access (PNA) di server live
  tracer: bila request membawa
  `Access-Control-Request-Private-Network: true`, respons
  (preflight OPTIONS, `/health`, `/events`, 404) menggemakan
  `Access-Control-Allow-Private-Network: true`. Rangkaian live
  bertambah 4 pemeriksaan (35 total). Catatan batas: header ini
  menjadi gerbang di Chrome lama; di Chrome 142+ gerbang yang
  menentukan adalah izin Local Network Access di browser
  (prompt saat pertama menyambung dari penampil HTTPS), dan
  origin HTTP dari IP publik tetap diblokir sebagai konteks
  insecure. Lihat `docs/PNA-DESIGN.md`.

## [0.1.11] - 2026-10-30

### Added

- Perbandingan dua trace di penampil: muat file kedua
  sebagai pembanding; ringkasan berdampingan (baris,
  durasi, kategori, network, konsol, exception, agen),
  diff waterfall (pasangan metode + URL, kemunculan
  ke-n dengan ke-n, selisih durasi, status A/B,
  kehadiran), dan diff konsol (multiset level + teks,
  maks 100 per sisi). Memakai seluruh baris kedua file;
  filter tidak diterapkan; panel lain tetap menampilkan
  trace A. Lihat `docs/COMPARE-DESIGN.md`.

## [0.1.10] - 2026-10-30

### Added

- Kebijakan resource per sesi (opt-in): `--max-rows`,
  `--max-seconds`, `--max-rss-mb` (Linux saja). Saat batas
  tercapai, sesi berakhir dengan anggun (alasan
  `row-limit`/`time-limit`/`rss-limit`, keluar 0) dan
  `session_ended` membawa error `E_RESOURCE_LIMIT`
  (baru) berisi `policy`/`limit`/`observed`;
  `session_started` mencatat `limits` yang aktif.
  Berlaku juga di mode `--replay`.
- Antrean tugas `--task-queue <file>`: file JSONL berisi
  tugas navigasi (`url`, `waitMs` opsional, `connection`
  opsional); dijalankan berurutan, baris rusak atau
  `connection` di luar jangkauan dilewati dan dihitung
  `skipped`; dengan `--stay`, file diawasi
  (`--queue-poll-ms`, default 500 ms) untuk tugas
  susulan; statistik antrean dilaporkan di
  `session_ended`. Menolak `--navigate` dan `--replay`.
- Rangkaian uji resource baru (27 pemeriksaan).

### Changed

- Jeda antar navigasi kini dapat disela oleh
  sinyal/pemicu kebijakan/batas ukuran (sebelumnya
  `setTimeout` penuh).
- Uji ketahanan: sesi panjang diperpanjang 20 -> 60 detik dengan
  pemeriksaan pertumbuhan memori datar (RSS akhir <= 1,5x RSS
  awal) dan laju stabil antar-paruh sesi; ditambah skrip soak
  manual 300 detik (`tracer-mvp/tests/run-soak-tests.mjs`,
  bukan bagian rantai CI). Lihat
  `docs/SOAK-DESIGN.md` dan `docs/SOAK-HASIL.md`.

## [0.1.9] - 2026-10-30

### Added

- Penangkapan domain Log: tracer mengaktifkan `Log.enable`, sehingga
  `Log.entryAdded` tercatat sebagai pelengkap konsol (di Lightpanda
  1.0.2 hanya entri kegagalan pemuatan resource; tidak ada duplikasi
  dengan `consoleAPICalled`/`exceptionThrown` — terverifikasi lewat
  probe, lihat `docs/LOG-DESIGN.md`). Penampil menampilkan entri Log
  di Panel Konsol dengan lencana sumber dan menautkan teksnya ke
  baris waterfall lewat `networkRequestId`. Sidecar menambahkan
  agregat `log` (`present`, `entries`, `byLevel`, `sources`) dan
  memasukkan `Log.entryAdded` ke kategori `console`; hitungan `errors`
  tidak berubah.

## [0.1.8] - 2026-10-30

### Fixed

- Korelasi agen pasca-hoc: baris `agent.*` kini dijangkar pada mtime
  file trace agen per batch (baris terakhir batch mendarat pada
  mtime, baris sebelumnya tersebar mundur sesuai selisih `t`),
  sehingga file agen yang sudah selesai sebelum tracer mulai tampil
  pada waktu aslinya, bukan menumpuk pada waktu baca. Batch dengan
  urutan `t` menurun memakai waktu baca (perilaku F5 lama);
  `mono_ms` baris berjangkar dibatasi bawah 0. Detik ke-0 garis
  waktu penampil dan durasi ringkasan sidecar kini memakai
  `ts` terawal–terakhir (min/maks), bukan baris pertama/terakhir
  urutan file — identik untuk file normal. Teks penjelasan Panel
  Agen diperbarui (klaim "mengelompok pada waktu ingest" sudah
  tidak berlaku).

## [0.1.7] - 2026-10-29

### Fixed

- Balapan `annotate_trace`: penulisan anotasi kini diserialkan
  antar-proses dengan lockfile (`<trace>.lock`, O_EXCL,
  timeout 5 detik, kunci basi > 10 detik dicuri otomatis),
  sehingga dua sidecar yang menganotasi file yang sama tidak
  lagi menulis `seq` yang sama. Kegagalan mendapatkan kunci
  menjadi penolakan tool yang rapi, bukan crash. Kunci daftar
  penampil diperkeras (`seq` + indeks) agar `seq` duplikat
  dari sumber mana pun tidak lagi menghilangkan baris.
  Residu: tracer yang sedang merekam tidak memakai kunci,
  sehingga `seq` duplikat dengan baris tracer masih mungkin
  dalam jendela satu interval flush — didokumentasikan di
  `docs/LOCK-DESIGN.md`.

## [0.1.6] - 2026-10-29

### Added

- Mode bertahan multi-koneksi (`--survive`, opt-in): bila satu
  koneksi CDP ditutup server, sesi berlanjut dengan koneksi lain
  yang masih hidup; penutupan dicatat sebagai baris
  `tracer.connection_closed` (`endpoint`, `endpoint_index`,
  `remaining`), dan `session_ended` membawa `closedEndpoints`
  untuk koneksi yang menutup lebih dulu. Tanpa flag ini perilaku
  tidak berubah: penutupan koneksi mana pun mengakhiri sesi
  (`cdp-closed`). Tidak ada reconnect otomatis; penutupan selama
  handshake tetap fatal. Penampil dan sidecar tidak berubah
  (baris penanda masuk kategori `tracer.*` yang sudah ada).

## [0.1.5] - 2026-10-29

### Fixed

- Redaksi rahasia bersarang pada argumen agen (`--agent-trace`):
  nilai pada kunci mirip rahasia (`token`, `key`, `secret`,
  `password`, `auth`) kini diganti `[REDACTED]` utuh pada kedalaman
  berapa pun (objek dan array bersarang) dan untuk tipe nilai apa pun.
  Sebelumnya aturan ini hanya berlaku untuk kunci tingkat atas yang
  bernilai string, sehingga mis. `args.config.api_key` atau nilai
  objek/array di bawah kunci mirip rahasia tertulis apa adanya di file
  trace. Struktur lebih dalam dari 32 tingkat disensor utuh sebagai
  pengamanan. Perilaku lain tidak berubah: header sensitif dan
  parameter URL bersarang tetap disensor oleh aturan generik, nilai
  biasa dipertahankan dan dipotong 500 karakter.
- Perbaikan harness uji ketahanan (hanya pengujian, kode produk tidak
  berubah): `run-robust-tests.mjs` kini menjalankan build `tsc` dulu
  seperti rangkaian uji lainnya. Sebelumnya rangkaian ini mengasumsikan
  `dist/` sudah ada — di checkout bersih CI tidak ada, sehingga proses
  tracer mati seketika dan penantian keluarnya menggantung 30 detik
  (badge CI "failing" pada 29 Okt 2026). `waitForExit` kini juga
  langsung kembali bila proses anak sudah keluar sebelum listener
  dipasang, dan jumlah baris trace diperiksa eksplisit sebelum
  Playwright/sesi panjang dimulai.

## [0.1.4] - 2026-10-29

Rilis ulang dengan isi sama seperti 0.1.3. Publish `lp-trace-mcp`
0.1.3 gagal pada langkah provenance (`TLOG_CREATE_ENTRY_ERROR`:
entri duplikat di transparency log Sigstore); `lp-tracer` 0.1.3
sendiri terbit normal. Token tidak berizin me-re-run job yang gagal
(403), sehingga rilis diterbitkan ulang sebagai 0.1.4.

## [0.1.3] - 2026-10-29

### Ditambahkan

- Uji ketahanan (ROBUST): koeksistensi Playwright (`connectOverCDP`
  berdampingan dengan tracer), sesi panjang 20 detik (seq bersambung,
  RSS < 256 MB), beban besar 101 permintaan; `playwright-core` sebagai
  `devDependency` pengujian tracer.
- Field `sessionError` pada `get_trace_summary`: `{code, message}`
  dari `tracer.session_ended` terakhir, `null` bila berakhir bersih.

### Temuan

- Lightpanda 1.0.2 tidak me-fetch `<img>` (0 hit server lokal);
  didokumentasikan, bukan bug tracer.

## [0.1.2] - 2026-10-29

### Diperbaiki

- `--version`, `--help`, dan versi server MCP kini membaca versi dari
  `package.json` (sumber tunggal), bukan string hardcode. Paket 0.1.1
  keliru melaporkan dirinya sebagai 0.1.0; ditambah uji versi yang
  membandingkan keluaran CLI dan server MCP dengan `package.json`.

## [0.1.1] - 2026-10-29

Rilis otomatis pertama lewat CI (trusted publishing OIDC + image Docker
ke GHCR). Isi sama dengan 0.1.0; versi 0.1.0 hanya terbit manual di npm.

## [0.1.0] - 2026-10-29

Rilis publik pertama.

### Added

- Error terbedakan + retry startup (lihat `docs/ERROR-DESIGN.md`):
  kode stabil `E_CDP_UNREACHABLE` / `E_HANDSHAKE` / `E_CDP_CLOSED` /
  `E_TRACE_LIMIT` / `E_RESUME` / `E_LIVE_PORT` / `E_REPLAY` /
  `E_NAVIGATE` di stderr (`[KODE] pesan`) dan di `data.error` pada
  `tracer.session_ended`. Flag `--retry <n>` (default 0) +
  `--retry-delay-ms` (default 500, backoff eksponensial maks 8000 ms)
  mengulang startup hanya bila endpoint tidak terjangkau.
- Live mode + record/replay (lihat `docs/LIVE-DESIGN.md`): flag
  `--live-port <n>` menyajikan baris trace lewat SSE di 127.0.0.1
  (`GET /events`, `GET /health`, CORS lokal); penampil mendapat panel
  Mode Live (EventSource, baris live menggantikan tampilan file).
  Flag `--replay <file>` menjalankan ulang navigasi tingkat atas dari
  file trace dan membandingkan jumlah request + host per langkah
  (laporan JSON ke stdout, `--replay-report` menulis file juga).
- Multi-sesi + sesi persisten (lihat `docs/MS-DESIGN.md`): flag `--cdp`
  dapat diulang (satu koneksi per kemunculan; URL yang sama boleh
  diulang — terverifikasi 2 koneksi ke satu proses `serve` mendapat
  target terpisah; target tidak bertahan setelah klien putus, sehingga
  yang persisten adalah file trace). Setiap baris membawa
  `endpoint`/`endpoint_index`; `--navigate` dipasangkan berurutan
  dengan `--cdp` (satu `--cdp`: navigasi berurutan pada target yang
  sama, perilaku M1). Flag `--append` melanjutkan file trace lama
  (sesi + `seq` bersambung, baris `tracer.session_resumed`; sesi
  berbeda atau ekor rusak ditolak tanpa menyentuh file). Penampil
  mendapat filter endpoint + waktu relatif dari `ts`; `get_trace_summary`
  mendapat agregat `endpoints` dan flag `resumed`. Uji: 37 pemeriksaan
  tracer (server CDP palsu + live 2 koneksi), penampil 25, sidecar 17.
- F5 — korelasi dengan file trace `agent --trace` upstream
  (lihat `docs/F5-DESIGN.md`): flag `--agent-trace` pada `lp-tracer`
  membaca (tail) file trace agen selama sesi dan menulis langkah agen
  sebagai baris `agent.*` pada sumbu waktu tracer yang sama, dengan
  redaksi Bab 3.6 yang sama (argumen dipotong, hasil tool tidak
  ditulis kecuali `--include-bodies`, tipe baris tak dikenal tidak
  membawa payload). Format trace agen diverifikasi dari run sungguhan
  Lightpanda 1.0.2 tanpa LLM; bentuk baris panggilan model belum
  terverifikasi dan ditangani sebagai `agent.unknown`. Penampil
  mendapat kategori `agen` + Panel Agen; `get_trace_summary` mendapat
  filter kategori `agent` dan field agregat `agent`. Uji live
  membuktikan korelasi ujung-ke-ujung (tracer + run skrip agen
  bersamaan); overhead benchmark tetap di bawah gerbang 5%.
- CI GitHub Actions (`.github/workflows/ci.yml`): uji tracer (M1, dengan
  Lightpanda 1.0.2 asli), penampil (M2, termasuk `svelte-check` dan
  build), dan sidecar MCP (M3) pada Node.js 22 dan 24, ditambah build
  ketiga image Docker tanpa push.
- Workflow rilis (`.github/workflows/release.yml`): pada tag `v*`, image
  Docker di-push ke GHCR dan paket `lp-tracer` + `lp-trace-mcp`
  diterbitkan ke npm lewat Trusted Publishing (OIDC). Publish npm butuh
  penyiapan satu kali di npmjs.com: daftarkan repo ini sebagai trusted
  publisher untuk kedua paket tersebut. Tanpa penyiapan itu, job npm
  gagal dengan error autentikasi yang jelas; job Docker tidak terpengaruh.
- Image Docker: `lp-trace-tracer` (Lightpanda 1.0.2 + tracer, dengan
  entrypoint yang menjalankan `serve` + tracer), `lp-trace-viewer`
  (build statis + nginx), `lp-trace-mcp` (sidecar stdio).
- Kesiapan publish npm: field `private` dihapus dari `lp-tracer` dan
  `lp-trace-mcp`, skrip `prepublishOnly` ditambahkan, dan field
  `repository`/`bugs` dilengkapi. `lp-trace-viewer` tetap privat karena
  didistribusikan sebagai situs statis, bukan paket npm.
- `lp-tracer` (M1): tracer CDP eksternal untuk Lightpanda 1.0.2 — handshake
  Target wajib, rekaman event ke JSONL teredaksi, overhead terukur 1,11%.
- `lp-trace-viewer` (M2): penampil trace statis — timeline, waterfall dari
  stempel waktu tracer, panel konsol, pencarian, ekspor CSV dan HAR
  subset best-effort.
- `lp-trace-mcp` (M3): sidecar MCP (stdio) dengan tepat dua tool,
  `get_trace_summary` dan `annotate_trace`.
- Dokumen perancangan v1.1 beserta laporan verifikasi M0/M0b di `docs/`.
- Lisensi Apache-2.0.
