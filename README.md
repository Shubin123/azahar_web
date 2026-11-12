# Azahar Web — Nintendo 3DS Emulator in the Browser

A WebAssembly port of [Azahar](https://github.com/azahar-emu/azahar) (Citra fork) that runs Nintendo 3DS games directly in the browser.

## Quick Start

### Run Locally

```bash
# Clone the repo
git clone https://github.com/Shubin123/azahar_web.git
cd azahar_web

# Start the local server (requires Node.js)
node web/server.cjs
# Or on Windows:
serve_web.bat
```

Open `http://localhost:8765` in Chrome, then load a **decrypted** `.3ds` ROM file.

### Play Together on One Device

**Local Play → 👥 Play together on this device** (or open `split.html`) gives
each player a screen of their own in one browser tab, 2 to 8 players
(`?players=N` up to 16): every screen is a separate console with its own
address and console ID, running the same game, and the consoles talk through
one pool of memory shared inside the tab (a ring per console that every other
console reads) instead of a network. Use the game's own local wireless menus as on real consoles, for
example Mario Kart 7's *Local Multiplayer*. Games that add players through
**Download Play**, such as Mario Party: Island Tour, open a lobby on the host's
screen that a 3DS joins from its HOME Menu; here every other screen joins it
on its own after a 5-second countdown (with **Not now**; **📥 Join Player N's
Download Play** joins later; a screen its player is using asks instead), with the Download Play part of its own copy of the
game (nothing is downloaded, and the dump may leave that part encrypted). A
screen whose game has its own wireless menu open is only offered 📥, so Mario
Kart 7 players can still join from the menu with the full game. When everyone
is listed, the host starts the game and the other screens restart into it. The
current game comes along (it is copied into browser storage if it was picked
from disk); otherwise choose a file, or a game played before, on that page.
Every game in the library's *Downloaded & ready to play* list also has a
**👥 Together** button that opens it this way in one click.

Players 1 and 2 share the keyboard, each with keys of their own: Player 1 the
left side (WASD moves; G, F, T, R are A, B, X, Y; Q/E are L/R; Z X C V the
D-pad; 1 Start; 2 Select) and Player 2 the right side (arrows move; L, K, O, I
are A, B, X, Y; U/P are L/R; M , . / the D-pad; Enter Start; Right Shift
Select). Each screen lists its keys and can pick other ones; Ctrl+1–9 gives one
player the whole keyboard (the emulator's usual keymap) and Ctrl+0 shares it
again. Controllers go to the players in the order they connect, or pick one per
screen. Each screen also shows the game room its console hosts or joined, and
the page says when every player is in one room. Only Player 1
is heard at first; each screen has its own mute button. Each player's
**Screens** menu sets how their console's two screens fill its space: **big
top** (the default: the top screen as large as it fits, the touch screen
50–75% of its size below or beside it), **stretched** (the top screen also
stretched over the room the touch screen leaves) or **3DS** (both at one size,
stacked); the browser remembers each player's choice. All consoles share
this device's processor: the page splits each display refresh between them,
and a console that is waiting for its next frame passes the rest of its time
to the others. With the accelerated renderer an Apple M4 runs a two-player
Mario Kart 7 race at full speed on both screens; the compatibility renderer is
much slower there.

**↺** on a screen restarts that console afresh, the others playing on (a host
drops it from its room, so it can join again). While everyone is in one room,
all consoles save a checkpoint together every couple of minutes: once each can
save at its next frame, they take in whatever is still on its way between them
and save while the link holds new frames, so nothing is in flight between their
checkpoints (about half a second per console, a pause on every screen; the
header's *Checkpoints* menu or `?checkpoints=0|120|300` changes or stops
this; a game that is always mid-operation, such as a Mario Kart 7 race, gets
none). **⤺ Back to checkpoint** brings every console back to it at
once, so their games still agree: one console going back alone (the host, say)
leaves the others' games ahead of it, and Mario Party reports a communication
error. A console that stops on its own is restarted automatically, on the
interpreter if compiled ARM code was on, and everyone goes back to the
checkpoint when there is one. On the accelerated renderer, shadow-mapped scenes
(such as Mario Party's attract intro) draw without their shadows: WebGL2 has no
image load/store, which 3DS shadow maps need; such a scene used to stop the
console with `RuntimeError: null function`. Mario Kart 7 still breaks off with a communication error in
some sessions after the room closes, on one device and between devices alike,
and its rooms take two players on one device for now: a third console finds
the room but the game does not list it (see `tests/PERFORMANCE.md`).

### Let an AI Play (NitroGen)

The **🤖 AI Player** widget lets NVIDIA's [NitroGen](https://huggingface.co/nvidia/NitroGen)
play for you: a 493M-parameter model (a SigLIP2 vision encoder and a flow-matching
transformer) trained on 40,000 hours of gameplay video to predict gamepad actions from game
frames. It looks at the top screen and holds the keys a controller would, through the page's
keymap, so your own keys and controller keep working alongside it. On its own it sees one
frame at a time and reacts; the optional planner below gives it a direction.

- **Nothing is fetched until you ask.** *Download model* streams NVIDIA's `ng.pt` (1.97 GB)
  straight from huggingface.co at a pinned revision (584c8dd), checks every tensor it uses
  against the CRC32 in `web/vendor/nitrogen/q8/manifest.json`, quantizes it to 8 bits on
  your device and keeps only the result (603 MB) in the browser's Cache Storage; that result
  must match the reference conversion's SHA-256 byte for byte. ng.pt itself is not kept
  (it is fetched with `cache: 'no-store'`). With it come the light expert's own weights
  (122 MB, from this site, checked against the manifest's SHA-256s). *Delete model* removes
  it all. This repository ships the ONNX graphs, never NVIDIA's weights.
- **Let the AI play** loads ONNX Runtime Web 1.31.1 from cdn.jsdelivr.net and runs the model
  in a worker on WebGPU (else WebAssembly). Each decision takes the frame just drawn and
  returns 18 actions, one per 1/60 s of game time. The game runs on while the AI decides the
  next ones, skipping actions that come too late; on a device too slow for that, tick *Pause
  the game while the AI thinks*, as NVIDIA's own player pauses its games. A screen that has
  not changed (a still menu) reuses what the model saw in it. Start and Select are off unless
  you allow them (NVIDIA's player also keeps the model off menus by default), HOME always.
- **Image encoder** (most of a decision's time):
  - *Mixture* (the default): a light expert reads every frame, and its gate hands the frames
    it is unsure of (about one in ten) to NitroGen's own encoder, so most decisions never use
    the heavy encoder's weights.
  - *Light expert only*: the fastest.
  - *NitroGen only*: NVIDIA's SigLIP2-large on every frame, NitroGen exactly as published.
- **Planner (System 2)**, off until you choose a model: a small vision-language model
  (Qwen3.5-0.8B or LFM2.5-VL-450M from huggingface.co, pinned revisions, run with
  Transformers.js 4.3.2 from cdn.jsdelivr.net) looks at both screens every 5 seconds of game
  time, with your notes (quest log, the task at hand, manual pages), and steers NitroGen:
  NitroGen makes 4 action chunks per decision in one batched run and the one that best goes
  the planner's way (its heading, the buttons it favours) is played, and buttons it wants
  avoided are never pressed. In menus, dialogues and on the bottom screen it presses buttons
  and touches the screen itself while NitroGen waits. It shows its goal in the widget.
- NitroGen is under the [NVIDIA License](web/vendor/nitrogen/LICENSE): non-commercial
  research use only. The light expert learned from NitroGen, so the same terms apply to it;
  its tower is Google's [SigLIP-base/16](https://huggingface.co/google/siglip-base-patch16-224)
  (Apache 2.0).

How it is made fast, and checked. `scripts/nitrogen/nitrogen_onnx.py` writes the graphs:
NVIDIA's inference code as ONNX operators, its linear layers in 8-bit `MatMulNBits` blocks of
32, the image encoders computing in float16, each residual add folded into ONNX Runtime's
`SkipLayerNormalization`, attention as MatMul and Softmax (ONNX Runtime's
`MultiHeadAttention` kernel is several times slower on WebGPU here), everything that depends
only on the denoising step folded into constants when the session is created, and the
denoiser's steps unrolled into one graph that takes a batch of noises. It samples the
actions with 4 flow-matching steps rather than NVIDIA's 16, as GR00T, whose action head
NitroGen's is, does. On an Apple M4 that takes a decision with NitroGen's own encoder from
329 ms to 122 ms (the encoder 95 ms, the denoiser 27 ms).

The light expert (`scripts/nitrogen/nitrogen_light_expert.py`) fuses
[Laya-Vision](https://huggingface.co/ZeraG07/laya-vision)'s front end into NitroGen as a second
expert of a mixture: SigLIP-base/16 at 256 pixels to its layer -2 and an adapter (Laya-Vision's
projector, then 2 transformer layers) into NitroGen's image feature space; NitroGen's VL layers
and denoiser are shared. A graph of its size runs in 46 ms on WebGPU against NitroGen's
encoder's 97. With the tower frozen and the adapter trained to copy NitroGen's features it
failed: features only cosine 0.82, and its actions further from NitroGen's than if it had been
shown a random other frame. What made it pass: training the tower's layers 5-10 too, and a loss
on what NitroGen does with the features (its frozen VL layers' output and the action velocities
its denoiser predicts at the 4 Euler steps' states), on 1,890 frames recorded from Pokémon X,
Mario Kart 7 and Craftus with augmentations. Its action error on held-out frames fell from 1.53
to 0.39 (1 = a random frame's). The gate predicts each frame's action error from the tower's
pooled tokens; its threshold sends 10% of fresh frames (`tmp_test/ai_frames/gatecal`) to
NitroGen's encoder. `nitrogen_onnx.py light` writes its graph, which reads NitroGen's VL weights
from the encoder's own weights file, so nothing more is converted from ng.pt.
`scripts/nitrogen/nitrogen_dataset_frames.py` cuts active-play frames (idle frames dropped, as
the dataset card asks; overlays blacked out) from the videos of NVIDIA's
[NitroGen dataset](https://huggingface.co/datasets/nvidia/NitroGen) for training on many more
games.

- The NitroGen graphs in float32 with 16 steps reproduce NVIDIA's own code to within 1e-5 on
  emulator framebuffers (`nitrogen_validate.py`, NVIDIA's model on the GPU); the light
  expert's float32 graph reproduces its PyTorch modules to within 5e-5.
- `tests/ai_player.test.cjs` (and `tests/ai_bench.cjs --expert gate|light|heavy` for any
  variant) compares the page's model with float32 NitroGen as policies, in the browser on
  WebGPU: 12 noise draws per framebuffer, saved ones (`tests/ai_frames.cjs`) and ones taken
  from the running game. How often it holds each 3DS key, and where it puts the sticks, must
  be within 1.25 times the float32 model's own difference between two sets of draws, and its
  draws as varied (0.8-1.25 times as often two draws hold different keys). NitroGen's own
  encoder at 8 bits, on 48 framebuffers: key frequencies 0.60 apart (float32 against itself
  0.72), sticks 0.038 (0.059), variety 0.89 and 0.88 times. The light expert alone at 8 bits:
  keys 0.54 (float32 against itself 0.55), sticks 0.032 (0.034), variety 0.85 and 0.81 times.
  The page's mixture, on 32 saved framebuffers and 16 from Pokémon X running: keys 0.77
  (0.77), sticks 0.056 (0.065), variety 0.86 and 0.83 times.
- It also checks the planner's steering, with a plan to head left, favour A and avoid B: B
  was never pressed (NitroGen alone pressed it on 18 of 384 actions) and A twice as often
  (0.10 to 0.19 of actions), but left only 0.02 to 0.07: picking among NitroGen's own draws
  cannot head somewhere NitroGen rarely goes, and the check asks for 0.1 more. And it checks
  that a planner's touch reaches the bottom screen (it opens Pokémon X's Friends list).
- `tests/ai_planner_bench.cjs` times the planner models in the browser and records what they
  read and plan on both-screen frames (`tests/ai_frames.cjs --screens`).
- What failed the checks: 2 denoising steps (variety 0.64 times: the actions fall back on
  their average), 1 step (0.03 times), smaller images (224 pixels: key frequencies 0.84
  apart), plain 4-bit weights (85% of actions with the same keys as float32 from the same
  noise), a mixture of experts in the encoder's feed-forward layers (16 experts per layer from
  co-activation clustering, as in MoEfication: even routed by an oracle, half the neurons
  active moved the key frequencies 1.46 times as far as float32 against itself), and the
  frozen-tower light expert above.

### Play on Other Devices and Share Saves (LAN)

```bash
npm run serve:lan        # node web/server.cjs --lan
```

This serves the page to your whole network over HTTPS and prints the address
to open on each device (e.g. `https://192.168.1.20:8765/`). HTTPS is required
because browsers only let the emulator use threads on a secure page; the server
makes a self-signed certificate with `openssl` on first run (kept in `.tls/`),
so each device shows a certificate warning once — accept it to continue. To
avoid the warning, pass a trusted certificate, e.g. from
[mkcert](https://github.com/FiloSottile/mkcert):
`TLS_CERT=cert.pem TLS_KEY=key.pem npm run serve:lan`.

Save-state sharing is available only while connected to another player in a
public or private Local Play lobby. Browsing lobbies, creating an unanswered
invite, and linking same-browser tabs do not enable sharing. Leaving or losing
the connection stops transfers and hides the LAN sync button.

Connected browsers keep their own copies and sync with the page server when
Local Play connects, after every save or delete, when the tab comes into view, and
every 20 seconds. Use **Sync LAN saves** in the Saves panel to transfer changes
immediately. The newest change to a slot wins, and deleting a slot deletes
it everywhere. The server stores them in `saves/` (override with `SAVE_DIR`).
Pages opened from a static host such as GitHub Pages keep saves in that
browser only. Games' own in-game saves are not persisted yet; use save states.

On Windows, `launch_chrome_vulkan.bat` starts the local server and opens Chrome
with the Vulkan ANGLE backend in a separate local profile. This is useful on
drivers where Chrome's default D3D11 backend stalls; it keeps the normal Chrome
profile and the site's renderer defaults intact. If Vulkan is unavailable, use
the standard local server and the Compatibility renderer.

Automatic recovery to Compatibility reopens the current ROM in a fresh session.
Picked files are copied into browser storage only when that recovery is needed;
if storage is unavailable, select the file again. Recovery restarts the title,
so load a browser save slot to restore saved progress.

### Deploy to GitHub Pages

The `web/` folder is self-contained and `.github/workflows/pages.yml` publishes it on every relevant `main` push. The workflow stamps the commit on every script the pages load (`?v=`), and `azahar_ui.js` and `azahar_split.js` pass it on to the engine's files and to each console's page, so a browser never runs one deploy's page with another's scripts (Pages lets it keep any file for 10 minutes, and a reload checks only the page). The included `coi-serviceworker.js` handles the required cross-origin isolation headers automatically on static hosts. The single `index.html` page provides Auto, accelerated WebGL2, and compatibility renderer modes, 1x-4x internal-resolution scaling, a 1x-4x fast-forward target for cutscenes, a fullscreen view (Alt+Enter) that keeps both screens' shapes and sizes the bottom screen between user-set minimum and maximum percentages of the top screen, and per-game persistent browser save slots; switching renderers performs the fresh-page reload required by browser canvas contexts.

## What's Included

```
web/                    # Ready-to-serve web application
  index.html            # Main page (accelerated WebGL2 first)
  index_webgl2.html     # Legacy redirect into index.html renderer selection
  azahar_ui.js          # UI controller (ROM loading, run loop, FPS display)
  azahar_input.js       # Gamepad and keyboard input mappings
  azahar_touch_controls.js # On-screen mobile controls for touch screens without a controller
  azahar_savestates.js  # IndexedDB persistence for compressed per-game save slots
  split.html            # Several consoles on one device, one screen per player
  azahar_split.js       # split.html: screens, controllers, sharing the main thread
  azahar_split_seat.js  # One console inside split.html (index.html?seat=N)
  azahar_shared_link.js # Shared-memory rings that link consoles on one device
  azahar_cpu_jit.js     # CPU watchdog: switches a stuck game from compiled code to the interpreter
  azahar_fullscreen.js  # Fullscreen view: screen layout within the user's size bounds
  azahar_ai_player.js   # AI Player widget: NitroGen sees the top screen and holds keys
  azahar_ai_worker.js   # Downloads, checks, quantizes, caches and runs NitroGen (worker)
  vendor/nitrogen/      # NitroGen's ONNX graphs, manifest and scales (no weights) + LICENSE
  coi-serviceworker.js  # COOP/COEP header injection for static hosts
  server.cjs            # Local dev server with isolation headers
  azahar.js             # Emscripten glue (software renderer)
  azahar.wasm           # WebAssembly binary (software renderer, ~10 MB)
  azahar_webgl2.js      # Emscripten glue (WebGL2 renderer)
  azahar_webgl2.wasm    # WebAssembly binary (WebGL2, ~10 MB)
tests/                  # Test suite
  web_artifact_smoke.cjs  # Offline WASM validation
  benchmark_browser.cjs   # Headless Chrome performance benchmark
  browser_regression.cjs  # E2E rendering regression test
  title_transition_regression.cjs # Cold-boot title-to-game regression
  config.cjs              # Shared test configuration
  ai_frames.cjs           # Saves the AI player's model inputs from a running game
  ai_player.test.cjs      # AI player: lazy download, conversion, speed, fidelity, play, delete
  ai_bench.cjs            # AI player: any model variant's speed and fidelity in the browser
  ai_common.cjs           # Shared by both: model workers, framebuffers, policy comparison
scripts/nitrogen/       # Makes and validates the AI player's quantized NitroGen
build_web.bat           # Windows build script (requires Emscripten SDK)
serve_web.bat           # Windows shortcut to start local server
PROJECT.md              # Detailed architecture and optimization history
```

## Requirements

**To run:** Any modern browser with WebAssembly SIMD and SharedArrayBuffer support (Chrome 91+, Firefox 89+, Safari 16.4+, iOS/iPadOS 16.4+).

On Safari and every iOS browser (all are WebKit), a ROM picked from the device is first copied into the browser's private storage (shown as "Copying ROM into browser storage"), because WebKit cannot read the picked file while a game runs. There is only ever one such copy, replaced by the next title; it needs free space equal to the ROM's size.

**To build from source:** Emscripten SDK 6.0+, CMake, Ninja, and the Azahar source tree checked out at `./azahar/`.

The web-specific engine changes (the SDL/software/WebGL2 port itself — `src/citra_sdl/`,
`src/video_core/renderer_webgl2/`, and the related CMake targets) live in a separate
sibling repository, [`Shubin123/azahar_emscripten`](https://github.com/Shubin123/azahar_emscripten)
(private), not upstream `azahar-emu/azahar`. Clone it as an independent sibling checkout
(not nested inside this repo) — see Building from Source below for why that needs one
extra CMake variable. `patches/README.md` predates that repo and pins a commit that
isn't reachable from upstream for the same reason — the engine's own history is the
source of truth now.

## Building from Source

```bash
# Clone both as siblings, not one inside the other
git clone https://github.com/Shubin123/azahar_web.git
git clone https://github.com/Shubin123/azahar_emscripten.git

# Configure (requires Emscripten activated in your shell)
emcmake cmake -B build-webgl2-opengl -S azahar_emscripten -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DENABLE_QT=OFF \
  -DENABLE_SDL2=ON \
  -DENABLE_SDL2_FRONTEND=ON \
  -DENABLE_SOFTWARE_RENDERER=ON \
  -DENABLE_OPENGL=ON \
  -DENABLE_WEBGL2_RENDERER=ON \
  -DENABLE_VULKAN=OFF \
  -DENABLE_OPENAL=OFF \
  -DENABLE_LIBUSB=OFF \
  -DENABLE_CUBEB=OFF \
  -DENABLE_ROOM=OFF \
  -DENABLE_WEB_SERVICE=OFF \
  -DENABLE_SCRIPTING=OFF \
  -DENABLE_TESTS=OFF \
  -DAZAHAR_WEB_ASSET_DIR=$(pwd)/azahar_web/web

# Build both the fallback and accelerated artifacts
cmake --build build-webgl2-opengl --parallel 8 --target azahar_web_bundle
```

The `azahar_web_bundle` target builds both renderers and copies their artifacts into
`web/` automatically. Its destination (`src/citra_sdl/CMakeLists.txt`'s
`AZAHAR_WEB_ASSET_DIR` cache variable) defaults to `../web` relative to the engine's
own source directory, which only lands in the right place if `azahar_emscripten` is
checked out *inside* this repo as `./azahar/` — pass it explicitly (as above) when
cloning the two repos as siblings instead, or the sync silently writes into whatever
`../web` resolves to next to wherever you cloned the engine.

## Testing

```bash
# Smoke test (no browser needed)
node tests/web_artifact_smoke.cjs

# Performance benchmark (requires Chrome)
AZAHAR_CHROME_ARGS=--use-angle=vulkan node tests/benchmark_browser.cjs --artifact webgl2 --duration-seconds 15 --warmup-seconds 5

# Rendering regression test (requires a decrypted ROM)
AZAHAR_ROM_PATH=test_games/your_rom.3ds node tests/browser_regression.cjs

# Cold boot, press the title-screen touch target, and sustain gameplay
AZAHAR_ROM_PATH=test_games/your_rom.3ds node tests/run.cjs --transition

# Fullscreen layout, canvas sizing, touch on the scaled bottom screen, and exit
node tests/fullscreen.test.cjs            # add --renderer=software for the CPU path

# CPU: the compiled code's controls, and (with a ROM) compiled, verify and interpreter runs
node tests/cpu_jit_watchdog.test.cjs
node tests/cpu_jit.test.cjs --rom test_games/your_rom.3ds [--state STATE.cst] [--bench]

# Save, restore, reload, and delete an IndexedDB-backed save through the UI
node tests/run.cjs --save-states --artifact webgl2

# Verify a picked ROM and cached replay survive renderer recovery
npm run test:renderer-recovery -- --rom path/to/your_rom.3ds

# Safari/iOS engine: WebKit with iPhone emulation (optional Playwright install)
npm install --no-save playwright && npx playwright install webkit
node tests/webkit_mobile.test.cjs --rom test_games/your_rom.3ds

# AI player (needs ng.pt: `hf download nvidia/NitroGen ng.pt --revision 584c8dded734d032f07a4bcc0ccb330e703298c4`).
# Save the model's inputs from games, build the float32 graphs the quantized model is
# compared with, check those against NVIDIA's code (a NitroGen checkout and
# scripts/nitrogen/requirements.txt; NVIDIA's model runs on the GPU), then the widget in
# Chrome: lazy download, byte-exact conversion, speed, the page's model vs float32 as
# policies on WebGPU over saved and live framebuffers, playing, and deleting
node tests/ai_frames.cjs --rom ROM [--state STATE.cst] --out tmp_test/ai_frames/valid/NAME
python3 scripts/nitrogen/nitrogen_onnx.py build --ckpt ng.pt --variants f32 --out tmp_test/ai_reference
python3 scripts/nitrogen/nitrogen_validate.py --ckpt ng.pt --nitrogen-src NitroGen \
    --graphs tmp_test/ai_reference/f32 --frames tmp_test/ai_frames/valid
node tests/ai_player.test.cjs --ckpt ng.pt --rom ROM --state STATE.cst
# Speed and fidelity of any variant nitrogen_onnx.py builds (e.g. --steps 2, --image-size 224)
node tests/ai_bench.cjs --ckpt ng.pt --model DIR [--rom ROM --state STATE.cst] --no-fidelity --distribution
```

## Architecture

- **CPU**: Pretranslated, direct-threaded `dyncom` ARM11 interpreter, with busy code compiled to WebAssembly as the game runs. The two switch per block: compiled code hands any instruction it does not implement back to the interpreter, and the page switches a game that gets stuck with compiled code on to the interpreter by itself (and remembers that title). *Renderer → CPU* offers *Interpreter only*; `?cpuJit=0` forces it and `?cpuJit=verify` checks every compiled run against the interpreter (slow; for testing). See `tests/PERFORMANCE.md` for what it gains.
- **Graphics**: Accelerated OpenGL-on-WebGL2 by default, with an explicit software fallback (`?renderer=software`). Auto uses hardware vertices on Vulkan/native-GL ANGLE and the reliable CPU-vertex WebGL2 path on D3D11; `?hwShader=1` forces hardware vertices for diagnostics.
- **Frontend**: SDL2 → HTML5 Canvas with `requestAnimationFrame` pacing
- **Threading**: SharedArrayBuffer-based pthreads (requires COOP/COEP isolation)
- **Memory**: 768 MB initial, growable to 4 GB

See [PROJECT.md](PROJECT.md) for detailed optimization history and benchmarks.

## Performance

Tested with Super Mario 3D Land (demo), Chrome headless:

| Renderer | Browser FPS | Game FPS | Speed | GPU cmd time |
|----------|-------------|----------|-------|--------------|
| Software compatibility | 31.3 | 12.6 | 21% | 66.88 ms |
| WebGL2 + D3D11 ANGLE (CPU vertices) | 42.8 | 16.8 | 28% | 39.70 ms |
| WebGL2 + Vulkan ANGLE | 140.1 | 68.9 | 115% | 4.44 ms |

The accelerated renderer is attempted first and stays active on D3D11 rather
than falsely falling back. Vulkan/native-GL ANGLE paths are currently the
fastest and pass the saved-state visual benchmark at greater than native 60
FPS. Chrome does not let a web page select its ANGLE backend; for a local
Vulkan run, launch Chrome with `--use-angle=vulkan`. D3D11 Auto deliberately
uses CPU vertex translation because forcing generated PICA vertex shaders can
block that backend's compiler for roughly a minute.

Audio currently uses the null sink in web builds because restoring SDL's
deprecated ScriptProcessor device produces invalid zero-sized callbacks. An
AudioWorklet-backed frontend sink is the remaining audio integration task.

## License

This wrapper repo provides build tooling and a web frontend for the [Azahar emulator](https://github.com/azahar-emu/azahar). See the upstream repository for the emulator's license terms.
