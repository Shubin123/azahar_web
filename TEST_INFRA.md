# E2E Test Infra: Azahar WebAssembly Proof-of-Concept

## Test Philosophy

The current web verification covers CMake configuration, the 8-job Ninja build, automatic artifact synchronization, generated artifacts, exported JavaScript APIs, and a Puppeteer browser harness. The real browser regression passes with a decrypted `.3ds` demo: it verifies COOP/COEP isolation, pthread initialization, ROM loading, automatic run-loop startup, canvas output, and the absence of browser console/page errors. Its opt-in 20-second timeout waits for a multi-color Super Mario 3D Land kiosk-demo framebuffer and reports the actual elapsed boot time. The existing 138-case Node mock/static suite is retained for diagnostics but is not currently a reliable gate against the current Emscripten artifact.
- Opaque-box, requirement-driven testing for the Azahar Emscripten WebAssembly 3DS emulator port.
- No direct dependency on C++ internals when opaque WebAssembly JavaScript exports (`azahar_init`, `azahar_load_rom`, `azahar_step_frame`), Emscripten MEMFS (`FS.writeFile`), and HTML5 Canvas framebuffers can be exercised.
- Methodology: 4-Tier design (Category-Partition, Boundary Value Analysis, Pairwise Combinatorial, Real-World Workload Testing).

## Feature Inventory & Test Coverage Plan
Targeting all 12 features defined in `PROJECT.md`:
1. **Emscripten CMake Build Setup**: `emcmake cmake` builds cleanly targeting WASM.
2. **JIT Exclude & Dyncom Routing**: Disables `dynarmic` JIT; routes CPU execution to `dyncom`.
3. **Software Renderer Enablement**: Enables `renderer_software`; disables desktop OpenGL 4.3 / Vulkan.
4. **External Dependency Stubbing**: Excludes desktop dependencies (cubeb, openal, libusb, room).
5. **Non-blocking Canvas Frontend**: Adapts `EmuWindow_SDL2_SW` for non-blocking single frame presentation.
6. **Main Loop Event Unrolling**: Replaces blocking loops with `azahar_step_frame` / Emscripten main loop.
7. **HTML5 Canvas Framebuffer Blit**: Renders 3DS framebuffers onto `<canvas>` element.
8. **Web UI & Game File Loader**: HTML/JS interface loading `.3ds`, `.3dsx`, `.cia`, `.elf` into MEMFS.
9. **WASM Memory and Thread Safety**: Sets linker flags (`INITIAL_MEMORY=512MB`, `STACK_SIZE=2MB`, `ALLOW_MEMORY_GROWTH=1`, `MAXIMUM_MEMORY=4GB`) and a preallocated 32-worker pthread pool.
10. **Memory Access Bounds Guard**: Prevents WASM memory out-of-bounds crashes (`RuntimeError: memory access out of bounds`).
11. **WebGPU Overlay Alignment**: Ensures `azahar-webgpu/` architecture links cleanly alongside WASM target.
12. **E2E Test Suite & Real-ROM Pass**: Verifies WASM instantiation, decrypted ROM loading, first-frame rendering, and continuous execution.

## Coverage Thresholds
- **Tier 1: Feature Coverage**: Minimum 5 test cases per feature = 60 test cases.
- **Tier 2: Boundary & Corner Cases**: Minimum 5 test cases per feature = 60 test cases.
- **Tier 3: Cross-Feature Combinations**: Minimum 12 pairwise test cases.
- **Tier 4: Real-World Application Scenarios**: Minimum 6 application scenarios.
- **Total Planned Test Suite Size**: 138 test cases.

## Test Architecture & Infrastructure
- **Test Directory**: `tests/e2e/`
- **Test Runner Script**: `tests/e2e/run_e2e_tests.js` (Node.js runner using mock browser environment / Emscripten shell runner)
- **Execution Command**: `node tests/e2e/run_e2e_tests.js` (138 legacy mock/static cases; diagnostic only)
- **Artifact Smoke Command**: `node tests/web_artifact_smoke.cjs` (checks real generated JS/WASM files)
- **Browser Regression**: `tests/browser_regression.cjs` (Puppeteer; starts `web/server.cjs`, verifies cross-origin isolation, initializes pthread-enabled WASM, uploads a ROM, auto-starts the loop, and checks a multi-color real-ROM framebuffer. Set `AZAHAR_REAL_ROM_BOOT_MS=20000` to enable the timed check.)
- **Output Format**: JSON test result report saved to `tests/e2e/test_results.json` and console TAP output.
- **Current web pass criteria**: `node tests/web_artifact_smoke.cjs` and the real-ROM browser regression exit 0. The broader 138-case legacy-suite gate remains pending modernization.

## Feature Inventory Coverage Table
| # | Feature | Source | Tier 1 (Count) | Tier 2 (Count) | Tier 3 | Tier 4 |
|---|---------|--------|:--------------:|:--------------:|:------:|:------:|
| 1 | Emscripten CMake Build Setup | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 2 | JIT Exclude & Dyncom Routing | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 3 | Software Renderer Enablement | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 4 | External Dependency Stubbing | Survey Explorer 1 | 5 | 5 | ✓ | ✓ |
| 5 | Non-blocking Canvas Frontend | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 6 | Main Loop Event Unrolling | Survey Explorer 2 | 5 | 5 | ✓ | ✓ |
| 7 | HTML5 Canvas Framebuffer Blit | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 8 | Web UI & Game File Loader | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 9 | WASM Memory Safety Setup | Survey Explorer 3 | 5 | 5 | ✓ | ✓ |
| 10 | Memory Access Bounds Guard | ORIGINAL_REQUEST §Acceptance Criteria | 5 | 5 | ✓ | ✓ |
| 11 | WebGPU Overlay Alignment | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ | ✓ |
| 12 | E2E Test Suite & First-Frame Pass | ORIGINAL_REQUEST §Acceptance Criteria | 5 | 5 | ✓ | ✓ |

## Real-World Test Game Resources
Available local test ROM files located at `C:\Users\shubadub\Documents\azahar\test_games`:
- `Super Mario 3D Land (Europe) (EnFrDeEsIt) (Demo) (Kiosk).cia` (39.3 MB) - encrypted CIA negative fixture; the UI must reject it cleanly.
- `Super Mario 3D Land (Europe) (EnFrDeEsIt) (Demo) (Kiosk).7z` (50.9 MB) - contains the 128 MiB decrypted `.3ds` that passed the browser regression.
- `Super Mario (USA) (Beta) (E3 2011 demo).7z` (82.9 MB) - encrypted 2 GiB image; not a no-key execution fixture.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Full Cold-Boot & Homebrew Execution | F1, F2, F3, F5, F6, F8, F9, F10, F12 | High |
| 2 | Decrypted Cartridge Load (Super Mario 3D Land kiosk demo) & WASM Memory Growth Stress | F8, F9, F10, F12 | High |
| 3 | Framebuffer Canvas Render & Multi-Frame Animation Step | F5, F6, F7, F12 | High |
| 4 | WebGPU Overlay Coexistence & Fallback Build Test | F1, F3, F11 | Medium |
| 5 | Invalid / Corrupted ROM Graceful Error Rejection | F8, F10, F12 | Medium |
| 6 | Rapid Re-initialization & State Reset Loop | F2, F5, F8, F10 | High |
