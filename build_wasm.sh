#!/bin/bash
# Azahar Emscripten CMake Configuration Script
set -e

export EM_CONFIG="$HOME/.emscripten"
export EM_CACHE="$LOCALAPPDATA/emscripten_cache"
export EMSDK="C:/Users/shubadub/emsdk"
export EMSDK_PYTHON="$EMSDK/python/3.13.3_64bit/python.exe"
export SSLKEYLOGFILE="$TEMP/ssl-keys.log"

cd "C:/Users/shubadub/Documents/azahar"

# Clean previous build — try old dir first, fall back to build-web2 if locked
rm -rf build-web 2>/dev/null || true
BUILD_DIR="build-web"
if [ -d "build-web" ]; then
    echo "build-web is locked, using build-web2 instead"
    BUILD_DIR="build-web2"
    rm -rf build-web2 2>/dev/null || true
fi

echo "=== Running CMake configuration via emcmake ==="
# BUILD_SHARED_LIBS=OFF prevents WASM side-module (.so) generation.
# The citra_sdl CMakeLists already provides all necessary target_link_options
# (pthreads, memory, SDL, etc.), so the old CMAKE_EXE_LINKER_FLAGS are removed.
# CMAKE_SHARED_LINKER_FLAGS is also removed — shared libs should not be built.
"$EMSDK_PYTHON" "$EMSDK/upstream/emscripten/emcmake.py" cmake \
  -G Ninja \
  -B "$BUILD_DIR" \
  -S azahar \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_STANDARD=20 \
  -DBUILD_SHARED_LIBS=OFF \
  -DENABLE_QT=OFF \
  -DENABLE_SDL2=ON \
  -DENABLE_SDL2_FRONTEND=ON \
  -DENABLE_SOFTWARE_RENDERER=ON \
  -DENABLE_WEBGL2_RENDERER=ON \
  -DENABLE_OPENGL=OFF \
  -DENABLE_VULKAN=OFF \
  -DENABLE_CUBEB=OFF \
  -DENABLE_OPENAL=OFF \
  -DENABLE_ROOM=OFF \
  -DENABLE_ROOM_STANDALONE=OFF \
  -DENABLE_WEB_SERVICE=OFF \
  -DENABLE_LIBUSB=OFF \
  -DENABLE_TESTS=OFF \
  -DCRYPTOPP_DISABLE_ASM=ON \
  -DCITRA_WARNINGS_AS_ERRORS=OFF \
  -DCITRA_USE_PRECOMPILED_HEADERS=OFF \
  -DCMAKE_C_FLAGS="-pthread -msimd128" \
  -DCMAKE_CXX_FLAGS="-pthread -msimd128"

echo "=== CMake configuration complete ==="
echo "=== Starting build ==="
cmake --build "$BUILD_DIR" -- -j4 2>&1 | tail -100
echo "=== Build complete ==="
