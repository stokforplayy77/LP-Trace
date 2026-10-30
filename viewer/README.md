# Penampil Trace Lightpanda (M2)

Penampil trace statis untuk file JSONL hasil tracer M1 (`lp-tracer`).
Berjalan sepenuhnya di browser, tanpa backend dan tanpa database, dan
tidak mengirim data ke mana pun. Mengikuti
[Dokumen Perancangan v1.1](../docs/dokumen-perancangan-v1.1.md)
(Bab 3.4, Bab 3.5, Bab 3.6, Bab 4.1 F3, Lampiran A). M2 mencakup **F3
(penampil trace)**. Sidecar MCP (F4, M3) ada di repo ini
(`../mcp-sidecar/`).

## Status verifikasi (jujur)

| Hal | Status |
|---|---|
| Muat `.jsonl` lewat pemilih file; baris rusak dilewati + dihitung | Terverifikasi (uji otomatis + uji asap browser) |
| Timeline relatif detik ke-0, diwarnai per kategori | Terverifikasi (uji asap + screenshot). Waktu relatif dari `ts` absolut sejak MS (benar lintas resume; `mono_ms` reset tiap proses tracer). |
| Waterfall dari stempel waktu tracer (`mono_ms`) | Terverifikasi pada trace nyata M1. Entri yang melintasi batas resume dilaporkan tanpa durasi (bukan negatif). |
| Filter endpoint (multi-endpoint) + lencana endpoint per baris | Terverifikasi (uji logika). Trace lama tanpa field endpoint tetap dibaca. |
| Penanda sesi dilanjutkan (`tracer.session_resumed`) di metadata | Terverifikasi (uji logika). |
| Mode live (SSE dari tracer `--live-port`) | Terverifikasi logika parse (`parseLiveEvent`) + uji live tracer + panel SSE di browser nyata (laptop, 30 Okt 2026, via tunnel + origin localhost: Jeda/Lanjut/Putus deterministik). Baris live menggantikan tampilan file selama tersambung. Sejak 0.1.12 server live menjawab preflight PNA; Chrome 142+ juga memerlukan izin Local Network Access di browser. |
| Breakdown DNS/TLS dan ukuran byte | **Tidak ditampilkan** — datanya kosong dari CDP (timing -1, `encodedDataLength` 0) |
| Panel konsol + filter level (`log`/`warning`/`error`/`exception`) | Terverifikasi; CDP memakai `"warning"`, bukan `"warn"`; sejak 0.1.9 entri `Log.entryAdded` tampil di panel yang sama dengan lencana sumber (mis. `log/network`), dan teks Log tertaut ke baris waterfall lewat `networkRequestId` |
| Pencarian teks (URL + teks konsol) | Terverifikasi |
| Perbandingan dua trace (ringkasan + diff waterfall + diff konsol) | Terverifikasi logika (33 uji) + uji asap browser desktop & lebar 390 px (emulasi). Memakai seluruh baris kedua file; filter tidak diterapkan. Panel lain tetap menampilkan trace A. |
| Ekspor CSV (tampilan terfilter saat ini) | Terverifikasi (logika; unduhan diuji lewat DOM di browser) |
| Ekspor HAR | Subset **best-effort** saja (tanpa breakdown timing, tanpa ukuran), dilabeli demikian di UI |
| Domain `Log` | Bukan sumber MVP; baris `Log.entryAdded` (bila ada) tampil sebagai event biasa |
| Pembukaan lewat `file://` | **Tidak berfungsi** (teruji 30 Okt 2026: modul ES diblokir CORS, halaman kosong) — jalankan lewat server statis lokal |
| Tampilan di HP / perangkat nyata | Dilihat di HP nyata (Android, lewat deploy VPS, 29 Okt 2026): halaman termuat dan terlihat. Pemeriksaan detail (luapan horizontal, unduh CSV) belum dilaporkan; panel live terverifikasi di browser laptop (30 Okt 2026). |

## Syarat

- Node.js 22 atau lebih baru (diuji pada Node v24.22.1).
- Trace `.jsonl` dari tracer M1 (skema Lampiran A), atau `static/sample.jsonl`
  (contoh sintetis M1) lewat tombol "Muat trace contoh".

## Pasang, uji, build

```bash
npm install
npm test        # 25 pemeriksaan logika murni (node:test)
npm run build   # -> folder build/ (ekspor statis)
npm run check   # svelte-check
```

## Jalankan (server statis lokal)

```bash
npx serve build
# atau
cd build && python3 -m http.server
```

Lalu buka alamat yang ditampilkan server, pilih file `.jsonl`, dan
jelajahi Timeline, Waterfall Jaringan, dan Panel Konsol. Tombol ekspor
mengunduh hasil filter tampilan saat ini (CSV utama; HAR subset
best-effort).

## Struktur

- `src/lib/trace.ts` — logika murni: parsing JSONL, kategori (termasuk
  `agen` untuk baris `agent.*` dari F5 dan `Log.entryAdded` di kategori
  konsol sejak 0.1.9), waterfall, filter
  konsol/pencarian/endpoint, Panel Agen (`agentEntries`), CSV, HAR subset.
  Tanpa dependensi framework; diuji langsung oleh `tests/`.
- `src/routes/+page.svelte` — seluruh UI (satu halaman).
- `tests/trace.test.mjs` — uji otomatis logika.
- `tests/fixtures/real-trace.jsonl` — trace NYATA dari tracer M1 +
  Lightpanda 1.0.2 (41 baris, sesi `m2-fixture`, sudah teredaksi oleh
  tracer; dibuat saat pengujian M2, lihat `M2-HASIL.md`).
- `static/sample.jsonl` — contoh sintetis dari M1 (Lampiran A).
- `smoke-*.png` — screenshot uji asap di Chromium headless.

## Catatan implementasi (penyimpangan tercatat)

1. **Konfigurasi SvelteKit 3.** `svelte.config.js` sudah tidak dipakai
   upstream (SvelteKit 3); konfigurasi adapter-static disampaikan lewat
   plugin `sveltekit()` di `vite.config.ts`. Stack tetap SvelteKit +
   adapter-static sesuai Bab 3.4 — hanya lokasi konfigurasinya yang
   berubah mengikuti upstream.
2. **Alias `$lib` dihapus di SvelteKit 3.** Import memakai jalur relatif
   (`../lib/trace`); alias `#lib` tidak ter-resolve pada setup ini.
3. **`tsconfig.json` memakai `extends: "$app/tsconfig"`**, sesuai
   persyaratan SvelteKit 3.
4. **Bentuk payload CDP mentah.** `Network.requestWillBeSent` membawa
   URL/metode di dalam `data.request`, dan `Network.responseReceived`
   membawa status/mimeType di dalam `data.response`. Penampil membaca
   kedua bentuk (langsung dan bersarang) — ditemukan lewat trace nyata
   dan ditutup dengan uji regresi.
5. **Panel Agen (F5).** Baris `agent.*` dari tracer ditampilkan pada
   kategori `agen` dengan panel langkah sendiri (nama tool, latensi,
   penanda error, judul halaman). Sejak tracer 0.1.8, waktu langkah
   dijangkar pada mtime file trace agen (lihat `docs/ANCHOR-DESIGN.md`),
   sehingga file yang sudah selesai sebelum tracer mulai tampil pada
   waktu aslinya; detik ke-0 garis waktu adalah kejadian terawal
   dalam file, bukan baris pertama urutan file.

## Redaksi dan privasi (Bab 3.6)

Penampil tidak pernah mengambil data mentah dari browser dan tidak
melakukan fetch jaringan sendiri (kecuali memuat `sample.jsonl` dari
server yang sama saat tombol contoh ditekan). Trace diasumsikan sudah
diredaksi saat perekaman oleh tracer M1: header sensitif, parameter
token pada URL, dan body tidak ada di dalam file. Catatan ini juga
ditampilkan di UI penampil.

## Lisensi

Apache-2.0 — lihat [LICENSE](../LICENSE) di akar repo (salinannya juga
ada di folder ini). Dokumen perancangan bukan nasihat hukum.
