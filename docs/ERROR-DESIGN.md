# Desain Error Terbedakan + Retry (tahap setelah live/replay)

Butir roadmap 15:52 WIB 29 Oktober 2026 ("distinguishable errors +
retry"), belum pernah dibuatkan cakupannya. Keadaan awal: semua
kegagalan handshake menjadi `HandshakeError` tanpa kode; koneksi
WebSocket yang tidak dapat dibuka tidak dapat dibedakan dari langkah
Target yang ditolak; tidak ada retry — serve yang baru dinyalakan
sedetik kemudian membuat sesi langsung gagal.

## 1. Kode error

Satu kelas baru `TracerError` (`src/errors.ts`): `{code, message,
details}`. Pesan stderr selalu berbentuk
`lp-tracer: [KODE] pesan`, dan bila sesi sudah punya file, baris
`tracer.session_ended` membawa `data.error = {code, ...details}`.
Kode yang dipakai:

| Kode | Arti | Keluar | Kapan |
|---|---|---|---|
| `E_CDP_UNREACHABLE` | WebSocket tidak dapat dibuka (port mati/timeout) | 1 | Startup; satu-satunya yang di-retry |
| `E_HANDSHAKE` | Langkah Target/enable ditolak setelah terhubung | 1 | Startup; fatal langsung |
| `E_CDP_CLOSED` | Server menutup koneksi di tengah sesi | 0 | Sesi berakhir anggun (perilaku lama dipertahankan) |
| `E_TRACE_LIMIT` | `--max-bytes` tercapai | 0 | Sesi berakhir, file utuh (perilaku lama) |
| `E_RESUME` | Validasi `--append` gagal (sesi beda/ekor rusak) | 1 | Sebelum file disentuh |
| `E_LIVE_PORT` | Server live gagal dibuka | 1 | Sebelum file disentuh |
| `E_REPLAY` | Masukan `--replay` tidak dapat dibaca/tanpa navigasi | 1 | Sebelum sesi replay |
| `E_NAVIGATE` | `Page.navigate` gagal | 0 | Peringatan saja, sesi berlanjut (perilaku lama) |
| (tanpa kode) | Kesalahan pemakaian CLI | 2 | `fail()` seperti sekarang |

Teks pesan yang sudah dijanjikan uji M1 dipertahankan: kegagalan
port mati tetap menyebut kata "handshake" (`handshake gagal pada
langkah endpoint ...`), penolakan attach tetap menyebut
`Target.attachToTarget`. Yang berubah hanyalah penambahan kode dan
`data.error`; tidak ada teks lama yang dihapus.

`E_CDP_CLOSED` dan `E_TRACE_LIMIT` tetap keluar 0: keduanya adalah
akhir sesi yang anggun dan terdokumentasi sejak M1/MS, dan skrip
yang mengandalkan exit 0 tidak boleh rusak. Yang membedakan
sekarang adalah kode di stderr dan di `session_ended`.

## 2. Retry startup

Flag baru: `--retry <n>` (default 0 = perilaku lama, tanpa retry)
dan `--retry-delay-ms <n>` (default 500).

- Hanya fase startup yang di-retry: seluruh urutan koneksi +
  handshake + enable untuk SEMUA endpoint, dari awal, dengan klien
  segar tiap percobaan. Percobaan = 1 + `--retry`.
- Hanya `E_CDP_UNREACHABLE` yang di-retry. Penolakan handshake
  (`E_HANDSHAKE`) bersifat deterministik dan langsung fatal tanpa
  percobaan ulang — retry terhadap penolakan Target hanya membuang
  waktu dan mengaburkan diagnosis.
- Tidak ada retry untuk kegagalan di tengah sesi (`E_CDP_CLOSED`):
  pemulihannya adalah `--append` (resume file), bukan menyambung
  ulang target yang sudah mati bersama koneksinya (fakta probe MS).
- Backoff eksponensial: jeda = min(`--retry-delay-ms` × 2^upaya,
  8000 ms). Setiap percobaan ulang dicatat ke stderr:
  `mencoba lagi (percobaan 2/4) setelah 500 ms.`
- Versi Lightpanda diambil ulang pada tiap percobaan ulang (serve
  yang baru bangun mungkin belum menjawab `/json/version` pada
  percobaan pertama).
- Selama handshake, event tutup koneksi DIABAIKAN (flag
  `handshaking`): penutupan saat handshake adalah bagian dari
  kegagalan handshake itu sendiri, bukan akhir sesi `cdp-closed`.
  Ini juga memperbaiki bahaya lama: sebelumnya tutup-koneksi saat
  handshake bisa mengakhiri sesi dengan exit 0.
- `--retry`/`--retry-delay-ms` diteruskan ke mode `--replay` (yang
  memakai `runTracer` yang sama).

## 3. Yang TIDAK dilakukan

- Retry perintah CDP individual (mis. `Page.navigate` yang timeout)
  — di luar cakupan; navigasi yang gagal tetap peringatan.
- Retry setelah sesi berjalan (reconnect target) — tidak mungkin
  tanpa kehilangan target (probe MS); pemulihannya `--append`.
- Perubahan exit code `E_CDP_CLOSED`/`E_TRACE_LIMIT` (tetap 0).
- Field ringkasan baru di sidecar untuk `session_ended.error`
  (ditunda; bukan penolakan, hanya belum dikerjakan).

## 4. Pengujian

- Server CDP palsu "flaky": N koneksi pertama dihancurkan saat
  upgrade (unreachable), lalu normal → `--retry` cukup = keluar 0;
  `--retry` kurang = keluar 1 + `[E_CDP_UNREACHABLE]` +
  `data.error.code` di `session_ended`.
- Default (`--retry` tidak diberikan) pada port mati: keluar 1,
  satu percobaan, tanpa baris "mencoba lagi".
- Server palsu yang menolak `attachToTarget` + `--retry 3`: keluar
  1 TANPA percobaan ulang, kode `E_HANDSHAKE`.
- Server palsu yang menutup soket 300 ms setelah attach +
  `--retry 3`: sesi berakhir `cdp-closed`, keluar 0, kode
  `E_CDP_CLOSED`, tanpa retry.
- Server palsu yang membanjiri event → limit: `session_ended`
  membawa `E_TRACE_LIMIT`.
- Validasi flag: `--retry -1`, `--retry-delay-ms -5`,
  `--retry abc` → keluar 2.
- Uji live: Lightpanda sungguhan; tracer dijalankan DULU ke port
  yang belum ada, serve dinyalakan 800 ms kemudian,
  `--retry 5 --retry-delay-ms 500` → tracer tersambung dan keluar 0
  (membuktikan kasus nyata: balapan startup serve).
- Uji M1 lama (uji 4) harus tetap hijau tanpa perubahan: teks
  "handshake" dan "Target.attachToTarget" dipertahankan.
- Versi paket tetap 0.1.0; dicatat di CHANGELOG Unreleased.
