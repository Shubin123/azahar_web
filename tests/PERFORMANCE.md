# Gameplay profiling

Use the same ROM, state, renderer, resolution, and speed for each comparison.
Run one emulator at a time. Keep cold-boot results separate from gameplay.
CPU profiling adds overhead; use unprofiled runs for performance decisions.

```powershell
$env:AZAHAR_CPU_PROFILE='tmp_test/gameplay.cpuprofile'
node tests/benchmark_browser.cjs --artifact webgl2 --warmup-seconds 5 --duration-seconds 20 --repeat 1 --profile --output tmp_test/gameplay.json
node tests/profile_report.cjs tmp_test/gameplay.cpuprofile build-webgl2-opengl/bin/Release/azahar_webgl2.html.symbols
```

CPU captures now start after state restoration and warmup, and stop before
shutdown. Repeats create separate `.run2.cpuprofile` etc. files. Use the symbol
map from the exact WASM link being profiled; rebuilding can change function IDs.
Report percentages are time-weighted, include idle time, and describe the sampled
main thread, not GPU execution or workers. Inclusive time includes callees and
must not be summed across functions.

For optional PICA vertex counters, set `AZAHAR_PAGE_QUERY='?picaTrace=1'`.
Each result's `picaTrace` contains measured-window batches, input vertices, cache
hits, shader invocations (`misses`), occupied-slot collisions, and total CPU vertex
processing milliseconds (including geometry processing). Counters are disabled
by default. A collision is not proof of avoidable shader work: the evicted index
may never be reused. Compare misses per vertex to test that hypothesis.

## 2026-09-07 findings

Chrome/ANGLE D3D11, Mario 3D Land W1-1, 5-second warmup, 20-second CPU capture:

| Main-thread function | Self time |
|---|---:|
| PICA shader interpreter | 44.4% |
| ARM interpreter | 12.6% |
| PICA register processing | 9.5% |
| Vertex-buffer upload | 4.8% |
| Shader decode/setup | 0.5% |

Increasing the vertex cache from 256 to 4096 entries was tested and **reverted**.
Two 15-second runs per variant gave mean game FPS 16.64 vs 16.59; mean callback
work 36.39 vs 36.49 ms. Collisions dropped sharply, but shader invocations per
input vertex changed only from about 34.38% to 34.31%. There is no demonstrated
speed benefit. Raw files: `tmp_test/cache256_ab.json`, `tmp_test/cache4096_ab.json`.

The next macro experiment should target execution of unique vertices: repair
the generated PICA shader path on ANGLE or compile/cache shader basic blocks.
Further decode caching and larger index caches do not address the measured cost.
Even eliminating the measured 44% shader cost alone would not establish 60 FPS
from this baseline; CPU dispatch and the remaining graphics work also matter.

### Native-clock and WASM SIMD follow-up

The WebGL2 artifact now defaults to a 100% ARM11 clock; the old 25% default
underclocked the guest and cannot improve real-time emulation. On the Mario W1-1
fixture, short direct samples improved from 16.80 game FPS / 26.9% whole-window
guest speed at `?cpuClock=25` to 17.85 FPS / 30.0% at `?cpuClock=100`. The query
parameter remains available for diagnostics (`10` through `400`), but native
timing is the production default.

The production WASM builds also use `-msimd128`, verified by disassembly to emit
SIMD instructions. It passed both renderer artifacts' direct and static-host
Chrome regressions. Mario's two 10-second clean-reload samples did **not** show a
repeatable additional guest-speed gain (28.6% then 24.1%, compared with the
preceding 27.7% and 26.6% samples). Treat SIMD as a browser-native codegen
baseline that may benefit other codepaths, not as evidence of a Mario PICA
speedup. Likewise, removing unused unary-instruction operand zeroing preserved
visual output but was inside the measurement noise band.

### Scheduler experiment

UI and benchmark now share `web/azahar_scheduler.js`. The default remains RAF;
`?scheduler=timer` and `?scheduler=message` are explicit diagnostic alternatives.
The message path has cancellation tests, and initial UI scheduling now retains
its handle so Stop can cancel the first pending tick as well as subsequent ticks.

The new NSMB2 W1-1 fixture exposed 46.8% idle time in a gameplay CPU capture.
Unprofiled 2-run snapshots averaged 35.5 game FPS on RAF, 39.1 on timers, and 38.5
on messages. However, Mario's same-session comparison showed essentially equal
whole-window guest speed (20.6% RAF vs 20.5% messages), while mean callback work
increased from 46.9 to 52.7 ms. The alternative schedulers are not promoted to
defaults: more callbacks did not produce a dependable cross-title speed gain.
These later Mario measurements were made in a separate session from the cache
experiment and must not be treated as an artifact regression against that table.

`measuredGuestSpeed` now reports actual guest microseconds advanced divided by
the complete measured wall interval. Use it alongside FPS snapshots and callback
percentiles. The increased graphics-command time with uninterrupted scheduling
suggests GPU/driver backpressure; a GPU timeline is needed to establish its cause.

## Capture local fixtures

```powershell
node tests/capture_fixture.cjs serve 'C:\path\game.3ds'
# In a second shell:
node tests/capture_fixture.cjs shot
node tests/capture_fixture.cjs key a 1000
node tests/capture_fixture.cjs touch 0.5 0.8
node tests/capture_fixture.cjs save w1-1-playable
node tests/capture_fixture.cjs close
```

The session uses isolated headless Chrome, the normal UI, and a localhost control
port (override with `AZAHAR_FIXTURE_PORT`). Keyboard bindings follow SDL defaults:
`a` is A, `s` is B, `m` is Start, arrow keys move the circle pad. Touch coordinates
are fractions of the combined canvas. Saves use the persistent UI and are exported
to `tmp_test/fixtures/<title>/<scene>/<title-id>.01.cst`, with screenshot and JSON
metadata next to the scene directory. Use that native filename with `--state`.
Keep ROMs, states, and game screenshots local. Label dialogue/cutscene/menu scenes
explicitly; verify movement before calling a fixture playable.

Fixtures captured locally on 2026-09-07 under `tmp_test/fixtures/`:

| Title | Scene | Compressed bytes | Validation |
|---|---|---:|---|
| Zelda: A Link Between Worlds demo | shop-introduction | 17,347,501 | Fresh Chrome restore passed; dialogue, not free movement |
| New Super Mario Bros. 2 | opening-cutscene | 19,534,310 | Saved for fast-forward comparisons |
| New Super Mario Bros. 2 | w1-1-playable | 20,243,184 | Movement observed; fresh Chrome restore and 5-second responsiveness test passed |
| The Sims 3 | after-create-sim | 9,139,743 | Setup checkpoint |
| The Sims 3 | first-home-tutorial | 10,146,763 | Sim focus/camera interaction observed; fresh Chrome restore passed; tutorial remains active |

These are local benchmark fixtures, not files shipped with GitHub Pages. Exact
ROM/state paths and screenshots are in each scene's JSON metadata. The first-home
Sims scene has a green portrait thumbnail, so it is also useful for visual debugging.

## 2026-09-19 renderer-throughput investigation

Title: `2in1 Horses 3D` (Horse & Foal), 256 MB, macOS (Apple M1), Chrome
headless, ANGLE Metal. Method notes, because the wrong tool answers this
question misleadingly:

1. **The emulator's own counters do not see the display path.** `timeGpu`
   measures CPU time spent emitting GL commands. It read 0.13 ms while the
   browser was spending ~100 ms per frame, so it cannot be used to decide
   whether graphics are the bottleneck.
2. **`ps` cannot attribute Chrome.** A second Chrome instance (the user's own
   browser) contributes processes of the same name, and the GPU process is not
   reliably a child of the harness browser. `SystemInfo.getProcessInfo` over CDP
   is scoped to the browser under test; the benchmark now samples it around the
   measured window and prints cores per process type.
3. **Callback timing alone is ambiguous.** 4 ms of work at 10 callbacks/s can
   mean either a cheap frame or a starved one. `AZAHAR_FRAME_TRACE=1` records
   long-animation-frame entries: 105 ms mean duration with 0.0 ms script and
   0.0 ms blocking established that the main thread was idle and waiting.
4. **Command volume was ruled out by counting.** `AZAHAR_GL_CENSUS=1` wraps the
   WebGL2 prototype and reports calls by name: 4,337 calls/s, 139 draws/s, and
   zero `texImage2D`/`texSubImage2D`/`compileShader` inside the window.
5. **The backend was isolated by substitution.** `--use-angle=swiftshader` runs
   the identical command stream on a CPU implementation and reached 60 Hz and
   101% guest speed. A software rasterizer beating the hardware one on the same
   commands localises the cost to ANGLE's Metal synchronization, not to the
   emulator.

Result: software 100.3% guest speed vs WebGL2/Metal 44.1% on the same scene,
with the GPU process at 0.76 cores against the renderer's 0.05. Screenshots of
both were compared first to confirm they draw the same frame; a renderer that
draws nothing is trivially fast.

Optimization 15 (`web/azahar_ui.js`, `checkDisplayThroughput`) acts on the
duty cycle rather than on frame rate alone, because a low frame rate with a
*busy* callback is CPU-bound and switching renderers would make it worse. It
requires 12 consecutive qualifying half-second samples: a single sample fires
during scene loads, which was observed misfiring the SwiftShader control at 90%
speed before the run requirement was added.

`tests/renderer_autofallback.cjs` drives the production UI end to end and
carries both directions:

```bash
# Positive: ANGLE Metal stalls, Auto must leave it
node tests/renderer_autofallback.cjs

# Negative control: WebGL2 keeps up, Auto must stay on it
AZAHAR_CHROME_ARGS=--use-angle=swiftshader \
  node tests/renderer_autofallback.cjs --expect-none
```

It uploads the ROM through the browser's real file picker. A 256 MB `File`
constructed inside the page competes with the 768 MB emulator heap and fails
`FileReader`, which is what `tests/browser_regression.cjs` currently hits on
this title.
