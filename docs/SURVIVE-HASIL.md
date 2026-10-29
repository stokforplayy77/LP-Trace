# SURVIVE-HASIL — Mode bertahan multi-koneksi (0.1.6)

Tanggal: 29 Oktober 2026. Cakupan: `tracer-mvp` saja
(`src/tracer.ts`, `src/cli.ts`, `src/replay.ts`, rangkaian uji
baru, dokumen). Penampil dan sidecar tidak berubah: baris penanda
baru masuk kategori `tracer.*` yang sudah ada di keduanya
(diverifikasi dengan membaca fungsi kategorinya, tanpa perubahan
kode).

## Yang dibangun

Flag `--survive` (opt-in, default mati) sesuai
`docs/SURVIVE-DESIGN.md`:

- `TracerOptions`/`ParsedArgs`/`ReplayOptions` membawa `survive`;
  teks bantuan diperbarui (tanpa backtick di dalam literal
  template, pelajaran F5).
- `tracer.ts` melacak koneksi hidup (`alive[]`, direset tiap
  percobaan `connectAll`) dan daftar `closedEndpoints`.
  Handler `onClose` kini bercabang: bila `--survive` dan masih
  ada koneksi hidup, tulis baris `tracer.connection_closed`
  (field tingkat atas `endpoint`/`endpoint_index` dari koneksi
  yang menutup, `data.remaining`) dan lanjutkan; bila tidak,
  jalur lama persis (`E_CDP_CLOSED`, `session_ended`
  `cdp-closed`, keluar 0). `sessionError` hanya dipasang pada
  jalur akhir sesi, bukan pada penutupan yang diselamatkan.
- `shutdown()` menggabungkan `closedEndpoints` ke
  `session_ended` bila daftarnya tidak kosong. Koneksi terakhir
  yang mengakhiri sesi tidak masuk daftar itu — ia sudah disebut
  di `endpoint`/`endpoint_index` akhir sesi.
- Tidak ada reconnect: koneksi yang mati tetap mati; target CDP
  mati bersama koneksinya. Melanjutkan file yang sama setelah
  tracer berhenti tetap lewat `--append`.

## Uji

Rangkaian baru `tests/run-survive-tests.mjs` (28 pemeriksaan),
dirangkai ke `npm test` setelah rangkaian error:

- Server CDP palsu dengan kontrol tutup per koneksi (pola codec
  manual yang sama dengan rangkaian MS/error). Satu jebakan
  ditemukan saat menulis uji: server dipakai ulang antar uji
  sehingga indeks soket bergeser — diatasi dengan helper
  `emitLatest`/`closeLatest` (koneksi terkini = koneksi uji
  yang sedang berjalan).
- Uji 1–4 (palsu): default tanpa flag (tutup → akhir sesi,
  tanpa penanda); survive + lanjut (penanda, event koneksi 1
  sesudah penutupan, SIGINT → `closedEndpoints`, tanpa
  `data.error`); survive + tutup kedua koneksi (penanda lalu
  akhir `cdp-closed` menyebut koneksi 1, `closedEndpoints`
  hanya berisi koneksi 0); satu koneksi + flag (identik
  dengan default).
- Uji 5 (live): dua proses `serve` Lightpanda 1.0.2 asli +
  halaman berdenyut; proses serve A dimatikan (SIGTERM) —
  penanda tercatat, baris koneksi B terus bertambah sesudah
  kematian A, SIGINT → keluar 0 + `closedEndpoints` menyebut
  serve A. Satu bug uji ditemukan di sini: tracer dijalankan
  sebelum serve siap sehingga gagal `E_CDP_UNREACHABLE`;
  diperbaiki dengan menunggu `/json/version` kedua serve
  sebelum tracer mulai (pola rangkaian robust).
- Seluruh rangkaian hijau: tracer 23+4+17+37+31+25+28+66
  (benchmark overhead 0,16%, gate 5%), sidecar 19/19,
  penampil 27/27. Uji error yang mengunci perilaku
  `cdp-closed` koneksi tunggal (uji 6) tetap lulus tanpa
  perubahan — perilaku default memang tidak berubah.

## Dokumen yang diperbarui

- `docs/SURVIVE-DESIGN.md` (desain, ditulis sebelum implementasi).
- `docs/MS-DESIGN.md`: pernyataan "tidak ada mode bertahan"
  diberi amandemen 0.1.6 (riwayat dipertahankan, bukan ditulis
  ulang) dan §8 diperbarui.
- `tracer-mvp/README.md`: baris flag `--survive`, baris internal
  `tracer.connection_closed`, dan field `closedEndpoints` pada
  `session_ended`.
- `README.md` (root): baris tabel `tracer-mvp` menyebut
  `--survive`.
- `CHANGELOG.md`: entri 0.1.6.

## Batas yang tersisa

- Reconnect otomatis dan retry penutupan di tengah sesi tetap
  non-tujuan (berbeda dengan retry startup `--retry`).
- Penutupan selama handshake tetap fatal untuk seluruh sesi.
- Uji live memakai dua proses `serve` terpisah (port berbeda);
  dua koneksi ke SATU proses `serve` yang salah satunya
  dimatikan secara selektif tidak dapat diuji dari luar, karena
  mematikan prosesnya mematikan kedua koneksi. Perilaku
  penanda/kelanjutan untuk kasus itu sama (jalur `onClose`
  yang sama), dibuktikan uji palsu 1–4.
