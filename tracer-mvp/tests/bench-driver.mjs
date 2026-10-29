// bench-driver.mjs — Pengemudi CDP untuk sisi "tanpa tracer" pada benchmark.
// Melakukan handshake Target + enable + navigasi yang sama dengan tracer,
// tanpa menulis trace. Nol dependensi, WebSocket native Node 22+.
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) {
      acc.push([a.slice(2), arr[i + 1]?.startsWith("--") ? "true" : arr[i + 1]]);
    }
    return acc;
  }, []),
);

const CDP = args.cdp || "ws://127.0.0.1:9233";
const URLS = String(args.urls || "").split(",").filter(Boolean);
const WAIT_MS = Number(args["wait-ms"] || 1200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
const pending = new Map();
let sessionId = null;
const ws = new WebSocket(CDP);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout koneksi CDP")), 10000);
  ws.onopen = () => {
    clearTimeout(t);
    resolve();
  };
  ws.onerror = () => {
    clearTimeout(t);
    reject(new Error("gagal koneksi CDP"));
  };
});
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }
    }, 10000);
  });

await send("Target.setDiscoverTargets", { discover: true });
const gt = await send("Target.getTargets");
const infos = gt.result?.targetInfos || [];
const page = infos.find((t) => t.type === "page");
let targetId = page?.targetId;
if (!targetId) {
  const ct = await send("Target.createTarget", { url: "about:blank" });
  targetId = ct.result.targetId;
}
const at = await send("Target.attachToTarget", { targetId, flatten: true });
sessionId = at.result.sessionId;
for (const m of ["Page.enable", "Network.enable", "Runtime.enable"]) {
  await send(m);
}
for (const url of URLS) {
  await send("Page.navigate", { url });
  await sleep(WAIT_MS);
}
ws.close();
process.exit(0);
