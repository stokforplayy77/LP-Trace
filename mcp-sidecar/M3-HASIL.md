# Hasil M3 — Sidecar MCP (29 Oktober 2026)

Sidecar MCP dibangun sesuai Dokumen Perancangan v1.1 (F4 + Bab 3.6),
setelah M1 dan M2 dinyatakan LULUS. Pengujian memakai fixture trace
nyata M2 (`viewer/tests/fixtures/real-trace.jsonl`, 41 baris, sesi
`m2-fixture`, Lightpanda 1.0.2) — fixture aslinya tidak diubah (selalu
disalin dulu untuk uji anotasi). Tidak diperlukan trace baru maupun
binary Lightpanda untuk M3; tidak ada unduhan dan tidak ada proses
browser yang dijalankan.

## Yang dibangun

Folder `mcp-sidecar/` (repo mandiri untuk pemakaian pribadi):

- `src/summary.ts` — logika murni: baca JSONL (baris rusak dilewati +
  dihitung), agregasi ringkasan, host/path tanpa query.
- `src/annotate.ts` — append baris `tracer.annotation` (append-only,
  seq berkelanjutan, penulisan diserialkan).
- `src/server.ts` — server MCP: tepat dua tool (`get_trace_summary`,
  `annotate_trace`), tidak ada tool/prompt/resource lain.
- `src/cli.ts` — titik masuk stdio (`--trace` / `LP_TRACE_PATH`,
  `--help`/`--version`, keluar bersih saat SIGINT/SIGTERM; semua log
  ke stderr).
- `tests/mcp.test.mjs` — 12 pemeriksaan otomatis (`npm test`), semua
  lewat klien MCP SDK sungguhan via stdio.
- `README.md`, `package.json`/`tsconfig.json` (TypeScript strict, MCP
  SDK resmi 1.32.2 sebagai satu-satunya dependensi runtime, zod
  sebagai dependensi transitif SDK).

Tidak dibangun (sesuai batas tugas): perubahan apa pun pada dokumen
v1.1 (.md/.pdf), folder `tracer-mvp/`, dan folder `viewer/`; publikasi
npm/Docker; file LICENSE final (keputusan lisensi masih tertunda).

## Hasil uji otomatis (`npm test`) — 12 pemeriksaan, 12 lulus

Jalankan pertama: 11 lulus, 1 gagal — kegagalan itu ekspektasi uji yang
keliru (hitungan kategori `network`), bukan bug kode; diperbaiki
ekspektasinya beserta penjelasan kategori pada deskripsi tool, lalu
jalankan ulang penuh: **12 lulus, 0 gagal**.

| Uji | Hasil |
|---|---|
| `tools/list` tepat 2 tool, nama persis | Lulus |
| Tool tak dikenal ditolak | Lulus |
| `get_trace_summary` atas fixture nyata cocok dengan hitungan independen (41 baris, 2 halaman, 4 permintaan, 3 error, durasi 2433 ms, level log/warning/error 1/1/1, tanpa query/teks konsol/rahasia di output) | Lulus |
| File kosong / tidak ada → ringkasan kosong + penjelasan, bukan error | Lulus |
| Filter kategori (`error` = 3 baris; `network` = 10 baris) + penolakan kategori tak dikenal | Lulus |
| Baris rusak dilewati + dihitung (2 dilewati, 2 baris valid tetap diringkas) | Lulus |
| `annotate_trace` menambah baris seq 42 lalu 43, skema lengkap, file lama utuh byte-per-byte; ringkasan sesi yang sama langsung melihat anotasi | Lulus |
| `annotate_trace` menolak sesi yang tidak cocok; file tetap 41 baris | Lulus |
| `annotate_trace` pada file yang belum ada membuat file (seq 1) | Lulus |
| Ringkasan tidak membocorkan rahasia sintetis (token URL, nilai header, teks konsol) dari fixture berisi rahasia buatan | Lulus |
| CLI tanpa `--trace` → keluar bukan nol + bantuan menyebut `--trace` | Lulus |
| CLI `--help` → keluar nol, menyebut kedua tool | Lulus |

## Contoh output nyata (klien MCP SDK via stdio)

`get_trace_summary` atas salinan fixture nyata:

```json
{
  "empty": false,
  "explanation": null,
  "traceExists": true,
  "session": "m2-fixture",
  "lightpandaVersion": "1.0.2",
  "rows": 41,
  "skippedLines": 0,
  "pages": 2,
  "requests": 4,
  "errors": 3,
  "errorBreakdown": { "exceptions": 2, "failedRequests": 1 },
  "durationMs": 2433,
  "durationSource": "mono_ms",
  "startedAt": "2026-10-29T06:51:31.808Z",
  "endedAt": "2026-10-29T06:51:34.241Z",
  "eventsByType": {
    "tracer.session_started": 1,
    "Page.frameStartedNavigating": 2,
    "Page.frameStartedLoading": 2,
    "Network.requestWillBeSent": 4,
    "Network.responseReceived": 3,
    "Runtime.executionContextsCleared": 3,
    "Page.frameNavigated": 2,
    "Target.targetInfoChanged": 4,
    "Runtime.executionContextCreated": 2,
    "DOM.documentUpdated": 2,
    "Network.loadingFinished": 3,
    "Runtime.consoleAPICalled": 3,
    "Page.domContentEventFired": 2,
    "Page.loadEventFired": 2,
    "Page.frameStoppedLoading": 2,
    "Network.loadingFailed": 1,
    "Runtime.exceptionThrown": 2,
    "tracer.session_ended": 1
  },
  "consoleByLevel": { "log": 1, "warning": 1, "error": 1 },
  "hosts": ["127.0.0.1:8772", "127.0.0.1:9"],
  "paths": ["/echo", "/m2-fetch", "/ok.html", "/throw.html"],
  "annotations": 0,
  "filter": null
}
```

`annotate_trace` atas salinan yang sama mengembalikan konfirmasi
`{"annotated": true, "seq": 42, "session": "m2-fixture",
"lightpandaVersion": "1.0.2", ...}` dan menulis baris:

```json
{"ts":"2026-10-29T06:59:04.283Z","mono_ms":452475,"seq":42,"session":"m2-fixture","lightpanda_version":"1.0.2","type":"tracer.annotation","data":{"text":"Contoh anotasi: navigasi kedua selesai, 2 exception tercatat"}}
```

## Penyimpangan dari spesifikasi (tercatat)

1. Path trace hanya dari CLI/env, bukan dari argumen tool (keputusan
   keamanan; lihat README butir 1).
2. `annotate_trace` pada file yang belum ada membuat file tersebut.
3. `mono_ms` anotasi dihitung dari `ts` baris pertama (lihat README
   butir 3).
4. Deskripsi kategori `network` diperjelas: `Network.loadingFailed`
   dihitung pada kategori `error`, bukan `network`.
5. Tidak ada file LICENSE final (keputusan lisensi tertunda, sama
   seperti M1/M2).

## Yang tidak diklaim

Integrasi dengan aplikasi klien MCP tertentu (hanya klien SDK lewat
stdio yang diuji), Playwright, timing/DNS/TLS/ukuran byte, dan domain
`Log` sebagai sumber MVP.

## Perintah pengulangan

```bash
cd mcp-sidecar
npm install && npm test   # build + 12 uji lewat klien MCP sungguhan
node dist/cli.js --trace /path/ke/trace.jsonl   # server MCP stdio
```

## Kesiapan M4

M3 menutup MVP sesuai Bab 6 (M1 tracer + M2 penampil + M3 sidecar).
Tersisa M4 (dokumentasi dan rilis) yang berada di luar tugas ini:
README gabungan, rilis npm, dan image Docker — semuanya membutuhkan
keputusan lisensi final dan keputusan publikasi dari user.
