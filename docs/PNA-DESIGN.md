# Desain: Dukungan Private Network Access (PNA) di Server Live

Status: diimplementasikan di tracer (0.1.12, belum rilis saat dokumen ini
ditulis). Viewer tidak berubah; tidak ada perubahan format trace.

## 1. Masalah

Laporan uji live user (30 Okt 2026, `laporan_uji_live_lp_trace.md`):
membuka penampil dari origin IP publik `http://139.162.21.81:8103/` lalu
menyambung ke SSE `http://127.0.0.1:9229/events` diblokir Chrome/Edge
dengan `corsError: 'InsecureLocalNetwork'`. Penyebab yang teridentifikasi
saat itu: server live tidak menjawab preflight PNA.

Solusi sementara yang terverifikasi user: forward port 8103 juga lewat
tunnel SSH dan buka penampil lewat `http://localhost:8103/` (origin
loopback → loopback, bukan lintas address space, sehingga tidak kena
PNA). Solusi itu tetap berlaku dan tetap yang termudah.

## 2. Mekanisme PNA (spesifikasi W3C)

Browser Chromium mengklasifikasikan alamat ke tiga address space:
public, private (RFC1918), loopback. Request dari space yang kurang
privat ke space yang lebih privat (mis. HTTPS publik → loopback)
memicu preflight CORS dengan header:

```
Access-Control-Request-Private-Network: true
```

Server harus menjawab preflight dengan:

```
Access-Control-Allow-Private-Network: true
```

Tanpa header itu, request diblokir. Header ini hanya bermakna di
Chromium; Firefox/Safari mengabaikannya (tidak merusak apa pun).

## 3. Temuan verifikasi browser (Chromium 156, di VPS)

Halaman HTTPS dari IP publik VPS (`https://139.162.21.81:18443`,
secure context terkonfirmasi) membuka EventSource ke server live
loopback VPS. Hasilnya mengubah pemahaman awal:

| Skenario | Hasil |
|---|---|
| Origin HTTPS publik + server DENGAN header PNA, tanpa izin browser | DITOLAK: `Permission was denied for this request to access the loopback address space` |
| Origin HTTPS publik + server DENGAN header PNA + izin `local-network-access` diberikan | TERSAMBUNG, baris mengalir |
| Origin HTTPS publik + server TANPA header PNA + izin `local-network-access` diberikan | TERSAMBUNG juga (koneksi terbuka) |

Kesimpulan:

- Sejak Chrome 142+, ada gerbang kedua di level jaringan: izin
  **Local Network Access**. Di Chrome 156, izin inilah yang
  menentukan, bukan header PNA. Tanpa izin, header tidak menolong;
  dengan izin, header tidak diperlukan (untuk topologi ini).
- Header PNA tetap diimplementasikan karena: (a) benar menurut
  spesifikasi, (b) menjadi gerbang di Chrome lama (94–141) yang
  hanya memakai preflight, (c) tidak merusak browser lain.
- Origin HTTP dari IP publik (insecure context) tetap diblokir
  Chrome apa pun jawaban server — itu aturan konteks insecure,
  bukan preflight. Workaround tunnel/localhost tetap berlaku
  untuk kasus itu.
- Konsekuensi UX ke depan: penampil yang disajikan lewat HTTPS
  (kandidat "paket VPS aman") akan memicu prompt izin akses
  jaringan lokal di browser saat pertama kali menyambung live;
  pengguna harus mengizinkannya. Itu perilaku browser, bukan
  sesuatu yang bisa dihilangkan dari sisi server.

## 4. Implementasi (tracer saja)

`live.ts`: `CORS_HEADERS` tetap, ditambah fungsi `corsHeaders(req)`
yang menggemakan `Access-Control-Allow-Private-Network: true`
HANYA bila request membawa `Access-Control-Request-Private-Network:
true`. Dipakai di semua respons server live: preflight OPTIONS,
`/health`, `/events`, dan 404. Respons biasa tanpa permintaan PNA
tidak mengklaim izin PNA.

## 5. Uji

Rangkaian live (`run-live-tests.mjs`, uji 3, memakai `http.request`
mentah agar header terkirim verbatim):

- 3g: OPTIONS + `Access-Control-Request-Private-Network: true`
  → 204 + `access-control-allow-private-network: true`.
- 3h: OPTIONS tanpa header permintaan → 204 + tanpa header PNA.
- 3i: GET `/health` dengan header permintaan → header PNA ada.
- 3j: GET `/health` tanpa header permintaan → header PNA absen.

Hasil: rangkaian live 35/35 (31 lama + 4 baru).

Verifikasi browser (manual, bukan bagian `npm test`): skrip
Playwright + Chromium headless di VPS — halaman HTTPS dari IP
publik, EventSource ke loopback, plus server stub tanpa header
sebagai kontrol. Prosedur ini yang menghasilkan tabel §3.
Skrip verifikasi disimpan sementara di VPS (`/tmp/pna-check/`)
dan dibersihkan setelah rilis.

## 6. Batas

- Tidak mengubah perilaku origin localhost (sudah bekerja).
- Tidak membuka server live ke jaringan: bind tetap 127.0.0.1.
- Tidak menghilangkan prompt izin Local Network Access di
  Chrome 142+; itu keputusan pengguna di browser.
