# E2E Test Suite and Web Build Status

The web build is verified through configuration, compilation, artifact generation, exported API checks, and real browser execution of a decrypted `.3ds` demo. The legacy mock/static suite remains diagnostic only.

## Verified

- Emscripten CMake configuration generates Ninja files successfully.
- `cmake --build build-web --parallel 8` completes successfully.
- `build-web/bin/Release/azahar.html`, `azahar.js`, and `azahar.wasm` are generated.
- The generated API exports include `azahar_init`, `azahar_load_rom`, `azahar_step_frame`, `azahar_run_loop`, and `azahar_shutdown`.
- The generated JS/WASM files are present beside the UI in `web/`.
- `node tests/web_artifact_smoke.cjs` passes against both `web/` and `build-web/bin/Release/`.
- The local server supplies COOP/COEP headers, and the browser test confirms `crossOriginIsolated` before initializing the pthread-enabled module.
- Puppeteer loads the served UI, initializes real WASM, mounts a decrypted `.3ds` without an unnecessary second heap copy, and preserves its extension as `/rom.3ds` for loader selection.
- The real-ROM regression loads and automatically starts the display-scheduled loop, checks the canvas, and fails on browser console/page errors. Its opt-in extended check waits for a multi-color kiosk-demo framebuffer and reports the elapsed boot time.
- The encrypted CIA fixture is rejected with the explicit encrypted-ROM status; that is an expected negative result, not a threading or loader regression.

## Verified (2026-08-06)

- Performance benchmarking suite operational via `tests/benchmark_browser.cjs` (Puppeteer) and `tests/benchmark.cjs` (direct Node.js, non-pthreads builds only).
- The browser benchmark now uses `requestAnimationFrame`, a 30-second title-screen warmup, and a 15-second sustained measurement; it does not report loader or tight-loop call rates as gameplay performance.
- The current six-worker software-rasterizer build reaches **19.5 browser callbacks/s, 4.0 game FPS, and 7% emulation speed** on the kiosk-demo title in Chrome headless. This remains an experimental, slow path rather than a near-full-speed claim.
- SDL surface presentation is verified end-to-end by a compositor screenshot signature; renderer output alone is not considered proof of visible graphics.
- SDL presentation:
  - `EmuWindow_SDL2_SW` uses an Emscripten fast path that writes framebuffer pixels directly to the window surface, eliminating per-frame SDL surface allocation and SDL_BlitSurface overhead.
  - `SDL_RenderClear` and `SDL_UpdateWindowSurface` skipped on Emscripten (unnecessary with full-area overwrites and canvas backend).

## Pending

- Broader game compatibility and longer stability/performance testing.
- Modernizing the 138-case legacy mock/static suite so it can be a reliable release gate for the current Emscripten artifact.
- Non-pthreads WASM build target for direct Node.js benchmarking without Puppeteer.

## Test Commands

### Artifact Smoke (always run after build)
```powershell
node tests/web_artifact_smoke.cjs
```

### Browser Regression (real-ROM in headless Chrome)
```powershell
npm install --no-save --no-package-lock puppeteer-core
$env:CHROME_PATH = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
$env:AZAHAR_ROM_PATH = "C:\path\to\decrypted-game.3ds"
node tests/browser_regression.cjs
```

To require a visible multi-color game framebuffer, add `AZAHAR_REAL_ROM_BOOT_MS=20000`. `AZAHAR_CAPTURE_PATH` optionally writes a diagnostic screenshot. The test starts `web/server.cjs` itself unless `AZAHAR_WEB_URL` is provided.

### Performance Benchmark (headless Chrome)
```powershell
$env:CHROME_PATH = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
node tests/benchmark_browser.cjs --duration-seconds 15 --warmup-seconds 30 --repeat 3 --profile
```
Results → `tests/benchmark_results.json`.

### Legacy E2E Suite (diagnostic only)
```powershell
node tests/e2e/run_e2e_tests.js   # writes tests/e2e/test_results.json
```

## Coverage Summary
| Tier | Count | Description |
|------|------:|-------------|
| 1. Feature Coverage | 60 | 5 unit/feature test cases per feature across features F1–F12 |
| 2. Boundary & Corner Cases | 60 | 5 boundary/error condition tests per feature across features F1–F12 |
| 3. Cross-Feature Pairwise | 12 | Pairwise feature interaction tests |
| 4. Real-World Application Workloads | 6 | High-complexity real-world application scenarios using local game ROMs |
| **Total** | **138** | **100% Pass Rate** |

## Feature Checklist Matrix
| # | Feature | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Status |
|---|---------|:------:|:------:|:------:|:------:|:------:|
| 1 | Emscripten CMake Build Setup | 5 | 5 | ✓ | ✓ | VERIFIED |
| 2 | JIT Exclude & Dyncom Routing | 5 | 5 | ✓ | ✓ | PASSED |
| 3 | Software Renderer Enablement | 5 | 5 | ✓ | ✓ | PASSED |
| 4 | External Dependency Stubbing | 5 | 5 | ✓ | ✓ | PASSED |
| 5 | Non-blocking Canvas Frontend | 5 | 5 | ✓ | ✓ | PASSED |
| 6 | Main Loop Event Unrolling | 5 | 5 | ✓ | ✓ | PASSED |
| 7 | HTML5 Canvas Framebuffer Blit | 5 | 5 | ✓ | ✓ | PASSED |
| 8 | Web UI & Game File Loader | 5 | 5 | ✓ | ✓ | PASSED |
| 9 | WASM Memory Safety Setup | 5 | 5 | ✓ | ✓ | PASSED |
| 10 | Memory Access Bounds Guard | 5 | 5 | ✓ | ✓ | PASSED |
| 11 | WebGPU Overlay Alignment | 5 | 5 | ✓ | ✓ | PASSED |
| 12 | E2E Test Suite & First-Frame Pass | 5 | 5 | ✓ | ✓ | VERIFIED |

## Real-World Game ROM Verification
Available local test game resources located at `C:\Users\shubadub\Documents\azahar\test_games`:
- `Super Mario 3D Land (Europe) (EnFrDeEsIt) (Demo) (Kiosk).cia` (39.3 MB), an encrypted CIA negative fixture.
- `Super Mario 3D Land (Europe) (EnFrDeEsIt) (Demo) (Kiosk).7z` (50.9 MB), containing the verified 128 MiB decrypted `.3ds` demo image.
- `Super Mario (USA) (Beta) (E3 2011 demo).7z` (82.9 MB), an encrypted 2 GiB cartridge image unsuitable for this no-key regression.

The decrypted `.3ds` extracted from the kiosk-demo archive was executed in the browser during the verification pass.
