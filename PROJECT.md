# Project: Azahar WebAssembly Proof-of-Concept

## Architecture
Azahar WebAssembly port targeting modern web browsers via Emscripten.
- **CPU Subsystem**: Portable `dyncom` ARM11 C++ interpreter (JIT `dynarmic` disabled via `ARCHITECTURE=GENERIC`), with hot code compiled to WebAssembly at run time and interpreter fallback per block (`src/core/arm/dyncom/arm_dyncom_jit.*` in the engine).
- **Graphics Subsystem**: `SwRenderer::RendererSoftware` rasterizer operating on 32-bit RGBA8 framebuffers (OpenGL & Vulkan hardware renderers disabled).
- **Frontend / Windowing**: Adapted `citra_sdl` / `EmuWindow_SDL2_SW` presenting software framebuffers to an HTML5 `<canvas id="canvas">`.
- **Accelerated renderer (`azahar_webgl2`)**: the OpenGL renderer on a WebGL2 context. WebGL2 has no image load/store, with which PICA shadow maps are written and read (`Driver::HasImageLoadStore`, `Profile::has_image_load_store`): shadow-map passes are skipped and shadow lookups read as fully lit. Before, the fragment shader failed to compile and the draw called `glMemoryBarrier`, a null entry point in WebGL, which trapped as `RuntimeError: null function`: Mario Party: Island Tour's attract intro (3D characters with shadows, after about a minute idle on the title) stopped a console that way, so a second player waiting on the title while the first gathered Download Play players stopped. Switching to the interpreter cannot help there; it is not the ARM JIT.
- **Event Loop**: Main loop unrolled into Emscripten event loop / exported C per-frame step function (`azahar_step_frame`).
- **File System / Loader**: HTML File API -> Emscripten MEMFS (`FS.writeFile` with ownership transfer) -> C++ `Core::System::Load()` via standard C file IO. The upload keeps the selected filename extension so the core chooses the correct loader.
- **Browser Threading**: Emscripten pthreads use `SharedArrayBuffer` workers. The served page must be cross-origin isolated with COOP/COEP headers.
- **Overlay Layer**: `azahar-webgpu/` CMake overlay cleanly linking `citra_core`.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Emscripten CMake Build Setup | `emcmake cmake` configures C++20 build cleanly targeting WebAssembly | M1 | ORIGINAL_REQUEST §R1 |
| 2 | JIT Exclude & Dyncom Routing | Disable `dynarmic` JIT and route CPU execution to portable `dyncom` interpreter | M1 | ORIGINAL_REQUEST §R1 |
| 3 | Software Renderer Enablement | Enable `renderer_software` backend and disable desktop OpenGL 4.3 / Vulkan | M1 | ORIGINAL_REQUEST §R1 |
| 4 | External Dependency Stubbing | Exclude desktop dependencies (cubeb, openal, libusb, room) and configure cryptopp | M1 | Survey Explorer 1 |
| 5 | Non-blocking Canvas Frontend | Adapt `EmuWindow_SDL2_SW` for single-frame non-blocking presentation to HTML5 canvas | M2 | ORIGINAL_REQUEST §R2 |
| 6 | Main Loop Event Unrolling | Replace blocking while loops with `emscripten_set_main_loop` / `azahar_step_frame` | M2 | Survey Explorer 2 |
| 7 | HTML5 Canvas Framebuffer Blit | Output rendered 3DS framebuffers directly onto `<canvas>` element | M2 | ORIGINAL_REQUEST §R2 |
| 8 | Web UI & Game File Loader | HTML/JS interface to load `.3ds`, `.3dsx`, `.cia`, `.elf` into MEMFS | M3 | ORIGINAL_REQUEST §R2 |
| 9 | WASM Memory and Thread Safety | Set linker flags (`INITIAL_MEMORY=512MB`, `STACK_SIZE=2MB`, `ALLOW_MEMORY_GROWTH=1`, `MAXIMUM_MEMORY=4GB`) and preallocate an 8-worker pthread pool | M4 | Survey Explorer 3 |
| 10 | Memory Access Bounds Guard | Prevent WASM out-of-bounds traps (`RuntimeError: memory access out of bounds`) | M4 | ORIGINAL_REQUEST §Acceptance Criteria |
| 11 | WebGPU Overlay Alignment | Ensure `azahar-webgpu/` overlay architecture builds alongside Emscripten targets | M4 | ORIGINAL_REQUEST §R3 |
| 12 | E2E Test Suite & Real-ROM Pass | Verify WASM instantiation, decrypted ROM loading, continuous emulation, and canvas output | M5 | ORIGINAL_REQUEST §Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Emscripten Build & CMake Setup | CMake configuration, dependency stubbing, dyncom & renderer_software selection | None | COMPLETE |
| M2 | Canvas Frontend & Loop Unrolling | `EmuWindow_SDL2_SW` adaptation, main loop unrolling, HTML5 canvas output | M1 | COMPLETE |
| M3 | Web UI & ROM Loading Pipeline | Minimal HTML/JS frontend, MEMFS file mounting, C++ file loading API | M2 | COMPLETE |
| M4 | WASM Memory Safety, Threading & WebGPU Overlay | Growable 512MB-to-4GB memory, 2MB stack, 8-worker pthread pool, out-of-bounds guards, WebGPU overlay link | M1, M2 | COMPLETE |
| M5 | E2E Verification & Real-ROM Rendering | Browser-driven WASM initialization, decrypted ROM execution, continuous frame loop, and canvas rendering verification | M1, M2, M3, M4 | COMPLETE |

## Interface Contracts
### Web UI ↔ WebAssembly Module (`web/azahar.js` / `web/azahar.wasm`)
- `FS.writeFile(path, data, {canOwn: true})`: JS mounts uploaded ROM bytes to Emscripten MEMFS without an extra browser-heap copy. The path retains the selected extension (for example, `/rom.3ds`).
- `azahar_init()`: C++ export initializing `Core::System` and software renderer window. Returns `0` on success.
- `azahar_load_rom(const char* path)`: C++ export calling `Core::System::Load()`. Returns `0` on success.
- `azahar_step_frame()`: C++ export stepping 1 emulation frame, executing CPU ticks and blitting framebuffer to canvas.
- `azahar_run_loop()`: C++ export starting the browser-friendly Emscripten main loop.
- `azahar_shutdown()`: C++ export stopping emulation and releasing frontend resources.
- `azahar_audio_ring()`: C++ export returning the address of the game-audio ring buffer in shared WASM memory (header of u32 frames written, u32 frames read, u32 capacity, u32 sample rate; interleaved stereo s16 samples from byte 16). `azahar_step_frame()` keeps it filled; `web/azahar_audio.js` drains it from an AudioWorklet.
- `AzaharRomFS.mount(FS, path, blob)` (`web/azahar_romfs.js`): mounts a File/Blob as a read-only MEMFS file read on demand, so multi-GiB images never occupy browser memory. Downloads and played titles are stored in the Origin Private File System.
- `azahar_set_cpu_jit(mode)` (0 interpreter, 1 compiled code, 2 verify) switches the ARM CPU at run time and returns the mode in effect; `azahar_get_cpu_jit_stats(double* out, 13)` fills mode, compiled blocks, failed blocks, modules, compile ms, instructions run compiled, compiled runs, invalidations, verified runs, mismatches, unverifiable runs, all instructions run, and guest accesses to unmapped memory; `azahar_debug_cpu_jit()` logs which instructions most often send compiled code back to the interpreter. The page's watchdog (`web/azahar_cpu_jit.js`) uses the frame rate, guest speed and the unmapped-access count.
- `azahar_get_uds_status(char* out, int size)`: writes the local wireless network this console hosts or joined as JSON (`status` none/host/client/spectator/connecting, the host's MAC `host`, `wlanCommId`, `networkId`, this console's `node`, `maxNodes`, `nodes` [{id, name}], and `initialized`: whether local wireless is open, the game being in one of its wireless menus or a Download Play join under way); `AzaharNetplay.gameRoom()` reads it. A guest that joined through Download Play does not know the network's ids; the host's address and node list identify the room.
- `azahar_debug_uds()`: logs each bound local wireless data channel (receive buffer, packets waiting, the most ever waiting, packets received, packets pulled and the guest thread that last pulled, and when) and, per channel, the packets sent and the thread that last sent; `azahar_debug_threads()` logs every guest thread's state and wait list (the arbitration address for a thread in `WaitArb`, the command header for one in `WaitIPC`). The Local Play tests print both when a game stops talking.
- `azahar_dlp_join(host_mac, nickname)`, `azahar_dlp_cancel()`, `azahar_get_dlp_status(out, size)`, `azahar_dlp_boot_child()`: Download Play without the HOME Menu (see Local Play below). `azahar_dlp_join` installs the running cartridge's Download Play child (NCSD partition 2 holds a CIA of it; a dump that left that partition encrypted is decrypted with the built-in keys) into NAND, then does what the HOME Menu's Download Play app does with `dlp:CLNT` (`DLP_CLNT::StartJoinWithoutApp`): finds the room of `host_mac` (or with a null address the first room offering that child), joins it, tells the host it needs no download, and when the host starts the game sets the wireless reboot info (host address and passphrase, read by the child with `APT:GetWirelessRebootInfo`) and reboots into the child (`NS::RebootToTitle`). The status is JSON: `stage` idle/scanning/connecting/joined/starting, `host`, `rooms`, `client_state`, and `error` when the child could not be installed. `azahar_dlp_boot_child` reboots into the child without a room, for restoring a checkpoint taken while it ran.
- `azahar_state_ready()`: 1 when a save or load asked for now happens at the next emulation step (no HLE async operation pending, none under way); split.html checks it before holding its link for a checkpoint.
- `azahar_net_forget_console(mac)`: the host's local wireless network drops the node with that address, as a deauthentication frame from it would; a restarted console rejoins under the same address, which a host refuses while it lists the old node. `AzaharNetplay.forgetConsole` calls it when a peer in another tab or device leaves, and split.html when it restarts a console afresh.
- `azahar_net_join(nickname, mac)`, `azahar_net_leave()`, `azahar_net_receive(data, size)`, `azahar_net_console_mac(out)`, `azahar_net_set_cross_version(enable)`: the serverless Local Play link (see below). After `azahar_net_join`, every local wireless frame the console transmits is passed to `Module.azaharNetSend(bytes)`; frames from peers go back in through `azahar_net_receive`. A null `mac` joins under the console's own address and needs a running title.

## Local Play (multiplayer)

Games' local wireless modes (the 3DS's "Local Play", service `nwm::UDS`) work between browsers with no server. The engine's `RoomMember` has a direct-link mode in which the page carries 802.11 frames between consoles and each console filters them by its own MAC address, as a room server would. `web/azahar_netplay.js` moves those frames:

- **Direct (WebRTC):** the host presses *Host: create invite* on the Local Play card and sends the code to a friend by any means; the friend pastes it into *Use pasted code* and sends back the reply code, which the host pastes in turn. Each further guest needs one more invite; the host relays frames between guests. A public STUN server is used only to discover each browser's internet address (needed outside one home network; it can be switched off under *More options*). No game data passes through any server.
- **Public lobbies:** *Host public lobby* lists the room; anyone pressing *Find lobbies* sees its name, game and player count and can *Join*, with no codes to swap. `web/azahar_lobbies.js` finds lobbies through public WebTorrent trackers (`wss://tracker.openwebtorrent.com`, `wss://tracker.webtorrent.dev`, `wss://tracker.files.fm:7073/announce`; `?trackers=` replaces them), which only relay the WebRTC offers and answers; the trackers see lobby names and connection details, but game data still goes directly between players. A browser that is only looking connects to each host to read its lobby card and is not a Local Play peer until it joins; joining reuses that connection as the link.
- **Same-browser tabs:** *More options → Link tabs* (or `?link=tabs:ROOM`) links tabs of one browser through a `BroadcastChannel`. This is for testing; background tabs pause emulation.
- **One device (`split.html`):** *👥 Play together on this device* opens a console per player (2-8 from the menu, `?players=N` up to 16) in one tab, each `index.html?seat=N&seats=M` in a frame, so each has its own emulator, MAC address and console ID. They share one pool of memory (`web/azahar_shared_link.js`): each console writes one ring that every other console reads with a read position of its own, carrying frames and control messages (hello, clock reports, bye; a message for one console names it), so the pool grows with the consoles, not with pairs (8 consoles: 2 MiB). A console that stops reading does not hold its sender up: it loses the oldest messages, counted. Each console drains the others' rings right before each emulation step, so a frame reaches it in the same refresh it was sent. Clock pacing works as over the network. The page owns the keyboard (consoles' frames pass their keys to it): players 1 and 2 have keys of their own on it (left and right side), others a controller each; Ctrl+1-9 gives one player the whole keyboard. Each screen shows the game room its console hosts or joined (`azahar_get_uds_status`), and the page says when every player is in one.

  All the frames run on one main thread. Each console publishes its step time, refresh span and whether it used its whole budget in a slot of the shared buffer; every 250 ms the page gives a console that finished early its own use plus headroom (at least 15%) and splits the rest between the consoles that ran out, and `tuneFrameBudget` scales the work budget by that share. Each frame also reports `navigator.hardwareConcurrency` divided between the consoles (`?cores=N` overrides), so their worker pools do not all claim every core. The page reads the controllers and hands each console its own (`AzaharInput.padCodes`/`setSourceCodes`); Ctrl+1-4 moves the keyboard and never reaches the game. Consoles' mute choices and Local Play names are not saved over the main page's.

**Download Play** (games such as Mario Party: Island Tour add players only this way): the host's game opens a lobby (a local wireless network with `wlan_comm_id` 0x2810) that a 3DS joins from its HOME Menu's Download Play app, which this emulator does not have. On split.html every other screen in no room joins it on its own (`renderSeatButtons`) once its player has left it alone (no key, button or touch) for 30 s (`?joinIdle=SECONDS`): its screen counts down 5 s (*📥 Join now*, *Not now*), then joins; a screen in use is asked instead (*📥 Join Player N's lobby*); after *Not now*, *Leave* or three joins that did not start, *📥 Join Player N's Download Play* joins. A screen whose game has local wireless open (`initialized`; Mario Kart 7 players on the room list) is only offered 📥, so it can join from the game's menu with the full game. Waiting in the lobby, a console gets none of its player's keys or controller (pressing them could take its game into a wireless menu of its own, which ends the join). A screen that opened a lobby too (nobody can join either) is offered *↺ Restart and join Player N*: it restarts and joins at once. `AzaharSplit.joins()` lists each console's joins and how they started. On the main page the Local Play card's *📥 Join Download Play* joins the first room offering the game's child. Either calls `AzaharNetplay.joinDownloadPlay` → `azahar_dlp_join`: the console installs the Download Play child from its own copy of the game (so nothing is downloaded, which also works with dumps whose Download Play partition stayed encrypted: the host then cannot distribute it), joins the room under its Local Play name, and the host's lobby lists it. When the host starts (Mario Party: *End*), the guest gets the room's passphrase, reboots into the child, and the child joins the game's own network on the host. The page notices the new title (`AzaharUI.getProgramId()`), and saves and checkpoints follow it. Mario Party on an Apple M4: two consoles at 100% speed from the lobby through the game's menus, the child following the host's choices.

**Restarting one console (split.html):** ↺ reloads one console's frame, which gets the game and the shared link again as at the start (a new hello: the others drop its old link state and pacing baseline), while the others play on; every other console drops it from the room it hosts (`forgetConsole`), so it can join again. A console whose run loop fails reports it to the page (`AzaharSplitSeat.failed`) instead of reloading itself, and the page restarts it, with `cpuJit=0` when compiled code was on, at most three times in a row. (A frame that reloaded itself with `cpuJit=0` lost its game and link and sat at "Choose a ROM"; one that found its game in browser storage ran unlinked and stopped again, as "Stopped at step N: null function".)

**Checkpoints (split.html):** while every console is in one room, all of them take a checkpoint together (`captureGroup`): the first 10 s after the room forms, then every 2 or 5 minutes (header menu or `?checkpoints=0|120|300`; 0 stops them). The engine saves only between HLE operations (`azahar_state_ready`; a save that cannot start within 5 s fails the run loop), so a checkpoint starts when every console can save at its next frame, else a second later. The consoles keep running: each takes in the frames still in the shared rings (`pump`), the link holds frames (`holdFrames = 'keep'`) while every console saves at its next frame (`AzaharUI.captureState`, slot 0), so no frame is in flight between the saves, and the hold ends at once (at most 1.5 s). A Mario Party console's part is about 10 MB and takes about 0.6 s on an Apple M4, a pause on every screen since they share one thread. (Pausing the consoles or holding the link while a save waited broke Mario Kart 7's race setup; its race never offers a checkpoint.) `AzaharSplit.checkpointStats()` counts tries put off, tried, taken and failed. Not while a console is in a Download Play room (the DLP services' state is not in save states); they are dropped when everyone moves to another room.

**Going back (`restoreGroup`):** ⤺ *Back to checkpoint*, and a console that stops, bring every console back to that checkpoint at once: the link drops frames (`holdFrames = 'drop'`), the consoles load their checkpoint in place while running (`AzaharUI.restoreState`), a console that stopped or runs another title (one restarted afresh runs the game, not the Download Play child it joined with) reloads and restores (booting the child first, `azahar_dlp_boot_child`), then the pending frames are dropped and every console measures its clock against the others again (`rebaseClocks`). Restoring one console alone does not work: the host going back alone leaves the guest's game ahead, and Mario Party reports a communication error.

Consoles join under their own MAC address once a title runs. Each console has its own address and ID, so two players must not run copies of the same save state; the card warns when two consoles share an address. Save states can be loaded while linked.

**Cross-version play** (on by default) lets different builds of a game, such as a demo and the retail game, find each other: when a title scans for its own `wlan_comm_id`/`id`, beacons from another build are rewritten to those ids, with the encrypted node list and network-info hash regenerated. Whether two builds can then play depends on the games themselves. The Super Smash Bros. kiosk demo's Group mode, for example, never starts local wireless at all.

Useful while debugging: `?logFilter=Service.NWM:Debug` widens the engine log for one session, and the engine logs `Hosting network`, `Scanning for`, `Node N joined the hosted network` and `Joined a network as node N` at the Info level.

### Multiplayer tests and lobby fixtures

- `tests/local_play.test.cjs` (no ROM): tabs and WebRTC links, invite/reply codes, host relay, leaving.
- `tests/public_lobbies.test.cjs`: hosting, finding and joining a public lobby through a local tracker (`tests/lobby_tracker.cjs`); `tests/multiplayer.test.cjs --via lobby` links the consoles of a game pairing through a lobby instead of codes.
- `tests/split_screen.test.cjs` (no ROM): the shared pool (order across the ring end, broadcast, a stopped reader losing old messages without holding others up, eight consoles), three consoles on `split.html` linked and exchanging frames, two players on one keyboard with keys of their own (and Ctrl+N/Ctrl+0), a controller per player, refresh sharing, and the Local Play card and the cached-games list handing a game to `split.html`. With `--rom` it plays a game from `multiplayer_games.json`: Player 1 hosts and the others join, each pressing their own keys (players 1 and 2) or controller (players 3 and up, `--players N`), and the test checks that every console is in the host's room (`azahar_get_uds_status`); with two players the race starts and `tests/sync_check.cjs` compares the screens. Waits count emulated time (`tests/guest_time.cjs`). Each console's wireless frames are counted per second of game time (`tests/frame_trace.cjs`, saved as `frames-N.txt`); a failure also saves each console's log; `--film` keeps a screenshot every 15 s. Mario Kart 7 on an Apple M4 (accelerated renderer, Metal): host and join at 100% speed on both screens, both screens agreed in 92% of race samples.
- `tests/split_screen.test.cjs` also restarts one console with ↺ (it rejoins the link, the others drop the old one) and makes one stop (it is restarted with compiled code off), with no ROM. With `--game mario-party-island-tour` (ROM by `--rom`, or by name with `--roms DIR`, see `tests/game_roms.cjs`): Player 1 opens the Download Play lobby, Player 2 idles 75 s on the title (through the attract intro that used to stop it), every other screen joins on its own with no click, every guest runs the child in the host's game room; then (unless `--no-recover`) the consoles checkpoint together and the guest must show the host's choices (`followCheck`: the host picks Party, then Minigames, and the guest's description box must match); Player 2, then Player 1, is made to stop (its step throws `RuntimeError: null function`), and each time every console goes back to the checkpoint and the screens agree again; ↺ restarts Player 2 afresh (the host drops it) and ⤺ brings everyone back, Player 2 in the game again.
- `tests/multiplayer_suite.cjs --roms DIR [--gpu]`: the split-screen test for Mario Kart 7 (Local Play: every player has the game, Player 2 saying *Not now* to the page's offer to join with Download Play, then a race whose screens are compared), Mario Kart 7 with a Download Play guest (`mario-kart-7-download-play`: Player 2, left alone on the title, joins Player 1's room on its own, and runs Mario Kart 7's Download Play child 0004000100030800 in Player 1's race network once Player 1 starts) and Mario Party: Island Tour (Download Play, crash recovery), the no-ROM checks once first; `--two-browsers` adds `multiplayer.test.cjs` for each. Prints a PASS/FAIL/SKIP line per game. A game that fails is played again (`--retries N`, default 1) and the line says it passed on a later try and why the first failed. Mario Kart 7 used to break off between the lobby and the race in about half the runs (a communication error on one console, the other waiting at *Please wait…*), or froze one console mid-race. `--stall-dump` (split_screen.test.cjs) caught it: one console's game threads, the main thread among them, all waited in `svcArbitrateAddress` on one lock word, nothing running. The cause was in the CPU core this build runs (the dyncom interpreter and the WebAssembly JIT built on it): each emulated core kept its LDREX reservation to itself, nothing cleared it when the other core or another thread wrote the word, and its `ClearExclusiveState` did nothing, so a thread whose LDREX/STREX straddled the other core's turn (cores take turns of at most 20000 instructions on the one thread) stored over the other core's update to the lock. `ARM_DynCom` now drops a core's reservation when it resumes after the other core ran and on every thread switch (as the kernel's CLREX does); a spuriously failing STREX only makes the guest retry. Mario Kart 7 then raced in 6 of 6 runs with both screens agreeing (2026-11-07, Apple M4). The host's `dlp:SRVR` *Could not get node info for network node id 0x2* errors right after `BeginGame` are expected: the client has already left the Download Play network (answering with the node info cached from when it joined made the race fail in 4 of 4 runs). On an Apple M4 (accelerated renderer, Metal, 2026-11-07): Mario Kart 7 hosted, joined and raced with both screens agreeing in 100% of samples; Mario Party (No-Intro dump from Vimm's Lair, `.cci`) joined by Download Play and started, and after a forced stop of the guest, of the host, and ↺ then ⤺, every console was back at the checkpoint with the guest showing the host's choices. `npm run test:multiplayer-suite -- --roms DIR --gpu`.
- `tests/multiplayer.test.cjs --game mario-party-island-tour --roms DIR`: the same Download Play join between two browsers linked by invite codes, the guest using the Local Play card's 📥; after the host starts, the host's game network (0xF8110) takes the guest's child (passes on an Apple M4).
- `tests/multiplayer.test.cjs --link-smoke`: two browsers running a real title link under distinct console addresses.
- `tests/multiplayer.test.cjs`: for each pairing in `tests/multiplayer_games.json` (Super Smash Bros. full/kiosk, Mario Kart 7), boots two browsers, restores their lobby fixtures, links them with invite/reply codes, runs the guest's join steps, and passes once the host accepts a node and the guest joins. Steps wait in each console's game time: two browsers on one machine run below full speed, and steps timed on the wall clock ran out before the game reached their menus. A failure saves both consoles' logs; `--web DIR` serves another copy of `web/`. Pairings of different builds also require the cross-version beacon. Missing ROMs, encrypted dumps and missing fixtures are skipped with the reason.

Lobby fixtures make each run jump straight to the game's local wireless lobby. Capture them with the fixture tool, in two separate sessions so the two consoles have different identities:

```bash
# Session 1: get to the room you host, so the console is already advertising it.
AZAHAR_RENDERER=software node tests/capture_fixture.cjs serve test_games/<rom>.3ds
node tests/capture_fixture.cjs key KeyA 600      # drive the menus; `shot` shows the screen
node tests/capture_fixture.cjs save lobby-host
node tests/capture_fixture.cjs close
# Session 2: a fresh console, on the screen that lists nearby rooms.
AZAHAR_RENDERER=software node tests/capture_fixture.cjs serve test_games/<rom>.3ds
node tests/capture_fixture.cjs save lobby-guest
```

`load SCENE` restores a saved scene in a session, `log PATTERN` filters the log, `touch X Y MS` holds a touch for slow scenes, and `AZAHAR_FIXTURE_QUERY=logFilter=Service.NWM:Debug` passes page options. Adjust a game's `guest.steps` in `multiplayer_games.json` to whatever joins the advertised room from the guest's lobby screen. Azahar needs decrypted dumps; the test reports an encrypted one.

### Core ↔ EmuWindow Software Presentation
- `EmuWindow_SDL2_SW::PresentSingleFrame()`: Non-blocking function blitting current `RendererSoftware` framebuffers to SDL surface and updating HTML5 canvas.

## Code Layout
- `azahar/CMakeLists.txt`: Root CMake configuration for Emscripten toolchain options.
- `azahar/src/core/`: Core emulator logic, `dyncom` CPU interpreter (`src/core/arm/dyncom`).
- `azahar/src/video_core/`: Software rasterizer (`src/video_core/renderer_software`).
- `azahar/src/citra_sdl/`: SDL2 software window frontend (`emu_window/emu_window_sdl2_sw.cpp`).
- `azahar-webgpu/`: Overlay architecture and WebGPU targets.
- `web/`: Web UI and generated release artifacts (`index.html`, `azahar_ui.js`, `azahar.js`, `azahar.wasm`).

## Current Build Status

The Emscripten configuration and Ninja build complete on Windows with Emscripten 6.0.6 and eight parallel jobs:

```powershell
cmake -B build-web2 -S azahar -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DENABLE_QT=OFF -DENABLE_SDL2=ON -DENABLE_SDL2_FRONTEND=ON -DENABLE_SOFTWARE_RENDERER=ON -DENABLE_OPENGL=OFF -DENABLE_VULKAN=OFF -DENABLE_OPENAL=OFF -DENABLE_LIBUSB=OFF -DENABLE_CUBEB=OFF -DENABLE_ROOM=OFF -DENABLE_WEB_SERVICE=OFF -DENABLE_SCRIPTING=OFF -DENABLE_TESTS=OFF
cmake --build build-web2 --parallel 8
```

Artifacts are generated under `build-web/bin/Release/` and automatically synchronized into `web/` by the `azahar_web_assets` CMake target. `build_web.bat` runs that target and verifies both files have matching SHA-256 hashes, so no manual copy step is needed. `node tests/web_artifact_smoke.cjs` validates the synchronized artifacts, generated API names, and WASM compilation. `tests/browser_regression.cjs`, supplied with a decrypted local `.3ds` through `AZAHAR_ROM_PATH`, verifies cross-origin isolation, initialization, ROM mounting/loading, automatic run-loop startup, canvas output, and browser errors. The accelerated display-scheduled loop detected a multi-color kiosk-demo framebuffer in about 8 seconds in Chrome. An encrypted CIA is expected to fail cleanly with the UI's encrypted-ROM status.

**Recovery note (2026-09-21):** the private engine fork this depends on had gone
untracked (see `patches/README.md`) and was recovered from a cold-storage backup.
It now lives at [`Shubin123/azahar_emscripten`](https://github.com/Shubin123/azahar_emscripten)
(branch `web-port-recovered`), which also carries uncommitted optimization work
found in that backup: WASM SIMD128 codegen, `-ffast-math` on the software
rasterizer/shader-interpreter hot paths, LibreSSL/faad2 Emscripten cross-compile
fixes, and staged (compile-gated, execution-gated-off) scaffolding for a WebGL2
CPU-vertex PICA path. The build was reproduced from scratch on Linux with
Emscripten 6.0.9 + Ninja; both `azahar_web_assets` (software) and the WebGL2
target built and passed `tests/web_artifact_smoke.cjs` for both artifacts. One
build fix was needed and is now committed to the engine repo: `-ffast-math`
on a per-file basis conflicts with `video_core`'s shared precompiled header
(`__FAST_MATH__` must match between a PCH and any translation unit consuming
it), so `sw_rasterizer.cpp`/`shader_interpreter.cpp` now set
`SKIP_PRECOMPILE_HEADERS ON` alongside their `-ffast-math` option instead of
forcing fast-math (and PCH incompatibility) onto the rest of the target.

## Performance & Benchmarking

### Optimization History

| # | Optimization | Description | Impact |
|---|-------------|-------------|--------|
| 1 | SDL surface caching | Reuse SDL surfaces across frames instead of alloc/free per frame (~700 KB/frame saved) | Eliminates per-frame malloc overhead |
| 2 | Correct Emscripten surface update | Preserve `SDL_UpdateWindowSurface()` after each software frame | Required for pixels to reach the browser canvas; guarded by compositor E2E |
| 3 | Parallel software rasterizer | Six fixed Emscripten raster workers, with four-row worker tasks | Browser callbacks 8.1→19.5 FPS; game FPS 2.0→4.0 on kiosk-demo workload |
| 4 | Browser-owned frame pacing | Disable the redundant native frame limiter for the web frontend | Removes main-thread sleeps; `requestAnimationFrame` remains the pacing clock |
| 5 | Incremental edge functions | Replace per-pixel SignedArea cross-product calls (2 muls + 3 subs × 3 per pixel) with pre-computed additive edge function steps in ProcessTriangle inner loop | Eliminates 6 multiplies per pixel; addition-only barycentric stepping |
| 6 | RGBA8 framebuffer fast-path | Bypass per-pixel format switch, lambda, Vec4 construction, and memcpy in LoadFBToScreenInfo; direct ABGR→RGBA byte-swap for the dominant RGBA8 format | Removes branch, allocation, and copy overhead for every displayed pixel |
| 7 | Sequential output rotation | Restructure LoadFBToScreenInfo RGBA8 fast-path to iterate output rows sequentially for write-combining cache locality (3DS LCD 90° rotation) | Marginal; presentation is not the bottleneck |
| 8 | Float32 attribute interpolation | Replace software-emulated f24 (24-bit float) operations with native float32 for all per-pixel attribute interpolation in the Emscripten rasterizer | Eliminates ~50 f24 bit-manipulation ops per pixel; native WASM float32 |
| 9 | Early depth rejection | Read-only depth buffer compare before texture sampling, lighting, and TEV stages; skips occluded pixels without stencil side effects | GPU cmd 175→158 ms (−10%); callbacks 31.6→34.0 (+7.6%); p95 141→114 ms |
| 10 | Conditional UV interpolation | Skip texture coordinate interpolation and f24 conversion for disabled texture units; skip tc0_w when not needed for cube/projection mapping | Reduces per-pixel work when only tex unit 0 is active |
| 11 | Float UV-to-texel conversion | Compute UV-to-texel in native float32 inside TextureColor, avoiding f24 round-trip for width/height scaling | GPU cmd 187->178 ms; game FPS 3.8->4.0 |
| 12 | Float-native texture sampling | TextureColorFloat bypasses f24 round-trip for UV coords entirely; float32 throughout the texture sampling path | Part of Opts 12-14 batch |
| 13 | TEV stage early-exit | Pre-compute active TEV stage count per triangle; skip pass-through stages in the inner pixel loop | Part of Opts 12-14 batch |
| 14 | Pre-computed TextureInfo | Hoist TextureInfo::FromPicaRegister and memory pointer lookups out of per-pixel loop to per-triangle setup; inline alpha test and hoist fog check | Part of Opts 12-14 batch |

### Benchmark Results (2026-09-01)

ROM: Super Mario 3D Land (Europe) (Kiosk Demo), 128 MB decrypted .3ds
Browser: Chrome headless, 30-second title-screen warmup, 15-second rAF measurement

| Build | Browser callback rate | Game FPS | Emulation speed | GPU command time | Callback p95 |
|-------|-----------------------|----------|-----------------|------------------|--------------|
| Inline rasterizer baseline | 8.1 FPS | 2.0 | 3% | 488 ms | 347 ms |
| Six-worker rasterizer | 19.5 FPS | 4.0 | 7% | 216 ms | 199 ms |
| Incremental edge + RGBA8 fast-path | 31.4 FPS | 3.3 | 5% | 175 ms | 142 ms |
| + Rotation + Float32 interp + Early-Z | 34.0 FPS | 5.0 | 8% | 158 ms | 114 ms |


### Gameplay Benchmark (2026-09-01)

ROM: Super Mario 3D Land W1-1 save state, Chrome headless, 5s warmup, 15s measurement

| Renderer | Browser callback rate | Game FPS | Speed | GPU cmd time | p95 |
|----------|-----------------------|----------|-------|--------------|-----|
| Software (optimizations 1-11) | 25.7 FPS | 4.0 | 7% | 178 ms | 161 ms |
| Software (optimizations 1-14) | 28.3 FPS | 4.0 | 7% | 175 ms | 138 ms |
| WebGL2 (experimental) | crashes — incomplete save-state support | — | — | — | — |

Title-screen figures above are historical baselines, not gameplay claims.
Software GPU command processing remains the dominant bottleneck.

### Benchmark Commands

```powershell
# Quick smoke test
node tests/web_artifact_smoke.cjs

# Gameplay benchmark (uses auto-detected save state, ~25s total)
$env:CHROME_PATH = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
node tests/benchmark_browser.cjs --artifact software --duration-seconds 15 --warmup-seconds 5 --repeat 1

# With profiling
node tests/benchmark_browser.cjs --artifact software --duration-seconds 15 --warmup-seconds 5 --repeat 1 --profile

# Interactive benchmark (visible Chrome window)
node tests/benchmark_browser.cjs --artifact software --interactive --duration-seconds 15 --warmup-seconds 5 --repeat 1

# Regression test (rendering validation)
$env:AZAHAR_ROM_PATH = (Resolve-Path 'test_games\*.3ds').Path
node tests/browser_regression.cjs
```

Results are written to `tests/benchmark_results.json`.

### Current Cross-title Baseline (2026-09-06)

These measurements use the deployed-default WebGL2 renderer on Chrome/ANGLE D3D11. Mario uses the player-controllable W1-1 state; the other dumps currently have only cold-boot measurements, so they identify broad title variance but are not yet comparable gameplay scenes.

| Title / scene | Game FPS | Speed | GPU command time | Browser callbacks/s |
|---|---:|---:|---:|---:|
| Super Mario 3D Land, W1-1 (3-run mean) | 16.4 | 27% | 43.4 ms | 41.5 |
| Zelda: A Link Between Worlds demo, boot | 28.9 | 48% | 2.10 ms | 140.2 |
| New Super Mario Bros. 2, boot | 68.3 | 113% | 0.74 ms | 143.6 |
| The Sims 3, boot | 26.4 | 63% | 2.30 ms | 139.4 |

Raw local results are written under `tmp_test/*_benchmark.json` so routine profiling does not overwrite the checked-in regression baseline.

### Fast-forward validation (2026-09-07)

Fast-forward no longer changes the emulated CPU clock. It requests up to 4x guest-time progress within the normal browser work budget and caps missed-time backlog, so slow gameplay cannot make a later 1x scene run too fast. On the NSMB2 boot workload, the 1x setting measured 69.8 game FPS / 117% speed and the 4x target measured 127.4 game FPS / 213% speed. Mario W1-1 remains GPU/CPU-vertex bound, so it cannot meet the requested target until that renderer bottleneck is removed.

### Post-recovery gameplay verification (2026-09-21)

Real title-screen-to-gameplay measurements against the rebuilt artifacts (Emscripten 6.0.9, engine recovered at `Shubin123/azahar_emscripten`), using `tests/title_transition_regression.cjs` against legally-owned decrypted dumps on Chrome 153 with no real GPU (Chrome falls back to ANGLE/SwiftShader, a CPU Vulkan implementation). WebGL2 numbers here are not a reliable proxy for real-GPU performance — SwiftShader's per-title characteristics differ substantially from hardware ANGLE backends — but they are valid for correctness (does the title render at all, does it regress).

| Title | Software: title → gameplay | WebGL2: title → gameplay |
|---|---:|---:|
| 2in1 Horses 3D (boot/demo) | 60 FPS / 100% | 60 FPS / 100% |
| Adventure Time: Explore the Dungeon | 60 → 37 FPS / 101% → 62% | 60 → 56 FPS / 101% → 94% |
| Animal Crossing: New Leaf | 27 → 24 FPS / 45% → 40% | previously crashed (shader compile failure); now renders correctly |
| Cubic Ninja | 17 → 18 FPS / 55% → 60% | 7 → 11 FPS / 27% → 38% (SwiftShader-limited; rendering verified correct) |

Two real bugs were found and fixed this pass:

- **WebGL2 fragment shader compile failure on the `MultiplyThenAdd` TEV op**: `fma()` has no GLSL ES 3.00 overloads (added only in GLSL ES 3.20), so any title using that PICA combiner operation failed WebGL2 shader compilation outright — it only ever worked on the desktop OpenGL renderer's GLSL profile. Found via Animal Crossing collapsing to ~1 FPS with repeated `LoadShader`/`LoadProgram` console errors; fixed in `azahar_emscripten` by replacing `fma(a, b, c)` with `(a * b + c)` in both the color and alpha combiner code paths (`src/video_core/shader/generator/glsl_fs_shader_gen.cpp`). Verified fixed on both Animal Crossing and Adventure Time, the latter showing WebGL2 is actually the *faster* path once it can compile (56 vs. 37 game FPS in gameplay).
- **Large-ROM upload failure**: Chrome's Blob/FileReader has an internal ceiling around 2.145 GB for a single whole-file read (`NotReadableError`, not a clean power-of-two boundary, not this machine's available memory). Fixed in `web/azahar_ui.js` by reading uploads in bounded 256 MB chunks via `file.slice(...).arrayBuffer()`, which resolves ROMs up to just under 2 GiB. A second, harder ceiling remains open: this Chrome build also refuses a plain `ArrayBuffer` at exactly 2^31 bytes or more (reproduced in a blank page, so not memory pressure), and Emscripten's MEMFS explicitly refuses to let a file alias a view into the WASM heap (its `canOwn` guard against `ALLOW_MEMORY_GROWTH` invalidating that view), falling back to the same full-size allocation. Fixing that needs a lazy, on-demand FS backend instead of MEMFS's one-buffer-per-file model — out of scope this pass. **Known limitation: ROMs at or above exactly 2 GiB (e.g. Fire Emblem Awakening, 2,147,483,648 bytes) cannot currently be loaded.**

### Software rasterizer worker-sync overhead (2026-09-21, reverted)

CPU-profiled real gameplay (Adventure Time, software renderer, 60→30 FPS drop, `tests/title_transition_regression.cjs` with `AZAHAR_TRANSITION_PROFILE`): **30.7% of all main-thread time** was spent inside `_emscripten_get_now`, traced through `_do_futex_wait` back to `RasterizerSoftware::AddTriangle()`. Root cause: `ProcessTriangle` calls `sw_workers.WaitForRequests()` — a full barrier — after every multi-row-band triangle, and the browser main thread cannot use real `Atomics.wait` (disallowed by spec there), so Emscripten's pthread condvar wait falls back to a busy-poll loop that repeatedly calls the clock while blocked. This is a real, large cost on any scene with many triangles (i.e. most real gameplay), not a one-off.

**Attempted fix, reverted as unsafe:** gave each of the 6 rasterizer workers its own dedicated queue (independent `Common::ThreadWorker` instances, not one shared pool — `sw_workers.QueueWork` is used elsewhere by `custom_tex_manager` and the Vulkan pipeline cache for workloads that benefit from dynamic load balancing, so the shared class itself was deliberately left untouched). Row bands were routed to a worker deterministically by absolute screen position (`y_begin` is already framebuffer-grid-aligned via `first_sample()`), so the same physical rows from different triangles always serialize on one worker's own FIFO queue — this preserves pixel-write ordering without a wait between triangles. The per-triangle wait was replaced by calls in `DrawTriangles()`/`FlushAll()`/`FlushRegion()`, which the rest of the codebase already invokes at exactly the right points (end of a draw call; before display transfer, memory fill, or a CPU read of framebuffer memory, from `video_core/gpu.cpp` and `core/memory.cpp`) — so no other call site needed auditing.

It builds, and screenshots for Cubic Ninja's title screen were pixel-identical before/after (title-screen FPS there went 7→27, ~4x, where the bottleneck genuinely was this wait). But it **crashed** Adventure Time in gameplay: `RuntimeError: remainder by zero` inside `SwRenderer::GetWrappedTexCoord`, running on a worker thread from a deferred row-band job. Cause: `process_row_band` captures PICA texture/register state (`regs`) **by reference**, reading it live at execution time. Under the old synchronous-per-triangle model this was always safe, because the main thread could not advance to a new draw's texture configuration until every worker job for the previous triangle had completed. Decoupling submission from execution broke that guarantee: the main thread can now mutate shared texture-unit state (e.g. switch textures) before an older, still-queued row-band job reads it, hitting a texture width of zero at read time — and, more broadly, risking silently-wrong texturing for any deferred job, not just this one crash.

**What a real fix needs**: the same treatment given to pixel writes (a mechanism proving no future draw's state mutation is visible to an in-flight job) but for *all* register/texture state a row-band job reads, not just framebuffer writes — e.g. snapshotting the relevant PICA state per triangle instead of capturing it live, which is a bigger, harder-to-verify change. The revert is clean; nothing here was pushed to `azahar_emscripten` in a broken state.

**Follow-up investigation (2026-09-22): two candidate fixes scoped, both larger than they first appear, neither attempted.**

1. *Move the emulation core off the browser main thread* (`-sPROXY_TO_PTHREAD`), so the existing per-triangle wait can use real `Atomics.wait` instead of the polling fallback — no capture-lifetime risk at all, since the wait frequency wouldn't need to change. But this build doesn't use that flag today: all 17 exported C functions (`azahar_step_frame`, `azahar_load_rom`, `azahar_get_perf_stats`, save states, etc.) are called *synchronously* from `web/azahar_ui.js` via `ccall`, directly on the browser main thread. Enabling it makes every one of those calls cross a thread boundary, which is inherently asynchronous (postMessage-based) — `Atomics.wait` is forbidden by spec on the actual browser main thread specifically to prevent tab freezes, so there's no lighter-weight variant that keeps a synchronous call convention. This is a rewrite of the entire JS↔wasm call boundary (all 17 call sites, callback/Promise-based instead of return-value-based), not a scoped rasterizer fix.

2. *Snapshot all state the row-band lambda depends on into heap-owned storage* (the direction from the reverted attempt, done exhaustively this time). Auditing the actual call graph: every row-band job calls into 8 `RasterizerSoftware` member functions — `TextureColor`, `TextureColorFloat`, `PixelColor`, `WriteTevConfig`, `WriteTevConfigN`, `WriteFog`, `DoAlphaTest`, `DoDepthStencilTest` (~700 lines combined) — and *every one of them* reads `this->regs`/`this->fb` directly, not through any passed-in state. That's over 50 individual live-state read sites (TEV combiner buffers, fog color, stencil/depth test, framebuffer pixel access, shadow/cube-map texture config, and more) across the most heavily hand-optimized code in the engine (14 documented micro-optimizations already layered in here). A real fix means changing all 8 signatures to take an explicit snapshot and rewriting every one of those read sites — comparable in size and risk to option 1, just in a different part of the codebase.

Both directions were scoped out loud with the user and explicitly not attempted this session: the verification available here (4 ROMs, short capture windows, no manual UI QA, automated scripts only) isn't enough to have confidence in a change this size, especially having already seen this exact failure shape once (worked on a simple scene, crashed on a busier one). Revisit with a broader ROM/browser test matrix, or plan for one before starting.

### Next FPS Work

See `tests/PERFORMANCE.md` for the 2026-09-07 gameplay-only CPU trace, rejected
4096-entry vertex-cache experiment, and new cross-title state inventory.
PICA execution accounts for 44.4% of the measured Mario main-thread trace;
decode/setup is only 0.5%. The larger cache did not improve FPS and was reverted.

1. Use the new persistent save UI to capture repeatable, player-controllable states for Zelda, NSMB2, and The Sims 3. Gate every optimization on the same scenes; boot screens are too light to predict gameplay cost.
2. Add production OpenGL counters around CPU PICA vertex translation, draw submission, display transfer, cache upload/download, and shader compilation. The existing detailed renderer counters describe the experimental backend and are zero on the default OpenGL path, leaving the current 43 ms Mario GPU-command cost insufficiently attributed.
3. Fix the generated PICA vertex-shader path on ANGLE/D3D11. It is fast at native resolution but currently produces empty scaled framebuffers, forcing the reliable CPU-vertex path for 2x-4x. A correct generated path removes the largest avoidable CPU graphics stage without reducing visuals.
4. Batch and cache CPU-translated vertex streams by shader/uniform/input state so unchanged draws avoid reinterpreting PICA instructions and rebuilding host buffers. This is the safest macro-level fallback if D3D shader generation remains driver-sensitive.
5. Profile the ARM11 pretranslated dyncom block dispatcher separately from graphics. Browser WebAssembly cannot directly execute arbitrary generated machine code, so the practical JIT direction is larger cached micro-op/superblock translation with fewer indirect dispatches, then validation against all captured gameplay states.
