# Desain Live Mode + Record/Replay (tahap setelah MS)

Kelompok roadmap 15:29 WIB 29 Oktober 2026 butir (5), belum pernah
dibuatkan cakupannya. Dokumen ini mengunci cakupannya sebelum
implementasi. Fakta dasar yang dipakai sudah terverifikasi tahap
sebelumnya (M1/MS): tracer menulis baris JSONL teredaksi per event,
`Page.frameNavigated` membawa `frame.url`, dan satu koneksi CDP
memiliki satu target eksklusif.

## 1. Live mode — SSE dari tracer (dipilih)

Alternatif yang dipertimbangkan dan DITOLAK: penampil membaca ulang
file trace secara berkala. Objek `File` dari `<input type="file">`
adalah snapshot saat dipilih — membaca ulang tidak melihat baris yang
ditambahkan setelahnya. File System Access API (`showOpenFilePicker` +
`getFile()` berulang) bisa, tetapi hanya Chromium dan butuh izin
pengguna. SSE dari tracer bekerja di browser apa pun, tanpa izin,
tracer sudah memegang baris teredaksi, dan endpoint yang sama bisa
dipakai klien SSE lain (curl, skrip).

### 1.1 Tracer: `--live-port <n>`

- Opt-in; tanpa flag ini tidak ada server sama sekali. Bind HANYA
  `127.0.0.1` (tidak terekspos ke jaringan; alat lokal).
- Server dimulai SEBELUM writer dibuka: port sudah dipakai
  (`EADDRINUSE`) = fatal, keluar 1, file trace tidak disentuh.
- Endpoint:
  - `GET /events` — SSE (`Content-Type: text/event-stream`,
    `Cache-Control: no-cache`). Saat koneksi dibuka, kirim
    `event: hello` + `data: {"session","endpoints"}`. Setiap baris
    yang berhasil ditulis tracer dikirim sebagai `data: <JSON baris>`
    (objek baris yang sama, sudah teredaksi). Komentar heartbeat
    `: ping` tiap 15 detik agar proksi/idle tidak memutus.
    Header CORS `Access-Control-Allow-Origin: *` (alat lokal,
    loopback saja).
  - `GET /health` — JSON `{status:"ok", session, rowsWritten,
    endpoints, uptimeMs}`.
  - Path lain → 404. `OPTIONS` → 204 dengan header CORS.
- Semantik siar: baris disiarkan SETELAH `writer.write` berhasil
  (urutan sama dengan file). Klien lambat tidak menghambat tracer
  (tulis ke socket bersifat async); tidak ada batas antrean per
  klien di v1 — klien lokal, operator yang memutus klien macet.
  Saat sesi berakhir: `session_ended` disiarkan, lalu respons SSE
  diakhiri dan server ditutup.
- `--live-port` dapat digabung dengan `--append`, `--agent-trace`,
  dan `--replay` (baris replay juga disiarkan langsung).

### 1.2 Penampil: panel Mode Live

- Bagian "Mode live": input URL (default
  `http://127.0.0.1:9229/events`), tombol Sambung/Putus, Jeda/Lanjut
  (jeda = pesan diabaikan, koneksi tetap hidup), status + jumlah
  baris diterima + baris rusak dilewati.
- Saat tersambung, baris live MENGGANTIKAN baris file (mode beralih);
  kembali ke mode file mengembalikan trace file yang dimuat.
  Seluruh tampilan turunan (Timeline, Waterfall, Konsol, Panel Agen,
  pencarian, filter, ekspor CSV/HAR) bekerja di atas baris live yang
  sama tanpa perubahan logika — hanya sumber barisnya yang berbeda.
- Baris SSE di-parse dengan `parseTraceLine` yang sama; baris rusak
  dilewati dan dihitung. Tidak ada auto-scroll di v1.
- Helper murni `parseLiveEvent(data: string)` di `trace.ts` (parse +
  null bila rusak) agar logika ini teruji tanpa DOM.

### 1.3 Sidecar: tanpa perubahan kode

`get_trace_summary` membaca ulang file tiap pemanggilan, sehingga
secara inheren sudah melihat file yang sedang tumbuh. Tidak ada
perubahan; README mencatatnya. Batasan yang didokumentasikan (tetap):
`annotate_trace` membaca file lalu menulis di akhir — bila tracer
menulis di antara baca dan tulis anotasi, dua baris bisa berbagi `seq`
yang sama. Penampil mentoleransinya (urutan file yang dipakai, bukan
`seq`). Mengunci tidak dikerjakan di tahap ini.

## 2. Record/replay — re-drive + perbandingan

### 2.1 Bukan apa

- BUKAN replay respons jaringan (tidak ada intersepsi Fetch yang
  terverifikasi di Lightpanda; tidak ada pemutaran ulang body).
- BUKAN replay interaksi (klik/isi form tidak direkam tracer).
- BUKAN perbandingan waktu (sumbu `mono_ms`/`ts` tidak sebanding
  antar-run). Yang dibandingkan: bentuk jaringan per langkah
  (jumlah request + himpunan host).

### 2.2 Cara kerja

Flag mode pada `lp-tracer`: `--replay <trace.jsonl>`.

1. Baca file trace masukan, ekstrak langkah navigasi
   (`extractReplaySteps`): `Page.frameNavigated` berurutan →
   `data.frame.url` (fallback `data.url`); buang `about:blank`;
   gabungkan URL identik yang BERURUTAN (reload tidak dibedakan di
   v1). Langkah kosong = fatal, keluar 1.
2. Jalankan ulang langkah-langkah itu lewat `runTracer` yang sama
   (`--navigate` = daftar langkah, `--wait-ms` berlaku). Sesi baru =
   `--session` bila diberikan, atau `replay-<sesi asli>`.
   Membutuhkan tepat SATU `--cdp`; menolak `--navigate` dan
   `--agent-trace` (keluar 2, konflik pemakaian). `--append` dan
   `--live-port` diizinkan.
3. Baca kembali trace hasil replay, kelompokkan
   `Network.requestWillBeSent` per jendela langkah (jendela i = baris
   setelah `frameNavigated` ke-i sampai sebelum `frameNavigated`
   berikutnya, pada masing-masing file), hitung jumlah request dan
   himpunan host per jendela. Host saja (tanpa path/query), konsisten
   dengan privasi ringkasan.
4. Laporan JSON: `{original:{path,session,steps,requests},
   replay:{path,session,requests}, steps:[{index,url,
   originalRequests,replayRequests,originalHosts,replayHosts,
   match}], match, notes}`. `match` = semua langkah jumlah request
   sama DAN himpunan host sama. Laporan ditulis ke stdout (JSON);
   ringkasan manusiawi ke stderr. Flag `--replay-report <file>`
   menulis JSON yang sama ke file.
5. `notes` selalu menyatakan kejujuran batasnya: konten live berubah,
   ketidakcocokan belum tentu regresi; replay adalah alat bantu
   regresi, bukan bukti determinisme.

## 3. Yang TIDAK dilakukan

- Server HTTP lain di tracer selain SSE/health loopback (tidak ada
  endpoint kontrol, tidak ada penulisan dari jaringan).
- Auto-scroll / grafik live di penampil.
- Replay interaksi, replay respons, perbandingan timing.
- Penguncian file untuk `annotate_trace` bersamaan dengan tracer.

## 4. Pengujian

- Uji unit: ekstraksi langkah (duplikat berurutan, `about:blank`,
  fallback `data.url`, file kosong → fatal); `parseLiveEvent`.
- Uji tracer (server CDP palsu): SSE menerima `hello` +
  `session_started` + event + `session_ended`, header CORS hadir,
  `/health` menjawab; port dipakai → keluar 1 tanpa file; replay
  terhadap server palsu deterministik → `match: true`; replay
  terhadap server dengan jumlah event berbeda → `match: false`.
- Uji live: Lightpanda sungguhan + server HTTP lokal 2 halaman:
  SSE menerima baris selama sesi; replay trace 2 halaman → laporan
  `match: true` (konten lokal deterministik).
- Uji penampil: `parseLiveEvent` + filter/CSV di atas baris live
  (logika murni; panel SSE diuji manual lewat smoke browser bila
  sempat, tidak diklaim bila tidak).
- Versi paket tetap 0.1.0 (belum ada rilis npm); dicatat di CHANGELOG
  bagian Unreleased.
