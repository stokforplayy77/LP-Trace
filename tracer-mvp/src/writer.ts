// writer.ts — Penulis JSONL buffered asinkron dengan batas ukuran (Bab 3.6).
// File dibuat dengan izin 0600. Bila batas ukuran tercapai, penulisan
// berhenti dengan pemberitahuan lewat callback; data lama tidak pernah
// ditimpa atau dirotasi diam-diam. Cadangan 1024 byte disimpan agar baris
// tracer.session_ended masih muat ditulis saat batas tercapai.

import { open, type FileHandle } from "node:fs/promises";

const FLUSH_INTERVAL_MS = 250;
const FLUSH_THRESHOLD_BYTES = 64 * 1024;
const SESSION_END_RESERVE_BYTES = 1024;

export class SizeLimitReached extends Error {
  constructor(public readonly maxBytes: number) {
    super(
      `batas ukuran trace tercapai (${maxBytes} byte); penulisan dihentikan, data lama tidak ditimpa`,
    );
    this.name = "SizeLimitReached";
  }
}

export class BufferedWriter {
  private handle: FileHandle | null = null;
  private buffer = "";
  private bufferBytes = 0;
  private bytesWritten = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private limited = false;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
    private readonly onLimit: (err: SizeLimitReached) => void,
  ) {}

  async open(): Promise<void> {
    // 'w' + mode 0600: file baru berizin 0600; file lama ditimpa isinya
    // (trace baru per sesi) tetapi izin yang sudah ada dipertahankan oleh
    // sistem bila file sudah ada — untuk jaminan 0600, chmod eksplisit.
    this.handle = await open(this.path, "w", 0o600);
    try {
      await this.handle.chmod(0o600);
    } catch {
      // Sistem yang tidak mendukung chmod: abaikan, file tetap ditulis.
    }
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  get totalBytes(): number {
    return this.bytesWritten + this.bufferBytes;
  }

  get isLimited(): boolean {
    return this.limited;
  }

  /**
   * Antre satu baris (tanpa newline; newline ditambahkan di sini).
   * Baris biasa dibatasi maxBytes dikurangi cadangan, agar baris
   * tracer.session_ended masih muat ditulis saat batas tercapai.
   * Mengembalikan false bila baris ditolak karena batas ukuran.
   */
  write(line: string): boolean {
    if (this.closed || this.limited) return false;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (
      this.bytesWritten + this.bufferBytes + bytes >
      this.maxBytes - SESSION_END_RESERVE_BYTES
    ) {
      this.limited = true;
      this.onLimit(new SizeLimitReached(this.maxBytes));
      return false;
    }
    this.buffer += line + "\n";
    this.bufferBytes += bytes;
    if (this.bufferBytes >= FLUSH_THRESHOLD_BYTES) {
      void this.flush();
    }
    return true;
  }

  /**
   * Tulis baris penutup sesi memakai cadangan ukuran. Mengembalikan false
   * bila baris akan melampaui batas ukuran absolut.
   */
  writeSessionEnd(line: string): boolean {
    if (this.closed) return false;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (this.bytesWritten + this.bufferBytes + bytes > this.maxBytes) {
      return false;
    }
    this.buffer += line + "\n";
    this.bufferBytes += bytes;
    return true;
  }

  flush(): Promise<void> {
    if (!this.handle || this.buffer.length === 0) return this.chain;
    const chunk = this.buffer;
    const chunkBytes = this.bufferBytes;
    this.buffer = "";
    this.bufferBytes = 0;
    this.chain = this.chain.then(async () => {
      if (!this.handle) return;
      // appendFile: selalu tulis di akhir file. (Jangan pakai write()
      // dengan argumen posisi: overload string-nya menafsirkan angka
      // kedua sebagai posisi file, sehingga flush akan menimpa awal file.)
      await this.handle.appendFile(chunk, "utf8");
      this.bytesWritten += chunkBytes;
    });
    return this.chain;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }
}
