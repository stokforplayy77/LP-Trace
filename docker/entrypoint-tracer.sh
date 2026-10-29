#!/bin/sh
# Entrypoint image lp-trace-tracer: jalankan `lightpanda serve` di latar,
# tunggu endpoint CDP siap, lalu jalankan tracer dengan argumen yang
# diteruskan (mis. --output /traces/trace.jsonl --navigate <url>).
set -eu

lightpanda serve --host 127.0.0.1 --port 9222 &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null || true' TERM INT

i=0
while [ "$i" -lt 60 ]; do
  if curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 0.5
done

exec node /app/dist/cli.js --cdp ws://127.0.0.1:9222 "$@"
