# lp-trace-mcp — Sidecar MCP untuk Trace Lightpanda (M3)

Sidecar MCP yang mengekspos **tepat dua tool** untuk file trace JSONL yang
ditulis tracer M1 (`lp-tracer`) dan dibaca penampil M2, sesuai Dokumen
Perancangan v1.1 (Bab 4.1 F4). Sidecar membaca file JSONL yang sama —
tidak ada format kedua, tidak ada akses ke browser, tidak ada pemanggilan
CDP, tidak ada akses jaringan.

## Tool

### `get_trace_summary`

Mengembalikan **ringkasan agregat saja**: jumlah halaman, jumlah
permintaan, jumlah error, total durasi, hitungan per kategori event,
hitungan per level konsol, nama host, dan path tanpa query, ditambah
field `agent` (F5): `{ present, toolCalls, errors, tools, modelCalls,
tokens, unknownLines }` — agregat langkah agen saja, tanpa argumen,
hasil, atau URL lengkap — ditambah field `endpoints` (MS): agregat per
koneksi CDP `{ endpoint, endpoint_index, label, rows, requests, errors }`,
flag `resumed` (true bila file memuat `tracer.session_resumed`), dan
field `sessionError` (ROBUST): `{ code, message }` dari
`tracer.session_ended` terakhir, atau `null` bila sesi berakhir bersih,
ditambah field `log` (domain Log): `{ present, entries, byLevel,
sources }` — agregat entri `Log.entryAdded` per level/sumber mentah
CDP; entri Log error TIDAK menambah hitungan error (kegagalan yang
sama dengan `Network.loadingFailed` yang sudah dihitung).

`get_trace_summary` membaca ulang file trace pada setiap pemanggilan,
sehingga ringkasannya sudah mengikuti file yang sedang ditulis tracer
(mode live / sesi `--append`) tanpa perubahan kode. `annotate_trace`
menulis di bawah lockfile antar-proses (`<trace>.lock`, O_EXCL):
panggilan bersamaan dari proses berbeda diserialkan sehingga `seq`
tidak bentrok antar anotasi. Residu: tracer yang sedang merekam
dapat men-flush baris dengan `seq` yang ditetapkan sebelum anotasi
membaca file, sehingga `seq` duplikat dengan baris tracer masih
mungkin dalam jendela satu interval flush — penampil menoleransinya
(kunci daftar memakai `seq` + indeks) dan ringkasan tidak bergantung
pada keunikan `seq`. Lihat `docs/LOCK-DESIGN.md`.

Argumen:

| Argumen | Wajib | Keterangan |
|---|---|---|
| `category` | Tidak | Filter kategori: `navigation`, `network`, `console`, `error`, `tracer`, `agent`, `other`. Bila tidak diisi, seluruh file diringkas. Filter berdasarkan isi (teks/URL) tidak didukung dan ditolak. |

Kategori `error` mencakup `Runtime.exceptionThrown` dan
`Network.loadingFailed` (yang terakhir ini dihitung di kategori error,
bukan `network`). Kategori `console` mencakup
`Runtime.consoleAPICalled` dan `Log.entryAdded` (domain Log, sejak
0.1.9). Kategori `agent` mencakup baris `agent.*` dari file
trace `agent --trace` upstream yang dikorelasikan tracer (F5). Level
konsol dihitung sebagaimana diterima CDP, dengan `"warn"` dinormalisasi
menjadi `"warning"`.

Bila file trace belum ada atau kosong, tool mengembalikan ringkasan
kosong dengan penjelasan, **bukan** error.

Yang **tidak pernah** dikembalikan: isi trace mentah, teks konsol, URL
lengkap beserta parameter query, nilai header, dan body. Durasi dihitung
dari selisih `ts` tracer (fallback `mono_ms`; Bab 3.2 Keputusan 4);
tidak ada klaim breakdown DNS/TLS atau ukuran byte.

### `annotate_trace`

Menambahkan **satu baris** ke file JSONL dengan `type:
"tracer.annotation"` dan field skema lengkap (`ts`, `mono_ms`, `seq`
berkelanjutan dari baris terakhir + 1, `session`,
`lightpanda_version`, `data` berisi teks anotasi). Penulisan bersifat
append-only: isi file yang sudah ada tidak pernah diubah. Mengembalikan
konfirmasi berisi `seq` baris yang ditulis. Penulisan diserialkan
dengan lockfile antar-proses: bila kunci tidak didapat dalam 5 detik
(kunci segar dipegang proses lain), tool gagal rapi dengan pesan yang
menyebut jalur kunci; kunci basi (lebih tua dari 10 detik, pemegang
crash) dicuri otomatis.

Argumen:

| Argumen | Wajib | Keterangan |
|---|---|---|
| `text` | Ya | Teks anotasi, disimpan apa adanya. |
| `session` | Tidak | Pengenal sesi yang diharapkan. Bila diisi dan berbeda dengan sesi pada file trace, anotasi ditolak agar tidak menandai file yang salah. |

> **Perhatian (Bab 3.6 butir 5):** teks anotasi disimpan apa adanya,
> tanpa sensor dan tanpa pemotongan. Jangan isi anotasi dengan rahasia
> (token, kata sandi, kunci API, isi header). Sidecar tidak berjanji
> anotasi bebas rahasia — tanggung jawab isi ada pada pemanggil.

## Menjalankan

```bash
npm install
npm run build
node dist/cli.js --trace /path/ke/trace.jsonl
```

Path file trace dapat juga diisi lewat variabel lingkungan `LP_TRACE_PATH`
bila flag `--trace` tidak diberikan. Bila keduanya tidak ada, server
keluar dengan pesan bantuan (ke stderr, agar stdout tetap bersih untuk
protokol MCP). Transport yang dipakai adalah **stdio**; semua log
ditulis ke stderr.

`--help` dan `--version` tersedia. SIGINT/SIGTERM ditangani dengan keluar
bersih.

Sidecar juga tersedia sebagai image Docker `lp-trace-mcp` (lihat
`docker/Dockerfile.mcp-sidecar` di akar repo; konteks build = akar
repo). Jalankan dengan `-i` agar stdin MCP tetap terhubung:

```bash
docker build -f docker/Dockerfile.mcp-sidecar -t lp-trace-mcp .
docker run --rm -i -v "$PWD:/traces" lp-trace-mcp --trace /traces/trace.jsonl
```

## Contoh konfigurasi klien (stdio)

```json
{
  "mcpServers": {
    "lp-trace": {
      "command": "node",
      "args": ["<path-ke-mcp-sidecar>/dist/cli.js", "--trace", "<path-ke-trace>/trace.jsonl"]
    }
  }
}
```

Konfigurasi di atas adalah contoh bentuk umum untuk klien MCP berbasis
stdio. Pengujian otomatis memakai klien SDK sungguhan lewat stdio (lihat
`tests/mcp.test.mjs`); integrasi dengan aplikasi klien tertentu (mis.
Claude Desktop) **tidak diuji** dan tidak diklaim.

## Batas privasi yang jujur

- Ringkasan hanya membaca file JSONL yang sudah diredaksi saat perekaman
  (Bab 3.6). Bila file trace berisi rahasia mentah (mis. direkam tanpa
  redaksi), ringkasan tetap tidak menampilkannya — tetapi file itu
  sendiri tetap mengandung rahasia dan harus ditangani sebagai berkas
  sensitif.
- Host dan path ditampilkan tanpa query. Segmen path yang mengandung
  rahasia secara harfiah tidak dapat dibedakan dari path biasa; jangan
  merekam URL semacam itu.
- Sidecar tidak pernah menulis apa pun ke file trace kecuali baris
  anotasi lewat `annotate_trace`, dan tidak pernah membaca ulang data
  dari browser.

## Lisensi

Apache-2.0 — lihat [LICENSE](../LICENSE) di akar repo (salinannya juga
ada di folder ini). Lisensi ini untuk proses terpisah yang hanya
berkomunikasi lewat CDP terbuka. Dokumen perancangan bukan nasihat
hukum.

## Perbedaan dari spesifikasi (tercatat)

1. Path file trace hanya berasal dari flag CLI `--trace` atau variabel
   lingkungan `LP_TRACE_PATH`, bukan dari argumen tool. Ini keputusan
   keamanan yang disengaja: argumen tool tidak boleh mengarahkan sidecar
   membaca/menulis file sembarang.
2. `annotate_trace` pada file yang belum ada akan membuat file tersebut
   (seq 1, sesi dari argumen atau `"unknown"`, versi `"unknown"`).
3. `mono_ms` baris anotasi dihitung dari selisih waktu saat ini dengan
   `ts` baris pertama (dibatasi bawah oleh `mono_ms` terakhir), agar
   tetap monotonik terhadap sesi yang sama.
4. Versi MCP SDK yang terpasang: 1.32.2 (rentang pada `package.json`:
   `^1.24.0`).
