# LP-Trace

[![CI](https://github.com/stokforplayy77/LP-Trace/actions/workflows/ci.yml/badge.svg)](https://github.com/stokforplayy77/LP-Trace/actions/workflows/ci.yml)

Lapisan observabilitas dan debugging untuk [Lightpanda Browser](https://github.com/lightpanda-io/browser):
tracer CDP eksternal yang merekam event browser ke file JSONL yang sudah
diredaksi, ditambah penampil trace statis dan sidecar MCP untuk
meringkas dan menganotasi trace tersebut.

> **Proyek independen.** LP-Trace bukan proyek resmi Lightpanda, tidak
> berafiliasi dengan dan tidak didukung oleh tim Lightpanda. "Lightpanda"
> disebut hanya untuk menyatakan kompatibilitas. LP-Trace tidak
> menautkan atau menyertakan kode Lightpanda — ketiga paket di bawah
> berjalan sebagai proses terpisah dan berkomunikasi dengan Lightpanda
> hanya lewat Chrome DevTools Protocol (CDP) yang terbuka. Lightpanda
> sendiri berlisensi AGPL-3.0.

## Isi repo

| Folder | Paket | Isi |
|---|---|---|
| `tracer-mvp/` | `lp-tracer` | Tracer CDP: handshake Target + `sessionId`, rekam event ke JSONL teredaksi, redaksi rahasia default (M1); flag `--agent-trace` mengorelasikan langkah agen dari file `agent --trace` upstream (F5) |
| `viewer/` | `lp-trace-viewer` | Penampil trace statis: timeline, waterfall jaringan, panel konsol, pencarian, ekspor CSV/HAR (M2); kategori `agen` + Panel Agen (F5) |
| `mcp-sidecar/` | `lp-trace-mcp` | Sidecar MCP (stdio) dengan tepat dua tool: `get_trace_summary` dan `annotate_trace` (M3); filter kategori `agent` + agregat langkah agen (F5) |
| `docs/` | — | Dokumen perancangan v1.1 (Markdown + PDF), laporan verifikasi M0/M0b, dan desain F5 (`F5-DESIGN.md`) |

Rancangan lengkap, termasuk keputusan desain, skema JSONL, dan aturan
redaksi, ada di [docs/dokumen-perancangan-v1.1.md](docs/dokumen-perancangan-v1.1.md).

## Status verifikasi (jujur)

- Diverifikasi terhadap Lightpanda **1.0.2** (versi acuan yang dikunci),
  telemetri dimatikan. Handshake Target 6 langkah bersifat wajib; gagal
  `attach` berarti fatal.
- Event terverifikasi: `Page.frameNavigated`, `Network.requestWillBeSent`,
  `Network.responseReceived`, `Network.loadingFinished`,
  `Network.loadingFailed`, `Runtime.consoleAPICalled`,
  `Runtime.exceptionThrown`, `DOM.documentUpdated`.
- Field `timing` CDP bernilai -1 dan ukuran byte 0 — waterfall memakai
  stempel waktu tracer, tanpa breakdown DNS/TLS dan tanpa ukuran byte.
  Domain `Log` bukan sumber data MVP. Level konsol CDP memakai
  `"warning"`, bukan `"warn"`.
- Overhead tracer terukur 1,11% (median 5 ulangan, beban kerja tetap —
  lihat `tracer-mvp/M1-HASIL.md`).
- F5 terverifikasi: format file `agent --trace` diprobe dari run
  sungguhan Lightpanda 1.0.2 (skrip PandaScript, tanpa LLM), dan uji
  live membuktikan langkah agen (goto/extract/evaluate) tercatat
  sebagai baris `agent.*` di antara event CDP. Bentuk baris panggilan
  model belum terverifikasi (tidak ada LLM pada probe) dan ditangani
  sebagai `agent.unknown` tanpa payload. Korelasi pasca-hoc atas file
  trace agen yang sudah selesai bersifat perkiraan (langkah
  mengelompok pada waktu ingest); korelasi waktu yang akurat butuh
  tracer berjalan bersamaan dengan agen.
- Belum diuji / tidak diklaim: Playwright, tampilan penampil di HP
  nyata, pembukaan penampil lewat `file://`, dan integrasi dengan
  aplikasi klien MCP tertentu.

## Cara pakai singkat

Syarat: Node.js 22 atau lebih baru. Binary Lightpanda 1.0.2 diunduh
lewat `tracer-mvp/scripts/download-lightpanda.sh`.

```bash
# 1. Jalankan Lightpanda (telemetri dimatikan)
LIGHTPANDA_DISABLE_TELEMETRY=true lightpanda serve --host 127.0.0.1 --port 9222

# 2. Rekam trace
cd tracer-mvp && npm install && npm run build
node dist/cli.js --cdp ws://127.0.0.1:9222 --output ./trace.jsonl --session "my-agent-run-001"

# 3a. Lihat trace di penampil
cd ../viewer && npm install && npm run build
npx serve build

# 3b. Atau baca lewat sidecar MCP (stdio)
cd ../mcp-sidecar && npm install && npm run build
node dist/cli.js --trace /path/ke/trace.jsonl
```

Korelasi dengan agen bawaan (F5): jalankan tracer dengan
`--agent-trace` menunjuk file yang sama dengan flag `--trace` pada
`lightpanda agent`, selagi agen berjalan:

```bash
# Terminal 1: tracer (tetap berjalan dengan --stay)
node dist/cli.js --cdp ws://127.0.0.1:9222 --output ./trace.jsonl \
  --agent-trace ./agent-trace.jsonl --stay

# Terminal 2: agen (menulis ./agent-trace.jsonl)
LIGHTPANDA_DISABLE_TELEMETRY=true lightpanda agent --task "..." --trace ./agent-trace.jsonl
```

Detail tiap paket, termasuk flag, format JSONL, aturan redaksi, dan
pemecahan masalah, ada di README masing-masing folder.

## Continuous integration

Workflow `.github/workflows/ci.yml` berjalan di tiap push ke `main` dan
tiap pull request: uji tracer (dengan Lightpanda 1.0.2 asli), penampil
(termasuk `svelte-check` dan build), dan sidecar MCP pada Node.js 22 dan
24, dilanjutkan build ketiga image Docker tanpa push.

## Docker

Image di-build dari konteks akar repo. Build lokal:

```bash
docker build -f docker/Dockerfile.tracer -t lp-trace-tracer .
docker build -f docker/Dockerfile.viewer -t lp-trace-viewer .
docker build -f docker/Dockerfile.mcp-sidecar -t lp-trace-mcp .
```

Pakai:

```bash
# Tracer (Lightpanda + tracer dalam satu container)
docker run --rm -v "$PWD/traces:/traces" lp-trace-tracer \
  --output /traces/trace.jsonl --navigate https://example.com

# Penampil
docker run --rm -p 8080:80 lp-trace-viewer
# lalu buka http://localhost:8080

# Sidecar MCP (butuh -i untuk stdin)
docker run --rm -i -v "$PWD:/traces" lp-trace-mcp --trace /traces/trace.jsonl
```

Pada tag `v*`, workflow rilis mem-push image ke GHCR sebagai
`ghcr.io/stokforplayy77/lp-trace-tracer|viewer|mcp-sidecar:<versi>`.
Catatan jujur: image belum pernah diuji build secara lokal (lingkungan
pengembangan tanpa daemon Docker); build pertama yang terverifikasi
berjalan di CI.

## npm

Paket `lp-tracer` dan `lp-trace-mcp` siap diterbitkan (field `private`
dihapus, skrip `prepublishOnly` membangun `dist/` sebelum publish).
Penerbitan dilakukan workflow rilis pada tag `v*` lewat Trusted
Publishing npm (OIDC) — butuh penyiapan satu kali di npmjs.com:
daftarkan repo ini sebagai trusted publisher untuk kedua paket. Cara
manual (butuh login npm + 2FA):

```bash
cd tracer-mvp && npm publish
cd ../mcp-sidecar && npm publish
```

`lp-trace-viewer` sengaja tetap privat: penampil didistribusikan
sebagai situs statis (atau image Docker), bukan paket npm.

## Privasi

Trace diasumsikan sudah diredaksi saat perekaman: header sensitif
(`authorization`, `cookie`, `set-cookie`, `proxy-authorization`,
`x-api-key`) menjadi `[REDACTED]`, parameter URL mirip token disensor,
dan body permintaan tidak direkam secara default. Event CDP mentah
membawa nilai sensitif apa adanya, jadi jangan merekam tanpa tracer ini
atau membagikan file trace mentah. Sidecar MCP hanya mengembalikan
ringkasan agregat — tidak pernah isi trace mentah, teks konsol, URL
lengkap, atau nilai header. Teks anotasi disimpan apa adanya; jangan
isi anotasi dengan rahasia.

## Lisensi

Apache-2.0 — lihat [LICENSE](LICENSE).
Hak cipta © 2026 Ricardo Manurung.
Dokumen perancangan bukan nasihat hukum; bila ada bagian dari proyek
ini menautkan atau menyertakan kode Lightpanda, penilaian lisensi harus
diulang.
