# Desain penangkapan domain Log (pelengkap konsol)

Tanggal: 30 Oktober 2026. Cakupan: `tracer-mvp` (enable domain),
penampil (kategori konsol + tautan waterfall), sidecar (agregat
log). Domain Log tidak dipakai pada MVP; M0b membuktikan satu
entri untuk sub-resource yang gagal dimuat.

## 1. Bukti probe (30 Oktober 2026, Lightpanda 1.0.2)

Probe `tracer-mvp/tests/probe-log/` (serve + halaman
`console.*` + fetch ke port tertutup + throw + reject):

- `Log.entryAdded` = 1, HANYA untuk fetch yang gagal:
  `entry = {source: "network", level: "error", text: "Failed to
  load resource: net::ERR_CONNECTION_REFUSED", timestamp:
  1793325895443, url: "http://127.0.0.1:9/log-fetch",
  networkRequestId: "REQ-0000000002"}`.
- TIDAK ADA duplikasi: 5 `consoleAPICalled`
  (log/warning/error/debug/info) dan 2 `exceptionThrown`
  tidak menghasilkan satu pun entri Log. Di 1.0.2, Log
  bukan cermin konsol — ia hanya melaporkan kegagalan
  pemuatan resource.
- Korelasi terverifikasi: `networkRequestId` entri Log SAMA
  dengan `requestId` `Network.loadingFailed` untuk fetch
  yang sama, sehingga entri Log dapat ditautkan ke baris
  waterfall-nya.
- `timestamp` entri adalah epoch MILIDETIK jam dinding
  (13 digit), bukan detik monotonik ala Chrome. Tracer
  tetap memakai stempel waktu terima sendiri; field ini
  direkam apa adanya dan tidak dipakai untuk pengurutan.
- `<img>` ke host mati tidak menghasilkan entri (konsisten
  dengan temuan ROBUST: Lightpanda 1.0.2 tidak me-fetch
  `<img>`).
- Level selain `error` (verbose/info/warning) dan sumber
  selain `network` (javascript/dll.) BELUM terverifikasi di
  1.0.2; kode harus menanganinya secara generik, bukan
  mengasumsikan hanya error/network.

## 2. Tracer: cukup mengaktifkan domainnya

- `enableDomains` menambahkan `"Log.enable"` ke daftar
  (Page, Network, Runtime, Log). Kegagalan enable tetap
  FATAL (`HandshakeError` menyebut metodenya), konsisten
  dengan ketiga domain lain dan dengan bukti bahwa
  `Log.enable` diterima pada versi yang dipin (1.0.2).
- TIDAK ADA allowlist event: `onEvent` mencatat semua
  method secara generik, sehingga `Log.entryAdded`
  mengalir ke file trace tanpa jalur khusus.
- TIDAK ADA kasus khusus redaksi: jalur generik
  `redactValue` sudah benar untuk payload ini — `text` dan
  `url` mengalami redaksi URL + potong pada 4096 karakter
  (`MAX_STRING_LEN`, ditambah penanda `…[truncated]`),
  dipertahankan. Teks Log adalah teks bebas tanpa kunci:
  residu yang sama dengan teks `result` agen — rahasia
  yang tertulis bebas di dalam teks tidak dapat disensor
  per kunci (didokumentasikan, bukan diperbaiki di sini).

## 3. Penampil: kategori konsol + tautan waterfall

- `categoryOf("Log.entryAdded")` = `konsol` (bukan kategori
  baru): Log adalah pelengkap konsol, dan tidak ada
  duplikasi yang perlu dipisahkan di 1.0.2.
- `consoleEntries` memasukkan baris `Log.entryAdded` dengan
  `level` dari pemetaan `verbose/info -> log`,
  `warning -> warning`, `error -> error`, selain itu `log`;
  `text` = `entry.text`; `ConsoleEntry` membawa `source`
  opsional (mis. `network`) agar asal Log terlihat di panel
  dan dapat dibedakan dari `consoleAPICalled`.
- `summarize` untuk `Log.entryAdded`:
  `[source/level] text` (fallback: tipe baris).
- `groupWaterfall`: entri mendapat `logText: string | null`
  dari `entry.networkRequestId` yang cocok (hanya bila
  baris Network untuk request itu sudah ada; `requestWillBeSent`
  selalu mendahului, jadi tautan andal). Tampilan waterfall
  menunjukkan teks Log pada baris yang gagal.
- Level/sumber di luar bukti probe (mis. `source:
  javascript`) dirender apa adanya, tidak diasumsikan.

## 4. Sidecar: agregat log terpisah, error tidak berubah

- `TraceSummary` mendapat `log: {present, entries, byLevel,
  sources}` — selalu hadir mengikuti pola field `agent`
  (dengan `present: false`, hitungan nol, dan peta kosong
  bila tidak ada entri Log): hitungan entri Log per level
  MENTAH (`verbose`/`info`/`warning`/`error`, fallback
  `unknown`) dan per sumber mentah. Level mentah dipakai agar
  tidak ada pemetaan yang diasumsikan; konsisten dengan
  `consoleByLevel` yang memakai level CDP apa adanya
  (dengan normalisasi `warn -> warning` yang sudah ada).
- Kategori filter: `Log.entryAdded` masuk kategori
  `console` (deskripsi kategori diperbarui). `errors`
  TIDAK berubah: entri Log error adalah kegagalan yang
  sama dengan `Network.loadingFailed` yang sudah dihitung;
  menghitungnya lagi akan menggandakan error.
- `log` selalu hadir mengikuti pola field `agent`
  (`present: false` bila tidak ada entri Log), agar
  ringkasan file lama tidak berubah bentuk.

## 5. Uji

- Unit redaksi: `redactEvent("Log.entryAdded", ...)` dengan
  URL ber-token di teks + teks > 4096 → parameter token
  tersensor, teks terpotong 4096, `networkRequestId` utuh.
- Fake server: `Log.entryAdded` tercatat verbatim
  (redaksi berlaku) dengan `endpoint`/`endpoint_index`
  benar pada multi-endpoint.
- Live (serve asli): halaman fetch ke port tertutup →
  baris `Log.entryAdded` hadir (`source: network`,
  `level: error`) dan `networkRequestId`-nya sama dengan
  `requestId` `loadingFailed` untuk fetch itu.
- Penampil: kategorisasi, entri konsol + pemetaan level +
  sumber, `logText` waterfall, ringkasan.
- Sidecar: agregat log, kategori console, `errors` tidak
  naik oleh entri Log.
- Regresi penuh ketiga paket.

## 6. Non-tujuan

- Mengaktifkan domain lain atau mengubah `enableDomains`
  menjadi soft-fail per domain.
- Dedup terhadap `consoleAPICalled` (tidak ada duplikasi
  di 1.0.2; bila Lightpanda kelak mencerminkan konsol ke
  Log, dedup diputuskan dari bukti baru, bukan asumsi).
- Memakai `entry.timestamp` untuk pengurutan atau durasi.
- Menafsirkan level/sumber yang belum terverifikasi
  sebagai perilaku Lightpanda.
