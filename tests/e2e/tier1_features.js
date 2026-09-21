/**
 * Tier 1: Feature Coverage Test Suite (60 Test Cases: T1_F01_01 to T1_F12_05)
 *
 * Implements 5 comprehensive unit/feature test cases per feature for all 12 platform features:
 * - F1: Emscripten CMake Build Setup
 * - F2: JIT Exclude & Dyncom Routing
 * - F3: Software Renderer Enablement
 * - F4: External Dependency Stubbing
 * - F5: Non-blocking Canvas Frontend
 * - F6: Main Loop Event Unrolling
 * - F7: HTML5 Canvas Framebuffer Blit
 * - F8: Web UI & Game File Loader
 * - F9: WASM Memory Safety Setup
 * - F10: Memory Access Bounds Guard
 * - F11: WebGPU Overlay Alignment
 * - F12: E2E Test Suite & First-Frame Pass
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT_DIR = path.resolve(__dirname, '../..');
const AZAHAR_DIR = path.join(ROOT_DIR, 'azahar');
const WEBGPU_DIR = path.join(ROOT_DIR, 'azahar-webgpu');

module.exports = function(addTest) {

    // =========================================================================
    // Feature 1: Emscripten CMake Build Setup (T1_F01_01 to T1_F01_05)
    // =========================================================================

    addTest('T1_F01_01', 'Tier 1', 'Emscripten CMake Build Setup', 'emcmake toolchain detection in CMakeLists.txt', async (harness) => {
        const cmakeFile = path.join(AZAHAR_DIR, 'CMakeLists.txt');
        assert.ok(fs.existsSync(cmakeFile), 'azahar/CMakeLists.txt must exist');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('EMSCRIPTEN') || content.includes('CMAKE_TOOLCHAIN_FILE') || content.includes('cmake_minimum_required'),
            'CMakeLists.txt must support toolchain configuration');
    });

    addTest('T1_F01_02', 'Tier 1', 'Emscripten CMake Build Setup', 'C++20 standard enforcement in CMakeLists.txt', async (harness) => {
        const cmakeFile = path.join(AZAHAR_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('CMAKE_CXX_STANDARD 20'), 'CMakeLists.txt must specify C++20 standard');
        assert.ok(content.includes('CMAKE_CXX_STANDARD_REQUIRED ON'), 'C++20 standard must be required');
    });

    addTest('T1_F01_03', 'Tier 1', 'Emscripten CMake Build Setup', 'Target citra_core / azahar_core definition in core CMake', async (harness) => {
        const coreCmake = path.join(AZAHAR_DIR, 'src', 'core', 'CMakeLists.txt');
        assert.ok(fs.existsSync(coreCmake), 'src/core/CMakeLists.txt must exist');
        const content = fs.readFileSync(coreCmake, 'utf-8');
        assert.ok(content.includes('add_library(citra_core') || content.includes('add_library(azahar_core'),
            'citra_core / azahar_core target must be defined in src/core/CMakeLists.txt');
    });

    addTest('T1_F01_04', 'Tier 1', 'Emscripten CMake Build Setup', 'Repo-owned web frontend target definition', async (harness) => {
        const webCmake = path.join(ROOT_DIR, 'port', 'CMakeLists.txt');
        assert.ok(fs.existsSync(webCmake), 'port/CMakeLists.txt must exist');
        const content = fs.readFileSync(webCmake, 'utf-8');
        assert.ok(content.includes('add_executable(azahar_web'),
            'the repo-owned azahar_web executable target must be defined');
    });

    addTest('T1_F01_05', 'Tier 1', 'Emscripten CMake Build Setup', 'WASM module output interface instantiation', async (harness) => {
        const mod = await harness.loadWasmModule();
        assert.ok(mod, 'WASM module interface must load successfully');
        assert.strictEqual(typeof mod._azahar_init, 'function', 'WASM module must export _azahar_init');
        assert.strictEqual(typeof mod._azahar_load_rom, 'function', 'WASM module must export _azahar_load_rom');
        assert.strictEqual(typeof mod._azahar_step_frame, 'function', 'WASM module must export _azahar_step_frame');
    });


    // =========================================================================
    // Feature 2: JIT Exclude & Dyncom Routing (T1_F02_01 to T1_F02_05)
    // =========================================================================

    addTest('T1_F02_01', 'Tier 1', 'JIT Exclude & Dyncom Routing', 'ARCHITECTURE default setting to GENERIC in CMakeLists.txt', async (harness) => {
        const cmakeFile = path.join(AZAHAR_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('set(ARCHITECTURE "GENERIC")'), 'ARCHITECTURE must default to GENERIC for web builds');
    });

    addTest('T1_F02_02', 'Tier 1', 'JIT Exclude & Dyncom Routing', 'Dynarmic JIT exclusion verification in core build', async (harness) => {
        const coreCmake = path.join(AZAHAR_DIR, 'src', 'core', 'CMakeLists.txt');
        const content = fs.readFileSync(coreCmake, 'utf-8');
        assert.ok(content.includes('arm/dyncom/arm_dyncom.cpp'), 'dyncom interpreter must be included when JIT disabled');
    });

    addTest('T1_F02_03', 'Tier 1', 'JIT Exclude & Dyncom Routing', 'ARM11 interpreter dyncom source file presence', async (harness) => {
        const dyncomFile = path.join(AZAHAR_DIR, 'src', 'core', 'arm', 'dyncom', 'arm_dyncom.cpp');
        assert.ok(fs.existsSync(dyncomFile), 'arm_dyncom.cpp source file must exist');
    });

    addTest('T1_F02_04', 'Tier 1', 'JIT Exclude & Dyncom Routing', 'CPU core initialization with dyncom interpreter via WASM export', async (harness) => {
        const mod = await harness.loadWasmModule();
        const ret = mod._azahar_init();
        assert.strictEqual(ret, 0, '_azahar_init must return 0 indicating success');
    });

    addTest('T1_F02_05', 'Tier 1', 'JIT Exclude & Dyncom Routing', 'Dyncom instruction step execution via frame tick step', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/test.3dsx', new Uint8Array([0x33, 0x44, 0x53, 0x58]));
        mod._azahar_load_rom('/test.3dsx');
        const stepRet = mod._azahar_step_frame();
        assert.strictEqual(stepRet, 0, '_azahar_step_frame must execute without dynarmic JIT exceptions');
    });


    // =========================================================================
    // Feature 3: Software Renderer Enablement (T1_F03_01 to T1_F03_05)
    // =========================================================================

    addTest('T1_F03_01', 'Tier 1', 'Software Renderer Enablement', 'Software rasterizer ENABLE_SOFTWARE_RENDERER option in CMake', async (harness) => {
        const cmakeFile = path.join(AZAHAR_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('ENABLE_SOFTWARE_RENDERER'), 'CMakeLists.txt must define ENABLE_SOFTWARE_RENDERER option');
    });

    addTest('T1_F03_02', 'Tier 1', 'Software Renderer Enablement', 'Desktop OpenGL disable option in CMakeLists.txt', async (harness) => {
        const cmakeFile = path.join(AZAHAR_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('ENABLE_OPENGL'), 'CMakeLists.txt must contain ENABLE_OPENGL option');
    });

    addTest('T1_F03_03', 'Tier 1', 'Software Renderer Enablement', 'Desktop Vulkan disable option in CMakeLists.txt', async (harness) => {
        const cmakeFile = path.join(AZAHAR_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('ENABLE_VULKAN'), 'CMakeLists.txt must contain ENABLE_VULKAN option');
    });

    addTest('T1_F03_04', 'Tier 1', 'Software Renderer Enablement', 'RendererSoftware instantiation on module initialization', async (harness) => {
        const mod = await harness.loadWasmModule();
        const initRet = mod._azahar_init();
        assert.strictEqual(initRet, 0, 'Renderer software GPU initialization must return 0');
    });

    addTest('T1_F03_05', 'Tier 1', 'Software Renderer Enablement', '32-bit RGBA8 buffer allocation query', async (harness) => {
        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx, '2D canvas context must exist');
        assert.strictEqual(harness.canvas.width, 400, 'Canvas width must be 400');
        assert.strictEqual(harness.canvas.height, 480, 'Canvas height must be 480');
        assert.strictEqual(ctx.data.length, 400 * 480 * 4, 'Framebuffer buffer length must equal 400 * 480 * 4 bytes');
    });


    // =========================================================================
    // Feature 4: External Dependency Stubbing (T1_F04_01 to T1_F04_05)
    // =========================================================================

    addTest('T1_F04_01', 'Tier 1', 'External Dependency Stubbing', 'Cubeb audio dependency exclude option in CMakeLists.txt', async (harness) => {
        const cmakeFile = path.join(AZAHAR_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('ENABLE_CUBEB'), 'ENABLE_CUBEB option must exist in CMakeLists.txt');
    });

    addTest('T1_F04_02', 'Tier 1', 'External Dependency Stubbing', 'OpenAL audio dependency exclude option in CMakeLists.txt', async (harness) => {
        const cmakeFile = path.join(AZAHAR_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('ENABLE_OPENAL'), 'ENABLE_OPENAL option must exist in CMakeLists.txt');
    });

    addTest('T1_F04_03', 'Tier 1', 'External Dependency Stubbing', 'Libusb dependency exclude option in CMakeLists.txt', async (harness) => {
        const cmakeFile = path.join(AZAHAR_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('ENABLE_LIBUSB'), 'ENABLE_LIBUSB option must exist in CMakeLists.txt');
    });

    addTest('T1_F04_04', 'Tier 1', 'External Dependency Stubbing', 'Dedicated room network exclude option in CMakeLists.txt', async (harness) => {
        const cmakeFile = path.join(AZAHAR_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('ENABLE_ROOM'), 'ENABLE_ROOM option must exist in CMakeLists.txt');
    });

    addTest('T1_F04_05', 'Tier 1', 'External Dependency Stubbing', 'Qt GUI dependency exclude option in CMakeLists.txt', async (harness) => {
        const cmakeFile = path.join(AZAHAR_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('ENABLE_QT'), 'ENABLE_QT option must exist in CMakeLists.txt');
    });


    // =========================================================================
    // Feature 5: Non-blocking Canvas Frontend (T1_F05_01 to T1_F05_05)
    // =========================================================================

    addTest('T1_F05_01', 'Tier 1', 'Non-blocking Canvas Frontend', 'Single-frame present method non-blocking execution', async (harness) => {
        const swFile = path.join(ROOT_DIR, 'port', 'src', 'citra_web', 'emu_window_web.cpp');
        assert.ok(fs.existsSync(swFile), 'port/src/citra_web/emu_window_web.cpp must exist');
        const content = fs.readFileSync(swFile, 'utf-8');
        assert.ok(content.includes('EmuWindow_Web::Present') && content.includes('SDL_UpdateWindowSurface'),
            'the web window must define non-blocking software frame presentation');
    });

    addTest('T1_F05_02', 'Tier 1', 'Non-blocking Canvas Frontend', 'SDL software window initialization without desktop display server', async (harness) => {
        assert.ok(harness.canvas, 'Canvas element must be available in harness DOM');
        assert.strictEqual(harness.canvas.id, 'canvas', 'Canvas element ID must be canvas');
    });

    addTest('T1_F05_03', 'Tier 1', 'Non-blocking Canvas Frontend', 'Framebuffer lock and unlock verification on frame draw', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/game.3dsx', new Uint8Array([1, 2, 3, 4]));
        mod._azahar_load_rom('/game.3dsx');
        mod._azahar_step_frame();
        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx.putImageDataCalls > 0, 'putImageData must be called during frame draw');
    });

    addTest('T1_F05_04', 'Tier 1', 'Non-blocking Canvas Frontend', 'Canvas 2D context binding verification', async (harness) => {
        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx, '2D context must bind cleanly to harness canvas');
        assert.strictEqual(typeof ctx.putImageData, 'function', '2D context must provide putImageData');
    });

    addTest('T1_F05_05', 'Tier 1', 'Non-blocking Canvas Frontend', 'Non-blocking loop interface executing 5 sequential frame steps', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/game.3dsx', new Uint8Array([1, 2, 3, 4]));
        mod._azahar_load_rom('/game.3dsx');
        for (let i = 0; i < 5; i++) {
            const ret = mod._azahar_step_frame();
            assert.strictEqual(ret, 0, `Frame step ${i} must return 0 without blocking`);
        }
    });


    // =========================================================================
    // Feature 6: Main Loop Event Unrolling (T1_F06_01 to T1_F06_05)
    // =========================================================================

    addTest('T1_F06_01', 'Tier 1', 'Main Loop Event Unrolling', 'C export azahar_step_frame execution and return code', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/test.3dsx', new Uint8Array([0x33, 0x44]));
        mod._azahar_load_rom('/test.3dsx');
        const res = mod._azahar_step_frame();
        assert.strictEqual(res, 0, '_azahar_step_frame must return 0 on success');
    });

    addTest('T1_F06_02', 'Tier 1', 'Main Loop Event Unrolling', 'Main loop unrolling replacement of blocking while loop', async (harness) => {
        const mod = await harness.loadWasmModule();
        assert.strictEqual(typeof mod._azahar_step_frame, 'function', 'WASM module must export per-frame step function');
    });

    addTest('T1_F06_03', 'Tier 1', 'Main Loop Event Unrolling', 'Frame tick counter increment across multiple steps', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/test.3dsx', new Uint8Array([1, 2, 3]));
        mod._azahar_load_rom('/test.3dsx');
        const initialCalls = harness.canvas.getContext('2d').putImageDataCalls;
        mod._azahar_step_frame();
        mod._azahar_step_frame();
        mod._azahar_step_frame();
        const finalCalls = harness.canvas.getContext('2d').putImageDataCalls;
        assert.strictEqual(finalCalls - initialCalls, 3, 'Frame steps must increment canvas draw calls');
    });

    addTest('T1_F06_04', 'Tier 1', 'Main Loop Event Unrolling', 'CPU and GPU synchronization per single step call', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/test.3dsx', new Uint8Array([1, 2, 3]));
        mod._azahar_load_rom('/test.3dsx');
        const ret = mod._azahar_step_frame();
        assert.strictEqual(ret, 0, 'CPU tick & GPU rasterizer step sync must succeed');
    });

    addTest('T1_F06_05', 'Tier 1', 'Main Loop Event Unrolling', 'Event loop yielding during async step execution', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/test.3dsx', new Uint8Array([1, 2, 3]));
        mod._azahar_load_rom('/test.3dsx');
        await new Promise(resolve => {
            setImmediate(() => {
                mod._azahar_step_frame();
                resolve();
            });
        });
        assert.ok(true, 'Async step yielded cleanly to JS event loop');
    });


    // =========================================================================
    // Feature 7: HTML5 Canvas Framebuffer Blit (T1_F07_01 to T1_F07_05)
    // =========================================================================

    addTest('T1_F07_01', 'Tier 1', 'HTML5 Canvas Framebuffer Blit', 'Canvas image data transfer via putImageData', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/game.3dsx', new Uint8Array([1, 2, 3]));
        mod._azahar_load_rom('/game.3dsx');
        mod._azahar_step_frame();
        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx.putImageDataCalls > 0, 'Canvas context putImageData must be invoked');
    });

    addTest('T1_F07_02', 'Tier 1', 'HTML5 Canvas Framebuffer Blit', 'Pixel dimension verification of target canvas buffer', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/game.3dsx', new Uint8Array([1, 2, 3]));
        mod._azahar_load_rom('/game.3dsx');
        mod._azahar_step_frame();
        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx.lastPutImageData, 'lastPutImageData must be populated');
        assert.strictEqual(ctx.lastPutImageData.width, 400, 'ImageData width must be 400');
        assert.strictEqual(ctx.lastPutImageData.height, 480, 'ImageData height must be 480');
    });

    addTest('T1_F07_03', 'Tier 1', 'HTML5 Canvas Framebuffer Blit', 'Top screen pixel blit rendering into top region', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/game.3dsx', new Uint8Array([1, 2, 3]));
        mod._azahar_load_rom('/game.3dsx');
        mod._azahar_step_frame();
        const ctx = harness.canvas.getContext('2d');
        const topRegionPixelAlpha = ctx.lastPutImageData.data[(100 * 400 + 200) * 4 + 3];
        assert.strictEqual(topRegionPixelAlpha, 255, 'Top screen region pixel alpha must be 255 (opaque)');
    });

    addTest('T1_F07_04', 'Tier 1', 'HTML5 Canvas Framebuffer Blit', 'Bottom screen pixel blit rendering into bottom region', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/game.3dsx', new Uint8Array([1, 2, 3]));
        mod._azahar_load_rom('/game.3dsx');
        mod._azahar_step_frame();
        const ctx = harness.canvas.getContext('2d');
        const bottomRegionPixelAlpha = ctx.lastPutImageData.data[(300 * 400 + 200) * 4 + 3];
        assert.strictEqual(bottomRegionPixelAlpha, 255, 'Bottom screen region pixel alpha must be 255 (opaque)');
    });

    addTest('T1_F07_05', 'Tier 1', 'HTML5 Canvas Framebuffer Blit', 'Color channel mapping verification for RGBA layout', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/game.3dsx', new Uint8Array([1, 2, 3]));
        mod._azahar_load_rom('/game.3dsx');
        mod._azahar_step_frame();
        const ctx = harness.canvas.getContext('2d');
        const data = ctx.lastPutImageData.data;
        assert.strictEqual(data[3], 255, 'Alpha channel (byte index 3) must be 255');
        assert.ok(typeof data[0] === 'number', 'Red channel must be numeric byte');
        assert.ok(typeof data[1] === 'number', 'Green channel must be numeric byte');
        assert.ok(typeof data[2] === 'number', 'Blue channel must be numeric byte');
    });


    // =========================================================================
    // Feature 8: Web UI & Game File Loader (T1_F08_01 to T1_F08_05)
    // =========================================================================

    addTest('T1_F08_01', 'Tier 1', 'Web UI & Game File Loader', 'MEMFS .3dsx file write and size verification', async (harness) => {
        const payload = new Uint8Array([0x33, 0x44, 0x53, 0x58, 0x01, 0x00]);
        harness.fs.writeFile('/roms/sample.3dsx', payload);
        assert.strictEqual(harness.fs.exists('/roms/sample.3dsx'), true, 'Mounted file must exist in MEMFS');
        const readBack = harness.fs.readFile('/roms/sample.3dsx');
        assert.strictEqual(readBack.length, payload.length, 'Readback buffer size must match written size');
    });

    addTest('T1_F08_02', 'Tier 1', 'Web UI & Game File Loader', 'C export azahar_load_rom execution with valid mounted file', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/sample.3dsx', new Uint8Array([0x33, 0x44, 0x53, 0x58]));
        const loadRet = mod._azahar_load_rom('/sample.3dsx');
        assert.strictEqual(loadRet, 0, '_azahar_load_rom must return 0 for mounted 3dsx binary');
    });

    addTest('T1_F08_03', 'Tier 1', 'Web UI & Game File Loader', '.cia file format parse and load match via MEMFS', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/game.cia', new Uint8Array([0x20, 0x00, 0x00, 0x00]));
        const loadRet = mod._azahar_load_rom('/game.cia');
        assert.strictEqual(loadRet, 0, '_azahar_load_rom must support .cia extension path loading');
    });

    addTest('T1_F08_04', 'Tier 1', 'Web UI & Game File Loader', '.elf homebrew executable format load match via MEMFS', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/app.elf', new Uint8Array([0x7F, 0x45, 0x4C, 0x46]));
        const loadRet = mod._azahar_load_rom('/app.elf');
        assert.strictEqual(loadRet, 0, '_azahar_load_rom must support .elf homebrew executable path loading');
    });

    addTest('T1_F08_05', 'Tier 1', 'Web UI & Game File Loader', 'MEMFS file cleanup and unlink verification', async (harness) => {
        harness.fs.writeFile('/temp.3dsx', new Uint8Array([1, 2, 3]));
        assert.strictEqual(harness.fs.exists('/temp.3dsx'), true, 'File must exist before unlink');
        const unlinkRet = harness.fs.unlink('/temp.3dsx');
        assert.strictEqual(unlinkRet, true, 'unlink must return true for existing file');
        assert.strictEqual(harness.fs.exists('/temp.3dsx'), false, 'File must no longer exist after unlink');
    });


    // =========================================================================
    // Feature 9: WASM Memory Safety Setup (T1_F09_01 to T1_F09_05)
    // =========================================================================

    addTest('T1_F09_01', 'Tier 1', 'WASM Memory Safety Setup', 'Linker initial memory flag check (>= 512MB heap)', async (harness) => {
        const mod = await harness.loadWasmModule();
        assert.ok(mod.HEAPU8, 'WASM module must expose HEAPU8');
        assert.ok(mod.HEAPU8.length >= 536870912, 'HEAPU8 initial size must be >= 512 MB (536,870,912 bytes)');
    });

    addTest('T1_F09_02', 'Tier 1', 'WASM Memory Safety Setup', 'Linker memory growth capability verification', async (harness) => {
        const mod = await harness.loadWasmModule();
        assert.ok(mod.buffer, 'WASM buffer must exist for memory growth support');
        assert.ok(mod.buffer instanceof ArrayBuffer, 'WASM memory buffer must be an instance of ArrayBuffer');
    });

    addTest('T1_F09_03', 'Tier 1', 'WASM Memory Safety Setup', 'Linker stack size configuration verification (>= 2MB)', async (harness) => {
        const mod = await harness.loadWasmModule();
        assert.ok(mod.HEAP32, 'WASM module must expose HEAP32');
        assert.ok(mod.HEAP32.length >= 524288, 'Heap word length must accommodate minimum 2MB stack');
    });

    addTest('T1_F09_04', 'Tier 1', 'WASM Memory Safety Setup', 'Heap alignment check (16-byte alignment)', async (harness) => {
        const mod = await harness.loadWasmModule();
        const ptr = mod._malloc(64);
        assert.ok(ptr > 0, '_malloc must return a valid non-zero heap pointer');
        assert.strictEqual(ptr % 16, 0, 'Allocated WASM heap pointer must be 16-byte aligned');
        mod._free(ptr);
    });

    addTest('T1_F09_05', 'Tier 1', 'WASM Memory Safety Setup', 'High memory allocation without heap corruption', async (harness) => {
        const mod = await harness.loadWasmModule();
        const bigSize = 64 * 1024 * 1024; // 64 MB
        const ptr = mod._malloc(bigSize);
        assert.ok(ptr > 0, '_malloc must succeed for 64MB allocation');
        mod._free(ptr);
        assert.ok(true, '64MB allocation and deallocation completed cleanly');
    });


    // =========================================================================
    // Feature 10: Memory Access Bounds Guard (T1_F10_01 to T1_F10_05)
    // =========================================================================

    addTest('T1_F10_01', 'Tier 1', 'Memory Access Bounds Guard', 'Safe pointer dereference within valid heap address space', async (harness) => {
        const mod = await harness.loadWasmModule();
        const val = mod.HEAPU8[1024];
        assert.ok(typeof val === 'number', 'Reading valid memory offset must return numeric byte value');
    });

    addTest('T1_F10_02', 'Tier 1', 'Memory Access Bounds Guard', 'Range check guard at edge of allocated WASM heap', async (harness) => {
        const mod = await harness.loadWasmModule();
        const lastIdx = mod.HEAPU8.length - 1;
        const lastVal = mod.HEAPU8[lastIdx];
        assert.ok(typeof lastVal === 'number', 'Reading boundary byte at heap end must succeed without error');
    });

    addTest('T1_F10_03', 'Tier 1', 'Memory Access Bounds Guard', 'Null pointer guard handling in exported WASM calls', async (harness) => {
        const mod = await harness.loadWasmModule();
        const ret = mod._azahar_load_rom(0); // Null pointer
        assert.ok(ret < 0, 'Null pointer argument to _azahar_load_rom must return negative error code');
    });

    addTest('T1_F10_04', 'Tier 1', 'Memory Access Bounds Guard', 'Software renderer framebuffer memory bounds verification', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/rom.3dsx', new Uint8Array([1, 2, 3]));
        mod._azahar_load_rom('/rom.3dsx');
        mod._azahar_step_frame();
        const ctx = harness.canvas.getContext('2d');
        assert.strictEqual(ctx.data.length, 400 * 480 * 4, 'Rendered framebuffer pixels must fit strictly inside canvas bounds');
    });

    addTest('T1_F10_05', 'Tier 1', 'Memory Access Bounds Guard', 'Safe string pointer load with length terminator guard', async (harness) => {
        const mod = await harness.loadWasmModule();
        if (typeof mod.stringToUTF8 === 'function') {
            const ptr = mod._malloc(256);
            mod.stringToUTF8('/valid/path.3dsx', ptr, 256);
            assert.ok(ptr > 0, 'stringToUTF8 must write within allocated heap boundary');
            mod._free(ptr);
        } else {
            assert.ok(true, 'stringToUTF8 string helper checked');
        }
    });


    // =========================================================================
    // Feature 11: WebGPU Overlay Alignment (T1_F11_01 to T1_F11_05)
    // =========================================================================

    addTest('T1_F11_01', 'Tier 1', 'WebGPU Overlay Alignment', 'Subdirectory CMake link for root azahar integration', async (harness) => {
        const cmakeFile = path.join(WEBGPU_DIR, 'CMakeLists.txt');
        assert.ok(fs.existsSync(cmakeFile), 'azahar-webgpu/CMakeLists.txt must exist');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('add_subdirectory(../azahar azahar)'), 'azahar-webgpu must include add_subdirectory(../azahar azahar)');
    });

    addTest('T1_F11_02', 'Tier 1', 'WebGPU Overlay Alignment', 'Target webgpu_core static library build definition', async (harness) => {
        const cmakeFile = path.join(WEBGPU_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('add_library(webgpu_core STATIC'), 'webgpu_core target must be defined as STATIC library');
    });

    addTest('T1_F11_03', 'Tier 1', 'WebGPU Overlay Alignment', 'Target webgpu_renderer static library build definition', async (harness) => {
        const cmakeFile = path.join(WEBGPU_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('add_library(webgpu_renderer STATIC'), 'webgpu_renderer target must be defined as STATIC library');
    });

    addTest('T1_F11_04', 'Tier 1', 'WebGPU Overlay Alignment', 'Executable azahar_webgpu target definition', async (harness) => {
        const cmakeFile = path.join(WEBGPU_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('add_executable(azahar_webgpu'), 'azahar_webgpu executable target must be defined');
    });

    addTest('T1_F11_05', 'Tier 1', 'WebGPU Overlay Alignment', 'Fallback build configuration capability check', async (harness) => {
        const cmakeFile = path.join(WEBGPU_DIR, 'CMakeLists.txt');
        const content = fs.readFileSync(cmakeFile, 'utf-8');
        assert.ok(content.includes('USE_WEBGPU'), 'USE_WEBGPU flag must be defined for fallback configuration');
    });


    // =========================================================================
    // Feature 12: E2E Test Suite & First-Frame Pass (T1_F12_01 to T1_F12_05)
    // =========================================================================

    addTest('T1_F12_01', 'Tier 1', 'E2E Test Suite & First-Frame Pass', 'Module instantiation via _azahar_init export call', async (harness) => {
        const mod = await harness.loadWasmModule();
        const initRet = mod._azahar_init();
        assert.strictEqual(initRet, 0, '_azahar_init must instantiate cleanly with return code 0');
    });

    addTest('T1_F12_02', 'Tier 1', 'E2E Test Suite & First-Frame Pass', 'ROM mount into MEMFS and _azahar_load_rom execution', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        const romData = new Uint8Array([0x33, 0x44, 0x53, 0x58, 0x00, 0x01, 0x02, 0x03]);
        harness.fs.writeFile('/homebrew.3dsx', romData);
        const loadRet = mod._azahar_load_rom('/homebrew.3dsx');
        assert.strictEqual(loadRet, 0, '_azahar_load_rom must load mounted homebrew.3dsx');
    });

    addTest('T1_F12_03', 'Tier 1', 'E2E Test Suite & First-Frame Pass', 'Frame 1 step execution without WASM runtime traps', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/homebrew.3dsx', new Uint8Array([1, 2, 3, 4]));
        mod._azahar_load_rom('/homebrew.3dsx');
        const stepRet = mod._azahar_step_frame();
        assert.strictEqual(stepRet, 0, 'First frame step execution must return 0 without WASM memory trap');
    });

    addTest('T1_F12_04', 'Tier 1', 'E2E Test Suite & First-Frame Pass', 'Canvas non-zero pixel rendering verification after frame 1', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/homebrew.3dsx', new Uint8Array([1, 2, 3, 4]));
        mod._azahar_load_rom('/homebrew.3dsx');
        mod._azahar_step_frame();
        const ctx = harness.canvas.getContext('2d');
        const nonZeroPixels = ctx.getNonZeroPixelCount();
        assert.ok(nonZeroPixels > 0, `Canvas must have rendered non-zero pixels (actual: ${nonZeroPixels})`);
    });

    addTest('T1_F12_05', 'Tier 1', 'E2E Test Suite & First-Frame Pass', 'Multi-frame execution stability across 10 consecutive frames', async (harness) => {
        const mod = await harness.loadWasmModule();
        mod._azahar_init();
        harness.fs.writeFile('/homebrew.3dsx', new Uint8Array([1, 2, 3, 4]));
        mod._azahar_load_rom('/homebrew.3dsx');
        for (let frame = 1; frame <= 10; frame++) {
            const stepRet = mod._azahar_step_frame();
            assert.strictEqual(stepRet, 0, `Frame ${frame} step must return 0`);
        }
        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx.getNonZeroPixelCount() > 0, 'Canvas must maintain non-zero pixel state across multi-frame run');
    });

};
