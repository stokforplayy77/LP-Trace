# Desain Multi-Sesi + Sesi Persisten (tahap setelah F5)

Keputusan desain berdasarkan LIMA probe CDP terhadap Lightpanda 1.0.2
sungguhan (skrip + hasil mentah di
`tracer-mvp/tests/probe-multisession/`). Pilihan cakupan "desain penuh
(multi-endpoint + resume)" diputuskan user 29 Oktober 2026.

## 1. Fakta probe (terverifikasi)

1. **Satu target per koneksi WebSocket.** `Target.createTarget` kedua
   dari koneksi yang SAMA gagal `-31998 TargetAlreadyLoaded`
   (probe1). Batasnya per koneksi, bukan per proses: koneksi kedua ke
   endpoint yang sama BERHASIL membuat target sendiri (probe5).
2. **Dua koneksi ke satu endpoint serve = dua sesi terpisah.**
   Masing-masing `createTarget` + `attachToTarget` berhasil,
   `location.href` berbeda (`/a.html` vs `/b.html`), aliran event
   independen (probe5, diperbaiki dari kesalahan parsing probe2).
   Label `targetId` (`FID-0000000001`) dan `sessionId` (`SID-1`)
   BERULANG identik di tiap koneksi — label per koneksi, BUKAN
   pembeda sesi. Pembeda sesi adalah KONEKSI (endpoint + urutan).
3. **Dua proses `serve` (port berbeda) juga berjalan bersamaan** dan
   dapat dikendalikan satu pengendali (probe2).
4. **Tidak ada persistensi di sisi browser.** Setelah klien CDP putus,
   `Target.getTargets` kosong dan attach ulang ke target lama gagal
   `BrowserContextNotLoaded` (probe2). Target hidup selama koneksinya;
   tracer yang putus tidak bisa melanjutkan target browser yang sama.
5. **Attach kedua ke target yang sama DITOLAK** (`BrowserContextNotLoaded`,
   probe4). Satu target dimiliki eksklusif oleh satu sesi attach.
   Konsekuensi: selama tracer ter-attach, tidak ada klien lain yang
   bisa menggerakkan target itu; navigasi uji harus digerakkan tracer
   sendiri atau oleh koneksi lain dengan targetnya sendiri.
6. Bentuk mentah `Runtime.evaluate` dan `Page.frameNavigated`
   terverifikasi (probe3): respons evaluate =
   `{result:{result:{type,value}}}`, frame membawa `frame.url`.

## 2. Model sesi

- **Satu sesi tracer = satu file trace**, dengan SATU pengenal `session`
  untuk seluruh file (korelasi lintas koneksi).
- **Satu koneksi CDP = satu "endpoint"** (satu kemunculan flag `--cdp`).
  Mengulang URL yang sama berarti N koneksi ke proses serve yang sama
  (N target). URL berbeda berarti proses serve berbeda. Keduanya
  diperlakukan sama oleh tracer.
- Setiap baris trace membawa pembeda koneksi (lihat §3). `seq` global
  tunggal (urutan kedatangan, dari 1, tanpa lompat) dan satu jam
  `mono_ms` proses tracer untuk semua koneksi — korelasi antar-koneksi
  memakai sumbu waktu yang sama.

## 3. Skema baris

Dua field tingkat atas DITAMBAHKAN pada semua baris (Lampiran A v1.1
diperluas; parser lama mengabaikan field yang tak dikenal):

| Field | Arti |
|---|---|
| `endpoint` | URL CDP koneksi asal baris; string kosong (`""`) untuk baris bukan-CDP (`tracer.*`, `agent.*`) |
| `endpoint_index` | Nomor urut koneksi (0, 1, 2, …); `-1` untuk baris bukan-CDP |

`session_started` membawa `data.cdp` (endpoint pertama, kompatibilitas)
DAN `data.endpoints` (daftar URL semua koneksi, duplikat dipertahankan,
urutan = indeks). `lightpanda_version` per baris diambil dari endpoint
asalnya; `session_started` memakai versi endpoint pertama.

## 4. Tracer

### 4.1 Flag

- `--cdp <url>` dapat DIULANG; tiap kemunculan = satu koneksi.
  Satu `--cdp` = perilaku M1 persis (plus field baru).
- `--navigate <url>` dipasangkan BERURUTAN dengan `--cdp`: navigasi
  ke-i untuk koneksi ke-i, dan jumlahnya tidak boleh melebihi jumlah
  `--cdp` (fatal bila berlebih). PENGECUALIAN: dengan SATU `--cdp`,
  `--navigate` boleh diulang untuk navigasi berurutan pada target yang
  sama (perilaku M1 dipertahankan). `--wait-ms`/`--stay` berlaku seperti M1.
- `--append`: lanjutkan file trace yang ada (lihat §5). Tanpa flag
  ini, perilaku lama dipertahankan (file ditimpa).

### 4.2 Aturan kegagalan (konsisten dengan Bab 3.3)

- Handshake gagal pada koneksi MANA PUN = fatal untuk seluruh sesi,
  pesan menyebut endpoint + indeks yang gagal.
- Koneksi CDP mana pun ditutup server = sesi diakhiri anggun
  (`reason: "cdp-closed"`, `data.endpoint` menyebut koneksi yang
  menutup). Tidak ada mode "bertahan dengan sisa koneksi" di v1 ini:
  trace parsial yang diam-diam kehilangan satu sisi lebih berbahaya
  daripada sesi yang berakhir terlihat.
- Batas ukuran (`--max-bytes`) berlaku untuk TOTAL file (semua
  koneksi berbagi satu writer + satu batas).

### 4.3 Urutan start

1. Buka writer (mode timpa/append), tentukan sesi + seq awal (§5).
2. Tulis `session_started` (atau `session_resumed` bila resume).
3. Mulai tailer `--agent-trace` bila diminta (F5, tidak berubah).
4. Handshake SEMUA koneksi berurutan (koneksi 0, 1, …). Event mulai
   dicatat setelah handshake koneksi itu selesai; event antar-koneksi
   ditulis sesuai urutan kedatangan.
5. Navigasi berpasangan, lalu mode pasif sampai sinyal / penutupan /
   batas ukuran.

## 5. Resume (`--append`) — persistensi sisi tracer

Karena browser tidak menyediakan persistensi (§1 butir 4), yang
persisten adalah FILE TRACE:

- File dibuka mode append (tidak ditimpa). Izin tetap ditegakkan 0600.
  Akuntansi batas ukuran menghitung isi lama (ukuran awal = ukuran
  file yang ada).
- Bila file ada dan tidak kosong: baca baris valid TERAKHIR. Sesi =
  `--session` bila diberikan, HARUS SAMA dengan sesi baris terakhir
  (beda = fatal); bila `--session` tidak diberikan, sesi diambil dari
  baris terakhir. `seq` berlanjut dari `seq` baris terakhir + 1.
  Baris pertama sesi baru ini adalah `tracer.session_resumed`
  (`data`: `previousRows`, `resumedFromSeq`, `output`) — BUKAN
  `session_started`.
- Bila file ada tapi KOSONG: mulai segar seperti tanpa `--append`
  (`session_started`, seq dari 1).
- Bila baris terakhir tidak dapat di-parse sebagai baris trace valid:
  fatal — jangan menempel ke ekor yang rusak.
- `mono_ms` selalu mulai dari 0 tiap proses tracer (jam proses baru).
  `ts` absolut tetap benar lintas proses. Penampil memakai `ts` untuk
  waktu relatif (lihat §6), sehingga batas resume tidak menghasilkan
  waktu negatif.
- `session_ended` dari sesi sebelumnya TETAP di dalam file, di tengah
  (sebelum baris-baris sesi lanjutan). Ini disengaja dan dinyatakan:
  file resume memuat beberapa penanda sesi; `session` yang sama
  mengikatnya. Penampil menandai batas resume; ringkasan menghitung
  seluruh baris.

## 6. Penampil

- `TraceRow` mendapat `endpoint`/`endpoint_index` (opsional — trace
  lama tanpa field ini tetap dibaca, dianggap endpoint `""`/`-1`).
- Filter endpoint: chips "Semua" + satu per koneksi, label = URL
  (dengan `#indeks` bila URL berduplikat). Timeline menampilkan lencana
  endpoint. Waterfall membawa label endpoint per entri.
- Waktu relatif dihitung dari `ts` (selisih milidetik terhadap baris
  pertama), fallback ke `mono_ms` bila `ts` tak ter-parse. Durasi
  waterfall dihitung dari `mono_ms` per entri dan dijepit ke >= 0
  (entri yang melintasi batas resume tidak boleh negatif).
- Metadata sesi menampilkan daftar endpoint + catatan "sesi
  dilanjutkan" bila ada baris `session_resumed`.
- CSV mendapat kolom `endpoint` dan `endpoint_index`. HAR tidak
  berubah (subset best-effort, entri dari semua endpoint digabung).

## 7. Ringkasan MCP

- `TraceSummary` mendapat `endpoints: [{ endpoint, endpoint_index,
  label, rows, requests, errors }]` (agregat per koneksi; kunci =
  pasangan endpoint+indeks) dan `resumed: boolean` (ada baris
  `session_resumed`).
- Agregat global (`hosts`, `paths`, `requests`, `errors`, `durationMs`)
  tidak berubah artinya (seluruh file). `durationMs` dari `ts`
  pertama–terakhir (konsisten dengan penampil).
- `annotate_trace` tidak berubah (pemeriksaan sesi memakai sesi file;
  file resume berbagi satu sesi, sehingga tetap valid).

## 8. Yang TIDAK dilakukan

- Persistensi target browser lintas proses (tidak didukung serve 1.0.2).
- Berbagi satu target antar-klien (ditolak upstream, probe4).
- Mode bertahan-dengan-sisa-koneksi saat satu endpoint mati (§4.2).
- Navigasi per-endpoint lewat flag terpisah selain pasangan berurutan
  (§4.1) — pasangan berurutan sudah mencakup kebutuhan uji.

## 9. Pengujian

- Uji unit (tanpa binary): server CDP palsu minimal yang MENERIMA
  handshake (menjawab `/json/version` + WS: discover/getTargets/
  createTarget/attach/enable + memancarkan satu event per sesi) —
  dua/lebih koneksi ke URL sama dan berbeda, penandaan endpoint/indeks,
  pasangan `--navigate`, fatal saat handshake satu koneksi gagal,
  fatal saat `--navigate` berlebih. Resume: append ke file berisi,
  seq bersambung, adopsi sesi, tolak sesi berbeda, tolak ekor rusak,
  file kosong = mulai segar, akuntansi batas ukuran termasuk isi lama.
- Uji live: 2 proses serve nyata + 1 tracer 2 koneksi + navigasi
  berpasangan ke halaman berbeda → baris kedua endpoint hadir dengan
  label benar, sesi konsisten, seq berurutan; lalu jalankan tracer
  kedua dengan `--append` ke file yang sama → `session_resumed`,
  seq bersambung, sesi sama.
- Uji penampil: filter endpoint, label duplikat, waktu relatif dari
  `ts`, CSV kolom baru, kompatibilitas trace lama.
- Uji sidecar: agregat `endpoints`, flag `resumed`, trace lama tanpa
  field endpoint.
- Versi paket tetap 0.1.0 (belum ada rilis npm); dicatat di CHANGELOG
  bagian Unreleased.
