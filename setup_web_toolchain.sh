#!/usr/bin/env bash
# Install the pinned Emscripten SDK and initialize every source dependency.
# Safe to run repeatedly; existing downloads and npm packages are reused.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/toolchain/versions.sh"

EMSDK_ROOT="${EMSDK:-$ROOT/.toolchains/emsdk}"

for command_name in git cmake ninja; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Missing required command: $command_name" >&2
        echo "On macOS, install Git, CMake, and Ninja first (for example with Homebrew)." >&2
        exit 1
    fi
done

echo "Initializing the pinned Azahar source and its nested submodules ..."
git -C "$ROOT" submodule update --init --recursive azahar
actual_azahar_rev="$(git -C "$ROOT/azahar" rev-parse HEAD)"
if [ "$actual_azahar_rev" != "$AZAHAR_UPSTREAM_REV" ]; then
    echo "Azahar submodule is at $actual_azahar_rev, expected $AZAHAR_UPSTREAM_REV" >&2
    echo "Run: git submodule update --init --recursive azahar" >&2
    exit 1
fi
"$ROOT/apply_upstream_patches.sh"

if [ ! -d "$EMSDK_ROOT/.git" ]; then
    echo "Cloning emsdk into $EMSDK_ROOT ..."
    mkdir -p "$(dirname "$EMSDK_ROOT")"
    git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_ROOT"
fi

if [ "$(git -C "$EMSDK_ROOT" rev-parse HEAD)" != "$EMSDK_GIT_REV" ]; then
    if [ -n "$(git -C "$EMSDK_ROOT" status --porcelain)" ]; then
        echo "Cannot pin a modified emsdk checkout at $EMSDK_ROOT." >&2
        echo "Set EMSDK to another path or clean that checkout first." >&2
        exit 1
    fi
    echo "Pinning emsdk to $EMSDK_GIT_REV ..."
    git -C "$EMSDK_ROOT" fetch origin "$EMSDK_GIT_REV"
    git -C "$EMSDK_ROOT" checkout --detach "$EMSDK_GIT_REV"
fi

echo "Installing Emscripten $EMSDK_VERSION ..."
"$EMSDK_ROOT/emsdk" install "$EMSDK_VERSION"
"$EMSDK_ROOT/emsdk" activate "$EMSDK_VERSION"

# The SDK ships a Node runtime that is compatible with both Emscripten and the
# pinned Puppeteer. Prefer it to the host's Node: older macOS/Windows installs
# often have Node 16, which Puppeteer 23 no longer supports.
EMSDK_NODE_DIR="$EMSDK_ROOT/node/$EMSDK_NODE_VERSION/bin"
EMSDK_NODE="$EMSDK_NODE_DIR/node"
if [ ! -x "$EMSDK_NODE" ] && [ -x "$EMSDK_NODE.exe" ]; then
    EMSDK_NODE="$EMSDK_NODE.exe"
fi
if [ ! -x "$EMSDK_NODE" ]; then
    echo "Pinned SDK Node was not installed at $EMSDK_NODE_DIR." >&2
    exit 1
fi
export PATH="$EMSDK_NODE_DIR:$PATH"

echo "Installing the pinned browser-test dependencies ..."
npm --prefix "$ROOT" ci --no-audit --no-fund

# shellcheck disable=SC1091
source "$EMSDK_ROOT/emsdk_env.sh" >/dev/null 2>&1
actual_emcc_version="$(emcc --version | sed -n '1s/.* \([0-9][0-9.]*\) .*/\1/p')"
if [ "$actual_emcc_version" != "$EMSDK_VERSION" ]; then
    echo "Expected emcc $EMSDK_VERSION, got ${actual_emcc_version:-unknown}" >&2
    exit 1
fi

echo
echo "Web toolchain ready:"
echo "  Azahar:    $actual_azahar_rev"
echo "  Emscripten: $actual_emcc_version ($EMSDK_ROOT)"
echo "  CMake:     $(cmake --version | head -1)"
echo "  Ninja:     $(ninja --version)"
echo "  Node:      $(node --version)"
echo
echo "Build with: ./build_web.sh"
