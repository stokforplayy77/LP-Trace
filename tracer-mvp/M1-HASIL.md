# Hasil M1 — Tracer MVP (29 Oktober 2026)

Tracer MVP dibangun sesuai Dokumen Perancangan v1.1 (F1 + F2), setelah
M0b dinyatakan LULUS. Pengujian dilakukan terhadap Lightpanda **1.0.2**
sungguhan (rilis GitHub `lightpanda-io/browser` tag `1.0.2`, aset
`lightpanda-x86_64-linux`, 76.408.136 byte, `./lightpanda version` →
`1.0.2`), Node v24.22.1, Linux x86_64, telemetri dimatikan
(`LIGHTPANDA_DISABLE_TELEMETRY=true`). Binary dihapus setelah pengujian;
semua proses serve/server dihentikan setelah pengujian.

## Yang dibangun

Folder `tracer-mvp/` (repo mandiri untuk pemakaian pribadi):

- `src/cli.ts` — CLI `lp-tracer` (flag wajib/opsional, validasi, `--help`/`--version`).
- `src/cdp.ts` — klien CDP WebSocket native + handshake Target Bab 3.3
  (kegagalan `attach` fatal, pesan menyebut langkah yang gagal).
- `src/tracer.ts` — orkestrasi: periksa `/json/version`, tulis
  `session_started`/`session_ended`, rekam event, tutup anggun saat
  SIGINT/SIGTERM, mode navigasi (`--navigate`) dan mode pasif.
- `src/redact.ts` — redaksi Bab 3.6 (header, parameter URL, body,
  pemotongan konsol, hapus `timing`).
- `src/writer.ts` — penulis JSONL buffered asinkron, izin 0600, batas
  ukuran dengan cadangan untuk `session_ended`.
- `tests/run-m1-tests.mjs` — rangkaian uji end-to-end (`npm test`).
- `tests/benchmark.mjs` + `tests/bench-driver.mjs` — benchmark Bab 3.7
  (`npm run bench`).
- `scripts/download-lightpanda.sh` — pengunduh binary 1.0.2 terverifikasi.
- `README.md`, `trace-example.jsonl` (contoh sintetis Lampiran A),
  `benchmark-result.json` (angka benchmark), `package.json`/`tsconfig.json`
  (TypeScript strict, nol dependensi runtime).

Tidak dibangun (sesuai batas tugas): penampil M2, sidecar MCP M3,
publikasi npm/Docker. Dokumen v1.1 (.md/.pdf) dan berkas bukti M0/M0b
tidak diubah.

## Hasil uji otomatis (`npm test`) — 53 pemeriksaan, 53 lulus

Jalankan pertama: 49 lulus, 2 gagal. Kedua kegagalan itu nyata dan
diperbaiki sebelum vonis akhir (lihat "Perbaikan selama M1" di bawah).
Jalankan ulang penuh: **53 lulus, 0 gagal**.

| Uji | Hasil |
|---|---|
| Build `tsc` strict bersih | Lulus |
| 1. Handshake + skema JSONL (seq dari 1 tanpa lompat, field lengkap, `session_started` pertama, `session_ended` terakhir, session konsisten, versi 1.0.2, `mono_ms` tidak menurun, domain Log tidak dipakai, izin 0600) | 10/10 lulus |
| 2. Event inti (`frameNavigated` ≥ 2, `requestWillBeSent` ≥ 2, `exceptionThrown` berisi `M1-UNCAUGHT-LOAD`, konsol `log`/`warning`/`error`, `loadingFailed` `CouldntConnect`) | 8/8 lulus |
| 3. Redaksi (4 nilai rahasia tidak mentah, `[REDACTED]` header, `token=REDACTED` + `api_key=REDACTED` pada URL, nama header tetap ada, `q=hello` utuh, `[BODY-OMITTED]`, argumen konsol ≤ 500 & total ≤ 2000, `getResponseBody` tidak pernah dipanggil) | 14/14 lulus |
| 4. Kegagalan handshake (port mati → bukan nol + pesan menyebut handshake; server CDP palsu menolak `attach` → bukan nol + pesan menyebut `Target.attachToTarget`) | 4/4 lulus |
| 5. SIGINT (`session_started` tertulis, keluar 0, `session_ended` tertulis, seq utuh tanpa baris terpotong) | 4/4 lulus |
| 7. Batas ukuran (`--max-bytes 4096`: ukuran ≤ batas, pesan batas tampil, `session_ended` tetap tertulis, seq utuh) | 4/4 lulus |
| 6. Benchmark berjalan dan angkanya tercatat | 6/6 lulus |

## Benchmark overhead (Bab 3.7) — LULUS

Beban kerja tetap: 4 navigasi lokal (`ok`, `throw`, `multi`, `ok`),
jeda 1200 ms, 5 ulangan tiap sisi, serve yang sama per sisi, telemetri
mati di kedua sisi.

| Sisi | Waktu per ulangan (ms) | Median |
|---|---|---|
| Tanpa tracer | 4946, 4924, 4951, 4971, 5179 | **4951 ms** |
| Dengan tracer | 5058, 5536, 5006, 4954, 4978 | **5006 ms** |
| **Overhead** | | **1,11% (gerbang 5%)** |

CPU tracer (utime+stime, terpisah dari proses Lightpanda): 0,15–0,23
detik per ulangan (median 0,17 detik). Ukuran trace per ulangan:
28.887 byte. Satu ulangan tracer tercatat 5.536 ms (pencilan); median
tidak terpengaruh. Tidak ada mitigasi lanjutan yang diperlukan dan
tidak ada manipulasi beban kerja. Angka lengkap: `benchmark-result.json`.

**Vonis gerbang M1: LULUS.** M2 boleh dimulai (atas keputusan user).

## Temuan terverifikasi selama M1

1. **Event CDP mentah membawa rahasia.** Probe hitungan langsung pada
   file mentah membuktikan Lightpanda 1.0.2 mengirim nilai sensitif apa
   adanya: header `Authorization`, parameter `token`/`api_key` pada URL,
   `postData` beserta salinan base64-nya (`postDataEntries`). Redaksi
   tracer bersifat esensial, bukan formalitas.
2. **`<img>` ke host mati tidak selalu menghasilkan `loadingFailed`.**
   Pada uji asap, gambar ke port tertutup tidak pernah di-fetch
   (Lightpanda tidak me-render). `loadingFailed` yang deterministik
   diperoleh dari `fetch()` halaman ke port tertutup — pola yang dipakai
   uji M1 dan benchmark.
3. **CDP memakai `"warning"`, bukan `"warn"`.** Sudah dicatat di M0b;
   tracer menyimpan `type` apa adanya.

## Perbaikan selama M1 (bug yang ditemukan dan diperbaiki)

1. **Bug penulis: flush menimpa awal file.** `FileHandle.write(chunk, 0,
   "utf8")` menafsirkan angka kedua sebagai *posisi file*, sehingga
   setiap flush menimpa dari byte 0 (file terkorupsi: 15 baris dengan
   `seq` sampai 24). Diperbaiki memakai `appendFile`. Ditemukan lewat
   uji asap; tidak ada di build akhir.
2. **Penanda URL ter-enkode.** `[REDACTED]` sebagai nilai parameter URL
   menjadi `%5BREDACTED%5D`. Diubah menjadi `REDACTED` tanpa kurung
   siku untuk parameter URL; penanda header tetap `[REDACTED]`.
3. **Pemeriksaan `getResponseBody` terlalu kasar.** Uji awal mencari
   substring di seluruh sumber dan gagal karena penyebutan di komentar.
   Diperbaiki menjadi pencarian pola pemanggilan sungguhan
   (`"Network.getResponseBody"` atau `getResponseBody(`/); kode tidak
   pernah memanggilnya.
4. **Dua error strict TypeScript** pada build pertama (indeks regex yang
   mungkin `undefined`); diperbaiki, build akhir bersih.

## Penyimpangan dari spesifikasi (tercatat)

1. Flag `--navigate`/`--stay`/`--wait-ms` ditambahkan (Bab 4.1 tidak
   menyediakan cara menggerakkan navigasi; langkah 6 Bab 3.3 menyebut
   `Page.navigate`). Tanpa flag, tracer pasif sesuai F1.
2. Penanda parameter URL `REDACTED` tanpa kurung siku (lihat di atas).
3. `postDataEntries` (base64 body) diperlakukan sama dengan `postData`.
4. `session_ended` juga ditulis saat handshake gagal
   (`reason: "handshake-failed"`).
5. `--max-bytes` minimum 4096 (cadangan untuk `session_ended`).
6. Uji kegagalan `attach` memakai server CDP palsu (WebSocket minimal),
   karena tidak ada padanan perilaku itu pada browser sungguhan.

## Yang tidak diklaim

Playwright, timing/DNS/TLS/ukuran byte, `Log.entryAdded` sebagai sumber
MVP, koeksistensi ulang di M1 (terbukti di M0b saja), dan overhead pada
beban selain yang diukur di atas.

## Perintah pengulangan

```bash
# 1. Unduh + verifikasi binary (lalu hapus setelah uji)
./scripts/download-lightpanda.sh        # -> vendor/lightpanda, version 1.0.2
# 2. Jalankan serve
LIGHTPANDA_DISABLE_TELEMETRY=true ./vendor/lightpanda serve --host 127.0.0.1 --port 9222
# 3. Build + uji (butuh binary lewat LP_BIN/PATH)
npm install && npm run build
LP_BIN=./vendor/lightpanda npm test
# 4. Pakai tracer
node dist/cli.js --cdp ws://127.0.0.1:9222 --output ./trace.jsonl --session "my-agent-run-001"
# 5. Bersihkan binary setelah uji
rm -f ./vendor/lightpanda
```
