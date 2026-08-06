#!/bin/bash
# Azahar Emscripten CMake Configuration Script
set -e

export EM_CONFIG="$HOME/.emscripten"
export EM_CACHE="$LOCALAPPDATA/emscripten_cache"
export EMSDK_PYTHON="C:/Users/shubadub/AppData/Local/Programs/Python/Python312/python.exe"
export SSLKEYLOGFILE="$TEMP/ssl-keys.log"

EM_DIR="C:/Program Files/Unity/Hub/Editor/2022.3.20f1/Editor/Data/PlaybackEngines/WebGLSupport/BuildTools/Emscripten"

cd "C:/Users/shubadub/Documents/azahar"

# Clean previous build
rm -rf build-web

echo "=== Running CMake configuration via emcmake ==="
"$EMSDK_PYTHON" "$EM_DIR/emscripten/emcmake.py" cmake \
  -G Ninja \
  -B build-web \
  -S azahar \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_STANDARD=20 \
  -DENABLE_QT=OFF \
  -DENABLE_SDL2=ON \
  -DENABLE_SDL2_FRONTEND=ON \
  -DENABLE_SOFTWARE_RENDERER=ON \
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
  -DCMAKE_CXX_FLAGS="-s USE_SDL=2" \
  -DCMAKE_EXE_LINKER_FLAGS="-s INITIAL_MEMORY=512MB -s STACK_SIZE=2MB -s ALLOW_MEMORY_GROWTH=1 -s USE_SDL=2 -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"FS\"]' -s NO_EXIT_RUNTIME=1"

echo "=== CMake configuration complete ==="
echo "=== Starting build ==="
cmake --build build-web -- -j1 2>&1 | tail -100
echo "=== Build complete ==="
