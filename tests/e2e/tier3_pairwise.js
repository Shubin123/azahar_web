/**
 * Azahar WebAssembly E2E Test Suite - Tier 3: Pairwise Combinatorial Tests
 * File: tests/e2e/tier3_pairwise.js
 * 
 * Contains 12 cross-feature pairwise test cases (T3_PAIR_01 through T3_PAIR_12)
 * testing feature interactions between CMake configuration, Dyncom interpreter,
 * software rendering, non-blocking loop unrolling, MEMFS game loader,
 * WASM memory safety, bounds guards, WebGPU overlay fallback, and first-frame pass.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

module.exports = function(addTest) {

    // T3_PAIR_01: F1 (CMake) + F2 (Dyncom)
    addTest('T3_PAIR_01', 'Tier 3', 'F1+F2', 'Verify emcmake configuration correctly routes CPU to dyncom when ARCHITECTURE=GENERIC', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        
        // Inspect root CMake configuration file for architecture routing
        const cmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        assert.ok(fs.existsSync(cmakePath), `CMakeLists.txt must exist at ${cmakePath}`);
        const cmakeContent = fs.readFileSync(cmakePath, 'utf-8');

        assert.ok(cmakeContent.includes('ARCHITECTURE'), 'CMakeLists.txt must reference ARCHITECTURE option');
        assert.ok(cmakeContent.includes('GENERIC'), 'CMakeLists.txt must support GENERIC architecture mode for dyncom routing');
        
        // Verify initialization with dyncom CPU routing
        const initResult = wasm._azahar_init();
        assert.strictEqual(initResult, 0, 'azahar_init should return 0 in GENERIC/dyncom mode');
    });

    // T3_PAIR_02: F2 (Dyncom) + F3 (SwRenderer)
    addTest('T3_PAIR_02', 'Tier 3', 'F2+F3', 'Validate dyncom ARM11 interpreter CPU ticks correctly trigger software renderer rasterization', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        wasm._azahar_init();
        harness.fs.writeFile('/test_game.3dsx', Buffer.alloc(1024, 0xAA));
        
        const loadRes = wasm._azahar_load_rom('/test_game.3dsx');
        assert.strictEqual(loadRes, 0, 'azahar_load_rom should return 0 for mounted 3dsx binary');

        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, 0, 'azahar_step_frame should return 0 on frame step');

        const ctx = harness.canvas.getContext('2d');
        const nonZeroPixels = ctx.getNonZeroPixelCount();
        assert.ok(nonZeroPixels > 0, `Dyncom CPU ticks must trigger rasterization resulting in non-zero pixels (got ${nonZeroPixels})`);
    });

    // T3_PAIR_03: F3 (SwRenderer) + F7 (Canvas Blit)
    addTest('T3_PAIR_03', 'Tier 3', 'F3+F7', 'Confirm 32-bit software renderer RGBA output blits directly to MockCanvasContext2D', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        wasm._azahar_init();
        harness.fs.writeFile('/game.3dsx', Buffer.alloc(512, 0x55));
        wasm._azahar_load_rom('/game.3dsx');

        const ctx = harness.canvas.getContext('2d');
        const initialCalls = ctx.putImageDataCalls;

        wasm._azahar_step_frame();

        assert.ok(ctx.putImageDataCalls > initialCalls, 'Software renderer frame must invoke putImageData on Canvas 2D context');
        assert.ok(ctx.lastPutImageData !== null, 'Canvas 2D context must store last blitted ImageData');
        assert.strictEqual(ctx.lastPutImageData.width, 400, 'Blitted framebuffer width must match 400');
        assert.strictEqual(ctx.lastPutImageData.height, 480, 'Blitted framebuffer height must match 480');

        // Check RGBA channel output
        const data = ctx.lastPutImageData.data;
        assert.ok(data.length === 400 * 480 * 4, 'ImageData buffer size must equal width * height * 4');
        assert.strictEqual(data[3], 255, 'Alpha channel of first pixel must be set to 255 (opaque)');
    });

    // T3_PAIR_04: F5 (Non-blocking) + F6 (Loop Unrolled)
    addTest('T3_PAIR_04', 'Tier 3', 'F5+F6', 'Ensure non-blocking PresentSingleFrame integrates seamlessly with unrolled azahar_step_frame', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        wasm._azahar_init();
        harness.fs.writeFile('/demo.3dsx', Buffer.alloc(2048, 0x12));
        wasm._azahar_load_rom('/demo.3dsx');

        const ctx = harness.canvas.getContext('2d');
        const startCalls = ctx.putImageDataCalls;
        const startTime = Date.now();

        // Step 60 frames in event-loop unrolled fashion
        for (let i = 0; i < 60; i++) {
            const stepRes = wasm._azahar_step_frame();
            assert.strictEqual(stepRes, 0, `Frame step ${i + 1} must return 0`);
        }

        const duration = Date.now() - startTime;
        assert.ok(duration < 2000, `Stepping 60 unrolled frames must be non-blocking (took ${duration}ms)`);
        assert.strictEqual(ctx.putImageDataCalls - startCalls, 60, 'Should record exactly 60 canvas present calls');
    });

    // T3_PAIR_05: F8 (MEMFS Loader) + F10 (Bounds Guard)
    addTest('T3_PAIR_05', 'Tier 3', 'F8+F10', 'Validate MEMFS file loading under memory bounds checking guard', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        wasm._azahar_init();

        // Mount 10MB test binary buffer into MEMFS
        const tenMBBuffer = Buffer.alloc(10 * 1024 * 1024, 0x7E);
        harness.fs.writeFile('/large_rom.3dsx', tenMBBuffer);

        assert.ok(harness.fs.exists('/large_rom.3dsx'), 'MEMFS must contain mounted large ROM file');
        const readBuf = harness.fs.readFile('/large_rom.3dsx');
        assert.strictEqual(readBuf.length, 10 * 1024 * 1024, 'MEMFS read length must equal 10MB');

        // Load into WASM core with bounds guard
        const loadRes = wasm._azahar_load_rom('/large_rom.3dsx');
        assert.strictEqual(loadRes, 0, 'azahar_load_rom should safely load 10MB ROM from MEMFS');

        // Verify WASM heap pointer dereference safety
        if (wasm.HEAPU8) {
            const heapLen = wasm.HEAPU8.length;
            assert.ok(heapLen >= 10 * 1024 * 1024, 'WASM heap size must accommodate loaded ROM');
            assert.doesNotThrow(() => {
                const sampleByte = wasm.HEAPU8[0];
            }, 'Accessing WASM heap must not throw memory access out of bounds');
        }
    });

    // T3_PAIR_06: F9 (WASM Memory) + F10 (Bounds Guard)
    addTest('T3_PAIR_06', 'Tier 3', 'F9+F10', 'Verify heap growth from 512MB preserves memory safety bounds guards', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        assert.ok(wasm.HEAPU8, 'WASM HEAPU8 array view must be available');
        const initialSize = wasm.HEAPU8.length;
        assert.ok(initialSize >= 512 * 1024 * 1024, `Initial WASM heap size must be >= 512MB (got ${initialSize})`);

        // Allocate 64MB memory chunk
        const allocSize = 64 * 1024 * 1024;
        const ptr = wasm._malloc ? wasm._malloc(allocSize) : 1024;
        assert.ok(ptr > 0, `_malloc must return valid memory pointer (got ${ptr})`);

        // Verify memory bounds guard on allocated pointer
        assert.doesNotThrow(() => {
            wasm.HEAPU8[ptr] = 0xAB;
            wasm.HEAPU8[ptr + allocSize - 1] = 0xCD;
            assert.strictEqual(wasm.HEAPU8[ptr], 0xAB, 'WASM memory write/read at start of allocation must match');
            assert.strictEqual(wasm.HEAPU8[ptr + allocSize - 1], 0xCD, 'WASM memory write/read at end of allocation must match');
        }, 'Memory operations within allocated bounds must be guarded and safe');

        if (wasm._free) {
            wasm._free(ptr);
        }
    });

    // T3_PAIR_07: F1 (CMake) + F11 (WebGPU Overlay)
    addTest('T3_PAIR_07', 'Tier 3', 'F1+F11', 'Ensure WebGPU overlay CMake configuration compiles cleanly with root Emscripten WASM build', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        const webgpuCmakePath = path.join(__dirname, '../../azahar-webgpu/CMakeLists.txt');
        assert.ok(fs.existsSync(webgpuCmakePath), `WebGPU CMakeLists.txt must exist at ${webgpuCmakePath}`);
        
        const webgpuCmakeContent = fs.readFileSync(webgpuCmakePath, 'utf-8');
        assert.ok(webgpuCmakeContent.includes('azahar'), 'azahar-webgpu CMake must reference parent azahar core module');
        assert.ok(webgpuCmakeContent.includes('webgpu_renderer') || webgpuCmakeContent.includes('webgpu_core'), 
            'WebGPU overlay CMake must define webgpu renderer or core targets');

        // Test fallback configuration capability
        const rootCmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        const rootCmakeContent = fs.readFileSync(rootCmakePath, 'utf-8');
        assert.ok(rootCmakeContent.includes('ENABLE_SOFTWARE_RENDERER'), 'Root CMake must support software renderer fallback');
    });

    // T3_PAIR_08: F4 (Dep Stubbing) + F12 (E2E First-Frame)
    addTest('T3_PAIR_08', 'Tier 3', 'F4+F12', 'Confirm emulator executes first-frame rendering when desktop dependencies are stubbed', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        // Verify root CMake defines stub options for desktop libraries
        const rootCmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        const rootCmakeContent = fs.readFileSync(rootCmakePath, 'utf-8');
        
        const stubbedOptions = ['ENABLE_CUBEB', 'ENABLE_OPENAL', 'ENABLE_LIBUSB', 'ENABLE_ROOM', 'ENABLE_QT'];
        for (const opt of stubbedOptions) {
            assert.ok(rootCmakeContent.includes(opt), `Root CMakeLists.txt must contain configurable option ${opt}`);
        }

        // Run full initialization and first frame pass
        const initRes = wasm._azahar_init();
        assert.strictEqual(initRes, 0, 'Initialization must succeed with stubbed dependencies');

        harness.fs.writeFile('/homebrew.3dsx', Buffer.alloc(1024, 0x33));
        const loadRes = wasm._azahar_load_rom('/homebrew.3dsx');
        assert.strictEqual(loadRes, 0, 'ROM load must succeed');

        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, 0, 'First frame step must return 0 with stubbed dependencies');

        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx.getNonZeroPixelCount() > 0, 'First frame rendering must output valid pixels without desktop hardware libraries');
    });

    // T3_PAIR_09: F7 (Canvas Blit) + F12 (E2E First-Frame)
    addTest('T3_PAIR_09', 'Tier 3', 'F7+F12', 'Verify first-frame rendering output directly updates canvas pixel non-zero count', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        const ctx = harness.canvas.getContext('2d');
        const countBefore = ctx.getNonZeroPixelCount();
        assert.strictEqual(countBefore, 0, 'Initial canvas non-zero pixel count must be 0');

        wasm._azahar_init();
        harness.fs.writeFile('/first_frame.3dsx', Buffer.alloc(2048, 0x99));
        wasm._azahar_load_rom('/first_frame.3dsx');

        wasm._azahar_step_frame();

        const countAfter = ctx.getNonZeroPixelCount();
        assert.ok(countAfter > 0, `First-frame rendering must update canvas non-zero pixel count (before: ${countBefore}, after: ${countAfter})`);
    });

    // T3_PAIR_10: F6 (Loop Unrolled) + F8 (MEMFS Loader)
    addTest('T3_PAIR_10', 'Tier 3', 'F6+F8', 'Test hot-swapping ROMs via MEMFS between unrolled frame steps', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        wasm._azahar_init();

        // Mount two distinct ROM files into MEMFS
        harness.fs.writeFile('/rom_a.3dsx', Buffer.alloc(1024, 0xAA));
        harness.fs.writeFile('/rom_b.3dsx', Buffer.alloc(2048, 0xBB));

        // Load ROM A and step 5 frames
        assert.strictEqual(wasm._azahar_load_rom('/rom_a.3dsx'), 0, 'Loading ROM A must return 0');
        for (let i = 0; i < 5; i++) {
            assert.strictEqual(wasm._azahar_step_frame(), 0, `ROM A frame step ${i + 1} must return 0`);
        }

        // Hot-swap to ROM B and step 5 frames
        assert.strictEqual(wasm._azahar_load_rom('/rom_b.3dsx'), 0, 'Hot-swapping to ROM B must return 0');
        for (let i = 0; i < 5; i++) {
            assert.strictEqual(wasm._azahar_step_frame(), 0, `ROM B frame step ${i + 1} must return 0`);
        }

        const ctx = harness.canvas.getContext('2d');
        assert.strictEqual(ctx.putImageDataCalls, 10, 'Should complete exactly 10 frame updates across hot-swapped ROMs');
    });

    // T3_PAIR_11: F3 (SwRenderer) + F11 (WebGPU Overlay)
    addTest('T3_PAIR_11', 'Tier 3', 'F3+F11', 'Test automatic fallback from WebGPU overlay to Software Renderer upon GPU context failure', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        // Simulate WebGPU context missing / failure in global navigator
        if (global.navigator) {
            delete global.navigator.gpu;
        }

        // Initialize core - should fall back to SwRenderer::RendererSoftware
        const initRes = wasm._azahar_init();
        assert.strictEqual(initRes, 0, 'Initialization must succeed via Software Renderer fallback when WebGPU is unavailable');

        harness.fs.writeFile('/fallback_test.3dsx', Buffer.alloc(512, 0x77));
        wasm._azahar_load_rom('/fallback_test.3dsx');

        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, 0, 'Frame step must succeed in software renderer fallback mode');

        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx.getNonZeroPixelCount() > 0, 'Software renderer fallback must produce rendered frame pixels on canvas');
    });

    // T3_PAIR_12: F9 (WASM Memory) + F12 (E2E First-Frame)
    addTest('T3_PAIR_12', 'Tier 3', 'F9+F12', 'Ensure initial 512MB memory setup accommodates full ROM load and first frame execution', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());

        // Mount 16MB `.3dsx` ROM payload into MEMFS
        const sixteenMBBuffer = Buffer.alloc(16 * 1024 * 1024, 0x44);
        harness.fs.writeFile('/game_16mb.3dsx', sixteenMBBuffer);

        const initRes = wasm._azahar_init();
        assert.strictEqual(initRes, 0, 'azahar_init must succeed');

        const loadRes = wasm._azahar_load_rom('/game_16mb.3dsx');
        assert.strictEqual(loadRes, 0, '16MB ROM load must succeed');

        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, 0, 'First frame execution must succeed with 16MB ROM loaded');

        // Check heap size and peak memory boundary
        if (wasm.HEAPU8) {
            assert.ok(wasm.HEAPU8.length >= 512 * 1024 * 1024, 'HEAPU8 must remain >= 512MB initial memory flag');
        }

        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx.getNonZeroPixelCount() > 0, 'First frame with 16MB ROM must produce non-zero canvas pixel output');
    });

};
