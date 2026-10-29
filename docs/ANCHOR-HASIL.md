# Hasil: penjangkaran mtime korelasi agen (0.1.8)

Tanggal: 30 Oktober 2026. Desain: `docs/ANCHOR-DESIGN.md`.
Pilihan user: "Korelasi agen (jangkar mtime)" — pekerjaan lanjutan
F5 yang dinyatakan tertunda di `docs/F5-DESIGN.md` §2.

## Masalah

Baris `agent.*` dicap waktu baca tracer. File agen yang sudah
selesai sebelum tracer mulai (post-hoc) menumpuk pada waktu
ingest: `agent_t` relatif benar, `ts`-nya salah bermenit-menit.

## Yang dibangun

- `tracer-mvp/src/agent-trace.ts`: fungsi murni
  `anchorBatchTimes` (jangkar = `min(mtime, waktu baca)`;
  penyebaran mundur dari baris terakhir batch; `t` menurun →
  seluruh batch fallback; `t` hilang/negatif → null per baris);
  `AgentTraceRow` membawa `agentT` mentah (terpisah dari
  `data.agent_t` yang tetap fallback 0) dan `tsMs` berjangkar;
  tailer menjangkar tiap batch dari snapshot `stat()` yang
  sama dengan pemeriksaan ukuran; penanda attached/reset dan
  sisa buffer `stop()` tetap waktu baca.
- `tracer-mvp/src/tracer.ts`: `writeRow` menerima override
  waktu opsional; `mono_ms` baris berjangkar = `ts -
  startWallMs`, dibatasi bawah 0. Jalur baris non-agen tidak
  berubah.
- `viewer/src/lib/trace.ts`: `relativeSeconds`/`durationMs`
  memakai `ts` terawal–terakhir (min/maks), fallback
  `mono_ms` min/maks. Teks Panel Agen diperbarui.
- `mcp-sidecar/src/summary.ts`: `durationMs`/`startedAt`/
  `endedAt` memakai rentang min/maks yang sama; identitas
  sesi/versi tetap dari baris pertama/terakhir urutan file.

## Uji (semua hijau)

- Tracer: robust 23, version 4, F5 24 (17 lama + 7 baru:
  3 unit `anchorBatchTimes`, 1 `agentT`, 3 tailer), MS 37,
  live 31, error 25, survive 28, M1 74 (66 lama + 8 cek
  uji 9: file agen lama dengan mtime dimundurkan 60 detik
  direkam serve asli — `ts` agen ≈ mtime + t − 5100,
  mendahului `session_started`, `mono_ms` ≥ 0).
  Benchmark overhead 0,91% (batas 5%).
- Penampil: 28/28 (1 baru: waktu relatif min/maks),
  `svelte-check` bersih, build bersih.
- Sidecar: 26/26 (1 baru: durasi/startedAt/endedAt
  min/maks), via klien MCP sungguhan.

## Koreksi selama pengerjaan (bukan bug produk)

- `anchorBatchTimes` awalnya tidak menyaring `t` negatif
  sendiri (hanya mengandalkan penyaring di `convertAgentLine`);
  diperkeras agar fungsi murni menegakkan kontraknya.
- Ekspektasi uji tailer memakai `data.agent_t` untuk baris
  `run` (tidak ada field itu di data `run`); diperbaiki
  memakai `agentT` baris.
- Ekspektasi uji 9 awalnya `mtime + t` padahal rumus yang
  benar `mtime + t − t_terakhir` (baris terakhir batch pada
  mtime); implementasi sudah benar, ekspektasi diperbaiki.

## Batas yang tersisa

- `t` diasumsikan waktu emisi baris; bila upstream memakai
  waktu mulai langkah, galat ≤ durasi langkah. Bentuk baris
  panggilan model tetap tidak terverifikasi.
- Galat penjangkaran ≤ satu interval polling + penundaan
  flush penulis upstream pada baris terakhir batch.
- File agen yang dipakai ulang dua sesi tanpa ditimpa dalam
  satu batch memakai waktu baca (fallback).
- Sisa buffer `stop()` tidak dijangkar.
