# Web build checkpoints

The emulator source checkout (`azahar/`) and generated deployment files
(`web/azahar.js`, `web/azahar.wasm`) are intentionally not normal outer-repo
sources. A working build is therefore only durable when it has a source commit,
a tracked provenance lock, and (for a release-quality checkpoint) an archived
artifact.

## Required checkpoint sequence

1. Commit the intended emulator changes inside `azahar/`, then push that commit
   to a branch you control. Do not checkpoint a dirty inner tree; that is how
   untracked source changes get lost. If the commit is not yet in its configured
   upstream, the checkpoint command writes a tracked recovery patch containing
   every commit from the upstream merge-base through `HEAD`.
2. Build and synchronize the files in `web/`.
3. Run the generated-artifact smoke test and the real-ROM browser regression.
4. Capture the checkpoint and archive the exact JS/WASM pair:

   ```powershell
   .\scripts\capture_web_checkpoint.ps1 -Archive
   ```

5. Commit the outer-repository changes, including
   `artifacts/azahar-web.lock.json` and the newly created ZIP in
   `artifacts/releases/`.

The lock records the upstream commit, recursive submodule revisions, artifact
sizes, and SHA-256 digests. The ZIP is deliberately tracked rather than
ignored: it is the recoverable deployment artifact for a browser-verified
checkpoint. If the source commit has not been pushed yet, the tracked recovery
patch prevents the inner checkout's commits from being the sole copy. Create an
archive only after a passing real-ROM check, not for each local iteration.

## Verify a checkpoint

After a clone or before benchmarking, regenerate the build and compare it to
the saved checkpoint:

```powershell
.\scripts\capture_web_checkpoint.ps1 -Verify
```

This fails if the emulator revision, submodule state, generated JS, or generated
WASM differs from the committed lock. It also fails for a dirty inner source
tree, forcing source changes to be committed before a durable benchmark or
release claim.

## Restore a known-good artifact

The matching archive is named with the first 12 characters of the source commit
and WASM digest. Extract it into `web/` to restore the served `azahar.js` and
`azahar.wasm`, then run the browser regression. The lock still identifies the
exact source and submodule state needed to rebuild it.

Never put ROMs in a checkpoint archive or commit them to this repository.
