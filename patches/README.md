# Native source deltas

The nested source directory is ignored by the wrapper repository. The patches
here record the complete per-file deltas against nested Azahar commit
`30d214dd69a791dc91a024c5062b09ec33792985` for the web-specific files changed
by this wrapper:

- `pica-core-web.patch` — PICA vertex cache and optional `?picaTrace=1` counters.
- `shader-interpreter-web.patch` — decoded instruction cache, stack storage, and
  WebAssembly arithmetic-path changes.
- `emscripten-main-web.patch` — browser lifecycle, render selection, native-clock
  policy, save-state, and speed-control bridge.
- `cmake-web.patch` — web targets and the WebAssembly SIMD build baseline.

On an otherwise compatible source checkout, check each selected patch with
`git apply --check ../patches/<name>.patch` before applying. These are per-file
deltas, not a replacement for the entire Emscripten port. The current local
checkout already contains them; do not apply them again.
