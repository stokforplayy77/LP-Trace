# Hasil Multi-Sesi + Sesi Persisten (MS-DESIGN.md)

Dilaksanakan 29 Oktober 2026, mengikuti desain `docs/MS-DESIGN.md`
yang diputuskan user (cakupan penuh: multi-endpoint + resume).
Seluruh klaim di bawah terverifikasi oleh uji yang dijalankan ulang
langsung oleh asisten, bukan hanya dilaporkan pendelegasian.

## Probe yang mendasari desain

Lima probe CDP terhadap Lightpanda 1.0.2 sungguhan (skrip + hasil di
`tracer-mvp/tests/probe-multisession/`):

1. `createTarget` kedua dari koneksi yang sama gagal
   `-31998 TargetAlreadyLoaded` — satu target per koneksi.
2. Dua koneksi ke SATU endpoint `serve` masing-masing mendapat target
   sendiri, `location.href` berbeda (`/a.html` vs `/b.html`), aliran
   event independen. Label `targetId`/`sessionId` berulang identik —
   pembeda sesi adalah koneksi.
3. Dua proses `serve` (port berbeda) berjalan bersamaan, satu
   pengendali dapat mengendalikan keduanya.
4. Setelah klien putus, `getTargets` kosong dan attach ulang gagal
   `BrowserContextNotLoaded` — tidak ada persistensi target di sisi
   browser.
5. Attach kedua ke target yang sama ditolak (`BrowserContextNotLoaded`)
   — satu target dimiliki eksklusif satu sesi.

Satu kesalahan parsing probe awal (satu level `.result` berlebih pada
`Runtime.evaluate`) ditemukan dan diperbaiki dengan probe ulang yang
membuktikan pemisahan lewat `href` (`probe5-result.json`).

## Yang dibangun

- **Tracer** (`tracer-mvp/src/`): `cdp.ts` tidak berubah (sudah
  per-koneksi); `tracer.ts` mengorkestrasi N `CdpClient` (handshake
  berurutan, gagal pada koneksi mana pun = fatal menyebut endpoint +
  indeks; penutupan koneksi mana pun = `cdp-closed` menyebut
  koneksinya), `writer.ts` mendukung mode append dengan akuntansi
  batas ukuran termasuk isi lama, `cli.ts` menerima `--cdp` berulang
  dan `--append`. Setiap baris membawa `endpoint`/`endpoint_index`
  (baris bukan-CDP: `""`/`-1`). `session_started` membawa
  `data.endpoints`; resume menulis `tracer.session_resumed`.
  Validasi resume (sesi berbeda / ekor rusak) terjadi SEBELUM writer
  dibuka — file tidak tersentuh saat ditolak.
- **Penampil** (`viewer/src/lib/trace.ts`, `+page.svelte`): filter
  endpoint (label `#indeks` hanya bila URL duplikat), lencana endpoint
  di timeline, metadata endpoint + penanda resume, waktu relatif dan
  durasi dari `ts` (fallback `mono_ms`), durasi waterfall negatif
  lintas resume menjadi null, kolom `endpoint`/`endpoint_index` di CSV.
  Trace lama tanpa field endpoint tetap dibaca.
- **Sidecar** (`mcp-sidecar/src/summary.ts`, `annotate.ts`): agregat
  `endpoints` per koneksi + flag `resumed`; durasi dari `ts` dulu
  (fallback `mono_ms`); baris anotasi membawa `endpoint: ""` /
  `endpoint_index: -1` sesuai skema baru.

## Koreksi selama implementasi

- **Aturan `--navigate` direvisi** (desain + kode + bantuan diperbarui):
  aturan pasangan berurutan mematahkan uji M1, karena M1 mengizinkan
  beberapa `--navigate` pada SATU target. Aturan final: satu `--cdp`
  → `--navigate` berurutan pada target yang sama (kompatibel M1);
  beberapa `--cdp` → pasangan berurutan dan jumlah `--navigate` tidak
  boleh melebihi jumlah `--cdp`.
- **Bug penampil** (ditemukan `svelte-check`): helper waterfall memakai
  variabel `row` di luar cakupan — diperbaiki dengan melewatkan baris
  ke helper (`get(id, row)`).
- **Ekspektasi uji yang keliru, bukan bug produk**: uji MS-5 menghitung
  6 baris padahal 7 (lupa `frameNavigated`); ekspektasi CSV lama
  diperbarui ke header baru; ekspektasi `durationSource` fixture
  diubah `mono_ms` → `ts` (nilainya sama, 2433 ms).

## Pengujian (dijalankan ulang, lulus semua)

- Tracer `npm test` (F5 + MS + M1): uji MS **37/37** — server CDP
  palsu yang menerima handshake (URL sama diulang, URL berbeda,
  validasi pasangan navigate, handshake gagal koneksi kedua, resume
  normal/mismatch/ekor-rusak/file-kosong/batas-ukuran, unit
  `readResumeState`) + uji live Lightpanda sungguhan (2 koneksi ke
  satu `serve`, navigasi berpasangan ke halaman berbeda, lalu resume
  `--append` ke file yang sama). Uji M1 **66/66**, overhead benchmark
  **1,4%** (gerbang 5%).
- Penampil: **25/25** (`svelte-check` 0 error/warning, build bersih).
- Sidecar: **17/17** lewat klien MCP SDK sungguhan.

## Batasan yang tetap berlaku

- Persistensi target browser tidak ada (keterbatasan serve 1.0.2);
  resume hanya melanjutkan file trace, target browser selalu baru.
- Satu koneksi yang mati mengakhiri seluruh sesi (fail-fast, terlihat).
- Durasi waterfall yang melintasi batas resume dilaporkan null.
- Redaksi argumen agen F5 tetap hanya kunci tingkat atas (catatan
  `F5-HASIL.md`); tidak diubah tahap ini.
