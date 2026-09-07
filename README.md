# Azahar Web — Nintendo 3DS Emulator in the Browser

A WebAssembly port of [Azahar](https://github.com/azahar-emu/azahar) (Citra fork) that runs Nintendo 3DS games directly in the browser.

## Quick Start

### Run Locally

```bash
# Clone the repo
git clone https://github.com/Shubin123/azahar_web.git
cd azahar_web

# Start the local server (requires Node.js)
node web/server.cjs
# Or on Windows:
serve_web.bat
```

Open `http://localhost:8765` in Chrome, then load a **decrypted** `.3ds` ROM file.

### Deploy to GitHub Pages

The `web/` folder is self-contained. Enable GitHub Pages pointed at the repo root or the `web/` directory. The included `coi-serviceworker.js` handles the required cross-origin isolation headers automatically on static hosts. The single `index.html` page provides Auto, accelerated WebGL2, and compatibility renderer modes; switching modes performs the fresh-page reload required by browser canvas contexts.

## What's Included

```
web/                    # Ready-to-serve web application
  index.html            # Main page (accelerated WebGL2 first)
  index_webgl2.html     # Legacy redirect into index.html renderer selection
  azahar_ui.js          # UI controller (ROM loading, run loop, FPS display)
  coi-serviceworker.js  # COOP/COEP header injection for static hosts
  server.cjs            # Local dev server with isolation headers
  azahar.js             # Emscripten glue (software renderer)
  azahar.wasm           # WebAssembly binary (software renderer, ~10 MB)
  azahar_webgl2.js      # Emscripten glue (WebGL2 renderer)
  azahar_webgl2.wasm    # WebAssembly binary (WebGL2, ~10 MB)
tests/                  # Test suite
  web_artifact_smoke.cjs  # Offline WASM validation
  benchmark_browser.cjs   # Headless Chrome performance benchmark
  browser_regression.cjs  # E2E rendering regression test
  title_transition_regression.cjs # Cold-boot title-to-game regression
  config.cjs              # Shared test configuration
build_web.bat           # Windows build script (requires Emscripten SDK)
serve_web.bat           # Windows shortcut to start local server
PROJECT.md              # Detailed architecture and optimization history
```

## Requirements

**To run:** Any modern browser with WebAssembly and SharedArrayBuffer support (Chrome 91+, Firefox 79+, Safari 15.2+).

**To build from source:** Emscripten SDK 6.0+, CMake, Ninja, and the Azahar source tree checked out at `./azahar/`.

## Building from Source

```bash
# Clone with the upstream emulator source
git clone https://github.com/Shubin123/azahar_web.git
cd azahar_web
git clone https://github.com/azahar-emu/azahar.git azahar

# Configure (requires Emscripten activated in your shell)
emcmake cmake -B build-webgl2-opengl -S azahar -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DENABLE_QT=OFF \
  -DENABLE_SDL2=ON \
  -DENABLE_SDL2_FRONTEND=ON \
  -DENABLE_SOFTWARE_RENDERER=ON \
  -DENABLE_OPENGL=ON \
  -DENABLE_WEBGL2_RENDERER=ON \
  -DENABLE_VULKAN=OFF \
  -DENABLE_OPENAL=OFF \
  -DENABLE_LIBUSB=OFF \
  -DENABLE_CUBEB=OFF \
  -DENABLE_ROOM=OFF \
  -DENABLE_WEB_SERVICE=OFF \
  -DENABLE_SCRIPTING=OFF \
  -DENABLE_TESTS=OFF

# Build both the fallback and accelerated artifacts
cmake --build build-webgl2-opengl --parallel 8 --target azahar_web_bundle
```

The `azahar_web_bundle` target builds both renderers and copies their artifacts into `web/` automatically.

## Testing

```bash
# Smoke test (no browser needed)
node tests/web_artifact_smoke.cjs

# Performance benchmark (requires Chrome)
AZAHAR_CHROME_ARGS=--use-angle=vulkan node tests/benchmark_browser.cjs --artifact webgl2 --duration-seconds 15 --warmup-seconds 5

# Rendering regression test (requires a decrypted ROM)
AZAHAR_ROM_PATH=test_games/your_rom.3ds node tests/browser_regression.cjs

# Cold boot, press the title-screen touch target, and sustain gameplay
AZAHAR_ROM_PATH=test_games/your_rom.3ds node tests/run.cjs --transition
```

## Architecture

- **CPU**: Pretranslated, direct-threaded `dyncom` ARM11 execution optimized by the browser's WebAssembly JIT; the incomplete per-block JavaScript JIT remains disabled
- **Graphics**: Accelerated OpenGL-on-WebGL2 by default, with an explicit software fallback (`?renderer=software`). Auto uses hardware vertices on Vulkan/native-GL ANGLE and the reliable CPU-vertex WebGL2 path on D3D11; `?hwShader=1` forces hardware vertices for diagnostics.
- **Frontend**: SDL2 → HTML5 Canvas with `requestAnimationFrame` pacing
- **Threading**: SharedArrayBuffer-based pthreads (requires COOP/COEP isolation)
- **Memory**: 768 MB initial, growable to 4 GB

See [PROJECT.md](PROJECT.md) for detailed optimization history and benchmarks.

## Performance

Tested with Super Mario 3D Land (demo), Chrome headless:

| Renderer | Browser FPS | Game FPS | Speed | GPU cmd time |
|----------|-------------|----------|-------|--------------|
| Software compatibility | 31.3 | 12.6 | 21% | 66.88 ms |
| WebGL2 + D3D11 ANGLE (CPU vertices) | 42.8 | 16.8 | 28% | 39.70 ms |
| WebGL2 + Vulkan ANGLE | 140.1 | 68.9 | 115% | 4.44 ms |

The accelerated renderer is attempted first and stays active on D3D11 rather
than falsely falling back. Vulkan/native-GL ANGLE paths are currently the
fastest and pass the saved-state visual benchmark at greater than native 60
FPS. Chrome does not let a web page select its ANGLE backend; for a local
Vulkan run, launch Chrome with `--use-angle=vulkan`. D3D11 Auto deliberately
uses CPU vertex translation because forcing generated PICA vertex shaders can
block that backend's compiler for roughly a minute.

Audio currently uses the null sink in web builds because restoring SDL's
deprecated ScriptProcessor device produces invalid zero-sized callbacks. An
AudioWorklet-backed frontend sink is the remaining audio integration task.

## License

This wrapper repo provides build tooling and a web frontend for the [Azahar emulator](https://github.com/azahar-emu/azahar). See the upstream repository for the emulator's license terms.
