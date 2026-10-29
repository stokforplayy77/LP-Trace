# Desain F5 — Korelasi trace `agent --trace` (Bab 7.3 v1.1)

Dokumen ini mencatat hasil probe format trace bawaan Lightpanda dan
keputusan desain F5. Format di bawah ini DIVERIFIKASI dari run sungguhan
Lightpanda 1.0.2 (bukan dari dokumentasi saja). Bukti mentah: dua file
trace di `tracer-mvp/tests/fixtures/agent-trace-*.jsonl`.

## 1. Hasil probe (29 Oktober 2026)

Perintah yang dijalankan (tanpa LLM, tanpa API key):

```text
lightpanda agent probe.js --trace agent-trace.jsonl
lightpanda agent probe2.js --trace agent-trace2.jsonl --trace-results
```

`probe.js` memakai primitif PandaScript (`new Page()`, `page.goto`,
`page.extract`, `page.evaluate`) terhadap server lokal 127.0.0.1:8765.
`probe2.js` membuka halaman 404 lalu `extract` yang gagal, untuk
memverifikasi bentuk error dan field `result` dari `--trace-results`.

### 1.1 Bentuk baris (satu JSON per baris, tanpa spasi berlebih)

Baris pembuka sesi:

```json
{"type":"run","t":0,"provider":"none","model":""}
```

Satu baris per tool call:

```json
{"type":"tool","t":9,"step":1,"name":"goto","ms":4,"result_bytes":6,"error":false,"navigated":true,"page":{"url":"http://127.0.0.1:8765/ok.html","httpStatus":200,"title":"F5 OK"}}
{"type":"tool","t":10,"step":2,"name":"extract","args":{"schema":"{\"title\":\"title\",\"heading\":\"h1\"}"},"ms":0,"result_bytes":38,"error":false,"navigated":false,"page":{"url":"http://127.0.0.1:8765/ok.html","httpStatus":200,"title":"F5 OK"}}
{"type":"tool","t":11,"step":3,"name":"evaluate","args":{"script":"document.title"},"ms":1,"result_bytes":5,"error":false,"navigated":false,"page":{"url":"http://127.0.0.1:8765/ok.html","httpStatus":200,"title":"F5 OK"}}
```

Baris penutup sesi:

```json
{"type":"end","t":11,"model_calls":0,"tool_calls":3,"tokens":{"input":0,"cached":0,"cache_creation":0,"output":0}}
```

### 1.2 Fakta terverifikasi

- `t` adalah milidetik relatif sejak sesi agen dimulai (0 pada baris
  `run`). TIDAK ADA stempel waktu absolut, TIDAK ADA pengenal sesi,
  dan TIDAK ADA pengenal korelasi ke event CDP di dalam file ini.
- `step` mulai dari 1 dan naik per tool call. `ms` adalah latensi
  langkah itu. `result_bytes` adalah ukuran hasil dalam byte.
- `args` HANYA ada pada sebagian tool (extract, evaluate). Baris
  `goto` TIDAK membawa `args`; URL-nya ada di `page.url`.
- `page` selalu membawa `url`, `httpStatus`, dan `title` (string kosong
  bila halaman tidak punya judul, mis. respons 404 tanpa judul).
- `error` boolean. Kasus error terverifikasi: `extract` gagal
  (`error:true`) dengan `result` berisi teks exception + stack, dan
  `goto` ke halaman 404 tetap `error:false`, `navigated:true`,
  `result:"loaded"`, `httpStatus:404`.
- `--trace-results` menambahkan field `result` (string) pada baris
  tool. TANPA flag itu, field `result` TIDAK ADA. `result_bytes`
  selalu ada pada kedua mode.
- Baris panggilan model (`model call` menurut teks `--help`: latensi
  dan token input/cached/output) TIDAK terverifikasi: probe berjalan
  tanpa LLM (tidak ada API key di lingkungan probe, tidak ada server
  LLM lokal). Bentuk pastinya TIDAK BOLEH diasumsikan; importer harus
  menoleransi tipe baris yang belum dikenal.

## 2. Keputusan desain

### 2.1 Mekanisme: tail file, stempel waktu tracer

Tracer mendapat flag baru `--agent-trace <path>`. Selama sesi tracer
berjalan, sebuah tailer membaca file trace agen baris demi baris dan
menulis tiap baris sebagai baris JSONL trace (skema Lampiran A) dengan
`ts`/`mono_ms` dari WAKTU BACA tracer. Korelasi dengan event CDP
terjadi lewat sumbu waktu tracer yang sama.

Konsekuensi yang dinyatakan jujur:

- Korelasi akurat bila tracer berjalan BERSAMAAN dengan agen (tail
  langsung: selisih waktu baca vs waktu kejadian hanya jeda polling).
- Bila file trace agen sudah selesai sebelum tracer membaca
  (korelasi pasca-hoc), langkah-langkah agen mengelompok pada waktu
  ingest, BUKAN pada waktu kejadian aslinya. Urutan langkah tetap
  benar, penempatan absolutnya perkiraan. Perbaikan jangkar
  (mtime file) dicatat sebagai pekerjaan lanjutan, bukan bagian F5.
- `agent_t` (nilai `t` upstream) selalu dipertahankan di `data`,
  sehingga urutan dan jarak relatif antar langkah agen tetap dapat
  dihitung dari file trace itu sendiri.

### 2.2 Skema baris trace

Namespace baru `agent.*` (di samping `tracer.*` dan method CDP):

| `type` | Sumber | `data` |
|---|---|---|
| `agent.tool` | baris `type:"tool"` | `step`, `name`, `ms`, `agent_t`, `error`, `navigated`, `result_bytes`, `page` (`url` teredaksi, `httpStatus`, `title` dipotong), `args` (lihat §2.3), `result` (hanya dengan `--include-bodies`) |
| `agent.run` | baris `type:"run"` | `provider`, `model` |
| `agent.end` | baris `type:"end"` | `model_calls`, `tool_calls`, `tokens` |
| `agent.unknown` | tipe lain apa pun | `agent_type`, `agent_t` saja (TANPA payload) |
| `tracer.agent_attached` | tailer mulai | `path` |
| `tracer.agent_reset` | file menyusut (ditulis ulang agen baru) | `path` |

`session` pada semua baris agen adalah sesi tracer, sama seperti baris
CDP, sehingga satu file trace memuat kedua sisi dalam satu sesi.

### 2.3 Redaksi (Bab 3.6 berlaku penuh)

- `page.url`: `redactUrl` yang sama (parameter mirip token disensor).
  `page.title`: dipotong 200 karakter.
- `args`: kunci dipertahankan; tiap nilai string disensor URL-nya dan
  dipotong 500 karakter (aturan argumen konsol). Nilai pada kunci yang
  namanya mirip rahasia (`token`, `key`, `secret`, `password`,
  `auth`) diganti `[REDACTED]` utuh — pada KEDALAMAN BERAPA PUN
  (objek dan array bersarang) dan untuk TIPE NILAI APA PUN. Nilai
  non-string yang bukan kunci mirip rahasia melewati `redactValue`
  yang sama dengan event CDP (header sensitif, URL, postData).
  Struktur lebih dalam dari 32 tingkat disensor utuh sebagai tindakan
  pengamanan terhadap sarang buatan yang ekstrem. (Perilaku awal F5
  hanya menyensor kunci tingkat atas yang bernilai string; celah
  rahasia bersarang itu diperbaiki pada 0.1.5, lihat
  `docs/REDACT-HASIL.md`.)
- `result`: TIDAK PERNAH ditulis kecuali `--include-bodies` aktif.
  Bila ditulis, dipotong 2000 karakter dan disensor URL-nya. Ini
  sejajar dengan default upstream (`--trace-results` mati) dan
  default tracer (body tidak direkam).
- Baris `agent.unknown` tidak membawa payload apa pun, sehingga teks
  prompt / panggilan model yang bentuknya belum terverifikasi tidak
  pernah bocor ke file trace.
- `tokens` pada `agent.end` hanya angka, dipertahankan apa adanya.

### 2.4 Perilaku tailer

- File boleh BELUM ADA saat tracer mulai (agen belum menulisnya):
  tailer menunggu, sesi tracer TIDAK gagal.
- Hanya baris yang diakhiri `\n` yang di-parse; sisa parsial di-buffer
  (dibatasi 64 KiB; bila terlampaui tanpa newline, dibuang dan
  dihitung sebagai baris dilewati).
- File menyusut (agen baru menimpa file yang sama): offset di-reset ke
  0 dan ditulis `tracer.agent_reset`. Ini satu-satunya cara tailer
  menangani penimpaan, karena upstream menimpa file (`--trace`
  overwrites PATH).
- Baris rusak (bukan JSON / bukan objek / tanpa `type` string):
  dilewati dan dihitung. Jumlahnya dilaporkan di `session_ended`.
- Saat shutdown, sisa buffer yang masih ter-parse sebagai JSON
  diproses sebagai baris terakhir; selebihnya dibuang dan dihitung.
- Polling tiap 250 ms, seirama dengan flush writer. Tailer berhenti
  saat sesi berakhir dan tidak pernah menahan shutdown.

### 2.5 Penampil

- Kategori baru `agen` untuk semua tipe `agent.*`. Timeline memakai
  sumbu `mono_ms` yang sama, sehingga langkah agen tampil berdampingan
  dengan event CDP.
- Panel Agen: daftar langkah (`step`, nama tool, `ms`, penanda error,
  judul halaman). Pencarian full-text mencakup nama tool.
- Ekspor CSV memakai ringkasan yang sama; HAR tidak berubah (hanya
  subset network).

### 2.6 Ringkasan MCP

- `get_trace_summary` mendapat kategori filter baru `agent` dan field
  `agent`: `{ present, toolCalls, errors, tools, modelCalls, tokens }`
  (hanya agregat; tanpa argumen, hasil, atau URL lengkap). URL halaman
  pada baris agen menyumbang host/path seperti baris CDP (tanpa query).
- `annotate_trace` tidak berubah.

## 3. Yang TIDAK dilakukan F5

- Jangkar mtime untuk korelasi pasca-hoc yang presisi.
- Menjalankan agen dari dalam tracer (agen tetap proses terpisah yang
  dijalankan pengguna; tracer hanya membaca file-nya).
- Bentuk baris panggilan model: belum terverifikasi, ditangani sebagai
  `agent.unknown` sampai ada probe dengan LLM sungguhan.
- Perubahan skema Lampiran A selain penambahan namespace `agent.*`
  dan field statistik agen di `session_ended`.

## 4. Pengujian

- Uji unit tailer (tanpa binary): baca bulk, append antar polling,
  reset saat file menyusut, baris rusak, file belum ada, redaksi
  argumen/hasil, dan gating `--include-bodies`. Fixture memakai DUA
  file trace NYATA hasil probe (§1).
- Uji live: tracer + `serve` + run skrip agen bersamaan; file trace
  hasil harus memuat baris `agent.tool` terurut di antara event CDP.
- Uji penampil: kategori, ringkasan, panel Agen, CSV.
- Uji sidecar: agregat `agent`, filter `agent`, dan tidak ada
  kebocoran (nilai argumen rahasia dan URL lengkap tidak muncul).
- Versi paket tetap 0.1.0 (belum ada rilis npm); F5 dicatat di
  CHANGELOG bagian Unreleased. Kenaikan versi dilakukan saat rilis.
