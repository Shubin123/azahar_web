# Getting the port fork onto another machine

This repository is only the wrapper: the web UI, the test harness, and the
generated `web/*.wasm` artifacts. The Emscripten/C++ port itself — the SDL
frontend, the WebGL2 renderer, and the web CMake targets — lives in a private
Azahar fork that is not here and is not upstream.

Run these on the machine that has the fork. On the Windows box referenced by
`run_build.bat` that is `C:\Users\shubadub\Documents\azahar`; commands below use
PowerShell.

## Why this is needed

`patches/` records deltas against Azahar commit
`30d214dd69a791dc91a024c5062b09ec33792985`, which does not exist in
`azahar-emu/azahar` (the GitHub API returns 422 for it, and 200 for upstream
HEAD). Upstream has no `src/citra_sdl/`, no `src/video_core/renderer_webgl2/`,
and no `ENABLE_WEBGL2_RENDERER` or `azahar_web_bundle` targets. Without the
fork, nothing inside `azahar.wasm` / `azahar_webgl2.wasm` can be rebuilt, which
blocks the two largest remaining FPS wins (see PROJECT.md → "Next FPS Work",
items 0 and 1).

## 1. Confirm it is the right tree

```powershell
cd C:\Users\shubadub\Documents\azahar

git rev-parse --verify 30d214dd69a791dc91a024c5062b09ec33792985   # must resolve
Test-Path src\citra_sdl\emscripten_main.cpp                        # must be True
Test-Path src\video_core\renderer_webgl2                           # must be True
git log --oneline -3
git status --short                                                 # see step 2
git remote -v
```

## 2. Commit anything uncommitted

A push or bundle only carries committed history. If `git status --short`
printed anything, the working tree holds port changes that would be left
behind — the shipped `.wasm` may have been built from exactly those.

```powershell
git add -A
git commit -m "Web port working state"
```

Then make sure the patch base is reachable, so it travels with the history
(`--all` only follows branches and tags):

```powershell
git tag -f web-port-base 30d214dd69a791dc91a024c5062b09ec33792985
```

## 3. Send it — pick one

### Option A: private GitHub repo (recommended)

The Mac is already signed in to `gh` as `Shubin123` with `repo` scope, so it can
clone this with no further setup.

```powershell
gh auth login                    # only if this machine is not signed in yet
gh repo create Shubin123/azahar-web-port --private
git remote add handoff https://github.com/Shubin123/azahar-web-port.git
git push handoff --all
git push handoff --tags
```

If a push is rejected for size, something large is committed in history — most
likely a build directory or a ROM. Say so rather than rewriting history; Option
B avoids the limits entirely.

### Option B: git bundle (no server, USB/OneDrive/email)

One file, carries full history, nothing is published anywhere.

```powershell
git bundle create $HOME\Desktop\azahar-port.bundle --all
git bundle verify $HOME\Desktop\azahar-port.bundle
```

Copy `azahar-port.bundle` to the Mac (any transfer works) and say where it
landed.

### Option C: direct pull over the LAN

If both machines are on the same network and the Mac can reach this one over
SSH, just share the path and I will clone it directly.

## 4. Submodules

The externals are normally public upstreams and will be re-fetched on the Mac.
Check whether any were redirected to a personal fork:

```powershell
git config --file .gitmodules --get-regexp url | Select-String "Shubin123|shubadub"
```

If that prints anything, those repositories have to come across too — repeat
step 3 for each.

## 5. Do not send

- `build-web2\`, `build-webgl2-opengl\`, `build-web\` — multi-GB and rebuildable
- `test_games\` — ROMs
- `tmp_test\` — save states and benchmark output

One exception worth copying by hand, if it exists: the linker symbol maps used
by `tests/profile_report.cjs`. They are small text files and make CPU profiles
readable.

```powershell
Get-ChildItem build-webgl2-opengl\bin\Release\*.html.symbols
```

## 6. On the Mac afterwards

The fork replaces the upstream checkout at `azahar/`:

```bash
# Option A
rm -rf azahar && gh repo clone Shubin123/azahar-web-port azahar
cd azahar && git submodule update --init --recursive && cd ..

# Option B
rm -rf azahar && git clone /path/to/azahar-port.bundle azahar
cd azahar && git submodule update --init --recursive && cd ..

./build_web.sh --clean
```

`cmake/emscripten-web-shims.cmake` and `cmake/emscripten-libressl.cmake` fix two
upstream assumptions that break under Emscripten (see PROJECT.md → "Build
reproducibility"). If the fork already handles them, the shims no-op — both are
guarded by `if (NOT TARGET ...)` / `if (EMSCRIPTEN)`.
