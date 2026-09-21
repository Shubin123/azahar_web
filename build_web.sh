#!/usr/bin/env bash
# Configure and build the Azahar web artifacts on macOS/Linux.
#
# Windows delegates here through build_web.bat so every host uses the same
# configuration. This script owns configuration because the Emscripten build needs
# cache variables and a shim include that are easy to get wrong by hand (see
# cmake/emscripten-web-shims.cmake for why each is required).
#
# Usage:
#   ./build_web.sh                     # configure (if needed) and build
#   ./build_web.sh --configure         # re-run configure only
#   ./build_web.sh --target citra_core # build one target
#   ./build_web.sh --clean             # remove the build directory first
#
# Environment:
#   AZAHAR_BUILD_DIR  Build directory (default: build-web-sw)
#   AZAHAR_WEB_ASSERTIONS  ON to link -sASSERTIONS=1 (readable aborts, slower)
#   EMSDK             Emscripten SDK root (default: repo-local, then ~/emsdk)
#   AZAHAR_ALLOW_TOOLCHAIN_MISMATCH  1 to permit a non-pinned emcc version
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${AZAHAR_BUILD_DIR:-$ROOT/build-web-sw}"
SOURCE_DIR="$ROOT/azahar"
# shellcheck disable=SC1091
source "$ROOT/toolchain/versions.sh"
if [ -n "${EMSDK:-}" ]; then
    EMSDK_ROOT="$EMSDK"
elif [ -f "$ROOT/.toolchains/emsdk/emsdk_env.sh" ]; then
    EMSDK_ROOT="$ROOT/.toolchains/emsdk"
else
    EMSDK_ROOT="$HOME/emsdk"
fi
JOBS="$(command -v nproc >/dev/null 2>&1 && nproc || sysctl -n hw.ncpu)"

configure_only=0
do_clean=0
target=""
while [ $# -gt 0 ]; do
    case "$1" in
        --configure) configure_only=1 ;;
        --clean) do_clean=1 ;;
        --target) target="${2:?--target needs a value}"; shift ;;
        -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

if [ ! -f "$SOURCE_DIR/CMakeLists.txt" ]; then
    echo "Initializing the pinned Azahar submodule ..."
    git -C "$ROOT" submodule update --init --recursive azahar
fi
if [ ! -f "$EMSDK_ROOT/emsdk_env.sh" ]; then
    echo "Pinned Emscripten SDK not found at $EMSDK_ROOT." >&2
    echo "Run ./setup_web_toolchain.sh, or set EMSDK to an existing SDK root." >&2
    exit 1
fi

actual_azahar_rev="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
if [ "$actual_azahar_rev" != "$AZAHAR_UPSTREAM_REV" ]; then
    echo "Azahar source mismatch: expected $AZAHAR_UPSTREAM_REV, got $actual_azahar_rev" >&2
    echo "Run: git submodule update --init --recursive azahar" >&2
    exit 1
fi
"$ROOT/apply_upstream_patches.sh"

# shellcheck disable=SC1091
source "$EMSDK_ROOT/emsdk_env.sh" >/dev/null 2>&1
EMSDK_NODE_DIR="$EMSDK_ROOT/node/$EMSDK_NODE_VERSION/bin"
if [ -d "$EMSDK_NODE_DIR" ]; then
    export PATH="$EMSDK_NODE_DIR:$PATH"
fi
actual_emcc_version="$(emcc --version | sed -n '1s/.* \([0-9][0-9.]*\) .*/\1/p')"
if [ "$actual_emcc_version" != "$EMSDK_VERSION" ] &&
   [ "${AZAHAR_ALLOW_TOOLCHAIN_MISMATCH:-0}" != "1" ]; then
    echo "Emscripten mismatch: expected $EMSDK_VERSION, got ${actual_emcc_version:-unknown}." >&2
    echo "Run ./setup_web_toolchain.sh or set AZAHAR_ALLOW_TOOLCHAIN_MISMATCH=1." >&2
    exit 1
fi
echo "Using $(emcc --version | head -1)"

if [ "$do_clean" = "1" ]; then
    case "$BUILD_DIR" in
        /|"$HOME"|"$ROOT")
            echo "Refusing to remove unsafe build directory: $BUILD_DIR" >&2
            exit 1
            ;;
    esac
    rm -rf "$BUILD_DIR"
fi

if [ "$do_clean" = "1" ] || [ "$configure_only" = "1" ] || [ ! -f "$BUILD_DIR/build.ninja" ]; then
    echo "Configuring into $BUILD_DIR ..."
    emcmake cmake -B "$BUILD_DIR" -S "$SOURCE_DIR" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_PROJECT_TOP_LEVEL_INCLUDES="$ROOT/cmake/emscripten-web-shims.cmake" \
        -DCMAKE_PROJECT_LibreSSL_INCLUDE="$ROOT/cmake/emscripten-libressl.cmake" \
        -DCMAKE_PROJECT_citra_INCLUDE="$ROOT/cmake/emscripten-web-overlay.cmake" \
        -DAZAHAR_WEB_PORT_DIR="$ROOT/port" \
        -DAZAHAR_WEB_ASSERTIONS="${AZAHAR_WEB_ASSERTIONS:-OFF}" \
        -DBUILD_SHARED_LIBS=OFF \
        -DENABLE_QT=OFF \
        -DENABLE_SDL2=ON \
        -DENABLE_SDL2_FRONTEND=ON \
        -DENABLE_SOFTWARE_RENDERER=ON \
        -DENABLE_OPENGL=OFF \
        -DENABLE_VULKAN=OFF \
        -DENABLE_OPENAL=OFF \
        -DENABLE_LIBUSB=OFF \
        -DENABLE_CUBEB=OFF \
        -DENABLE_ROOM=OFF \
        -DENABLE_WEB_SERVICE=OFF \
        -DENABLE_SCRIPTING=OFF \
        -DENABLE_TESTS=OFF
fi

[ "$configure_only" = "1" ] && exit 0

if [ -n "$target" ]; then
    cmake --build "$BUILD_DIR" --target "$target" --parallel "$JOBS"
else
    cmake --build "$BUILD_DIR" --target azahar_web --parallel "$JOBS"
fi

if [ -f "$BUILD_DIR/bin/Release/azahar.wasm" ]; then
    echo
    echo "Built: $BUILD_DIR/bin/Release/azahar.{js,wasm}"
    AZAHAR_BUILD_DIR="$BUILD_DIR" node "$ROOT/tests/rebuilt_artifact_smoke.cjs"
    echo
    # Deliberately NOT copied over web/. Those are the fork's artifacts, and
    # web/azahar_webgl2.* cannot be rebuilt here at all, so overwriting them
    # would trade a working accelerated renderer for a reconstruction.
    echo "To try them without touching web/:"
    echo "  ./stage_web.sh /tmp/azahar-staged"
    echo "  AZAHAR_WEB_DIR=/tmp/azahar-staged node tests/benchmark_browser.cjs \\"
    echo "    --artifact software --no-state --warmup-seconds 60 --duration-seconds 10"
fi
