# E2E Test Infra: Azahar WebAssembly Proof-of-Concept

## Test Philosophy

The current web verification covers CMake configuration, the 8-job Ninja build, generated artifacts, exported JavaScript APIs, and the existing 138-case mock/static suite. Browser-driven ROM execution remains a pending test tier.
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
9. **WASM Memory Safety Setup**: Sets linker flags (`INITIAL_MEMORY=512MB`, `ALLOW_MEMORY_GROWTH=1`, `STACK_SIZE=2MB`).
10. **Memory Access Bounds Guard**: Prevents WASM memory out-of-bounds crashes (`RuntimeError: memory access out of bounds`).
11. **WebGPU Overlay Alignment**: Ensures `azahar-webgpu/` architecture links cleanly alongside WASM target.
12. **E2E Test Suite & First-Frame Pass**: Verifies WASM instantiation, ROM loading, and first-frame rendering.

## Coverage Thresholds
- **Tier 1: Feature Coverage**: Minimum 5 test cases per feature = 60 test cases.
- **Tier 2: Boundary & Corner Cases**: Minimum 5 test cases per feature = 60 test cases.
- **Tier 3: Cross-Feature Combinations**: Minimum 12 pairwise test cases.
- **Tier 4: Real-World Application Scenarios**: Minimum 6 application scenarios.
- **Total Planned Test Suite Size**: 138 test cases.

## Test Architecture & Infrastructure
- **Test Directory**: `tests/e2e/`
- **Test Runner Script**: `tests/e2e/run_e2e_tests.js` (Node.js runner using mock browser environment / Emscripten shell runner)
- **Execution Command**: `node tests/e2e/run_e2e_tests.js` (138 mock/static cases; currently passing)
- **Artifact Smoke Command**: `node tests/web_artifact_smoke.cjs` (checks real generated JS/WASM files)
- **Output Format**: JSON test result report saved to `tests/e2e/test_results.json` and console TAP output.
- **Pass Criteria**: Exit code 0, 100% test pass rate across Tiers 1-4. This remains pending.

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
- `Super Mario 3D Land (Europe) (EnFrDeEsIt) (Demo) (Kiosk).cia` (39.3 MB) - Used for `.cia` format mounting and execution testing.
- `Super Mario (USA) (Beta) (E3 2011 demo).7z` (82.9 MB) - Used for compressed archive extraction and large ROM load testing.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Full Cold-Boot & Homebrew Execution | F1, F2, F3, F5, F6, F8, F9, F10, F12 | High |
| 2 | Large Game ROM Load (`.cia` / Super Mario 3D Land) & WASM Memory Growth Stress | F8, F9, F10, F12 | High |
| 3 | Framebuffer Canvas Render & Multi-Frame Animation Step | F5, F6, F7, F12 | High |
| 4 | WebGPU Overlay Coexistence & Fallback Build Test | F1, F3, F11 | Medium |
| 5 | Invalid / Corrupted ROM Graceful Error Rejection | F8, F10, F12 | Medium |
| 6 | Rapid Re-initialization & State Reset Loop | F2, F5, F8, F10 | High |
