// scripts/build-singlefile.mjs — Ubah build-singlefile/ menjadi index.html
// mandiri yang bisa dibuka lewat file://.
//
// Latar: boot SvelteKit memakai dynamic import() ke chunk _app/, dan
// modul ES yang di-fetch diblokir CORS dari origin null (file://).
// Skrip ini menggabung chunk klien (start + app + nodes + chunks)
// menjadi SATU modul ESM lewat esbuild, lalu menanamkannya inline di
// index.html bersama CSS-nya. Hasil: index.html boot tanpa fetch modul.
// Catatan: file CSS pendamping tetap dipertahankan (runtime SvelteKit
// menyuntikkan <link> ke sana saat hidrasi); isinya juga sudah inline,
// jadi gaya tetap tampil walau file itu hilang.
//
// Pemakaian: npm run build:singlefile
//   (= SINGLEFILE=1 vite build && node scripts/build-singlefile.mjs)
import { readdir, readFile, writeFile, rm, mkdtemp, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const OUT = join(fileURLToPath(new URL("..", import.meta.url)), "build-singlefile");
const htmlPath = join(OUT, "index.html");
let html = await readFile(htmlPath, "utf8");

// 1. Salin _app/immutable ke direktori sementara dan sederhanakan
// dynamic import gaya Vite agar esbuild mau menggabungkannya:
//   import(`../nodes/x.js`, __vite__mapDeps([...]), import.meta.url)
//   -> import(`../nodes/x.js`)
// Bentuk 3-argumen itu protokol runtime Vite; esbuild tidak mengenalinya
// sebagai import yang bisa di-bundle, sehingga ia lolos mentah ke modul
// inline dan gagal di file:// (import.meta.url modul inline = URL halaman,
// sehingga `../nodes/...` mengarah ke folder yang salah). Dengan 1 argumen,
// esbuild (tanpa code splitting) menggabung modulnya inline dan mengganti
// import() dengan promise namespace — persis yang dibutuhkan file://.
// Di samping itu, path CSS di manifest (`../assets/...`, di-resolve
// runtime terhadap import.meta.url) ditulis ulang menjadi path relatif
// dari halaman (`_app/immutable/assets/...`) supaya suntikan <link>
// runtime menemukan file CSS pendamping.
const dir = await mkdtemp(join(tmpdir(), "lp-singlefile-"));
const tmpApp = join(dir, "_app-immutable");
await cp(join(OUT, "_app/immutable"), tmpApp, { recursive: true });
const rewriteJs = async (d) => {
  for (const f of await readdir(d, { withFileTypes: true })) {
    const p = join(d, f.name);
    if (f.isDirectory()) await rewriteJs(p);
    else if (f.name.endsWith(".js")) {
      let t = await readFile(p, "utf8");
      t = t.replace(/import\(`([^`]+)`,\s*__vite__mapDeps\([^)]*\),\s*import\.meta\.url\)/g, "import(`$1`)");
      t = t.replace(/"\.\.\/assets\//g, '"_app/immutable/assets/');
      await writeFile(p, t);
    }
  }
};
await rewriteJs(tmpApp);
const entryDir = join(tmpApp, "entry");
const entries = await readdir(entryDir);
const start = entries.find((f) => f.startsWith("start.") && f.endsWith(".js"));
const app = entries.find((f) => f.startsWith("app.") && f.endsWith(".js"));
if (!start || !app) {
  throw new Error(`chunk entry tidak ditemukan di ${entryDir}: ${entries.join(", ")}`);
}

// 2. Ekstrak konfigurasi boot dari <script> SvelteKit di index.html.
// Bentuk yang diharapkan (dihasilkan SvelteKit, stabil antar build):
//   __sveltekit_xxx = { base: <ekspresi>, version: "<hash>" };
//   const element = document.currentScript.parentElement;
//   import("./_app/.../start...").then(async (kit) => {
//     kit.init(__sveltekit_xxx);
//     const app = await import("./_app/.../app...");
//     kit.start(app, element, { node_ids: [...], data: [...], form, error });
//   });
const boot = html.match(/<script>\s*\{[\s\S]*?__sveltekit_\w+\s*=[\s\S]*?<\/script>/);
if (!boot) throw new Error("blok <script> boot SvelteKit tidak ditemukan di index.html");
const bootText = boot[0];
const base = bootText.match(/base:\s*(.+?),\s*version:/s)?.[1]?.trim();
const version = bootText.match(/version:\s*"([^"]+)"/)?.[1];
const startOpts = bootText.match(/kit\.start\(app,\s*element,\s*(\{[\s\S]*?\})\s*\)/)?.[1];
if (!base || !version || !startOpts) {
  throw new Error("gagal mengekstrak base/version/startOpts dari boot script");
}

// 3. Bundle start + app (+ semua chunk yang mereka impor) jadi satu modul.
const entryPath = join(dir, "entry.js");
await writeFile(
  entryPath,
  `import * as kit from ${JSON.stringify(join(entryDir, start))};\n` +
    `import * as app from ${JSON.stringify(join(entryDir, app))};\n` +
    `kit.init({ base: ${base}, version: ${JSON.stringify(version)} });\n` +
    `kit.start(app, window.__lpRoot, ${startOpts});\n`,
);
const { outputFiles } = await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});
if (outputFiles.length !== 1) {
  throw new Error(`esbuild menghasilkan ${outputFiles.length} file, diharapkan 1`);
}
// Hindari penutup tag script di dalam kode inline (di string JS, \/ == /).
const bundled = outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

// 4. Inline CSS pendamping (runtime juga menyuntikkan <link> ke file
// aslinya; keduanya berisi aturan yang sama, jadi tidak konflik).
const assetsDir = join(OUT, "_app/immutable/assets");
let css = "";
try {
  for (const f of await readdir(assetsDir)) {
    if (f.endsWith(".css")) css += await readFile(join(assetsDir, f), "utf8") + "\n";
  }
} catch {
  // Tidak ada CSS: lanjut tanpa <style>.
}
if (css) html = html.replace("</head>", () => `<style>\n${css}</style>\n</head>`);

// 5. Hapus modulepreload (merujuk chunk yang sudah tidak ada), ganti
// boot script dengan penanda elemen + modul inline. Skrip klasik harus
// berada di dalam div yang sama dengan boot script lama agar
// parentElement-nya tetap div pembungkus aplikasi.
html = html.replace(/<link[^>]*rel="modulepreload"[^>]*>\n?/g, "");
html = html.replace(
  boot[0],
  // PENTING: pakai fungsi replacer, bukan string — String.replace
  // mengekspansi pola $&/$'/$\`/$n di string pengganti, dan bundle JS
  // mengandung $ sehingga penulisan langsung merusak kode (terbukti:
  // SyntaxError di bundle hasil replace string).
  () =>
    `<script>window.__lpRoot = document.currentScript.parentElement;</script>\n` +
    `<script type="module">\n${bundled}</script>`,
);

// 5b. Pengaman: pastikan modul yang SUDAH tertanam di HTML lolos parse
// (bukan hanya bundle mentah) sebelum file ditulis.
const embedded = html.match(/<script type="module">\n([\s\S]*?)<\/script>/)?.[1];
if (!embedded) throw new Error("modul inline tidak ditemukan di HTML hasil");
const checkFile = join(dir, "check.mjs");
await writeFile(checkFile, embedded);
try {
  execFileSync(process.execPath, ["--check", checkFile], { stdio: "pipe" });
} catch (e) {
  throw new Error(
    `modul inline tidak lolos node --check: ${(e.stderr ?? e.stdout ?? Buffer.from(String(e))).toString().slice(0, 300)}`,
  );
}
// 6. Bersihkan file yang sudah tidak dirujuk, kecuali CSS pendamping
// dan sample.jsonl (dipakai bila folder ini disajikan lewat server).
await rm(join(OUT, "200.html"), { force: true });
for (const sub of ["entry", "nodes", "chunks"]) {
  await rm(join(OUT, "_app/immutable", sub), { recursive: true, force: true });
}
await rm(join(OUT, "_app/version.json"), { force: true });
await writeFile(htmlPath, html);
await rm(dir, { recursive: true, force: true });
console.log(`singlefile: ${htmlPath} (${(html.length / 1024).toFixed(0)} KB, JS inline ${(bundled.length / 1024).toFixed(0)} KB)`);
