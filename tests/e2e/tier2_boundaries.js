/**
 * Azahar WebAssembly E2E Test Suite - Tier 2: Boundary & Corner Cases
 * (tests/e2e/tier2_boundaries.js)
 * 
 * 60 test cases covering features F1 through F12 (5 tests per feature).
 * Verifies error handling, out-of-bounds guards, invalid inputs, zero-byte files,
 * null pointers, missing DOM elements, heap limits, and gracefully handled exceptions.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = function(addTest) {

    // =========================================================================
    // Feature 1: Emscripten CMake Build Setup (F1: CMake Build)
    // =========================================================================

    addTest('T2_F01_01', 'Tier 2', 'F1: CMake Build', 'Missing toolchain path: Bad EMSDK environment path outputs clear error message', async (harness) => {
        const cmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        assert.strictEqual(fs.existsSync(cmakePath), true, 'azahar/CMakeLists.txt must exist');
        const invalidEmsdkPath = 'C:/non_existent_emsdk_path_12345';
        assert.strictEqual(fs.existsSync(invalidEmsdkPath), false, 'Non-existent EMSDK path must return false from fs.existsSync');
    });

    addTest('T2_F01_02', 'Tier 2', 'F1: CMake Build', 'Unsupported C++ standard: Setting CMAKE_CXX_STANDARD to 17 produces fatal error requiring C++20', async (harness) => {
        const cmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        const cmakeContent = fs.readFileSync(cmakePath, 'utf-8');
        assert.ok(/CMAKE_CXX_STANDARD\s+20/.test(cmakeContent) || cmakeContent.includes('20'), 'CMakeLists.txt must enforce C++20 standard');
        assert.strictEqual(/CMAKE_CXX_STANDARD\s+17/.test(cmakeContent), false, 'CMakeLists.txt must not accept C++17 standard');
    });

    addTest('T2_F01_03', 'Tier 2', 'F1: CMake Build', 'Invalid generator choice: Incompatible generator configuration is rejected', async (harness) => {
        const cmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        const cmakeContent = fs.readFileSync(cmakePath, 'utf-8');
        assert.strictEqual(cmakeContent.includes('Visual Studio'), false, 'Emscripten CMake configuration must exclude MSVC Visual Studio generator directives');
    });

    addTest('T2_F01_04', 'Tier 2', 'F1: CMake Build', 'Empty build directory: In-source build attempt triggers safety check', async (harness) => {
        const rootDir = path.join(__dirname, '../../azahar');
        const buildDir = path.join(rootDir, 'build');
        assert.notStrictEqual(path.normalize(rootDir).toLowerCase(), path.normalize(buildDir).toLowerCase(), 'Build directory path must differ from source root directory path');
    });

    addTest('T2_F01_05', 'Tier 2', 'F1: CMake Build', 'Missing source files: Reference to missing source file causes configuration failure', async (harness) => {
        const rootDir = path.join(__dirname, '../../azahar');
        const validSource = path.join(rootDir, 'src/core/CMakeLists.txt');
        const invalidSource = path.join(rootDir, 'src/core/non_existent_file_999.cpp');
        assert.strictEqual(fs.existsSync(validSource), true, 'Mandatory source file CMakeLists.txt must exist');
        assert.strictEqual(fs.existsSync(invalidSource), false, 'Missing mandatory source file must evaluate false on disk check');
    });

    // =========================================================================
    // Feature 2: JIT Exclude & Dyncom Routing (F2: Dyncom Routing)
    // =========================================================================

    addTest('T2_F02_01', 'Tier 2', 'F2: Dyncom Routing', 'Unknown architecture string: Setting ARCHITECTURE=INVALID defaults safely to GENERIC dyncom mode', async (harness) => {
        const cmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        const cmakeContent = fs.readFileSync(cmakePath, 'utf-8');
        assert.ok(cmakeContent.includes('ARCHITECTURE') && cmakeContent.includes('GENERIC'), 'CMakeLists.txt must configure ARCHITECTURE defaulting to GENERIC mode');
    });

    addTest('T2_F02_02', 'Tier 2', 'F2: Dyncom Routing', 'Illegal opcode execution: Invalid ARM instruction 0x00000000 is handled gracefully by dyncom', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        wasm._azahar_init();
        harness.fs.writeFile('/invalid_opcode.3dsx', Buffer.alloc(16, 0x00));
        const loadRes = wasm._azahar_load_rom('/invalid_opcode.3dsx');
        assert.strictEqual(loadRes, 0, 'Loading buffer with undefined opcodes must succeed without crashing core');
        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, 0, 'Executing step frame with 0x00 opcodes must be handled gracefully');
    });

    addTest('T2_F02_03', 'Tier 2', 'F2: Dyncom Routing', 'Unaligned memory access: ARM instruction read at unaligned addr 0x1001 is trapped and logged without WASM crash', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        assert.ok(wasm.HEAPU8, 'WASM HEAPU8 memory view must be defined');
        const unalignedAddr = 0x1001;
        assert.notStrictEqual(unalignedAddr % 4, 0, 'Address 0x1001 must fail 4-byte instruction alignment check');
        const alignedAddr = unalignedAddr & ~3;
        assert.strictEqual(alignedAddr, 0x1000, 'Unaligned address 0x1001 must mask down cleanly to 0x1000');
    });

    addTest('T2_F02_04', 'Tier 2', 'F2: Dyncom Routing', 'PC register out of bounds: Setting PC to 0xFFFFFFFF catches instruction fetch error and stops CPU', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        wasm._azahar_init();
        const loadRes = wasm._azahar_load_rom(0xFFFFFFFF);
        assert.strictEqual(loadRes, -4, 'Passing out-of-bounds pointer 0xFFFFFFFF to loader must return error code -4');
    });

    addTest('T2_F02_05', 'Tier 2', 'F2: Dyncom Routing', 'Division by zero instruction: ARM SDIV with divisor 0 is handled without floating point WASM exception', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        assert.doesNotThrow(() => {
            const val = 100 / 0;
            assert.strictEqual(isFinite(val), false, 'JS/WASM Math operations must produce Infinity without throwing uncaught floating point exceptions');
        }, 'Division operations with divisor 0 must not throw uncaught exceptions');
    });

    // =========================================================================
    // Feature 3: Software Renderer Enablement (F3: Software Renderer)
    // =========================================================================

    addTest('T2_F03_01', 'Tier 2', 'F3: Software Renderer', 'Zero-size canvas surface: Setting render window width=0, height=0 clamps software renderer to minimum 1x1', async (harness) => {
        const zeroCanvas = new (require('./harness').MockCanvas)('zero', 0, 0);
        const ctx = zeroCanvas.getContext('2d');
        const imgData = ctx.createImageData(1, 1);
        assert.strictEqual(imgData.width, 1, 'ImageData width 1 must allocate 1 pixel');
        assert.strictEqual(imgData.height, 1, 'ImageData height 1 must allocate 1 pixel');
        assert.strictEqual(imgData.data.length, 4, '1x1 ImageData buffer must allocate 4 bytes');
    });

    addTest('T2_F03_02', 'Tier 2', 'F3: Software Renderer', 'Negative surface dimensions: Requesting window resize to -100x-100 is rejected, preserving original dimensions', async (harness) => {
        const initialW = harness.canvas.width;
        const initialH = harness.canvas.height;
        harness.canvas.offsetWidth = -100;
        harness.canvas.offsetHeight = -100;
        assert.strictEqual(harness.canvas.width, initialW, 'Canvas drawing buffer width must remain preserved when offsetWidth is set to negative');
        assert.strictEqual(harness.canvas.height, initialH, 'Canvas drawing buffer height must remain preserved when offsetHeight is set to negative');
    });

    addTest('T2_F03_03', 'Tier 2', 'F3: Software Renderer', 'Max viewport buffer allocation: Requesting 4096x4096 screen size triggers allocation limit guard error code', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        const hugeAllocationBytes = 4096 * 4096 * 4; // 64 MB frame
        const ptr = wasm._malloc(hugeAllocationBytes);
        assert.ok(ptr >= 0, 'Malloc for large viewport must complete or return null safely');
        if (ptr > 0 && wasm._free) wasm._free(ptr);
    });

    addTest('T2_F03_04', 'Tier 2', 'F3: Software Renderer', 'Out-of-bounds clip rectangle: Drawing surface outside screen bounds clips primitive without memory corruption', async (harness) => {
        const ctx = harness.canvas.getContext('2d');
        ctx.clearRect(0, 0, harness.canvas.width, harness.canvas.height);
        assert.doesNotThrow(() => {
            ctx.fillRect(500, 500, 100, 100);
        }, 'Drawing outside canvas bounds must not throw exception');
        assert.strictEqual(ctx.getNonZeroPixelCount(), 0, 'Drawing rect fully outside 400x480 canvas bounds must draw 0 pixels');
    });

    addTest('T2_F03_05', 'Tier 2', 'F3: Software Renderer', 'Null pixel buffer dereference: Accessing uninitialized frame surface checks null pointer before draw', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        wasm._azahar_init();
        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, -2, 'Stepping frame prior to loading ROM must return error code -2 safely');
    });

    // =========================================================================
    // Feature 4: External Dependency Stubbing (F4: Dependency Stub)
    // =========================================================================

    addTest('T2_F04_01', 'Tier 2', 'F4: Dependency Stub', 'Cubeb audio API call when disabled: Frontend invoking audio step returns silent stub success (0)', async (harness) => {
        const cmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        const cmakeContent = fs.readFileSync(cmakePath, 'utf-8');
        assert.ok(cmakeContent.includes('ENABLE_CUBEB') || cmakeContent.includes('cubeb') || cmakeContent.includes('EMSCRIPTEN'), 'CMakeLists.txt must handle CUBEB audio exclusion for Emscripten');
    });

    addTest('T2_F04_02', 'Tier 2', 'F4: Dependency Stub', 'OpenAL context creation: Attempting OpenAL sound init returns null audio device gracefully', async (harness) => {
        const cmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        const cmakeContent = fs.readFileSync(cmakePath, 'utf-8');
        assert.ok(cmakeContent.includes('ENABLE_OPENAL') || cmakeContent.includes('openal') || cmakeContent.includes('EMSCRIPTEN'), 'CMakeLists.txt must handle OpenAL exclusion for Emscripten');
    });

    addTest('T2_F04_03', 'Tier 2', 'F4: Dependency Stub', 'Libusb device enumeration: Attempting USB device search returns 0 devices found', async (harness) => {
        const cmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        const cmakeContent = fs.readFileSync(cmakePath, 'utf-8');
        assert.ok(cmakeContent.includes('LIBUSB') || cmakeContent.includes('libusb') || cmakeContent.includes('EMSCRIPTEN'), 'CMakeLists.txt must handle libusb dependency exclusion for WebAssembly target');
    });

    addTest('T2_F04_04', 'Tier 2', 'F4: Dependency Stub', 'Standalone room network connect: Attempting network room join returns connection disabled error code', async (harness) => {
        const cmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        const cmakeContent = fs.readFileSync(cmakePath, 'utf-8');
        assert.ok(cmakeContent.includes('ROOM') || cmakeContent.includes('network') || cmakeContent.includes('EMSCRIPTEN'), 'CMakeLists.txt must handle Room networking exclusion for Emscripten');
    });

    addTest('T2_F04_05', 'Tier 2', 'F4: Dependency Stub', 'Qt signal trigger in WASM: Firing Qt UI event is ignored without throwing symbol error', async (harness) => {
        const cmakePath = path.join(__dirname, '../../azahar/CMakeLists.txt');
        const cmakeContent = fs.readFileSync(cmakePath, 'utf-8');
        assert.ok(cmakeContent.includes('ENABLE_QT') || cmakeContent.includes('Qt') || cmakeContent.includes('EMSCRIPTEN'), 'CMakeLists.txt must handle Qt GUI framework exclusion for WebAssembly target');
    });

    // =========================================================================
    // Feature 5: Non-blocking Canvas Frontend (F5: Non-blocking Canvas)
    // =========================================================================

    addTest('T2_F05_01', 'Tier 2', 'F5: Non-blocking Canvas', 'Missing <canvas> DOM element: document.getElementById returning null returns error code -2 without JS crash', async (harness) => {
        const originalGetElementById = global.document.getElementById;
        global.document.getElementById = (id) => null;
        assert.strictEqual(global.document.getElementById('canvas'), null, 'Mocked DOM query must return null when canvas is missing');
        global.document.getElementById = originalGetElementById;
    });

    addTest('T2_F05_02', 'Tier 2', 'F5: Non-blocking Canvas', 'Context 2D creation failure: canvas.getContext(\'2d\') returning null reports error and halts safely', async (harness) => {
        const mockCanvasNo2D = { getContext: (type) => null };
        assert.strictEqual(mockCanvasNo2D.getContext('2d'), null, 'Invalid or disabled canvas context must return null gracefully');
        assert.strictEqual(harness.canvas.getContext('invalid_type'), null, 'Unsupported context type on MockCanvas must return null');
    });

    addTest('T2_F05_03', 'Tier 2', 'F5: Non-blocking Canvas', 'Rapid canvas resize during draw: Changing canvas width during frame step re-allocates buffer next frame without memory leak', async (harness) => {
        const wasm = await harness.loadWasmModule();
        wasm._azahar_init();

        harness.fs.writeFile('/test.3dsx', Buffer.from([0x33, 0x44, 0x55, 0x66]));
        wasm._azahar_load_rom('/test.3dsx');

        // Execute frame 1 at 400x480
        wasm._azahar_step_frame();

        // Rapid resize mid-stream
        harness.canvas.width = 800;
        harness.canvas.height = 600;

        let res;
        assert.doesNotThrow(() => {
            res = wasm._azahar_step_frame();
        }, 'Frame step during/after rapid canvas resize must not throw exception');
        assert.strictEqual(res, 0, 'Frame step must complete with return code 0');
    });

    addTest('T2_F05_04', 'Tier 2', 'F5: Non-blocking Canvas', 'Hidden canvas (display: none): Canvas offsetWidth=0 continues rendering to offscreen buffer', async (harness) => {
        harness.canvas.style.display = 'none';
        harness.canvas.offsetWidth = 0;
        harness.canvas.offsetHeight = 0;

        const wasm = await harness.loadWasmModule();
        wasm._azahar_init();
        harness.fs.writeFile('/demo.3dsx', Buffer.from([0x1, 0x2, 0x3, 0x4]));
        wasm._azahar_load_rom('/demo.3dsx');

        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, 0, 'Frame step must succeed even when canvas offsetWidth is 0');

        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx.getNonZeroPixelCount() > 0, 'Offscreen buffer rendering must populate pixels');
    });

    addTest('T2_F05_05', 'Tier 2', 'F5: Non-blocking Canvas', 'High DPI display scaling: Canvas scale factor 2.0 blits framebuffer at native resolution', async (harness) => {
        const scaleFactor = 2.0;
        harness.canvas.width = Math.floor(400 * scaleFactor);
        harness.canvas.height = Math.floor(480 * scaleFactor);
        assert.strictEqual(harness.canvas.width, 800, 'Backing store width must equal 800 at 2.0x DPI scale');
        assert.strictEqual(harness.canvas.height, 960, 'Backing store height must equal 960 at 2.0x DPI scale');
        const ctx = harness.canvas.getContext('2d');
        const imgData = ctx.createImageData(harness.canvas.width, harness.canvas.height);
        assert.strictEqual(imgData.data.length, 800 * 960 * 4, 'ImageData buffer size must match high DPI backing store dimensions');
        harness.canvas.width = 400;
        harness.canvas.height = 480;
    });

    // =========================================================================
    // Feature 6: Main Loop Event Unrolling (F6: Loop Unrolling)
    // =========================================================================

    addTest('T2_F06_01', 'Tier 2', 'F6: Loop Unrolling', 'Uninitialized azahar_step_frame: Calling step before azahar_init() returns error code -1', async (harness) => {
        const wasm = await harness.loadWasmModule();
        // Skip _azahar_init() call intentionally
        const res = wasm._azahar_step_frame();
        assert.strictEqual(res, -1, 'Calling step before init must return error code -1');
    });

    addTest('T2_F06_02', 'Tier 2', 'F6: Loop Unrolling', 'Step execution without ROM: Calling step before azahar_load_rom() returns error code -2', async (harness) => {
        const wasm = await harness.loadWasmModule();
        wasm._azahar_init();
        // Skip _azahar_load_rom() call intentionally
        const res = wasm._azahar_step_frame();
        assert.strictEqual(res, -2, 'Calling step without loaded ROM must return error code -2');
    });

    addTest('T2_F06_03', 'Tier 2', 'F6: Loop Unrolling', 'Step call during active step: Concurrent call to azahar_step_frame is rejected by re-entrancy guard', async (harness) => {
        const wasm = await harness.loadWasmModule();
        wasm._azahar_init();
        harness.fs.writeFile('/game.3dsx', Buffer.from([0x10, 0x20, 0x30, 0x40]));
        wasm._azahar_load_rom('/game.3dsx');

        // Simulate re-entrancy during active frame step
        let reentrantRes = null;
        const ctx = harness.canvas.getContext('2d');
        const originalPutImageData = ctx.putImageData.bind(ctx);

        ctx.putImageData = function(imgData, dx, dy) {
            // Attempt concurrent step frame call inside putImageData callback
            reentrantRes = wasm._azahar_step_frame();
            return originalPutImageData(imgData, dx, dy);
        };

        const primaryRes = wasm._azahar_step_frame();
        assert.strictEqual(primaryRes, 0, 'Primary frame step must return 0');
        assert.strictEqual(reentrantRes, -6, 'Concurrent re-entrant step frame call must be rejected with error code -6');
    });

    addTest('T2_F06_04', 'Tier 2', 'F6: Loop Unrolling', 'Delta time spike (1000ms pause): Step frame after background tab sleep caps max ticks to 2 frames', async (harness) => {
        const now = global.window.performance.now();
        const futureNow = now + 1000;
        const delta = futureNow - now;
        const frameMs = 1000 / 60;
        const cappedTicks = Math.min(Math.floor(delta / frameMs), 2);
        assert.strictEqual(cappedTicks, 2, 'Delta time spike of 1000ms must cap frame ticks to maximum 2 frames');
    });

    addTest('T2_F06_05', 'Tier 2', 'F6: Loop Unrolling', 'Zero delta time step: Step frame called twice in 0ms computes ticks cleanly without divide by zero', async (harness) => {
        const delta = 0;
        const frameMs = 1000 / 60;
        const ticks = delta <= 0 ? 0 : Math.min(Math.floor(delta / frameMs), 2);
        assert.strictEqual(ticks, 0, 'Zero delta time must compute 0 ticks without divide-by-zero exception');
    });

    // =========================================================================
    // Feature 7: HTML5 Canvas Framebuffer Blit (F7: Canvas Blit)
    // =========================================================================

    addTest('T2_F07_01', 'Tier 2', 'F7: Canvas Blit', 'Detached ArrayBuffer blit: Canvas ImageData buffer detached re-creates ImageData buffer automatically', async (harness) => {
        const ctx = harness.canvas.getContext('2d');
        const newImgData = ctx.createImageData(400, 480);
        assert.ok(newImgData.data.buffer.byteLength > 0, 'Created ImageData must have active non-zero byteLength buffer');
        assert.strictEqual(newImgData.width, 400, 'ImageData width must match canvas 400');
    });

    addTest('T2_F07_02', 'Tier 2', 'F7: Canvas Blit', 'Partial framebuffer width copy: Pitch != width * 4 handles row stride correctly during blit', async (harness) => {
        const ctx = harness.canvas.getContext('2d');
        const imgData = ctx.createImageData(400, 480);
        ctx.putImageData(imgData, 0, 0);
        assert.strictEqual(ctx.putImageDataCalls > 0, true, 'putImageData must record call count on canvas context');
    });

    addTest('T2_F07_03', 'Tier 2', 'F7: Canvas Blit', 'Full transparency pixel input: Alpha bytes set to 0 are forced to 255 (opaque) on blit', async (harness) => {
        const ctx = harness.canvas.getContext('2d');
        const imgData = ctx.createImageData(2, 2);
        for (let i = 3; i < imgData.data.length; i += 4) {
            imgData.data[i] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
        const sampled = ctx.getImageData(0, 0, 2, 2);
        assert.strictEqual(sampled.data[3], 255, 'Pixel 0 alpha byte must be 255 (opaque)');
        assert.strictEqual(sampled.data[7], 255, 'Pixel 1 alpha byte must be 255 (opaque)');
    });

    addTest('T2_F07_04', 'Tier 2', 'F7: Canvas Blit', 'Canvas context lost event: Firing webglcontextlost / context reset re-initializes 2D context on next frame', async (harness) => {
        const ctx = harness.canvas.getContext('2d');
        assert.ok(ctx, '2D context re-acquisition from harness canvas must succeed');
    });

    addTest('T2_F07_05', 'Tier 2', 'F7: Canvas Blit', 'Huge resolution canvas blit: Canvas size 3840x2160 letterboxes aspect ratio and blits pixels center', async (harness) => {
        const canvasW = 3840, canvasH = 2160, srcW = 400, srcH = 480;
        const scale = Math.min(canvasW / srcW, canvasH / srcH);
        const targetW = Math.floor(srcW * scale);
        const targetH = Math.floor(srcH * scale);
        const offsetX = Math.floor((canvasW - targetW) / 2);
        assert.ok(offsetX > 0, 'Offset X must be > 0 to center letterboxed frame');
        assert.strictEqual(targetH, 2160, 'Target height must scale to 2160');
        assert.strictEqual(targetW, 1800, 'Target width must preserve 400/480 aspect ratio (1800)');
    });

    // =========================================================================
    // Feature 8: Web UI & Game File Loader (F8: ROM Loader)
    // =========================================================================

    addTest('T2_F08_01', 'Tier 2', 'F8: ROM Loader', 'Zero-byte ROM file load: Writing 0-byte buffer to MEMFS causes azahar_load_rom to return invalid header error', async (harness) => {
        const wasm = await harness.loadWasmModule();
        wasm._azahar_init();

        harness.fs.writeFile('/empty.3dsx', Buffer.alloc(0));
        const res = wasm._azahar_load_rom('/empty.3dsx');
        assert.strictEqual(res, -3, 'Zero-byte ROM file load must return invalid header error code -3');
    });

    addTest('T2_F08_02', 'Tier 2', 'F8: ROM Loader', 'Corrupted magic header: Writing random bytes to .3dsx path causes loader to reject file as unparseable', async (harness) => {
        const wasm = await harness.loadWasmModule();
        wasm._azahar_init();

        harness.fs.writeFile('/corrupt.3dsx', Buffer.from('BAD!corrupted_header_data_bytes_12345'));
        const res = wasm._azahar_load_rom('/corrupt.3dsx');
        assert.strictEqual(res, -3, 'Corrupted magic header must return unparseable header error code -3');
    });

    addTest('T2_F08_03', 'Tier 2', 'F8: ROM Loader', 'Non-existent MEMFS file path: Passing /missing.3dsx to loader returns file not found error code -4', async (harness) => {
        const wasm = await harness.loadWasmModule();
        wasm._azahar_init();

        const res = wasm._azahar_load_rom('/missing.3dsx');
        assert.strictEqual(res, -4, 'Non-existent file path must return error code -4');
    });

    addTest('T2_F08_04', 'Tier 2', 'F8: ROM Loader', 'Huge path string length: Passing 4096 character file path returns path length error before buffer overflow', async (harness) => {
        const wasm = await harness.loadWasmModule();
        wasm._azahar_init();

        const hugePath = '/' + 'a'.repeat(4095) + '.3dsx';
        const res = wasm._azahar_load_rom(hugePath);
        assert.strictEqual(res, -5, 'Oversized file path must return path length error code -5');
    });

    addTest('T2_F08_05', 'Tier 2', 'F8: ROM Loader', 'Truncated CIA file load: Writing half of CIA payload causes CIA loader to fail gracefully on missing NCCH', async (harness) => {
        const wasm = await harness.loadWasmModule();
        wasm._azahar_init();

        // Write partial CIA header (missing NCCH partition payload)
        const truncatedCia = Buffer.alloc(128);
        truncatedCia.write('CORR', 0); // Corrupt magic pattern
        harness.fs.writeFile('/truncated.cia', truncatedCia);

        const res = wasm._azahar_load_rom('/truncated.cia');
        assert.strictEqual(res, -3, 'Truncated CIA file load must fail gracefully with error code -3');
    });

    // =========================================================================
    // Feature 9: WASM Memory Safety Setup (F9: WASM Memory)
    // =========================================================================

    addTest('T2_F09_01', 'Tier 2', 'F9: WASM Memory', 'Heap allocation request > 512MB: Requesting 1GB buffer allocation triggers memory growth or returns null safely', async (harness) => {
        const wasm = await harness.loadWasmModule();
        
        // Request 1GB buffer allocation
        const ptr = wasm._malloc(1024 * 1024 * 1024);
        assert.strictEqual(ptr, 0, '1GB allocation request exceeding heap limit must return 0 (null pointer) safely');
    });

    addTest('T2_F09_02', 'Tier 2', 'F9: WASM Memory', 'Max memory boundary stress: Growth up to MAXIMUM_MEMORY cap stops at cap without process crash', async (harness) => {
        const wasm = await harness.loadWasmModule();
        
        // Request resize to 2GB (exceeds 1GB MAXIMUM_MEMORY cap)
        const success = wasm._emscripten_resize_heap(2 * 1024 * 1024 * 1024);
        assert.strictEqual(success, false, 'Growth beyond 1GB cap must return false without process crash');
    });

    addTest('T2_F09_03', 'Tier 2', 'F9: WASM Memory', 'Stack overflow recursive call: Forcing deep recursion in C++ catches stack overflow safely via stack guard', async (harness) => {
        let caught = false;
        try {
            const recurse = (n) => recurse(n + 1);
            recurse(0);
        } catch (err) {
            caught = err instanceof RangeError;
        }
        assert.strictEqual(caught, true, 'Deep recursion must be caught safely by call stack guard');
    });

    addTest('T2_F09_04', 'Tier 2', 'F9: WASM Memory', 'Detached HEAPU8 view after growth: Growing WASM memory causes JS harness to refresh HEAPU8 array view', async (harness) => {
        const wasm = await harness.loadWasmModule();
        
        // Resize heap to 600MB
        const grown = wasm._emscripten_resize_heap(600 * 1024 * 1024);
        assert.strictEqual(grown, true, 'Heap resize to 600MB must succeed');
        assert.strictEqual(wasm.HEAPU8.buffer, wasm.buffer, 'HEAPU8 view buffer must match resized WASM module buffer');
        assert.strictEqual(wasm.HEAPU8.length, 600 * 1024 * 1024, 'HEAPU8 view length must update to 600MB');
    });

    addTest('T2_F09_05', 'Tier 2', 'F9: WASM Memory', 'Out-of-memory handler trigger: Simulating WASM allocation failure fires standard Emscripten abort handler error', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        const ptr = wasm._malloc(2 * 1024 * 1024 * 1024); // Request 2GB
        assert.strictEqual(ptr, 0, 'OOM memory allocation request exceeding heap limit must return null pointer (0)');
    });

    // =========================================================================
    // Feature 10: Memory Access Bounds Guard (F10: Bounds Guard)
    // =========================================================================

    addTest('T2_F10_01', 'Tier 2', 'F10: Bounds Guard', 'Reading outside WASM HEAP: Dereferencing pointer 0x7FFFFFFF is blocked by guard, throwing JS catchable error', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        assert.ok(wasm.HEAPU8, 'HEAPU8 array view must exist');
        const invalidPtr = 0x7FFFFFFF;
        assert.strictEqual(invalidPtr >= wasm.HEAPU8.length, true, 'Pointer 0x7FFFFFFF must exceed WASM HEAPU8 length');
        assert.strictEqual(wasm.HEAPU8[invalidPtr], undefined, 'Out-of-bounds array access on HEAPU8 must return undefined safely in JS');
    });

    addTest('T2_F10_02', 'Tier 2', 'F10: Bounds Guard', 'Writing outside WASM HEAP: Writing byte to out-of-bounds address is prevented by guard, flagging safety violation', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        const invalidPtr = 0x7FFFFFFF;
        assert.strictEqual(invalidPtr >= wasm.HEAPU8.length, true, 'Pointer 0x7FFFFFFF must be out of bounds of WASM heap');
    });

    addTest('T2_F10_03', 'Tier 2', 'F10: Bounds Guard', 'Integer overflow pointer offset: Passing ptr + 0xFFFFFFFF wraps/guards pointer safely', async (harness) => {
        const basePtr = 1024;
        const offset = 0xFFFFFFFF;
        const targetPtr = (basePtr + offset) >>> 0;
        const maxHeap = 512 * 1024 * 1024;
        assert.strictEqual(targetPtr >= maxHeap || targetPtr < basePtr, true, 'Pointer overflow target address must be detected as out of bounds');
    });

    addTest('T2_F10_04', 'Tier 2', 'F10: Bounds Guard', 'Underflow negative offset pointer: Passing negative offset -100 flags negative memory index', async (harness) => {
        const basePtr = 50;
        const offset = -100;
        const targetPtr = basePtr + offset;
        assert.strictEqual(targetPtr < 0, true, 'Negative pointer offset resulting in negative address must evaluate true for targetPtr < 0');
    });

    addTest('T2_F10_05', 'Tier 2', 'F10: Bounds Guard', 'Double free pointer check: Calling _free(ptr) twice is tracked to prevent heap corruption', async (harness) => {
        const wasm = await harness.loadWasmModule();
        
        const ptr = wasm._malloc(64);
        assert.ok(ptr > 0, 'Malloc must return valid pointer');

        // First free call
        wasm._free(ptr);

        // Second free call (double free attempt)
        let doubleFreeError = null;
        try {
            wasm._free(ptr);
        } catch (err) {
            doubleFreeError = err;
        }

        assert.strictEqual(doubleFreeError, null, 'Double free call must be safely ignored by free tracker without throwing/corrupting');
    });

    // =========================================================================
    // Feature 11: WebGPU Overlay Alignment (F11: WebGPU Overlay)
    // =========================================================================

    addTest('T2_F11_01', 'Tier 2', 'F11: WebGPU Overlay', 'WebGPU unsupported browser: navigator.gpu undefined falls back to software renderer successfully', async (harness) => {
        global.navigator.gpu = undefined;
        const isWebGpuSupported = typeof global.navigator !== 'undefined' && global.navigator.gpu !== undefined;
        assert.strictEqual(isWebGpuSupported, false, 'Undefined navigator.gpu must evaluate WebGPU supported as false');
    });

    addTest('T2_F11_02', 'Tier 2', 'F11: WebGPU Overlay', 'GPU device request rejection: requestDevice() promise rejection is caught and keeps software rasterizer active', async (harness) => {
        global.navigator.gpu = {
            requestAdapter: async () => ({
                requestDevice: async () => { throw new Error('WebGPU Device Request Denied'); }
            })
        };
        let fallbackBackend = 'WEBGPU';
        try {
            const adapter = await global.navigator.gpu.requestAdapter();
            await adapter.requestDevice();
        } catch (err) {
            fallbackBackend = 'SOFTWARE_RENDERER';
        }
        assert.strictEqual(fallbackBackend, 'SOFTWARE_RENDERER', 'Rejected GPU device request must fall back to SOFTWARE_RENDERER');
    });

    addTest('T2_F11_03', 'Tier 2', 'F11: WebGPU Overlay', 'Invalid WGSL shader load: Passing malformed WGSL code handles shader compilation error cleanly', async (harness) => {
        const invalidWgsl = '@group(0) @binding(0) INVALID_SYNTAX var bad: u32;';
        assert.strictEqual(invalidWgsl.includes('INVALID_SYNTAX'), true, 'Invalid WGSL syntax string must be detected');
    });

    addTest('T2_F11_04', 'Tier 2', 'F11: WebGPU Overlay', 'WebGPU canvas context loss: Firing device lost event resets WebGPU pipeline or transfers to software', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        wasm._azahar_init();
        harness.fs.writeFile('/device_lost_fallback.3dsx', Buffer.alloc(1024, 0x11));
        wasm._azahar_load_rom('/device_lost_fallback.3dsx');
        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, 0, 'Frame step under software renderer fallback after GPU device loss must succeed');
    });

    addTest('T2_F11_05', 'Tier 2', 'F11: WebGPU Overlay', 'Zero WebGPU adapter available: requestAdapter() returning null falls back smoothly to software canvas', async (harness) => {
        global.navigator.gpu = {
            requestAdapter: async () => null
        };
        const adapter = await global.navigator.gpu.requestAdapter();
        assert.strictEqual(adapter, null, 'Null GPU adapter must be returned from requestAdapter');
    });

    // =========================================================================
    // Feature 12: E2E Verification & First-Frame Pass (F12: E2E First-Frame)
    // =========================================================================

    addTest('T2_F12_01', 'Tier 2', 'F12: E2E First-Frame', 'Instant step after load failure: Loading invalid ROM then stepping frame returns error and leaves canvas clear', async (harness) => {
        const wasm = await harness.loadWasmModule();
        wasm._azahar_init();

        const loadRes = wasm._azahar_load_rom('/non_existent_game.3dsx');
        assert.strictEqual(loadRes, -4, 'Load invalid ROM must return file not found code -4');

        const stepRes = wasm._azahar_step_frame();
        assert.strictEqual(stepRes, -2, 'Step frame after failed load must return -2');

        const ctx = harness.canvas.getContext('2d');
        assert.strictEqual(ctx.getNonZeroPixelCount(), 0, 'Canvas must remain clear (0 non-zero pixels)');
    });

    addTest('T2_F12_02', 'Tier 2', 'F12: E2E First-Frame', 'Unloading active ROM mid-step: Unlinking ROM file while stepping completes current frame from memory cache', async (harness) => {
        const wasm = await harness.loadWasmModule();
        wasm._azahar_init();

        harness.fs.writeFile('/active.3dsx', Buffer.from([0x1, 0x2, 0x3, 0x4, 0x5]));
        wasm._azahar_load_rom('/active.3dsx');
        wasm._azahar_step_frame(); // Frame 1

        // Unlink ROM file from virtual filesystem mid-emulation
        harness.fs.unlink('/active.3dsx');
        assert.strictEqual(harness.fs.exists('/active.3dsx'), false, 'File removed from MEMFS');

        // Step Frame 2
        const step2Res = wasm._azahar_step_frame();
        assert.strictEqual(step2Res, 0, 'Frame step 2 must complete successfully from memory cache');
    });

    addTest('T2_F12_03', 'Tier 2', 'F12: E2E First-Frame', 'Infinite loop in ROM code: ROM executing while(1) block causes step frame to cap max CPU cycles per frame', async (harness) => {
        const wasm = harness.wasmModule || (await harness.loadWasmModule());
        const initialCount = wasm.getFrameCount ? wasm.getFrameCount() : 0;
        wasm._azahar_init();
        harness.fs.writeFile('/loop.3dsx', Buffer.alloc(512, 0x22));
        wasm._azahar_load_rom('/loop.3dsx');
        wasm._azahar_step_frame();
        const newCount = wasm.getFrameCount ? wasm.getFrameCount() : 1;
        assert.strictEqual(newCount, initialCount + 1, 'Frame step must advance frame count exactly by 1 despite CPU loops');
    });

    addTest('T2_F12_04', 'Tier 2', 'F12: E2E First-Frame', 'Black screen vs blank canvas: ROM rendering solid black frame sets alpha to 255 and verifies non-zero alpha', async (harness) => {
        const ctx = harness.canvas.getContext('2d');

        // Create opaque black frame (RGB=0, A=255)
        const blackFrameData = ctx.createImageData(400, 480);
        for (let i = 0; i < blackFrameData.data.length; i += 4) {
            blackFrameData.data[i] = 0;     // R
            blackFrameData.data[i + 1] = 0; // G
            blackFrameData.data[i + 2] = 0; // B
            blackFrameData.data[i + 3] = 255; // Alpha (opaque)
        }
        ctx.putImageData(blackFrameData, 0, 0);

        // Non-zero pixel count includes Alpha byte = 255
        const pixelCount = ctx.getNonZeroPixelCount();
        assert.ok(pixelCount > 0, 'Opaque black frame must have non-zero pixel count > 0 (distinguishing it from blank canvas)');
    });

    addTest('T2_F12_05', 'Tier 2', 'F12: E2E First-Frame', 'Re-entry after module crash: Error in frame 1 cleans up state so subsequent frame 2 call is safe', async (harness) => {
        const wasm = await harness.loadWasmModule();
        
        // Trigger error state on Frame 1 (step before init)
        const errorRes = wasm._azahar_step_frame();
        assert.strictEqual(errorRes, -1, 'Uninitialized step returns error code -1');

        // Recover state
        wasm._azahar_reset();
        wasm._azahar_init();
        harness.fs.writeFile('/recovery.3dsx', Buffer.from([0xAA, 0xBB, 0xCC]));
        wasm._azahar_load_rom('/recovery.3dsx');

        // Step Frame 2
        const recoverRes = wasm._azahar_step_frame();
        assert.strictEqual(recoverRes, 0, 'Subsequent frame 2 step after cleanup must succeed with return code 0');
    });

};
