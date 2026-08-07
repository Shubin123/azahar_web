# WebGL2 renderer readiness contract

This document deliberately does **not** start a renderer implementation. It
defines the boundary that must be satisfied before an accelerated backend can
be offered to users.

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
4. Add PICA rendering incrementally: framebuffer/layout, texture formats and
   swizzles, TEV stages, depth/stencil, blending, then shader/cache behavior.
   Each feature stays behind a compatibility gate until it matches software.
5. Only after all visual and movement gates pass may the UI offer the
   accelerated backend as an experimental preference. Software remains the
   automatic fallback.

## Required gates for every renderer milestone

| Gate | Pass condition |
| --- | --- |
| Capability preflight | `node tests/webgl2_preflight.cjs --require-webgl2` reports context limits/extensions without claiming the production canvas. |
| Generated artifact | `node tests/web_artifact_smoke.cjs` passes for each artifact. |
| Cold boot compositor | `node tests/browser_regression.cjs` observes a high-information compositor frame; renderer-only buffers do not suffice. |
| W1-1 state restore and movement | `node tests/browser_gameplay_state.cjs --state <moving-state.cst>` restores through the normal UI, captures the compositor, holds the default circle-pad right input, and verifies another changed visible compositor frame. |
| Differential review | Compare accelerated and software W1-1 captures from the same state. Any geometry, texture, TEV, depth/stencil, or blend discrepancy is a blocker unless recorded as a known title-specific limitation. |
| Fallback | Force context creation/shader/device failure and verify that a fresh software session boots, renders, and accepts input. |
| Performance | Report headed W1-1 measurements separately from correctness. A backend with no material real-scene improvement remains experimental. |
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
