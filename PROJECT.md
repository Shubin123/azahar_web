# Project: Azahar WebAssembly Proof-of-Concept

## Architecture
Azahar WebAssembly port targeting modern web browsers via Emscripten.
- **CPU Subsystem**: Portable `dyncom` ARM11 C++ interpreter (JIT `dynarmic` disabled via `ARCHITECTURE=GENERIC`).
- **Graphics Subsystem**: `SwRenderer::RendererSoftware` rasterizer operating on 32-bit RGBA8 framebuffers (OpenGL & Vulkan hardware renderers disabled).
- **Frontend / Windowing**: Adapted `citra_sdl` / `EmuWindow_SDL2_SW` presenting software framebuffers to an HTML5 `<canvas id="canvas">`.
- **Event Loop**: Main loop unrolled into Emscripten event loop / exported C per-frame step function (`azahar_step_frame`).
- **File System / Loader**: HTML File API -> Emscripten MEMFS (`FS.writeFile` with ownership transfer) -> C++ `Core::System::Load()` via standard C file IO. The upload keeps the selected filename extension so the core chooses the correct loader.
- **Browser Threading**: Emscripten pthreads use `SharedArrayBuffer` workers. The served page must be cross-origin isolated with COOP/COEP headers.
- **Overlay Layer**: `azahar-webgpu/` CMake overlay cleanly linking `citra_core`.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Emscripten CMake Build Setup | `emcmake cmake` configures C++20 build cleanly targeting WebAssembly | M1 | ORIGINAL_REQUEST §R1 |
| 2 | JIT Exclude & Dyncom Routing | Disable `dynarmic` JIT and route CPU execution to portable `dyncom` interpreter | M1 | ORIGINAL_REQUEST §R1 |
| 3 | Software Renderer Enablement | Enable `renderer_software` backend and disable desktop OpenGL 4.3 / Vulkan | M1 | ORIGINAL_REQUEST §R1 |
| 4 | External Dependency Stubbing | Exclude desktop dependencies (cubeb, openal, libusb, room) and configure cryptopp | M1 | Survey Explorer 1 |
| 5 | Non-blocking Canvas Frontend | Adapt `EmuWindow_SDL2_SW` for single-frame non-blocking presentation to HTML5 canvas | M2 | ORIGINAL_REQUEST §R2 |
| 6 | Main Loop Event Unrolling | Replace blocking while loops with `emscripten_set_main_loop` / `azahar_step_frame` | M2 | Survey Explorer 2 |
| 7 | HTML5 Canvas Framebuffer Blit | Output rendered 3DS framebuffers directly onto `<canvas>` element | M2 | ORIGINAL_REQUEST §R2 |
| 8 | Web UI & Game File Loader | HTML/JS interface to load `.3ds`, `.3dsx`, `.cia`, `.elf` into MEMFS | M3 | ORIGINAL_REQUEST §R2 |
| 9 | WASM Memory and Thread Safety | Set linker flags (`INITIAL_MEMORY=512MB`, `STACK_SIZE=2MB`, `ALLOW_MEMORY_GROWTH=1`, `MAXIMUM_MEMORY=4GB`) and preallocate a 32-worker pthread pool | M4 | Survey Explorer 3 |
| 10 | Memory Access Bounds Guard | Prevent WASM out-of-bounds traps (`RuntimeError: memory access out of bounds`) | M4 | ORIGINAL_REQUEST §Acceptance Criteria |
| 11 | WebGPU Overlay Alignment | Ensure `azahar-webgpu/` overlay architecture builds alongside Emscripten targets | M4 | ORIGINAL_REQUEST §R3 |
| 12 | E2E Test Suite & Real-ROM Pass | Verify WASM instantiation, decrypted ROM loading, continuous emulation, and canvas output | M5 | ORIGINAL_REQUEST §Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Emscripten Build & CMake Setup | CMake configuration, dependency stubbing, dyncom & renderer_software selection | None | COMPLETE |
| M2 | Canvas Frontend & Loop Unrolling | `EmuWindow_SDL2_SW` adaptation, main loop unrolling, HTML5 canvas output | M1 | COMPLETE |
| M3 | Web UI & ROM Loading Pipeline | Minimal HTML/JS frontend, MEMFS file mounting, C++ file loading API | M2 | COMPLETE |
| M4 | WASM Memory Safety, Threading & WebGPU Overlay | Growable 512MB-to-4GB memory, 2MB stack, 32-worker pthread pool, out-of-bounds guards, WebGPU overlay link | M1, M2 | COMPLETE |
| M5 | E2E Verification & Real-ROM Rendering | Browser-driven WASM initialization, decrypted ROM execution, continuous frame loop, and canvas rendering verification | M1, M2, M3, M4 | COMPLETE |

## Interface Contracts
### Web UI ↔ WebAssembly Module (`web/azahar.js` / `web/azahar.wasm`)
- `FS.writeFile(path, data, {canOwn: true})`: JS mounts uploaded ROM bytes to Emscripten MEMFS without an extra browser-heap copy. The path retains the selected extension (for example, `/rom.3ds`).
- `azahar_init()`: C++ export initializing `Core::System` and software renderer window. Returns `0` on success.
- `azahar_load_rom(const char* path)`: C++ export calling `Core::System::Load()`. Returns `0` on success.
- `azahar_step_frame()`: C++ export stepping 1 emulation frame, executing CPU ticks and blitting framebuffer to canvas.
- `azahar_run_loop()`: C++ export starting the browser-friendly Emscripten main loop.
- `azahar_shutdown()`: C++ export stopping emulation and releasing frontend resources.

### Core ↔ EmuWindow Software Presentation
- `EmuWindow_SDL2_SW::PresentSingleFrame()`: Non-blocking function blitting current `RendererSoftware` framebuffers to SDL surface and updating HTML5 canvas.

## Code Layout
- `azahar/CMakeLists.txt`: Root CMake configuration for Emscripten toolchain options.
- `azahar/src/core/`: Core emulator logic, `dyncom` CPU interpreter (`src/core/arm/dyncom`).
- `azahar/src/video_core/`: Software rasterizer (`src/video_core/renderer_software`).
- `azahar/src/citra_sdl/`: SDL2 software window frontend (`emu_window/emu_window_sdl2_sw.cpp`).
- `azahar-webgpu/`: Overlay architecture and WebGPU targets.
- `web/`: Web UI and generated release artifacts (`index.html`, `azahar_ui.js`, `azahar.js`, `azahar.wasm`).

## Current Build Status

The Emscripten configuration and Ninja build complete on Windows with Emscripten 6.0.6 and eight parallel jobs:

```powershell
cmake -B build-web -S azahar -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DENABLE_QT=OFF -DENABLE_SDL2=ON -DENABLE_SDL2_FRONTEND=ON -DENABLE_SOFTWARE_RENDERER=ON -DENABLE_OPENGL=OFF -DENABLE_VULKAN=OFF -DENABLE_SCRIPTING=OFF -DENABLE_TESTS=OFF
cmake --build build-web --parallel 8
```

Artifacts are generated under `build-web/bin/Release/` and automatically synchronized into `web/` by the `azahar_web_assets` CMake target. `build_web.bat` runs that target and verifies both files have matching SHA-256 hashes, so no manual copy step is needed. `node tests/web_artifact_smoke.cjs` validates the synchronized artifacts, generated API names, and WASM compilation. `tests/browser_regression.cjs`, supplied with a decrypted local `.3ds` through `AZAHAR_ROM_PATH`, verifies cross-origin isolation, initialization, ROM mounting/loading, automatic run-loop startup, canvas output, and browser errors. The accelerated display-scheduled loop detected a multi-color kiosk-demo framebuffer in about 8 seconds in Chrome. An encrypted CIA is expected to fail cleanly with the UI's encrypted-ROM status.

## Performance & Benchmarking

### Optimization History

| # | Optimization | Description | Impact |
|---|-------------|-------------|--------|
| 1 | SDL surface caching | Reuse SDL surfaces across frames instead of alloc/free per frame (~700 KB/frame saved) | Eliminates per-frame malloc overhead |
| 2 | Emscripten direct framebuffer write | Write software renderer pixels directly to SDL window surface; bypass intermediate SDL surface + SDL_BlitSurface | Saves one full-buffer memcpy + blit per screen per frame |
| 3 | Skip SDL_RenderClear on Emscripten | Screen blits overwrite the entire window area; clearing first is wasted work | Saves a full-frame fill per presentation |
| 4 | Skip SDL_UpdateWindowSurface on Emscripten | No-op on the Emscripten canvas backend | Eliminates an unnecessary call per frame |
| 5 | Software rasterizer inline execution | `sw_rasterizer.cpp` runs scanline processing inline on the main thread instead of dispatching to worker pool | Avoids browser main-thread blocking on pthread condition variables |
| 6 | PTHREAD_POOL_SIZE reduced 32→8 | Software rasterizer runs inline; fewer workers needed | Reduces thread creation overhead and memory pressure |
| 7 | Slice count / deadline tuning | 20 RunLoop slices with a 14 ms deadline balances emulation throughput against browser responsiveness | +3% emulation speed (90% → 93%) |

### Benchmark Results (2026-08-06)

ROM: Super Mario 3D Land (Europe) (Kiosk Demo), 128 MB decrypted .3ds
Browser: Chrome headless, 100 benchmark frames, 20 warmup frames, 3 repeats

| Run | Avg Frame | FPS | Emulation Speed | Swap Time | σ |
|-----|-----------|-----|-----------------|-----------|----|
| 1   | 16.74 ms  | 59.7 | 93%             | 0.76 ms   | 0.28 ms |
| 2   | 16.71 ms  | 59.8 | 94%             | 0.76 ms   | 0.03 ms |
| 3   | 16.71 ms  | 59.8 | 93%             | 0.79 ms   | 0.05 ms |
| **Agg** | **16.72 ms** | **59.8** | **93%** | **0.77 ms** | — |

The step rate is capped by the browser's `requestAnimationFrame` (~60 Hz). The
tight standard deviation (σ < 0.3 ms) indicates stable, jitter-free execution.
The dyncom CPU interpreter is the primary remaining bottleneck.

### Benchmark Commands

```powershell
# Quick smoke test: verify artifacts are in sync
node tests/web_artifact_smoke.cjs

# Browser benchmark (requires Puppeteer)
npm install --no-save puppeteer-core
$env:CHROME_PATH = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
node tests/benchmark_browser.cjs --frames 300 --warmup 30 --repeat 3

# With profiling (perf counter samples every ~1s)
node tests/benchmark_browser.cjs --frames 300 --warmup 30 --repeat 1 --profile

# Direct Node.js benchmark (non-pthreads builds only)
node tests/benchmark.cjs --frames 300 --warmup 30 --repeat 3
```

Results are written to `tests/benchmark_results.json`.
