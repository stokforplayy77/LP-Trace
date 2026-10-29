# Hasil M0b — Verifikasi Ulang pada Lightpanda 1.0.2 (29 Okt 2026, 13:02 WIB)

Diuji langsung di sandbox Linux x86_64 dengan binary rilis `1.0.2`
(terverifikasi `./lightpanda version` → `1.0.2`; binary dihapus setelah uji,
seperti M0). Telemetri dimatikan (`LIGHTPANDA_DISABLE_TELEMETRY=true`).
Server uji lokal `m0b-server.mjs` menyajikan halaman yang melempar exception
saat dimuat; target uji TIDAK lagi `example.com` dan TIDAK lagi throw lewat
`Runtime.evaluate`.

Perintah ulang:

```bash
./lightpanda serve --host 127.0.0.1 --port 9223
node m0b-server.mjs            # http://127.0.0.1:8765
node m0b-probe.mjs --cdp ws://127.0.0.1:9223 --base http://127.0.0.1:8765
```

## Verdict: M0b LULUS — semua gerbang Bab 6 dokumen v1.1 terpenuhi

| Uji (Bab 6) | Hasil |
|---|---|
| Matriks diulang pada 1.0.2 | Lulus — handshake + 4 enable OK, sama seperti M0 |
| Exception pada halaman yang dimuat | Lulus — `Runtime.exceptionThrown` 2 event |
| Attach target kedua + berdampingan Puppeteer | Lulus — halaman terpisah, tidak saling membajak |
| Pemetaan level konsol | Lulus — `log` 2, `warning` 1, `error` 1 |
| `Network.loadingFailed` (URL sengaja gagal) | Lulus — 1 event, `errorText: CouldntConnect` |
| `Log.entryAdded` | Lulus — 1 event (sebelumnya 0 pada M0) |

## Matriks klien A (m0b-result.json)

`Page.frameNavigated` 1, `Network.requestWillBeSent` 2,
`Network.responseReceived` 1, `Network.loadingFinished` 1,
`Network.loadingFailed` 1, `Runtime.consoleAPICalled` 4,
`Runtime.exceptionThrown` 2, `Log.entryAdded` 1.

Penjelasan angka network: 2 request = dokumen `/throw.html` (200) +
`fetch` ke port tertutup (gagal). Konsol: `log` 2 = `M0B-LOG` + log
pasca-Puppeteer; `warning` 1 dan `error` 1 sesuai `console.warn/error`
halaman. Perhatian: CDP memakai type `"warning"`, bukan `"warn"` —
skrip probe awal sempat salah menilai ini; sudah diperbaiki dan uji
diulang.

## Exception — yang gagal dibuktikan M0 kini terbukti

Halaman `/throw.html` berisi throw uncaught saat load dan
`Promise.reject` tanpa handler. Keduanya tercatat: 2 event
`exceptionThrown`; sampel pertama `text: "Uncaught"`,
`description: "Error: M0B-UNCAUGHT-LOAD"`. Log server Lightpanda pada
run yang sama mencatat keduanya (`uncaught exception` dan
`unhandled rejection`, scope `page_error`). Pemetaan 1:1 event kedua
ke rejection tidak dibuktikan per-sampel di JSONL (skrip hanya
menyimpan sampel pertama per jenis event) — yang dibuktikan adalah
jumlah 2 event untuk 2 pemicu tersebut. Kategori error pada T1
dokumen v1.1 kini boleh dihitung tercapai untuk exception halaman
yang tidak tertangkap.

## Log — juga terbukti pada 1.0.2

`Log.entryAdded` 1, sampel: `source: network, level: error`,
`text: "Failed to load resource: net::ERR_CONNECTION_REFUSED"`,
`url: http://127.0.0.1:9/m0b-fetch`. Sesuai changelog 1.0.2
(`Log.entryAdded` untuk resource yang gagal dimuat). Untuk MVP tetap
disarankan mengandalkan `Runtime.consoleAPICalled` + `exceptionThrown`
sebagai sumber utama; `Log` adalah pelengkap, bukan pengganti.

## Timing — tetap -1 pada 1.0.2

`response.timing` seluruh field -1 (kecuali `pushStart/pushEnd: 0`)
dan `encodedDataLength: 0`, persis seperti M0 pada nightly. Keputusan
dokumen v1.1 BERDIRI: waterfall dibangun dari stempel waktu tracer,
breakdown DNS/TLS tidak dijanjikan.

## Koeksistensi — dua lapis bukti

1. **CDP mentah + CDP mentah** (`m0b-probe.mjs`): klien B attach
   penuh ke targetnya sendiri, bernavigasi ke `/ok.html`, sementara
   klien A tetap di `/throw.html` dan tetap menerima event
   (konsol A 3 → 4 setelah B tersambung). Label `targetId`
   (`FID-0000000001`) dan `sessionId` (`SID-1`) SAMA di kedua
   koneksi — itu label per koneksi, bukan bukti berbagi halaman;
   bukti pemisahan adalah `location.href` yang berbeda.
2. **Puppeteer + CDP mentah** (`m0b-puppeteer.mjs`,
   `m0b-puppeteer.json`, puppeteer-core 25.16.0): `puppeteer.connect`
   ke endpoint yang sama, `newPage`, `goto /ok.html`, `title`
   `"M0B OK"`, sementara klien mentah tetap menerima event dan
   lokasinya tetap `/throw.html`. Halaman terpisah, tidak ada
   pembajakan target. Playwright tidak diuji — klaim hanya untuk
   Puppeteer (dan klien CDP mentah).

## Yang TIDAK diuji M0b

- Playwright (hanya Puppeteer + klien mentah).
- Overhead performa <5% (benchmark Bab 3.7 — gerbang M1, bukan M0b).
- `agent --trace` bawaan vs tracer (diferensiasi dokumen, bukan uji).
- Perilaku pada beban paralel / sesi panjang.

## File bukti

- `m0b-probe.mjs` — probe M0b tanpa dependensi (Node 24).
- `m0b-server.mjs` — server uji lokal (halaman throw + ok).
- `m0b-puppeteer.mjs` — uji koeksistensi Puppeteer (butuh
  `puppeteer-core`; diuji dengan 25.16.0, diinstal sementara di /tmp
  dan tidak disimpan di workspace).
- `m0b-result.json` — matriks + handshake + verdict lengkap.
- `m0b-puppeteer.json` — hasil uji Puppeteer.
- `m0b-events.jsonl` — sampel event (dipotong 500 karakter).

## Konsekuensi untuk dokumen v1.1

M0b adalah gerbang Bab 6: karena lulus, M1 boleh dimulai dan
repositori resmi boleh dibuat. Dokumen v1.1 sendiri belum diubah —
penanda "M0b lulus" dan pembaruan status event (`exceptionThrown`,
`Log.entryAdded`) menjadi bagian dari kickoff M1, atas keputusan user.

## Adendum: verifikasi independen (29 Okt 2026, 13:26–13:27 WIB)

Seluruh rangkaian M0b diulang dari nol dengan unduhan baru binary
`lightpanda-x86_64-linux` 1.0.2 (76.408.136 byte, aset rilis
`1.0.2`): `./lightpanda version` → `1.0.2`,
`/json/version` → `"Lightpanda-Version": "1.0.2"`. Hasilnya
mereproduksi berkas di atas: matriks klien A identik kecuali stempel
waktu, klien B / koeksistensi / verdict identik, dan uji Puppeteer
(puppeteer-core 25.16.0, diinstal sementara di /tmp) identik
(console 3 → 4, judul `"M0B OK"`, halaman terpisah). Binary
dihapus dan proses serve/server dihentikan setelah verifikasi.

Dua celah spesifikasi tugas yang belum tercakup pada run pertama
ditutup pada verifikasi ini:

- **Matriks diulang pada `https://example.com`** (bukan hanya halaman
  lokal): `Page.frameNavigated` 1, `Network.requestWillBeSent` 2,
  `Network.responseReceived` 2, `Network.loadingFinished` 2,
  `Network.loadingFailed` 0, `Runtime.consoleAPICalled` 2,
  `Runtime.exceptionThrown` 0, `Log.entryAdded` 0,
  `DOM.documentUpdated` 1 — persis sama dengan M0.
  Bukti: `m0b-example-repeat-result.json`.
- **Navigasi ke port tertutup secara harfiah**
  (`Page.navigate` ke `http://127.0.0.1:9/`): `Network.loadingFailed`
  1, `errorText: CouldntConnect` (juga tercermin pada respons
  `Page.navigate` itu sendiri); `Page.frameNavigated` 0 dan
  `Log.entryAdded` 0 pada jalur kegagalan navigasi tingkat atas ini
  (berbeda dengan kegagalan sub-resource pada halaman, yang
  menghasilkan 1 `Log.entryAdded`). Bukti:
  `m0b-closed-port-result.json`.

Vonis gerbang tidak berubah: **M0b LULUS**.
