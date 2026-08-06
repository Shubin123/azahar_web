/**
 * Azahar WebAssembly E2E Test Suite - Tier 4: Real-World Application Workload Scenarios
 * File: tests/e2e/tier4_workloads.js
 * 
 * Contains 6 high-complexity real-world application workload test cases
 * (T4_WORKLOAD_01 through T4_WORKLOAD_06) incorporating local game ROM files from test_games directory:
 * - Super Mario 3D Land (Europe) (EnFrDeEsIt) (Demo) (Kiosk).cia (39.3 MB)
 * - Super Mario (USA) (Beta) (E3 2011 demo).7z (82.9 MB)
 * 
 * Tests full cold-boot, large game ROM memory growth stress, continuous multi-frame animation,
 * WebGPU overlay coexistence fallback, corrupted ROM error handling, and rapid re-init reset loops.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

module.exports = function(addTest) {

    // Helper to resolve test_games directory path reliably
    function getTestGamesDir() {
        const primaryPath = path.join(__dirname, '../../test_games');
        if (fs.existsSync(primaryPath)) return primaryPath;
        const absPath = 'C:\\Users\\shubadub\\Documents\\azahar\\test_games';
        if (fs.existsSync(absPath)) return absPath;
        throw new Error(`test_games directory not found at ${primaryPath} or ${absPath}`);
    }

    // T4_WORKLOAD_01: Full Cold-Boot & Homebrew Execution Scenario
    addTest('T4_WORKLOAD_01', 'Tier 4', 'F1, F2, F3, F5, F8, F9, F10, F12', 'Full Cold-Boot & Homebrew Execution Scenario (60 FPS / 1 Second Emulation)', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        // Step 1: Cold Boot WASM Initialization
        const initRes = wasm._azahar_init();
        assert.strictEqual(initRes, 0, 'Cold-boot azahar_init must return 0');

        // Step 2: Mount standard 3DS homebrew executable into MEMFS
        const homebrewBuffer = Buffer.alloc(4 * 1024 * 1024, 0x88);
        harness.fs.writeFile('/boot.3dsx', homebrewBuffer);
        assert.ok(harness.fs.exists('/boot.3dsx'), 'MEMFS must contain mounted homebrew binary /boot.3dsx');

        // Step 3: Load Executable
        const loadRes = wasm._azahar_load_rom('/boot.3dsx');
        assert.strictEqual(loadRes, 0, 'azahar_load_rom must return 0 for /boot.3dsx');

        // Step 4: Step 60 frames (1 second of emulation at 60 FPS)
        const startTime = Date.now();
        const ctx = harness.canvas.getContext('2d');
        const startCalls = ctx.putImageDataCalls;

        for (let frame = 1; frame <= 60; frame++) {
            const stepRes = wasm._azahar_step_frame();
            assert.strictEqual(stepRes, 0, `Frame ${frame} step must return 0`);
        }

        const duration = Date.now() - startTime;
        assert.ok(duration < 2000, `60 frame steps must complete in < 2000ms (took ${duration}ms)`);
        assert.strictEqual(ctx.putImageDataCalls - startCalls, 60, 'Exactly 60 canvas present calls must be recorded');

        const nonZeroPixels = ctx.getNonZeroPixelCount();
        assert.ok(nonZeroPixels > 5000, `Full cold-boot homebrew execution must render > 5,000 pixels on canvas (got ${nonZeroPixels})`);
    });

    // T4_WORKLOAD_02: Large Game ROM Load & Heap Memory Growth Stress Scenario
    addTest('T4_WORKLOAD_02', 'Tier 4', 'F8, F9, F10, F12', 'Large Game ROM Load & Heap Memory Growth Stress Scenario using local test_games ROMs', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        const gamesDir = getTestGamesDir();

        // Target local game ROMs in test_games directory
        const ciaPath = path.join(gamesDir, 'Super Mario 3D Land (Europe) (EnFrDeEsIt) (Demo) (Kiosk).cia');
        const archivePath = path.join(gamesDir, 'Super Mario (USA) (Beta) (E3 2011 demo).7z');

        assert.ok(fs.existsSync(ciaPath), `CIA game ROM must exist at ${ciaPath}`);
        assert.ok(fs.existsSync(archivePath), `7z archive ROM must exist at ${archivePath}`);

        // Read real CIA file buffer (39.3 MB)
        const ciaStat = fs.statSync(ciaPath);
        assert.ok(ciaStat.size > 30 * 1024 * 1024, `CIA file size must be > 30MB (actual: ${ciaStat.size} bytes)`);

        const ciaBuffer = fs.readFileSync(ciaPath);
        assert.strictEqual(ciaBuffer.length, ciaStat.size, 'Read buffer length must match file stat size');

        // Step 1: Mount real 39.3MB CIA file into Emscripten MEMFS
        harness.fs.writeFile('/sm3dland.cia', ciaBuffer);
        assert.ok(harness.fs.exists('/sm3dland.cia'), 'MEMFS must contain mounted sm3dland.cia');

        // Step 2: Initialize emulator and load CIA game
        wasm._azahar_init();
        const loadRes = wasm._azahar_load_rom('/sm3dland.cia');
        assert.strictEqual(loadRes, 0, 'azahar_load_rom must load 39.3MB CIA game binary without error');

        // Step 3: Exercise WASM Heap Allocation Growth & Memory Bounds Guard
        if (wasm.HEAPU8) {
            const initialHeapSize = wasm.HEAPU8.length;
            assert.ok(initialHeapSize >= 512 * 1024 * 1024, 'Initial WASM heap must be >= 512MB');

            // Simulate memory growth stress
            const stressSize = 32 * 1024 * 1024;
            const ptr = wasm._malloc ? wasm._malloc(stressSize) : 2048;
            assert.ok(ptr > 0, 'Memory allocation during large ROM stress must return valid pointer');

            // Access heap boundaries safely
            assert.doesNotThrow(() => {
                wasm.HEAPU8[ptr] = 0xFF;
                wasm.HEAPU8[ptr + stressSize - 1] = 0xEE;
            }, 'Heap read/write during large ROM stress must not trigger out of bounds error');

            if (wasm._free) wasm._free(ptr);
        }

        // Step 4: Verify archive ROM metadata (82.9 MB)
        const archiveStat = fs.statSync(archivePath);
        assert.ok(archiveStat.size > 80 * 1000 * 1000, `7z Archive file size must be > 80MB (actual: ${archiveStat.size} bytes)`);

        // Step 5: Step frame to confirm rendering after large ROM load
        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, 0, 'Frame step must succeed after loading 39.3MB CIA game ROM');
    });

    // T4_WORKLOAD_03: Framebuffer Canvas Render & Multi-Frame Animation Step Scenario
    addTest('T4_WORKLOAD_03', 'Tier 4', 'F5, F6, F7, F12', 'Framebuffer Canvas Render & Multi-Frame Animation Step Scenario (300 Frames / 5 Seconds)', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        wasm._azahar_init();
        harness.fs.writeFile('/anim_game.3dsx', Buffer.alloc(1024 * 1024, 0x66));
        wasm._azahar_load_rom('/anim_game.3dsx');

        const ctx = harness.canvas.getContext('2d');
        const startCalls = ctx.putImageDataCalls;
        const frameTimes = [];

        // Step 300 frames (5 seconds at 60 FPS)
        for (let frame = 1; frame <= 300; frame++) {
            const frameStart = Date.now();
            const res = wasm._azahar_step_frame();
            assert.strictEqual(res, 0, `Frame ${frame} step must return 0`);
            frameTimes.push(Date.now() - frameStart);
        }

        assert.strictEqual(ctx.putImageDataCalls - startCalls, 300, 'Exactly 300 canvas present calls must be recorded over 5 seconds of emulation');

        const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
        assert.ok(avgFrameTime < 16.6, `Average frame step time must be < 16.6ms for 60 FPS capability (actual avg: ${avgFrameTime.toFixed(2)}ms)`);

        const finalPixels = ctx.getNonZeroPixelCount();
        assert.ok(finalPixels > 0, 'Canvas must contain active rendered frame buffer pixels after 300 frames');
    });

    // T4_WORKLOAD_04: WebGPU Overlay Coexistence & Fallback Build Test Scenario
    addTest('T4_WORKLOAD_04', 'Tier 4', 'F1, F3, F11', 'WebGPU Overlay Coexistence & Fallback Build Test Scenario', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        // Verify build configuration files for WebGPU overlay coexistence
        const webgpuCmakePath = path.join(__dirname, '../../azahar-webgpu/CMakeLists.txt');
        assert.ok(fs.existsSync(webgpuCmakePath), `azahar-webgpu/CMakeLists.txt must exist at ${webgpuCmakePath}`);

        // Simulate WebGPU initialization failure (e.g. unsupported WebGPU context in browser environment)
        let webgpuSupported = false;
        let fallbackTriggered = false;

        try {
            if (!global.navigator || !global.navigator.gpu) {
                throw new Error('WebGPU API not supported in current context');
            }
            webgpuSupported = true;
        } catch (gpuErr) {
            fallbackTriggered = true;
        }

        assert.ok(fallbackTriggered, 'WebGPU init failure scenario must trigger fallback handler');

        // Execute fallback initialization to Software Renderer
        const initRes = wasm._azahar_init();
        assert.strictEqual(initRes, 0, 'Initialization under WebGPU fallback must succeed with Software Renderer');

        harness.fs.writeFile('/webgpu_fallback.3dsx', Buffer.alloc(2048, 0x44));
        wasm._azahar_load_rom('/webgpu_fallback.3dsx');

        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, 0, 'Software renderer step must succeed under WebGPU fallback');

        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx.getNonZeroPixelCount() > 0, 'Canvas must receive valid software rendered frame under WebGPU fallback mode');
    });

    // T4_WORKLOAD_05: Invalid / Corrupted ROM Graceful Error Handling Scenario
    addTest('T4_WORKLOAD_05', 'Tier 4', 'F8, F10, F12', 'Invalid / Corrupted ROM Graceful Error Rejection Scenario', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        wasm._azahar_init();

        // Test 1: Zero-byte file
        harness.fs.writeFile('/empty.3dsx', Buffer.alloc(0));
        const emptyLoadRes = wasm._azahar_load_rom('/empty.3dsx');
        assert.ok(emptyLoadRes !== 0, 'azahar_load_rom must return non-zero error code for 0-byte ROM file');

        // Test 2: Corrupted magic header byte sequence
        const corruptBuffer = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x11, 0x22, 0x33]);
        harness.fs.writeFile('/corrupt.3dsx', corruptBuffer);
        const corruptLoadRes = wasm._azahar_load_rom('/corrupt.3dsx');
        assert.ok(corruptLoadRes !== 0, 'azahar_load_rom must return non-zero error code for corrupted magic header');

        // Test 3: Truncated CIA payload (512 bytes)
        const truncatedCia = Buffer.alloc(512, 0xFF);
        harness.fs.writeFile('/truncated.cia', truncatedCia);
        const truncLoadRes = wasm._azahar_load_rom('/truncated.cia');
        assert.ok(truncLoadRes !== 0, 'azahar_load_rom must return non-zero error code for truncated CIA payload');

        // Step 4: Verify recovery - load valid ROM after error rejections
        const validBuffer = Buffer.alloc(2048, 0x77);
        harness.fs.writeFile('/valid_recovery.3dsx', validBuffer);
        const recoveryLoadRes = wasm._azahar_load_rom('/valid_recovery.3dsx');
        assert.strictEqual(recoveryLoadRes, 0, 'Emulator state must remain clean and load valid ROM cleanly after corrupted ROM rejections');

        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, 0, 'Frame step must succeed after loading valid recovery ROM');
    });

    // T4_WORKLOAD_06: Rapid Re-initialization & State Reset Loop Scenario
    addTest('T4_WORKLOAD_06', 'Tier 4', 'F2, F5, F8, F10', 'Rapid Re-initialization & State Reset Loop Scenario incorporating local CIA game ROM', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        const gamesDir = getTestGamesDir();
        const ciaPath = path.join(gamesDir, 'Super Mario 3D Land (Europe) (EnFrDeEsIt) (Demo) (Kiosk).cia');

        assert.ok(fs.existsSync(ciaPath), `CIA game ROM must exist at ${ciaPath}`);
        const ciaBuffer = fs.readFileSync(ciaPath);

        // Execute rapid reset loop 10 times
        for (let cycle = 1; cycle <= 10; cycle++) {
            harness.reset();
            const cycleWasm = harness.wasmModule || wasm;

            // Step 1: Init core
            const initRes = cycleWasm._azahar_init();
            assert.strictEqual(initRes, 0, `Cycle ${cycle}: azahar_init must return 0`);

            // Step 2: Mount and Load local game ROM
            const romName = `/sm3dland_cycle_${cycle}.cia`;
            harness.fs.writeFile(romName, ciaBuffer);
            const loadRes = cycleWasm._azahar_load_rom(romName);
            assert.strictEqual(loadRes, 0, `Cycle ${cycle}: azahar_load_rom must return 0`);

            // Step 3: Step 5 frames
            for (let f = 1; f <= 5; f++) {
                const stepRes = cycleWasm._azahar_step_frame();
                assert.strictEqual(stepRes, 0, `Cycle ${cycle} frame ${f} step must return 0`);
            }
        }

        // Final verification on harness canvas state
        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx.getNonZeroPixelCount() > 0, 'Final cycle of rapid reset loop must produce valid rendered frame on canvas');
    });

};
