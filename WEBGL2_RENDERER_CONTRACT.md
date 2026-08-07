# WebGL2 renderer readiness contract

This document defines the boundary that must be satisfied before an
accelerated backend can be offered to users.

## Current implementation milestone

The repository now contains an opt-in `azahar_webgl2` artifact and a
`RendererWebGL2` that owns a browser WebGL2/GLES 3.00 presentation pipeline.
It source-links GLSL ES 3.00 shaders, uses CPU-staged RGBA8 texture uploads,
direct single-context presentation, and RGBA readback. `RasterizerWebGL2` now
owns the PICA operation boundary and forwards every unsupported operation to
the software rasterizer. Its current stage is deliberately `PresentationOnly`;
this is a real WebGL backend and compatibility boundary, not a claim that PICA
draw acceleration has landed. Geometry shaders, texture buffers, image
load/store, persistent maps, program pipelines/binaries, texture views, and
shared-context mailboxes remain gated until each has a WebGL2-safe port.

The next implementation slice is present behind the separate
`ENABLE_WEBGL2_CPU_VERTEX_SLICE` CMake gate, which defaults to `OFF`. It
profiles only flat, untextured, unlit, primary-color TEV batches with a simple
RGBA8 target and no depth/stencil/blend/clip/scissor behavior while preserving
the immediate software path exactly. The underlying handwritten GLSL ES 3.00
program and RGBA8 FBO bridge decode/retile-resolve guest memory with
`DecodeTexture`/`EncodeTexture`, but their execution requires the stricter
`ENABLE_WEBGL2_CPU_VERTEX_EXECUTION` gate, also defaulting to `OFF`. That
second gate stays closed until queued CPU `OutputVertex` batching carries an
immutable PICA state snapshot and passes a stable gameplay differential; boot
and title animations are not valid differential fixtures. The normal
experimental artifact remains stage 0.

The `azahar_get_renderer_stats` export reports both the current PICA stage and
draw/fallback counters. At stage 0 it must report zero accelerated draw
batches. This prevents a presentation-only build from being mistaken for a
performance backend and establishes the baseline for the next slice.
Callers with a 24-double buffer also receive CPU-vertex candidate, rejected,
bridge-failure, state-rejection-mask, per-state-class, and batch-size profile
counters; the original 10-double prefix is unchanged. Rejection-mask bits 0
through 4 represent framebuffer, output-merger, texturing, rasterizer, and
pipeline state respectively. `azahar_reset_renderer_stats` clears the
session counters after a W1-1 state restore so boot work does not pollute a
gameplay differential.

## Non-negotiable deployment rules

- The current software renderer remains a built, tested fallback artifact.
- An accelerated renderer is opt-in until it passes every gate below on the
  W1-1 moving gameplay fixture.
- Backend selection happens before the emulator claims a canvas. A canvas that
  has been given a 2D context cannot later become a WebGL2 canvas.
- WebGL2 context creation, shader compilation, device/context loss, or visual
  validation failure must select software before loading a title. There is no
  in-place renderer swap during an active emulation session.
- No capability probe alone authorizes the accelerated backend. It records
  support; it does not prove PICA correctness.

## Required implementation order

1. Keep `azahar_web` unchanged and add a separately named experimental WebGL2
   artifact. It must be possible to run either artifact from the same revision.
2. Add a runtime capability probe on a separate canvas. Preserve the existing
   software canvas and its compositor regression gate.
3. Implement context lifecycle, resize, loss handling, and a clean software
   fallback. This milestone must not claim raster acceleration.
4. Use the `RasterizerWebGL2` forwarding seam to add PICA rendering
   incrementally. Start with CPU-generated vertices plus a GLSL ES 3.00
   fragment path, then texture formats/swizzles, TEV stages, depth/stencil,
   blending, and guest shader/cache behavior. Each operation stays on the
   software fallback until it matches software.
5. Only after all visual and movement gates pass may the UI offer the
   accelerated backend as an experimental preference. Software remains the
   automatic fallback.

## Required gates for every renderer milestone

| Gate | Pass condition |
| --- | --- |
| Capability preflight | `node tests/webgl2_preflight.cjs --require-webgl2 --artifact webgl2` reports context limits/extensions without claiming the production canvas. |
| Generated artifact | `node tests/web_artifact_smoke.cjs` and `node tests/web_artifact_smoke.cjs --artifact webgl2` pass. |
| Cold boot compositor | `node tests/browser_regression.cjs` observes a high-information compositor frame; renderer-only buffers do not suffice. |
| W1-1 state restore and movement | Run `node tests/browser_gameplay_state.cjs --artifact software --state <moving-state.cst>` and the same command with `--artifact webgl2`. Each restores through the normal UI, captures the compositor, holds the default circle-pad right input, and verifies another changed visible compositor frame. |
| Differential review | Compare accelerated and software W1-1 captures from the same state. Any geometry, texture, TEV, depth/stencil, or blend discrepancy is a blocker unless recorded as a known title-specific limitation. |
| Fallback | `node tests/webgl2_fallback.cjs` forces context loss and verifies navigation to a fresh software session; shader/context creation failure follows the same pre-title route. |
| Performance | Compare `benchmark_browser.cjs --artifact software` and `--artifact webgl2` on the same headed W1-1 state. Report native GPU/swap time and renderer counters as well as FPS. A backend with no material real-scene improvement, or zero accelerated PICA batches, remains experimental. |
| Checkpoint | Commit source first; then run smoke/compositor gates, archive JS/WASM, verify `capture_web_checkpoint.ps1 -Verify`, and commit lock/archive/recovery patch. |

## Fixture discipline

The W1-1 fixture is local and ignored because it contains user-owned game
state. Create it only through:

```powershell
$env:AZAHAR_CAPTURE_MANUAL = '1'
node tests/capture_gameplay_state.cjs
```

The visible overlay is pressed only after the tester clears lower-screen menus
and sees Mario moving in the level. Use the exact printed `.cst` path in
benchmarks; do not substitute splash, title, or tutorial captures.
