# Repository layout and source retrieval

The outer repository is intentionally small. It contains the experimental web frontend, focused tests, build helpers, and project documentation. Large or externally maintained trees are kept out of Git.

## External source trees

`azahar/` is a separate checkout of the upstream emulator repository:

```powershell
git clone https://github.com/azahar-emu/azahar.git azahar
git -C azahar submodule update --init --recursive
```

The upstream checkout owns its own `.gitmodules`, including Boost, Dynarmic, SDL2, LibreSSL, Crypto++, fmt, Zstandard, and the other emulator dependencies. `azahar-webgpu/` is the local overlay; its CMake/source/tests/examples are tracked here, while copied dependency trees (`externals/` and the duplicate `src/fmt/`) and `build-*` output are ignored. The overlay's logging sources remain tracked because `types.h` contains the WebGPU-specific `Render_WebGPU` type.

`test_games/` contains local ROM/archive data and is intentionally ignored. Do not commit it; use separately obtained, legally owned test data when needed.

## Generated files

`build-web/`, `build-integration/`, `_test_cmake/`, `tmp_test/`, and the generated `web/azahar.{js,wasm,html}` files are disposable build outputs. Recreate the WebAssembly build with:

```powershell
cmake -B build-web -S azahar -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DENABLE_QT=OFF -DENABLE_SDL2=ON -DENABLE_SDL2_FRONTEND=ON -DENABLE_SOFTWARE_RENDERER=ON -DENABLE_OPENGL=OFF -DENABLE_VULKAN=OFF -DENABLE_SCRIPTING=OFF -DENABLE_TESTS=OFF
build_web.bat
```

`azahar_web_assets` automatically copies the current `azahar.js` and `azahar.wasm` to `web/` on every build, and `build_web.bat` verifies their hashes. Run `serve_web.bat` to serve that directory with the required isolation headers on port 9000; both `/` and `/web/index.html` are accepted. The generated artifacts remain ignored by the outer repository.

`artifacts/azahar-web.lock.json` is the tracked provenance record for the last browser-verified build, and `artifacts/releases/` holds tracked, immutable checkpoint ZIPs. Follow [ARTIFACTS.md](ARTIFACTS.md) after every successful real-ROM checkpoint. This is intentionally separate from day-to-day generated files: the lock binds a known-good JS/WASM pair to the precise inner commit and recursive submodule revisions, while the ZIP allows the exact served pair to be restored without rebuilding.

## Two-repository rule

Changes under `azahar/` belong to the upstream checkout and are not automatically captured by the outer repository. The current web port includes required changes in that inner checkout, including the Emscripten entry point, CMake integration, SDL presentation, thread compatibility, UDP stub, and LibreSSL portability shim. Before resetting or recloning it, export or commit those changes in the upstream repository (or preserve them as a reviewable patch). Do not discard them merely because the outer repository ignores the checkout.

Check both repositories independently:

```powershell
git status
git -C azahar status
```
