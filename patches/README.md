# Native source deltas

`pica-core-web.patch` records the complete PICA core file delta against nested
Azahar commit `30d214dd69a791dc91a024c5062b09ec33792985`. It includes the existing
256-entry vertex cache and the optional `?picaTrace=1` counters added in this
profiling pass. The nested source directory is ignored by the wrapper repository;
this patch preserves the source corresponding to these tracing changes.

On an otherwise compatible source checkout, check with
`git apply --check ../patches/pica-core-web.patch` before applying. This is one
file's delta, not the entire Emscripten port. The current local checkout already
contains it; do not apply it again.
