# lp-tracer — Tracer CDP untuk Lightpanda Browser (M1)

Tracer eksternal yang merekam event Chrome DevTools Protocol (CDP) dari
Lightpanda Browser ke file JSONL yang sudah diredaksi. Tracer berjalan
sebagai proses terpisah dan **tidak** mengubah kode Lightpanda.

Proyek ini mengikuti
[Dokumen Perancangan v1.1](../docs/dokumen-perancangan-v1.1.md)
(Bab 3.2–3.7, Bab 4.1 F1–F2, Lampiran A). M1 mencakup **F1 (CLI +
handshake)** dan **F2 (pengumpulan event)**. Penampil trace (F3, M2) dan
sidecar MCP (F4, M3) ada di repo ini (`../viewer/`, `../mcp-sidecar/`).

## Status verifikasi (jujur)

| Hal | Status |
|---|---|
| Handshake Target + `sessionId` (Bab 3.3) | Terverifikasi di Lightpanda 1.0.2 (M0b + uji M1) |
| Event: `Page.frameNavigated`, `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`, `Network.loadingFailed`, `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `DOM.documentUpdated` | Terverifikasi di 1.0.2 |
| Level konsol | CDP memakai `"warning"` (bukan `"warn"`); `log`/`warning`/`error` terpetakan |
| Domain `Log` | **Tidak dipakai** di MVP (sesuai Bab 3.5) |
| Field `timing` CDP | Bernilai -1 (M0/M0b); tidak disimpan, waterfall memakai stempel waktu tracer |
| Ukuran byte / breakdown DNS/TLS | Tidak tersedia dari CDP; tidak diklaim |
| Koeksistensi dengan Puppeteer | Terbukti di M0b; M1 tidak mengujinya ulang |
| Playwright | Tidak diuji; tidak diklaim |
| Overhead < 5% | Terverifikasi lewat benchmark Bab 3.7 (lihat di bawah) |

## Syarat

- Node.js 22 atau lebih baru (diuji pada Node v24.22.1).
- Binary Lightpanda **1.0.2** (versi acuan yang dikunci). Unduh lewat
  `scripts/download-lightpanda.sh` (menaruh binary di `vendor/`), atau
  sediakan lewat `PATH`/env `LP_BIN` untuk pengujian.

## Pasang dan build

```bash
npm install
npm run build
```

Tidak ada dependensi runtime: hanya WebSocket native Node.js.
DevDependencies: `typescript` + `@types/node` (lokal di proyek).

## Pakai

Jalankan Lightpanda dulu (telemetri dimatikan untuk pengujian):

```bash
LIGHTPANDA_DISABLE_TELEMETRY=true lightpanda serve --host 127.0.0.1 --port 9222
```

Lalu jalankan tracer:

```bash
node dist/cli.js --cdp ws://127.0.0.1:9222 --output ./trace.jsonl --session "my-agent-run-001"
```

Tracer melakukan handshake Target, mengaktifkan `Page`/`Network`/`Runtime`,
dan merekam sampai menerima SIGINT/SIGTERM (saat itu buffer di-flush dan
baris `tracer.session_ended` ditulis). Untuk menjalankan navigasi dari
tracer sendiri (pengujian/benchmark), pakai `--navigate` (dapat diulang);
tanpa `--stay`, tracer keluar sendiri setelah navigasi selesai:

```bash
node dist/cli.js --cdp ws://127.0.0.1:9222 --output ./trace.jsonl \
  --navigate http://127.0.0.1:8771/ok.html \
  --navigate http://127.0.0.1:8771/throw.html --wait-ms 1200
```

### Docker

Image `lp-trace-tracer` menjalankan Lightpanda 1.0.2 dan tracer dalam
satu container (lihat `docker/Dockerfile.tracer` di akar repo; konteks
build = akar repo):

```bash
docker build -f docker/Dockerfile.tracer -t lp-trace-tracer .
docker run --rm -v "$PWD/traces:/traces" lp-trace-tracer \
  --output /traces/trace.jsonl --navigate https://example.com
```

### Flag

| Flag | Keterangan |
|---|---|
| `--cdp <url>` (wajib) | Endpoint CDP, mis. `ws://127.0.0.1:9222` |
| `--output <file>` (wajib) | File trace JSONL (izin 0600) |
| `--session <id>` | Pengenal sesi; bila kosong, dibuat otomatis |
| `--include-bodies` | Rekam `postData` permintaan, disertai peringatan. Body respons tidak pernah diambil (tracer tidak memanggil `Network.getResponseBody`). |
| `--max-bytes <n>` | Batas ukuran file (default 50 MB, minimum 4096). Bila tercapai, penulisan berhenti; data lama tidak ditimpa; cadangan 1024 byte disimpan untuk `session_ended`. |
| `--navigate <url>` | Navigasikan target tracer ke URL (dapat diulang). Tambahan di luar Bab 4.1, lihat "Perbedaan dari spesifikasi". |
| `--wait-ms <n>` | Jeda antar navigasi (default 1500 ms). |
| `--stay` | Tetap berjalan setelah navigasi selesai. |
| `--help`, `--version` | Bantuan / versi. |

Argumen tidak dikenal menyebabkan error dan bantuan ditampilkan, keluar
bukan nol. Kegagalan pada langkah `attach` handshake bersifat fatal:
tracer keluar bukan nol dengan pesan yang menyebut langkah handshake
yang gagal.

## Format JSONL (Lampiran A)

Satu objek JSON per baris:

| Field | Keterangan |
|---|---|
| `ts` | ISO 8601 UTC, waktu terima event menurut jam tracer |
| `mono_ms` | Milidetik monotonik sejak sesi dimulai |
| `seq` | Nomor urut dari 1, berurutan tanpa lompat |
| `session` | Pengenal sesi |
| `lightpanda_version` | Versi dari `/json/version`, atau `"unknown"` |
| `type` | Nama method CDP verbatim, atau `tracer.*` untuk baris internal |
| `data` | Payload setelah redaksi/pemotongan |

Baris internal: `tracer.session_started` (baris pertama),
`tracer.session_ended` (baris terakhir), dan `tracer.annotation`
(dicadangkan untuk M3; tidak ditulis oleh M1). Contoh sintetis:
[`trace-example.jsonl`](trace-example.jsonl).

## Redaksi dan privasi (Bab 3.6)

Aturan default, tidak dapat dimatikan diam-diam:

- Header `authorization`, `cookie`, `set-cookie`, `proxy-authorization`,
  `x-api-key` (tanpa membedakan huruf besar/kecil) → nilai menjadi
  `[REDACTED]`; nama header tetap dicatat.
- Parameter URL yang namanya mirip token (`token`, `key`, `secret`,
  `password`, `auth`, termasuk bentuk `api_key`/`authToken`) → nilainya
  menjadi `REDACTED` (tanpa kurung siku, agar tidak menjadi
  `%5B...%5D` oleh pengodean URL). URL dicatat utuh kecuali parameter itu.
- Body permintaan (`postData`, `postDataEntries` base64) tidak direkam;
  diganti penanda `[BODY-OMITTED]`, kecuali `--include-bodies` aktif.
- Argumen konsol: tiap argumen ≤ 500 karakter, total satu event ≤ 2000
  karakter. Field `timing` pada `Network.responseReceived` tidak disimpan.
- String sangat panjang pada event lain dipotong (maks 4096 karakter).

Temuan yang memverifikasi pentingnya aturan ini: event CDP **mentah**
dari Lightpanda 1.0.2 membawa nilai sensitif apa adanya (header
`Authorization`, parameter `token` pada URL, dan `postData` beserta
salinan base64-nya). Redaksi tracer bukan formalitas — tanpanya, rahasia
akan tertulis mentah di file trace.

## Benchmark overhead (Bab 3.7)

Beban kerja tetap: 4 navigasi lokal (`ok`, `throw`, `multi`, `ok`) dengan
jeda 1200 ms, 5 ulangan tiap sisi, Lightpanda 1.0.2 yang sama, telemetri
mati di kedua sisi. Hasil pada sandbox Linux x86_64, Node v24.22.1
(29 Oktober 2026, berkas `benchmark-result.json`):

| | Median wall-clock |
|---|---|
| Tanpa tracer | 4951 ms |
| Dengan tracer | 5006 ms |
| **Overhead** | **1,11% (gerbang 5% → LULUS)** |

CPU tracer (utime+stime, terpisah dari proses Lightpanda): 0,15–0,23
detik per ulangan (median 0,17 detik). Ukuran trace per ulangan:
28.887 byte (beban kerja deterministik). Satu ulangan tracer tercatat
5.536 ms (pencilan); median tetap kokoh. Ulangi dengan `npm run bench`
(butuh binary Lightpanda lewat `LP_BIN`/`PATH`).

## Pengujian

```bash
npm test        # build + uji end-to-end terhadap Lightpanda 1.0.2 + benchmark
npm run bench   # hanya benchmark overhead
```

Rangkaian uji menjalankan Lightpanda 1.0.2 sungguhan dan memeriksa:
handshake + skema JSONL, event inti (exception, level konsol,
`loadingFailed`), redaksi (nilai rahasia tidak mentah, pemotongan
konsol, `getResponseBody` tidak pernah dipanggil), kegagalan handshake
(port mati + server CDP palsu yang menolak `attach`), SIGINT
(`session_ended` + flush), batas ukuran, dan benchmark tercatat.
Lihat [`M1-HASIL.md`](M1-HASIL.md).

## Perbedaan dari spesifikasi (tercatat, bukan diam-diam)

1. **Flag `--navigate` / `--stay` / `--wait-ms`.** Bab 4.1 tidak
   menyediakan cara bagi tracer untuk menggerakkan navigasi, padahal
   langkah 6 Bab 3.3 menyebut `Page.navigate`. Flag ini membuat tracer
   dapat menguji dan mengukur dirinya sendiri. Tanpa flag tersebut,
   tracer bersifat pasif (mengamati sampai sinyal tiba), sesuai F1.
2. **Penanda parameter URL adalah `REDACTED`** (tanpa kurung siku),
   karena `[REDACTED]` menjadi `%5BREDACTED%5D` setelah pengodean URL.
   Penanda header tetap `[REDACTED]`.
3. **`postDataEntries`** (salinan base64 body) diperlakukan sama dengan
   `postData`: dihilangkan secara default.
4. **`session_ended` juga ditulis saat handshake gagal**
   (`reason: "handshake-failed"`), agar file trace selalu lengkap.
5. **`--max-bytes` minimum 4096**, agar cadangan untuk `session_ended`
   selalu tersedia.

## Hubungan dengan `agent --trace` bawaan

Sejak Lightpanda 1.0.1, mode `agent` bawaan punya flag `--trace` yang
mencatat langkah agent. Tracer ini berbeda: sumber datanya event CDP
untuk sesi CDP apa pun, ditambah (di M2/M3) penampil dan ringkasan MCP.
Keduanya saling melengkapi; F5 (iterasi berikutnya) memakai file
`--trace` sebagai korelasi.

## Lisensi

Apache-2.0 — lihat [LICENSE](../LICENSE) di akar repo (salinannya juga
ada di folder ini). Lisensi ini berlaku untuk proses terpisah ini, yang
berkomunikasi hanya lewat CDP terbuka tanpa menautkan kode Lightpanda;
Lightpanda sendiri berlisensi AGPL-3.0. Dokumen perancangan bukan
nasihat hukum; bila tracer menautkan/menyertakan kode Lightpanda,
penilaian lisensi harus diulang.

## Pemecahan masalah

- `handshake gagal pada langkah ...` — periksa `lightpanda serve`
  berjalan di alamat `--cdp`, dan tidak ada proses lain yang memakai
  target yang sama. Jalankan dengan `LP_DEBUG_CDP=1` untuk mencatat
  setiap pesan CDP mentah (method/id) ke stderr.
- Trace kosong selain `session_started`/`session_ended` — tidak ada
  navigasi pada target yang dipakai tracer. Pakai `--navigate` atau
  gerakkan navigasi dari klien lain pada target yang sama.
