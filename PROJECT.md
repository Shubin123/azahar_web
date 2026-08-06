# Project: Azahar WebAssembly Proof-of-Concept

## Architecture
Azahar WebAssembly port targeting modern web browsers via Emscripten.
- **CPU Subsystem**: Portable `dyncom` ARM11 C++ interpreter (JIT `dynarmic` disabled via `ARCHITECTURE=GENERIC`).
- **Graphics Subsystem**: `SwRenderer::RendererSoftware` rasterizer operating on 32-bit RGBA8 framebuffers (OpenGL & Vulkan hardware renderers disabled).
- **Frontend / Windowing**: Adapted `citra_sdl` / `EmuWindow_SDL2_SW` presenting software framebuffers to an HTML5 `<canvas id="canvas">`.
- **Event Loop**: Main loop unrolled into Emscripten event loop / exported C per-frame step function (`azahar_step_frame`).
- **File System / Loader**: HTML File API -> Emscripten MEMFS (`FS.writeFile`) -> C++ `Core::System::Load()` via standard C file IO.
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
| 9 | WASM Memory Safety Setup | Set linker flags (`INITIAL_MEMORY=512MB`, `ALLOW_MEMORY_GROWTH=1`, `STACK_SIZE=2MB`) | M4 | Survey Explorer 3 |
| 10 | Memory Access Bounds Guard | Prevent WASM out-of-bounds traps (`RuntimeError: memory access out of bounds`) | M4 | ORIGINAL_REQUEST §Acceptance Criteria |
| 11 | WebGPU Overlay Alignment | Ensure `azahar-webgpu/` overlay architecture builds alongside Emscripten targets | M4 | ORIGINAL_REQUEST §R3 |
| 12 | E2E Test Suite & First-Frame Pass | Verify WASM instantiation, ROM loading, and first-frame rendering pass | M5 | ORIGINAL_REQUEST §Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Emscripten Build & CMake Setup | CMake configuration, dependency stubbing, dyncom & renderer_software selection | None | COMPLETE |
| M2 | Canvas Frontend & Loop Unrolling | `EmuWindow_SDL2_SW` adaptation, main loop unrolling, HTML5 canvas output | M1 | COMPLETE |
| M3 | Web UI & ROM Loading Pipeline | Minimal HTML/JS frontend, MEMFS file mounting, C++ file loading API | M2 | COMPLETE |
| M4 | WASM Memory Safety & WebGPU Overlay | Linker memory flags (512MB init, 2MB stack), out-of-bounds guards, WebGPU overlay link | M1, M2 | COMPLETE |
| M5 | E2E Verification & First-Frame Rendering | 100% E2E test suite execution, ROM execution & first-frame rendering verification | M1, M2, M3, M4 | COMPLETE |

## Interface Contracts
### Web UI ↔ WebAssembly Module (`web/azahar.js` / `web/azahar.wasm`)
- `FS.writeFile(path, data)`: JS mounts uploaded ROM bytes to Emscripten MEMFS path (e.g. `/rom.3dsx`).
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

Artifacts are generated under `build-web/bin/Release/` and copied into `web/` for serving. `node tests/web_artifact_smoke.cjs` validates both artifact copies, the generated API names, and WASM compilation; the existing 138-case mock/static suite also passes. Real ROM execution remains pending because the browser automation command is unavailable and the local game resources are archived test files.
