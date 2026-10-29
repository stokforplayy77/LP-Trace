#!/usr/bin/env bash
# Unduh binary Lightpanda 1.0.2 (versi acuan M1) ke ./vendor/lightpanda.
# Dipakai oleh pengujian integrasi bila binary belum tersedia di PATH/LP_BIN.
# Setelah pengujian, binary boleh dihapus (perintah pengulangan ada di M1-HASIL.md).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="1.0.2"
ARCH="$(uname -m)"
if [ "$ARCH" != "x86_64" ]; then
  echo "arsitektur $ARCH belum didukung skrip ini (hanya x86_64-linux)" >&2
  exit 1
fi
ASSET="lightpanda-x86_64-linux"
URL="https://github.com/lightpanda-io/browser/releases/download/${VERSION}/${ASSET}"

mkdir -p vendor
echo "Mengunduh Lightpanda ${VERSION} (${ASSET})..."
curl -sL --max-time 300 -o "vendor/lightpanda" "$URL"
chmod +x vendor/lightpanda
GOT="$(./vendor/lightpanda version)"
if [ "$GOT" != "$VERSION" ]; then
  echo "verifikasi versi gagal: diharapkan ${VERSION}, diterima ${GOT}" >&2
  exit 1
fi
echo "OK: vendor/lightpanda -> ${GOT}"
