#!/usr/bin/env bash
# Apply the repository-owned Emscripten/performance delta to the pinned public
# Azahar submodule. Safe to run repeatedly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$ROOT/azahar"
PATCH="$ROOT/patches/public-upstream-web-performance.patch"

if [ ! -f "$SOURCE_DIR/CMakeLists.txt" ]; then
    echo "Azahar submodule is not initialized. Run ./setup_web_toolchain.sh." >&2
    exit 1
fi
if [ ! -f "$PATCH" ]; then
    echo "Missing required source patch: $PATCH" >&2
    exit 1
fi

if git -C "$SOURCE_DIR" apply --check --reverse "$PATCH" >/dev/null 2>&1; then
    echo "Azahar web performance patch: already applied"
    exit 0
fi

if [ -n "$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=no)" ]; then
    echo "Cannot apply the web performance patch over unrelated Azahar edits:" >&2
    git -C "$SOURCE_DIR" status --short --untracked-files=no >&2
    exit 1
fi

if ! git -C "$SOURCE_DIR" apply --check "$PATCH"; then
    echo "The web performance patch does not match the pinned Azahar revision." >&2
    echo "Restore the submodule with: git submodule update --init --recursive --force azahar" >&2
    exit 1
fi

git -C "$SOURCE_DIR" apply "$PATCH"
echo "Azahar web performance patch: applied"
