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
| 9 | WASM Memory and Thread Safety | Set linker flags (`INITIAL_MEMORY=512MB`, `STACK_SIZE=2MB`, `ALLOW_MEMORY_GROWTH=1`, `MAXIMUM_MEMORY=4GB`) and preallocate an 8-worker pthread pool | M4 | Survey Explorer 3 |
| 10 | Memory Access Bounds Guard | Prevent WASM out-of-bounds traps (`RuntimeError: memory access out of bounds`) | M4 | ORIGINAL_REQUEST §Acceptance Criteria |
| 11 | WebGPU Overlay Alignment | Ensure `azahar-webgpu/` overlay architecture builds alongside Emscripten targets | M4 | ORIGINAL_REQUEST §R3 |
| 12 | E2E Test Suite & Real-ROM Pass | Verify WASM instantiation, decrypted ROM loading, continuous emulation, and canvas output | M5 | ORIGINAL_REQUEST §Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Emscripten Build & CMake Setup | CMake configuration, dependency stubbing, dyncom & renderer_software selection | None | COMPLETE |
| M2 | Canvas Frontend & Loop Unrolling | `EmuWindow_SDL2_SW` adaptation, main loop unrolling, HTML5 canvas output | M1 | COMPLETE |
| M3 | Web UI & ROM Loading Pipeline | Minimal HTML/JS frontend, MEMFS file mounting, C++ file loading API | M2 | COMPLETE |
| M4 | WASM Memory Safety, Threading & WebGPU Overlay | Growable 512MB-to-4GB memory, 2MB stack, 8-worker pthread pool, out-of-bounds guards, WebGPU overlay link | M1, M2 | COMPLETE |
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
cmake -B build-web2 -S azahar -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DENABLE_QT=OFF -DENABLE_SDL2=ON -DENABLE_SDL2_FRONTEND=ON -DENABLE_SOFTWARE_RENDERER=ON -DENABLE_OPENGL=OFF -DENABLE_VULKAN=OFF -DENABLE_OPENAL=OFF -DENABLE_LIBUSB=OFF -DENABLE_CUBEB=OFF -DENABLE_ROOM=OFF -DENABLE_WEB_SERVICE=OFF -DENABLE_SCRIPTING=OFF -DENABLE_TESTS=OFF
cmake --build build-web2 --parallel 8
```

Artifacts are generated under `build-web/bin/Release/` and automatically synchronized into `web/` by the `azahar_web_assets` CMake target. `build_web.bat` runs that target and verifies both files have matching SHA-256 hashes, so no manual copy step is needed. `node tests/web_artifact_smoke.cjs` validates the synchronized artifacts, generated API names, and WASM compilation. `tests/browser_regression.cjs`, supplied with a decrypted local `.3ds` through `AZAHAR_ROM_PATH`, verifies cross-origin isolation, initialization, ROM mounting/loading, automatic run-loop startup, canvas output, and browser errors. The accelerated display-scheduled loop detected a multi-color kiosk-demo framebuffer in about 8 seconds in Chrome. An encrypted CIA is expected to fail cleanly with the UI's encrypted-ROM status.

### Build reproducibility (2026-09-19)

**The toolchain builds; the port's own sources are missing.** These are separate
problems and were previously conflated.

*Toolchain — working, and verified end to end.* `./build_web.sh` builds the
upstream Azahar tree for WebAssembly on macOS (Apple M1, emcc 6.0.9, CMake
4.4.3, Ninja): 1439/1439 steps, zero errors, producing `libcitra_core.a`
(71.4 MB, 242 members), `libvideo_core.a`, `libaudio_core.a`,
`libcitra_common.a` and `libnetwork.a`. The objects are ThinLTO bitcode
carrying the `wasm32-unknown-emscripten` triple, not host code.

Three upstream assumptions hold only on native targets and are compensated in
`cmake/emscripten-web-shims.cmake` and `cmake/emscripten-libressl.cmake`:

- `tsl::robin_map` is only provided by the dynarmic subdirectory, which
  `externals/CMakeLists.txt` adds for x86_64/arm64 only. Emscripten reports
  `ARCHITECTURE=GENERIC`, so it is skipped while `src/video_core` links the
  target unconditionally and the generate step fails.
- LibreSSL selects its entropy backend by platform macro and stops with
  "No arc4random hooks defined for this platform" because Emscripten defines
  `__EMSCRIPTEN__` and `__unix__` but not `__linux__`. It cannot simply be
  dropped: `hle/service/ssl/ssl_c.cpp` includes `<openssl/rand.h>`, so stub
  targets satisfy the link line but not the compile.
  `cmake/emscripten-libressl.cmake` selects the Linux getentropy backend for
  that subproject only.
- `-Wc++11-narrowing` is a clang *default-error*, which the tree's existing `-w`
  cannot suppress. wasm32 has a 32-bit `size_t`, so `ResultVal<u64>` narrows
  inside a braced initializer in `common/expected.h` and `citra_core` will not
  compile. The shim replicates the port's own `if (EMSCRIPTEN)` block, recorded
  in `patches/cmake-web.patch` and absent from upstream HEAD:
  `add_compile_options(-Wno-c++11-narrowing -pthread -msimd128)`. That the patch
  *edits* that line rather than adding it is further evidence the fork carried
  Emscripten support upstream never had.

Note CMake 4.4.3 only *warns* about the pre-3.10 `cmake_minimum_required` calls
in SDL2, enet and nihstro; they are not fatal.

*Port sources — absent, and not reconstructible here.* `patches/README.md` names
base commit `30d214dd69a791dc91a024c5062b09ec33792985`, and that commit **does
not exist in azahar-emu/azahar**: the GitHub API returns 422 for it while
returning 200 for upstream HEAD. The port was developed against a private fork.
Consistent with that, upstream's SDL frontend is `src/citra_cli` (gated behind
`ENABLE_QT`), there is no `src/citra_sdl/` or `src/video_core/renderer_webgl2/`
upstream, `ENABLE_WEBGL2_RENDERER` and `azahar_web_bundle` do not exist, and
`emscripten-main-web.patch` *modifies* `emscripten_main.cpp` rather than
creating it — only about 49% of that file appears as patch context.

Consequence: any optimization inside `azahar.wasm` / `azahar_webgl2.wasm` —
including the CPU-side limits under "Next FPS Work" — needs that fork or the
original build tree. Work in `web/` and `tests/` is unaffected, which is where
optimization 15 lives. See `FORK_HANDOFF.md` for the steps to
move the fork off the machine that holds it (per `run_build.bat`, that is
`C:\Users\shubadub\Documents\azahar`).

## Performance & Benchmarking

### Optimization History

| # | Optimization | Description | Impact |
|---|-------------|-------------|--------|
| 1 | SDL surface caching | Reuse SDL surfaces across frames instead of alloc/free per frame (~700 KB/frame saved) | Eliminates per-frame malloc overhead |
| 2 | Correct Emscripten surface update | Preserve `SDL_UpdateWindowSurface()` after each software frame | Required for pixels to reach the browser canvas; guarded by compositor E2E |
| 3 | Parallel software rasterizer | Six fixed Emscripten raster workers, with four-row worker tasks | Browser callbacks 8.1→19.5 FPS; game FPS 2.0→4.0 on kiosk-demo workload |
| 4 | Browser-owned frame pacing | Disable the redundant native frame limiter for the web frontend | Removes main-thread sleeps; `requestAnimationFrame` remains the pacing clock |
| 5 | Incremental edge functions | Replace per-pixel SignedArea cross-product calls (2 muls + 3 subs × 3 per pixel) with pre-computed additive edge function steps in ProcessTriangle inner loop | Eliminates 6 multiplies per pixel; addition-only barycentric stepping |
| 6 | RGBA8 framebuffer fast-path | Bypass per-pixel format switch, lambda, Vec4 construction, and memcpy in LoadFBToScreenInfo; direct ABGR→RGBA byte-swap for the dominant RGBA8 format | Removes branch, allocation, and copy overhead for every displayed pixel |
| 7 | Sequential output rotation | Restructure LoadFBToScreenInfo RGBA8 fast-path to iterate output rows sequentially for write-combining cache locality (3DS LCD 90° rotation) | Marginal; presentation is not the bottleneck |
| 8 | Float32 attribute interpolation | Replace software-emulated f24 (24-bit float) operations with native float32 for all per-pixel attribute interpolation in the Emscripten rasterizer | Eliminates ~50 f24 bit-manipulation ops per pixel; native WASM float32 |
| 9 | Early depth rejection | Read-only depth buffer compare before texture sampling, lighting, and TEV stages; skips occluded pixels without stencil side effects | GPU cmd 175→158 ms (−10%); callbacks 31.6→34.0 (+7.6%); p95 141→114 ms |
| 10 | Conditional UV interpolation | Skip texture coordinate interpolation and f24 conversion for disabled texture units; skip tc0_w when not needed for cube/projection mapping | Reduces per-pixel work when only tex unit 0 is active |
| 11 | Float UV-to-texel conversion | Compute UV-to-texel in native float32 inside TextureColor, avoiding f24 round-trip for width/height scaling | GPU cmd 187->178 ms; game FPS 3.8->4.0 |
| 12 | Float-native texture sampling | TextureColorFloat bypasses f24 round-trip for UV coords entirely; float32 throughout the texture sampling path | Part of Opts 12-14 batch |
| 13 | TEV stage early-exit | Pre-compute active TEV stage count per triangle; skip pass-through stages in the inner pixel loop | Part of Opts 12-14 batch |
| 15 | Display-path throughput fallback | Auto leaves an accelerated backend that stalls frame production instead of failing. Emulation advances once per browser frame, so a backend delivering few frames caps guest speed regardless of how cheap each frame is; the callback duty cycle separates that from being CPU-bound | 2in1 Horses 3D: 11 -> 60 game FPS (18% -> 101% speed) end to end through the UI |
| 14 | Pre-computed TextureInfo | Hoist TextureInfo::FromPicaRegister and memory pointer lookups out of per-pixel loop to per-triangle setup; inline alpha test and hoist fog check | Part of Opts 12-14 batch |

### Benchmark Results (2026-09-01)

ROM: Super Mario 3D Land (Europe) (Kiosk Demo), 128 MB decrypted .3ds
Browser: Chrome headless, 30-second title-screen warmup, 15-second rAF measurement

| Build | Browser callback rate | Game FPS | Emulation speed | GPU command time | Callback p95 |
|-------|-----------------------|----------|-----------------|------------------|--------------|
| Inline rasterizer baseline | 8.1 FPS | 2.0 | 3% | 488 ms | 347 ms |
| Six-worker rasterizer | 19.5 FPS | 4.0 | 7% | 216 ms | 199 ms |
| Incremental edge + RGBA8 fast-path | 31.4 FPS | 3.3 | 5% | 175 ms | 142 ms |
| + Rotation + Float32 interp + Early-Z | 34.0 FPS | 5.0 | 8% | 158 ms | 114 ms |


### Gameplay Benchmark (2026-09-01)

ROM: Super Mario 3D Land W1-1 save state, Chrome headless, 5s warmup, 15s measurement

| Renderer | Browser callback rate | Game FPS | Speed | GPU cmd time | p95 |
|----------|-----------------------|----------|-------|--------------|-----|
| Software (optimizations 1-11) | 25.7 FPS | 4.0 | 7% | 178 ms | 161 ms |
| Software (optimizations 1-14) | 28.3 FPS | 4.0 | 7% | 175 ms | 138 ms |
| WebGL2 (experimental) | crashes — incomplete save-state support | — | — | — | — |

Title-screen figures above are historical baselines, not gameplay claims.
Software GPU command processing remains the dominant bottleneck.

### Benchmark Commands

```powershell
# Quick smoke test
node tests/web_artifact_smoke.cjs

# Gameplay benchmark (uses auto-detected save state, ~25s total)
$env:CHROME_PATH = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
node tests/benchmark_browser.cjs --artifact software --duration-seconds 15 --warmup-seconds 5 --repeat 1

# With profiling
node tests/benchmark_browser.cjs --artifact software --duration-seconds 15 --warmup-seconds 5 --repeat 1 --profile

# Interactive benchmark (visible Chrome window)
node tests/benchmark_browser.cjs --artifact software --interactive --duration-seconds 15 --warmup-seconds 5 --repeat 1

# Regression test (rendering validation)
$env:AZAHAR_ROM_PATH = (Resolve-Path 'test_games\*.3ds').Path
node tests/browser_regression.cjs
```

Results are written to `tests/benchmark_results.json`.

Optional diagnostics, all off by default because each one perturbs what it
measures:

| Variable | Effect |
|---|---|
| `AZAHAR_GL_CENSUS=1` | Counts WebGL2 calls by name over the measured window |
| `AZAHAR_FRAME_TRACE=1` | Records long-animation-frame entries (script vs render vs idle) |
| `AZAHAR_SCREENSHOT=PATH` | Writes the `#canvas` contents after the run |
| `AZAHAR_CHROME_ARGS` | Extra Chrome flags, e.g. `--use-angle=swiftshader` |

Per-process CPU (`SystemInfo.getProcessInfo` over CDP) is always sampled around
the measured window and reported in cores, scoped to the browser under test.

### Current Cross-title Baseline (2026-09-06)

These measurements use the deployed-default WebGL2 renderer on Chrome/ANGLE D3D11. Mario uses the player-controllable W1-1 state; the other dumps currently have only cold-boot measurements, so they identify broad title variance but are not yet comparable gameplay scenes.

| Title / scene | Game FPS | Speed | GPU command time | Browser callbacks/s |
|---|---:|---:|---:|---:|
| Super Mario 3D Land, W1-1 (3-run mean) | 16.4 | 27% | 43.4 ms | 41.5 |
| Zelda: A Link Between Worlds demo, boot | 28.9 | 48% | 2.10 ms | 140.2 |
| New Super Mario Bros. 2, boot | 68.3 | 113% | 0.74 ms | 143.6 |
| The Sims 3, boot | 26.4 | 63% | 2.30 ms | 139.4 |

Raw local results are written under `tmp_test/*_benchmark.json` so routine profiling does not overwrite the checked-in regression baseline.

### Fast-forward validation (2026-09-07)

Fast-forward no longer changes the emulated CPU clock. It requests up to 4x guest-time progress within the normal browser work budget and caps missed-time backlog, so slow gameplay cannot make a later 1x scene run too fast. On the NSMB2 boot workload, the 1x setting measured 69.8 game FPS / 117% speed and the 4x target measured 127.4 game FPS / 213% speed. Mario W1-1 remains GPU/CPU-vertex bound, so it cannot meet the requested target until that renderer bottleneck is removed.

### 2in1 Horses 3D — renderer throughput (2026-09-19)

ROM: `2in1 Horses 3D` (Horse & Foal), 256 MB, title/game-select scene.
Chrome headless on macOS (Apple M1), 120-second warmup, 15-second measurement.
Both renderers were confirmed to draw the same scene before comparing.

| Renderer | Guest speed | Game FPS | Browser callbacks/s | GPU process | Renderer process |
|---|---:|---:|---:|---:|---:|
| Software | 100.3% | 60.0 | 60.0 | 0.03 cores | 1.19 cores |
| WebGL2, ANGLE Metal (default) | 44.1% | 23.3 | 10.2 | 0.76 cores | 0.05 cores |
| WebGL2, ANGLE SwiftShader | 101.0% | 59.5 | 59.9 | 1.63 cores | 0.17 cores |

The accelerated backend is not doing more work; it is stalling. Its GPU process
burns 0.76 cores to deliver 10 frames a second on 4,337 GL calls/s and 139
draws/s, with no texture upload and no shader compilation inside the measured
window. Long-animation-frame entries average 105 ms with 0.0 ms of script and
0.0 ms blocking, so the main thread is idle and waiting. SwiftShader — a pure
CPU implementation of the same GL commands, and far slower at real
rasterization — reaches a full 60 Hz, which rules out command volume as the
cause and points at a per-frame synchronization stall in ANGLE's Metal backend.

Because `azahar_step_frame` advances the guest once per browser frame, capped
frame production caps emulation. That is what optimization 15 detects and
escapes.

Scope, so existing configurations are unaffected:

- Only **Auto** re-picks a backend. `?renderer=webgl2` (the dropdown's
  "Accelerated") is pinned and is never switched for being slow; the
  hard-failure fallbacks still apply to both, because a backend that cannot
  present is not a choice.
- The verdict is stored under `azahar-renderer-verdict`, keyed by the
  `UNMASKED_RENDERER_WEBGL` adapter string, so a macOS/Metal result cannot
  suppress the accelerated path on a D3D11 or Vulkan machine. The existing
  D3D11 CPU-vertex selection in `preflightWebGL2` is unchanged.
- A repeat visit acts on the stored verdict during preflight, before the WebGL2
  module is fetched: measured at 0.1 s versus a ~14 s probe plus a second ROM
  upload.
- `?autoFallback=0` pins the current renderer and ignores any stored verdict.
  The benchmark passes it so it always measures the artifact it was asked for.

`tests/renderer_autofallback.cjs` covers all three directions: Auto switches and
then reuses the verdict, `--pinned` asserts an explicit WebGL2 choice survives on
the same stalling backend, and `--expect-none` (with
`AZAHAR_CHROME_ARGS=--use-angle=swiftshader`) asserts Auto stays put when the
accelerated path keeps up.

### Next FPS Work

See `tests/PERFORMANCE.md` for the 2026-09-07 gameplay-only CPU trace, rejected
4096-entry vertex-cache experiment, cross-title state inventory, and the
2026-09-19 renderer-throughput investigation and its method.
PICA execution accounts for 44.4% of the measured Mario main-thread trace;
decode/setup is only 0.5%. The larger cache did not improve FPS and was reverted.

0. **Find the per-frame stall in the WebGL2 path on ANGLE Metal.** Optimization
   15 escapes it but does not fix it, so the accelerated backend is still
   unavailable to this title on macOS. SwiftShader running the identical command
   stream at 60 Hz localises the cause to backend synchronization rather than to
   command volume, PICA work, or the emulator's own counters (`timeGpu` measures
   only CPU time spent emitting commands and reports 0.13 ms while the GPU
   process burns 0.82 cores). Blocked on build reproducibility.
1. **Decouple emulation from frame production.** `azahar_step_frame` stops after
   `max_slices_per_tick = 256` slices, which on this title is ~4 ms of a 14 ms
   budget; the deadline is never reached. Whenever the display path is slow, the
   emulator therefore idles most of every frame (measured duty cycle 2-5%).
   Running to the deadline instead of a fixed slice count, or advancing the guest
   without presenting when frames are being dropped, would raise guest speed on
   any frame-starved configuration. Blocked on build reproducibility.
2. Use the new persistent save UI to capture repeatable, player-controllable states for Zelda, NSMB2, and The Sims 3. Gate every optimization on the same scenes; boot screens are too light to predict gameplay cost.
3. Add production OpenGL counters around CPU PICA vertex translation, draw submission, display transfer, cache upload/download, and shader compilation. The existing detailed renderer counters describe the experimental backend and are zero on the default OpenGL path, leaving the current 43 ms Mario GPU-command cost insufficiently attributed.
4. Fix the generated PICA vertex-shader path on ANGLE/D3D11. It is fast at native resolution but currently produces empty scaled framebuffers, forcing the reliable CPU-vertex path for 2x-4x. A correct generated path removes the largest avoidable CPU graphics stage without reducing visuals.
5. Batch and cache CPU-translated vertex streams by shader/uniform/input state so unchanged draws avoid reinterpreting PICA instructions and rebuilding host buffers. This is the safest macro-level fallback if D3D shader generation remains driver-sensitive.
6. Profile the ARM11 pretranslated dyncom block dispatcher separately from graphics. Browser WebAssembly cannot directly execute arbitrary generated machine code, so the practical JIT direction is larger cached micro-op/superblock translation with fewer indirect dispatches, then validation against all captured gameplay states.
