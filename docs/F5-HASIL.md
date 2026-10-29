# F5 — Hasil: korelasi `agent --trace` (29 Oktober 2026)

F5 mengorelasikan file trace `agent --trace` bawaan Lightpanda ke dalam
file trace lp-tracer. Desain + bukti probe format: `F5-DESIGN.md`
di folder ini.

## Yang dibangun

- `tracer-mvp/src/agent-trace.ts` (baru): `AgentTraceTailer` (polling
  250 ms, file boleh belum ada, reset saat file menyusut, baris parsial
  di-buffer maks 64 KiB) + `convertAgentLine` (baris `tool`/`run`/`end`
  → `agent.tool`/`agent.run`/`agent.end`, tipe lain → `agent.unknown`
  tanpa payload) + `redactAgentArgs` (aturan Bab 3.6 untuk argumen).
- `tracer-mvp/src/cli.ts` + `src/tracer.ts`: flag `--agent-trace
  <file>`; tailer mulai setelah `session_started`; statistik agen
  (`agentLines`, `agentSkipped`, `agentResets`) dibawa di
  `tracer.session_ended`.
- `tracer-mvp/src/redact.ts`: `truncateString` dan `isTokenLikeParam`
  diekspor untuk dipakai ulang (tanpa perubahan perilaku).
- `viewer/src/lib/trace.ts` + `src/routes/+page.svelte`: kategori
  `agen`, ringkasan baris agen, `agentEntries()`, Panel Agen, pencarian
  mencakup nama tool + judul halaman.
- `mcp-sidecar/src/summary.ts` + `src/server.ts`: kategori filter
  `agent`, field agregat `agent` pada ringkasan, URL halaman agen
  menyumbang host/path (tanpa query).

## Pengujian (dijalankan ulang oleh asisten, 29 Okt 2026)

| Paket | Hasil |
|---|---|
| tracer-mvp | `npm test` (LP_BIN = binary 1.0.2): uji unit F5 14/14 + uji M1 66/66, 0 gagal. Uji 8 live (13 pemeriksaan): tracer `--stay --agent-trace` + run skrip PandaScript (`goto`/`extract`/`evaluate`) bersamaan → `tracer.agent_attached`, 3 `agent.tool` step 1–3 berurutan, `session_ended` membawa `agentLines >= 3`, seq berurutan, tanpa field `result` tanpa `--include-bodies`. Benchmark: overhead 0,57% (gerbang 5%). |
| viewer | `npm test` 19/19 (14 lama + 5 F5); `svelte-check` 0 error/warning; build sukses. |
| mcp-sidecar | `npm test` 15/15 (12 lama + 3 F5) lewat klien MCP SDK sungguhan, setelah perbaikan satu baris: `CATEGORY_DESCRIPTIONS` di `server.ts` belum punya kunci `agent` (TS2741) — ditemukan saat build pertama, diperbaiki, lalu seluruh uji lulus. |

## Penyimpangan / batasan tercatat

- Bentuk baris panggilan model upstream belum terverifikasi (probe
  tanpa LLM); ditangani sebagai `agent.unknown` tanpa payload.
- Korelasi pasca-hoc (file agen sudah selesai sebelum dibaca) bersifat
  perkiraan: langkah mengelompok pada waktu ingest. Korelasi waktu
  yang akurat butuh tracer berjalan bersamaan dengan agen.
- `redactAgentArgs` menerapkan sensor kunci mirip rahasia hanya pada
  kunci tingkat atas; nilai non-string melewati `redactValue` sesuai
  desain §2.3 (kunci mirip rahasia yang bersarang di dalam objek
  argumen tidak diganti `[REDACTED]`).
- Versi paket tetap 0.1.0 (belum ada rilis npm); F5 dicatat di
  CHANGELOG bagian Unreleased.
