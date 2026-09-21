#!/usr/bin/env bash
# Stage a servable web/ directory that uses the locally built artifacts.
#
# web/ keeps the fork's shipped .wasm files: web/azahar_webgl2.* cannot be
# rebuilt from this repository at all, so they are never overwritten. This
# copies the UI next to the local software build instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-/tmp/azahar-staged}"
BUILD_DIR="${AZAHAR_BUILD_DIR:-$ROOT/build-web-sw}"
BIN="$BUILD_DIR/bin/Release"

if [ ! -f "$BIN/azahar.wasm" ]; then
    echo "No local build at $BIN. Run ./build_web.sh --target azahar_web first." >&2
    exit 1
fi

mkdir -p "$DEST"
# UI, server and support scripts come from web/; the emulator does not.
for f in index.html index_webgl2.html azahar_ui.js azahar_savestates.js \
         azahar_scheduler.js coi-serviceworker.js server.cjs \
         azahar_webgl2.js azahar_webgl2.wasm; do
    [ -f "$ROOT/web/$f" ] && cp "$ROOT/web/$f" "$DEST/"
done
cp "$BIN/azahar.js" "$BIN/azahar.wasm" "$DEST/"

echo "Staged $DEST"
ls -la "$DEST" | awk 'NR>3 {printf "  %-28s %10s\n", $9, $5}'
