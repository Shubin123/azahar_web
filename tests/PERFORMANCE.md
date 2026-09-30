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
# Positive: ANGLE Metal stalls, Auto must leave it and reuse the verdict
node tests/renderer_autofallback.cjs

# Back-compat: an explicit WebGL2 choice survives the same stalling backend
node tests/renderer_autofallback.cjs --pinned

# Negative control: WebGL2 keeps up, Auto must stay on it
AZAHAR_CHROME_ARGS=--use-angle=swiftshader \
  node tests/renderer_autofallback.cjs --expect-none
```

Measured on 2026-09-19 with `2in1 Horses 3D`:

| Direction | Result |
|---|---|
| Auto, ANGLE Metal | switched; 14 -> 60 game FPS, 23% -> 100% speed |
| Auto, repeat visit | went straight to software in 0.1 s from the stored verdict |
| Pinned `?renderer=webgl2` | stayed on WebGL2 (47 game FPS / 78%) as chosen |
| Auto, ANGLE SwiftShader | stayed on WebGL2 |

It uploads the ROM through the browser's real file picker. A 256 MB `File`
constructed inside the page competes with the 768 MB emulator heap and fails
`FileReader`, which is what `tests/browser_regression.cjs` currently hits on
this title.

## 2026-09-30 emulation-thread parallelism

Engine commits `2e80ec649`..`694ea43b0` on `azahar_emscripten`
(`web-port-recovered`). Software renderer, headless Chrome, 16 logical CPUs,
unprofiled 15-second windows. Each row pair ran back to back, pre-change build
first, and the table shows the mean of two pairs.

| Scene | Build | Game FPS | Guest speed | GPU ms/frame |
|---|---|---:|---:|---:|
| Mario 3D Land demo, `mario-moving` state | before | 16.4 | 28% | 50.6 |
| | after | 32.9 | 55% | 21.3 |
| Cubic Ninja title, 20 s boot warmup | before | 20.7 | 69% | 10.3 |
| | after | 30.0 (cap) | 101% | 5.1 |
| Animal Crossing boot, 20 s warmup | before | 26.3 | 44% | 29.4 |
| | after | 41.7 | 70% | 15.1 |

Boot-path scenes are time-based, so a faster build reaches a later scene in
the window; use the save-state row for decisions.

What changed, in order of impact:

1. **Per-SVC clock reads removed on the web.** `PerfStats` timed every SVC
   and IPC request with `steady_clock::now()`, a JavaScript import in WASM.
   That was ~22% of the emulation thread. The web UI never reported those
   spans.
2. **Vertex shading on the worker pool.** For draws of at least 96 vertices
   without a geometry shader, distinct vertices are shaded in 32-vertex tasks
   through `RasterizerInterface::RunParallel`. Primitive assembly stays serial
   and in order. The shader interpreter had been ~42% of the emulation thread.
3. **One raster barrier per draw.** Triangles queue until `DrawTriangles()`.
   Threads then claim slices of framebuffer-global row bands (aligned to the
   3x3 sample blocks) and walk the whole draw in submission order, so pixel
   ordering is unchanged. Before this, each triangle was its own fork/join,
   and the main thread busy-waited (~26% in Animal Crossing).
4. **Display transfers split into 16-row tasks** (~5% of the emulation thread).

The calling thread takes work in every parallel region: a pool wait on the
browser main thread is a spin loop. No threads were added; the existing
six-worker pool cap stands.

Remaining main-thread profile (Mario state): ARM interpreter ~24%, the main
thread's share of parallel shading/raster ~48%, serial PICA bookkeeping
(clipping, register writes, shader setup) ~20%. The next structural step would
be an asynchronous GPU thread overlapping command lists with ARM execution.
That changes when guests observe P3D/PPF interrupts relative to guest time, so
it needs its own validation plan.

`AZAHAR_SCENE_SCREENSHOT=path.png` makes `benchmark_browser.cjs` save the
frame it sampled for the scene statistics, so two builds can be compared
visually on the same state.

## 2026-09-30 asynchronous GPU thread

Engine commits `028a4b7dd`..`1839c21ba` on `azahar_emscripten`
(`perf/macro-fps`). Software renderer, headless Chrome, 16 logical CPUs
(8 physical), unprofiled 15-second windows. A background VM kept one core
busy during these runs, so single runs varied by up to ±3 game FPS; the
Mario row is the mean of five interleaved before/after pairs.

| Scene | Build | Game FPS | Guest speed | GPU ms/frame |
|---|---|---:|---:|---:|
| Mario 3D Land demo, `mario-moving` state | before (`63b5dd429`) | 30.9 | 51% | 22.6 |
| | after | 41.1 | 69% | 21.0 |
| Animal Crossing boot, 20 s warmup | before | 43.8 | 72% | 14.5 |
| | after | 60.9 | 103% | 13.4 |
| Cubic Ninja title, 20 s warmup | before | 30.4 (cap) | 101% | 5.2 |
| | after | 30.5 (cap) | 101% | 4.7 |

What changed:

1. **GSP commands run on a GPU thread.** The emulation thread (the
   browser main thread) used to process every PICA command list itself,
   about two thirds of its time. `GPU::Execute` now queues GSP commands to
   a dedicated thread. The interrupts they raise are delivered to the guest
   by the emulation thread at the start of each `RunLoop`. The emulation
   thread waits for the GPU thread only when every guest thread is idle,
   at VBlank, on GPU register access, and before saving state. The guest's
   ARM code now overlaps GPU work instead of alternating with it.
2. **Spinning fork-join pool.** Parallel shading and rasterization regions
   used a mutex/condvar queue, so each region paid a futex wake per worker
   plus one at the join. That cost matters now that the join is on a worker
   thread, where waits really block. `SwThreadPool` publishes a region
   through one atomic and spins briefly before sleeping.
3. **Finer work items** (16-vertex shading tasks, three raster slices per
   thread) cut load imbalance at the joins.

The pthread pool has one more worker for the GPU thread. Hardware renderers
still execute GSP commands synchronously.

After the change, the GPU thread is the critical path in Mario (about 85%
busy). The main thread waits for it roughly 60% of the time, almost all of
that because the guest is waiting on a P3D interrupt. Letting the waiting
main thread take raster/shading items was tried and made Animal Crossing
slower (60.8 -> 49.9 FPS): on 8 physical cores it only adds contention.
Clipping triangles in parallel chunks at draw time made no measurable
difference, since most draws are small.

Remaining GPU-thread profile (Mario state): vertex shader interpreter ~22%
(plus ~16% on each worker), its share of rasterization ~22%, triangle
clipping/setup ~9%, PICA register writes ~5%, idle ~13%.

`AZAHAR_WORKER_PROFILE=1` makes `benchmark_browser.cjs` also write one
`.worker<N>.cpuprofile` per pthread next to `AZAHAR_CPU_PROFILE`. The GPU
thread's profile is the one with `ProcessCmdList` under it.

`tests/title_transition_regression.cjs` fails at the title touch step with
both the old and new engine builds, so it is not a regression from this
change.
