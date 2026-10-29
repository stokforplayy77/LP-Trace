// run-version-tests.mjs — Versi CLI harus sama dengan package.json.
//
// Penjaga regresi untuk bug label 0.1.0 pada paket 0.1.1 (versi hardcode
// di src/cli.ts; sumber kebenaran kini src/version.ts yang membaca
// package.json). Build (tsc) dijalankan dulu, seperti run-m1-tests.mjs.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
let passed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function run(argv, cwd = ROOT) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const build = await run([join(ROOT, "node_modules", ".bin", "tsc")]);
check("build tsc bersih (exit 0)", build.code === 0, build.stderr.slice(0, 300));

const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const v = await run([
  process.execPath,
  join(ROOT, "dist", "cli.js"),
  "--version",
]);
check("--version keluar 0", v.code === 0, v.stderr.slice(0, 200));
check(
  "--version sama dengan package.json",
  v.stdout.trim() === `lp-tracer ${pkg.version}`,
  JSON.stringify(v.stdout),
);
const h = await run([process.execPath, join(ROOT, "dist", "cli.js"), "--help"]);
check(
  "--help menyebut versi package.json",
  h.stdout.includes(`lp-tracer ${pkg.version}`),
);

console.log(`\n${passed} lulus, ${failures.length} gagal`);
if (failures.length > 0) {
  console.log("GAGAL:", failures.join(", "));
  process.exit(1);
}
