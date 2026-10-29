# REDACT-HASIL — Perbaikan redaksi rahasia bersarang (0.1.5)

Tanggal: 29 Oktober 2026. Cakupan: `tracer-mvp/src/agent-trace.ts`
dan `tracer-mvp/tests/run-f5-tests.mjs` saja; penampil dan sidecar
tidak berubah (redaksi terjadi saat penulisan trace).

## Celah yang ditemukan

`redactAgentArgs` (F5) hanya menyensor kunci mirip rahasia pada
tingkat atas DAN hanya bila nilainya string:

```js
if (isTokenLikeParam(key) && typeof value === "string") { out[key] = REDACTED; ... }
out[key] = truncateDeep(redactValue(value, ...), AGENT_ARG_MAX);
```

`redactValue` (aturan generik CDP) tidak mengenal kunci mirip
parameter token — ia hanya menangani header sensitif, URL, dan
postData. Akibatnya dua bentuk rahasia lolos apa adanya ke file
trace:

1. Kunci mirip rahasia bersarang: `args.config.api_key`,
   `args.opts.nested.accessToken` — tertulis utuh.
2. Kunci mirip rahasia tingkat atas dengan nilai non-string:
   `args.token = {sub: "..."}`, `args.tokenArr = [...]`,
   `args.token = 12345` — tertulis utuh.

Catatan ini sudah dibawa sebagai batasan yang diketahui sejak
F5-HASIL ("redactAgentArgs secret-key redaction applies only to
top-level keys") dan dibawa terus di MS/LIVE/ERROR/ROBUST-HASIL.
Perilaku header sensitif dan parameter URL bersarang TIDAK bocor:
keduanya ditangani `redactValue` secara rekursif.

## Perbaikan

Fungsi baru `redactSecretKeysDeep` di `agent-trace.ts`: menelusuri
nilai secara rekursif (objek + array); nilai pada kunci mirip
rahasia (`isTokenLikeParam`: `token`, `key`, `secret`, `password`,
`auth`, termasuk bentuk `api_key`/`authToken`, tanpa membedakan
huruf besar/kecil) diganti `[REDACTED]` utuh pada kedalaman berapa
pun dan untuk tipe nilai apa pun, sebelum `redactValue` dan
`truncateDeep` berjalan. Urutan ini mempertahankan perilaku lama
untuk struktur bukan-rahasia: header sensitif, parameter URL, dan
postData bersarang tetap ditangani aturan generik; nilai biasa
tetap dipotong 500 karakter; masukan tidak diubah (salinan baru).

Batas kedalaman 32 tingkat (`AGENT_MAX_DEPTH`): struktur di luar
batas disensor utuh, agar file trace yang dibuat-buat dengan sarang
ribuan tingkat tidak membuat penelusuran rekursif kehabisan stack.
Batas ini jauh di atas kedalaman argumen agen yang wajar.

## Uji

Tiga uji baru di `run-f5-tests.mjs` (rangkaian F5 menjadi 17):

- Kunci mirip rahasia bersarang (objek, array berisi objek,
  nilai objek/array/angka/boolean/null, varian huruf) → seluruhnya
  `[REDACTED]`; header `authorization` dan parameter URL bersarang
  tetap disensor; nilai biasa dipertahankan; masukan tidak diubah.
- Sarang 40 tingkat berisi rahasia di dasar → selesai tanpa
  melempar, rahasia tidak muncul, ada penanda `[REDACTED]`.
- Jalur lengkap `convertAgentLine` dengan argumen bersarang →
  baris trace tidak mengandung rahasia.

Seluruh rangkaian hijau setelah perbaikan: tracer 23+4+17+37+31+
25+66 (benchmark overhead 0,97%, gate 5%), sidecar 19/19, penampil
27/27.

## Dokumen yang diperbarui

- `docs/F5-DESIGN.md` §2.3: redaksi args kini digambarkan rekursif,
  dengan catatan perbaikan 0.1.5.
- `tracer-mvp/README.md`: aturan redaksi argumen agen ditambahkan
  pada bagian redaksi.
- `CHANGELOG.md`: entri 0.1.5 (perbaikan ini + perbaikan harness
  CI yang sebelumnya masih di Unreleased).
- Laporan tahap lama (F5/MS/LIVE/ERROR/ROBUST-HASIL) dibiarkan
  sebagai catatan historis; batasan yang mereka bawa kini tertutup
  oleh perbaikan ini.

## Batas yang tersisa

- `result` tool agen tetap hanya ditulis dengan `--include-bodies`
  (string, dipotong 2000 karakter, disensor URL-nya) — tidak ada
  redaksi kunci di dalamnya karena bentuknya teks bebas, bukan
  objek. Upstream `--trace-results` berperilaku sama.
- Baris `agent.unknown` tetap tanpa payload.
