#!/usr/bin/env bash
# Configure and build the Azahar web artifacts on macOS/Linux.
#
# The Windows path uses build_web.bat against a pre-existing build directory.
# This script owns configuration as well, because the Emscripten build needs
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
#   EMSDK             Emscripten SDK root (default: $HOME/emsdk)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${AZAHAR_BUILD_DIR:-$ROOT/build-web-sw}"
EMSDK_ROOT="${EMSDK:-$HOME/emsdk}"
SOURCE_DIR="$ROOT/azahar"
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

if [ ! -d "$SOURCE_DIR" ]; then
    echo "Missing $SOURCE_DIR. Clone it first:" >&2
    echo "  git clone --recurse-submodules https://github.com/azahar-emu/azahar.git azahar" >&2
    exit 1
fi
if [ ! -f "$EMSDK_ROOT/emsdk_env.sh" ]; then
    echo "Emscripten SDK not found at $EMSDK_ROOT. Set EMSDK or install emsdk." >&2
    exit 1
fi

# shellcheck disable=SC1091
source "$EMSDK_ROOT/emsdk_env.sh" >/dev/null 2>&1
echo "Using $(emcc --version | head -1)"

[ "$do_clean" = "1" ] && rm -rf "$BUILD_DIR"

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
    # The upstream checkout has no web frontend target, so a bare build
    # produces the emulator libraries only. See PROJECT.md, "Build
    # reproducibility": src/citra_sdl/ and the web CMake targets are part of
    # the port and are not in this repository.
    cmake --build "$BUILD_DIR" --parallel "$JOBS"
fi

if [ -f "$BUILD_DIR/bin/Release/azahar.wasm" ]; then
    echo
    echo "Built: $BUILD_DIR/bin/Release/azahar.{js,wasm}"
    echo
    # Deliberately NOT copied over web/. Those are the fork's artifacts, and
    # web/azahar_webgl2.* cannot be rebuilt here at all, so overwriting them
    # would trade a working accelerated renderer for a reconstruction.
    echo "To try them without touching web/:"
    echo "  ./stage_web.sh /tmp/azahar-staged"
    echo "  AZAHAR_WEB_DIR=/tmp/azahar-staged node tests/benchmark_browser.cjs \\"
    echo "    --artifact software --no-state --warmup-seconds 60 --duration-seconds 10"
fi
