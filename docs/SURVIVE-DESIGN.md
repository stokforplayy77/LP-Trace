# Desain mode bertahan multi-koneksi (--survive)

Tanggal: 29 Oktober 2026. Tahap lanjutan dari MS (multi-endpoint +
resume). Perilaku yang diubah hanya ada di `tracer-mvp`; penampil
dan sidecar tidak berubah (baris penanda baru masuk kategori
`tracer.*` yang sudah ada di keduanya).

## 1. Keadaan saat ini (MS)

`docs/MS-DESIGN.md` §4.2: bila koneksi CDP mana pun ditutup server
SETELAH handshake berhasil, sesi diakhiri dengan anggun
(`tracer.session_ended`, reason `cdp-closed`, menyebut koneksi yang
menutup, `data.error` berkode `E_CDP_CLOSED`) dan proses keluar 0.
Tidak ada mode "bertahan dengan sisa koneksi" di v1. Untuk sesi
multi-endpoint, matinya satu proses `serve` menghentikan perekaman
seluruh endpoint lain yang masih sehat.

## 2. Keputusan

- Flag baru `--survive` (boolean, default mati). Perilaku default
  TIDAK berubah: tanpa flag, penutupan koneksi mana pun tetap
  mengakhiri sesi seperti MS. Alasannya konsistensi dengan
  konvensi proyek (perilaku baru lewat flag eksplisit:
  `--append`, `--retry`, `--live-port`) dan tidak ada skrip lama
  yang semantiknya berubah diam-diam.
- Dengan `--survive`: penutupan satu koneksi HANYA mengakhiri sesi
  bila tidak ada koneksi lain yang masih hidup. Selama masih ada
  koneksi hidup, sesi berlanjut: nomor urut global dan jam `mono_ms`
  tidak terputus, dan penutupan itu sendiri dicatat sebagai baris
  penanda (bukan akhir sesi).
- Koneksi yang mati TETAP mati: tidak ada reconnect otomatis.
  Target CDP mati bersama koneksinya (terbukti di probe MS), jadi
  reconnect berarti target baru dengan riwayat navigasi yang
  terputus — itu bukan "bertahan", itu sesi baru. Melanjutkan
  file trace yang sama setelah tracer berhenti tetap lewat
  `--append` (resume sisi tracer, MS).

## 3. Perilaku rinci

### 3.1 Baris penanda `tracer.connection_closed`

Ditulis tepat saat koneksi ke-i ditutup dan masih ada koneksi lain
yang hidup (hanya dalam mode `--survive`):

```json
{"type": "tracer.connection_closed", "data": {
  "endpoint": "ws://127.0.0.1:9223",
  "endpoint_index": 0,
  "remaining": 1
}}
```

Field tingkat atas `endpoint`/`endpoint_index` diisi dari koneksi
yang menutup (bukan `""`/`-1`), sehingga baris ini tampil di bawah
endpoint tersebut pada filter penampil dan terhitung pada agregasi
per-endpoint sidecar. `remaining` = jumlah koneksi yang masih
hidup sesudah penutupan ini. Baris ini TIDAK ditulis bila
penutupan itu mengakhiri sesi (koneksi terakhir): jalur lama
`cdp-closed` yang berlaku, agar keluaran satu-koneksi identik
dengan sebelum tahap ini, dengan atau tanpa `--survive`.

### 3.2 Akhir sesi

- Koneksi terakhir menutup (dengan atau tanpa `--survive`):
  perilaku lama persis — `session_ended` reason `cdp-closed`,
  `data.error` = `E_CDP_CLOSED` + endpoint/indeks, keluar 0.
- Sinyal / batas ukuran / kegagalan handshake: tidak berubah.
  Penutupan selama handshake berlangsung tetap bagian dari
  kegagalan handshake (fatal), bukan pemicu mode bertahan —
  `handshaking` masih mengabaikan event tutup pada fase itu.
- Bila sesi berakhir (alasan apa pun) SETELAH satu atau lebih
  penutupan yang "diselamatkan", `session_ended` membawa field
  tambahan `closedEndpoints`: daftar `{endpoint, endpoint_index}`
  koneksi yang menutup lebih dulu, sesuai urutan penutupan.
  Field ini hanya ada bila daftarnya tidak kosong; skema lama
  tidak berubah untuk sesi tanpa penutupan. Koneksi terakhir
  yang mengakhiri sesi TIDAK masuk daftar ini — ia sudah disebut
  di `endpoint`/`endpoint_index` pada `data.error`/extra akhir
  sesi, sesuai perilaku lama.
- `sessionError` (`E_CDP_CLOSED`) HANYA dipasang pada jalur akhir
  sesi, bukan pada penutupan yang diselamatkan. Ringkasan sidecar
  (`sessionError`) dengan demikian tetap berarti "sesi berakhir
  karena koneksi putus", bukan "pernah ada koneksi putus".

### 3.3 Interaksi dengan fitur lain

- `--stay` / pasif: loop tunggu tidak berubah; ia selesai saat
  `shutdownRequested`, yang hanya dipasang jalur akhir sesi.
- Mode live (SSE): baris penanda disiarkan seperti baris lain;
  server SSE tetap hidup selama sesi bertahan dan baru ditutup
  pada `session_ended`, seperti biasa.
- `--append` / resume: baris penanda adalah baris biasa dalam
  file; resume menghitungnya sebagai baris lama. Tidak ada
  perlakuan khusus.
- Replay: memakai tepat satu `--cdp`; flag `--survive`
  diteruskan tetapi tidak berpengaruh (koneksi tunggal yang
  menutup = akhir sesi, seperti biasa).
- Batas ukuran (`--max-bytes`): bersama untuk semua koneksi,
  tidak berubah; penanda juga memakan kuota seperti baris lain.
- Retry startup (`--retry`): hanya untuk kegagalan koneksi saat
  startup; penutupan di tengah sesi tidak di-retry, dengan atau
  tanpa `--survive`.

## 4. Penampil dan sidecar: tanpa perubahan kode

- Penampil: `trace.ts` mengategorikan semua `type` berawalan
  `tracer.` sebagai kategori `tracer`; baris penanda tampil
  sebagai penanda sesi, dapat dicari teksnya, dan lolos filter
  endpoint (baris bukan-CDP selalu lolos) sekaligus terikat pada
  endpoint penutup lewat field tingkat atasnya.
- Sidecar: `summary.ts` mengategorikan `tracer.*` sebagai
  `tracer`; agregasi per-endpoint menghitung baris penanda pada
  endpoint penutupnya. `sessionError` tetap dari
  `session_ended` terakhir.

## 5. Uji (rangkaian baru `run-survive-tests.mjs`)

Server CDP palsu memakai pola codec WebSocket manual yang sama
dengan rangkaian MS/error (Node tidak punya server WebSocket
bawaan), ditambah satu bagian live dengan Lightpanda 1.0.2 asli:

1. Tanpa flag (default): 2 koneksi, tutup koneksi 0 → sesi
   berakhir `cdp-closed` menyebut koneksi 0, keluar 0, tanpa
   baris penanda.
2. Dengan `--survive`: tutup koneksi 0 → baris
   `tracer.connection_closed` (`endpoint_index` 0,
   `remaining` 1); event dari koneksi 1 masih tercatat sesudah
   penutupan; SIGINT → keluar 0, `session_ended`
   reason `signal-SIGINT` membawa `closedEndpoints: [indeks 0]`,
   tanpa `data.error`.
3. Dengan `--survive`: tutup koneksi 0 lalu koneksi 1 → penanda
   untuk 0, lalu sesi berakhir `cdp-closed` menyebut koneksi 1.
4. Satu koneksi + `--survive`: tutup → berakhir `cdp-closed`
   seperti biasa, tanpa baris penanda (keluaran identik).
5. Live: dua proses `serve` asli (port berbeda) + halaman
   berdenyut (console/fetch berkala) pada koneksi 1; matikan
   proses `serve` 0 → penanda tercatat, baris koneksi 1 terus
   bertambah sesudah kematian 0; SIGINT → keluar 0.

## 6. Non-tujuan

- Reconnect / pembuatan ulang target untuk koneksi yang mati.
- Retry penutupan di tengah sesi (berbeda dengan retry startup).
- Mengubah perilaku default tanpa flag.
- Mengamati navigasi yang digerakkan klien CDP lain (tetap
  mustahil: satu target per koneksi, dibuktikan probe MS).
