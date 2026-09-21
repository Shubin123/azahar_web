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

The `web/` folder is self-contained and `.github/workflows/pages.yml` publishes it on every relevant `main` push. The included `coi-serviceworker.js` handles the required cross-origin isolation headers automatically on static hosts. The single `index.html` page provides Auto, accelerated WebGL2, and compatibility renderer modes, 1x-4x internal-resolution scaling, a 1x-4x fast-forward target for cutscenes, and per-game persistent browser save slots; switching renderers performs the fresh-page reload required by browser canvas contexts.

## What's Included

```
web/                    # Ready-to-serve web application
  index.html            # Main page (accelerated WebGL2 first)
  index_webgl2.html     # Legacy redirect into index.html renderer selection
  azahar_ui.js          # UI controller (ROM loading, run loop, FPS display)
  azahar_savestates.js  # IndexedDB persistence for compressed per-game save slots
  coi-serviceworker.js  # COOP/COEP header injection for static hosts
  server.cjs            # Local dev server with isolation headers
  azahar.js             # Emscripten glue (software renderer)
  azahar.wasm           # WebAssembly binary (software renderer, ~10 MB)
  azahar_webgl2.js      # Emscripten glue (WebGL2 renderer)
  azahar_webgl2.wasm    # WebAssembly binary (WebGL2, ~10 MB)
tests/                  # Test suite
  web_artifact_smoke.cjs  # Offline WASM validation
  prepare_rom.cjs         # Verify/flag a decrypted dump as a test title
  renderer_autofallback.cjs # Auto renderer switch, end to end through the UI
  benchmark_browser.cjs   # Headless Chrome performance benchmark
  browser_regression.cjs  # E2E rendering regression test
  title_transition_regression.cjs # Cold-boot title-to-game regression
  config.cjs              # Shared test configuration
build_web.bat           # Windows build script (requires Emscripten SDK)
build_web.sh            # Reproducible software-WASM build (macOS/Linux/Git Bash)
setup_web_toolchain.sh  # Pins source, Emscripten, and npm dependencies
stage_web.sh            # Stages rebuilt software + checked-in WebGL2 artifacts
port/                   # Reconstructed, repo-owned Emscripten frontend
cmake/                  # Non-invasive upstream Emscripten compatibility shims
apply_upstream_patches.sh # Idempotent public-source performance patch installer
serve_web.bat           # Windows shortcut to start local server
PROJECT.md              # Detailed architecture and optimization history
```

## Requirements

**To run:** Any modern browser with WebAssembly and SharedArrayBuffer support (Chrome 91+, Firefox 79+, Safari 15.2+).

**To build from source:** Git, CMake, Ninja, and enough disk for an Emscripten
C++ build. The setup script installs the pinned Emscripten SDK and uses its
pinned Node 24 runtime for the browser-test dependencies; Azahar itself is a
pinned public submodule.

## Building from Source

```bash
# Clone with the exact upstream emulator source
git clone --recurse-submodules https://github.com/Shubin123/azahar_web.git
cd azahar_web
./setup_web_toolchain.sh
./build_web.sh
./stage_web.sh /tmp/azahar-staged
```

`build_web.sh` produces `build-web-sw/bin/Release/azahar.{js,wasm}` and validates
the result. It intentionally does not overwrite `web/`. `stage_web.sh` creates
a servable directory containing the rebuilt software artifact and the
checked-in accelerated artifact.

The build verifies the pinned submodule revision and idempotently applies
`patches/public-upstream-web-performance.patch`. It refuses to patch over
unrelated edits, so a locally modified emulator checkout cannot silently enter
a supposedly reproducible artifact.

### macOS / Linux

`./build_web.sh` configures and builds in one step, injecting the repo-owned
frontend under `port/` and the Emscripten shims under `cmake/`:

```bash
./build_web.sh                      # configure (if needed) and build
./build_web.sh --target citra_core  # one target
./build_web.sh --clean              # start from scratch
```

The build uses the exact Azahar submodule revision and Emscripten 6.0.9. It
prefers `.toolchains/emsdk`, then `$HOME/emsdk`; set `$EMSDK` to override.
`AZAHAR_WEB_ASSERTIONS=ON ./build_web.sh --configure` enables readable runtime
assertions for diagnostics.

The repository now rebuilds the software renderer from public upstream sources
without the unavailable private fork. The original `renderer_webgl2/` source is
still unavailable, so `web/azahar_webgl2.{js,wasm}` remains a checked-in,
tested binary artifact rather than a locally reproducible target.

On the 2in1 Horses title-select fixture, the rebuilt release artifact sustains
about 60 game FPS and 100% guest speed after warmup on this Apple M1 Mac. Browser
callback cadence is deliberately not used as an FPS claim: the frame loop may
advance more than one guest frame per callback when the browser presents at a
lower cadence. The checked-in software artifact reaches the same 60 FPS cap.

## Testing

```bash
# Smoke test (no browser needed)
node tests/web_artifact_smoke.cjs

# Validate the locally rebuilt software artifact
npm run smoke:rebuilt

# Stage it and boot a real ROM without touching web/
./stage_web.sh /tmp/azahar-staged
AZAHAR_WEB_DIR=/tmp/azahar-staged npm run smoke:rebuilt-browser

# Include a native save/load round-trip in the rebuilt artifact audit
AZAHAR_WEB_DIR=/tmp/azahar-staged \
  node tests/rebuilt_browser_smoke.cjs --save-state

# Performance benchmark (requires Chrome)
AZAHAR_CHROME_ARGS=--use-angle=vulkan node tests/benchmark_browser.cjs --artifact webgl2 --duration-seconds 15 --warmup-seconds 5

# Rendering regression test (requires a decrypted ROM)
AZAHAR_ROM_PATH=test_games/your_rom.3ds node tests/browser_regression.cjs

# Prepare a decrypted dump as a test title (verifies it, copies into test_games/)
node tests/prepare_rom.cjs '/path/to/game.3ds'

# Auto renderer fallback, driven through the production UI
node tests/renderer_autofallback.cjs
AZAHAR_CHROME_ARGS=--use-angle=swiftshader \
  node tests/renderer_autofallback.cjs --expect-none

# Cold boot, press the title-screen touch target, and sustain gameplay
AZAHAR_ROM_PATH=test_games/your_rom.3ds node tests/run.cjs --transition

# Save, restore, reload, and delete an IndexedDB-backed save through the UI
node tests/run.cjs --save-states --artifact webgl2
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

### Renderer dropdown

| Setting | Behaviour |
|---|---|
| **Auto — best for this machine** (default) | Starts accelerated, and switches only if this GPU fails or cannot keep up. The result is remembered per GPU adapter, so later visits start on the right renderer immediately. |
| **Accelerated (WebGL2)** | Pinned. Never switched for being slow; only a backend that cannot present at all still falls back. |
| **Compatibility (software)** | Pinned software rasterizer. |

Auto also leaves an accelerated backend that *stalls* rather than fails. Some
drivers throttle frame production instead of rejecting work, and because the
emulator advances one guest step per browser frame, that caps speed no matter how
cheap each frame is. On macOS/ANGLE-Metal, `2in1 Horses 3D` runs at 11 game FPS
(18% speed) on WebGL2 and 60 game FPS (101%) on the software renderer, so Auto
switches after ~14 seconds of sustained low throughput. The decision uses the
callback duty cycle, not the frame rate alone: a slow frame rate with a *busy*
callback is CPU-bound, where switching would be worse.

The verdict is keyed by the WebGL adapter string, so a result measured on one
GPU never suppresses the accelerated path on another — Windows D3D11 and Vulkan
machines keep their own answer, and the D3D11 CPU-vertex selection is untouched.
A repeat visit then costs a redirect (~0.1 s) instead of another timed probe and
a second ROM upload. "Re-measure this machine" clears it, and so does picking a
renderer by hand. `?autoFallback=0` pins the current renderer and ignores any
stored verdict, which benchmarks pass so they measure what they asked for.

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
