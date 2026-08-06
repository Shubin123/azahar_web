#!/bin/bash
set -e

# Resolve script location robustly (WSL-safe)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==================================="
echo "Building WebGPU Wrapper (Web)"
echo "==================================="
echo "Project root: $PROJECT_ROOT"

# Ensure emcmake is available
if ! command -v emcmake >/dev/null 2>&1; then
    echo "Error: emcmake not found."
    echo "Did you run: source emsdk_env.sh ?"
    exit 1
fi

BUILD_DIR="$PROJECT_ROOT/build-web"
mkdir -p "$BUILD_DIR"

cd "$BUILD_DIR"

echo "Configuring with emcmake..."
emcmake cmake "$PROJECT_ROOT" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_TESTS=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DINTEGRATE_AZAHAR=ON \
    -DUSE_WEBGPU=ON


echo "Building..."
cmake --build . -j$(nproc)

echo ""
echo "==================================="
echo "Web build complete!"
echo "==================================="
echo ""
# echo "Artifacts:"
# echo "  $BUILD_DIR/examples/"
