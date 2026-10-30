// live-hint.ts — Pesan panduan saat sambungan live SSE gagal.
//
// EventSource tidak memberi detail error (gagal CORS/PNA, tunnel putus,
// dan tracer mati semuanya muncul sebagai event error generik), sehingga
// penampil menebak penyebab paling mungkin dari URL-nya:
// - SSE ke loopback (127.0.0.1/localhost) dari origin NON-loopback
//   (mis. penampil dibuka lewat IP publik VPS) -> kemungkinan besar
//   diblokir Private Network Access / izin Local Network Access.
// - Selain itu -> kemungkinan besar tracer/tunnel memang tidak jalan.
// Halaman file:// (hostname kosong) dianggap aman loopback: uji 30 Okt
// 2026 membuktikan SSE dari file:// ke loopback tersambung.
const LOOPBACK_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export function liveFailureHint(pageHostname: string, sseUrl: string): string {
  let sseHost: string;
  try {
    sseHost = new URL(sseUrl).hostname;
  } catch {
    return "Periksa URL SSE live dan pastikan tracer masih jalan dengan --live-port yang sama.";
  }
  if (isLoopback(sseHost) && !isLoopback(pageHostname)) {
    return (
      "Kemungkinan browser memblokir akses ke alamat loopback dari origin ini " +
      "(Private Network Access). Buka penampil lewat http://localhost:8103/ dengan " +
      "tunnel port 8103 ikut diteruskan, atau izinkan 'Local Network Access' saat " +
      "browser memintanya (penampil HTTPS). Pastikan juga tracer dan tunnel masih jalan."
    );
  }
  return (
    "Periksa tracer masih jalan dengan --live-port yang sama, " +
    "dan tunnel SSH (bila memakai VPS) masih aktif."
  );
}
