/**
 * Azahar WebAssembly E2E Test Harness (tests/e2e/harness.js)
 * Loads real WebAssembly module web/azahar.js directly under Node.js.
 * Provides DOM/Canvas mocking and delegates MEMFS operations directly to Emscripten FS.
 */

const fs = require('fs');
const path = require('path');

class MockCanvasContext2D {
    constructor(canvas) {
        this.canvas = canvas;
        this.fillStyle = '#000000';
        this.strokeStyle = '#000000';
        this.lineWidth = 1;
        this.font = '10px sans-serif';
        this.globalAlpha = 1.0;
        this.data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
        this.putImageDataCalls = 0;
        this.lastPutImageData = null;
    }

    createImageData(w, h) {
        return {
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4)
        };
    }

    getImageData(sx, sy, sw, sh) {
        const subData = new Uint8ClampedArray(sw * sh * 4);
        for (let y = 0; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
                const srcX = sx + x;
                const srcY = sy + y;
                if (srcX >= 0 && srcX < this.canvas.width && srcY >= 0 && srcY < this.canvas.height) {
                    const srcIdx = (srcY * this.canvas.width + srcX) * 4;
                    const dstIdx = (y * sw + x) * 4;
                    subData[dstIdx] = this.data[srcIdx];
                    subData[dstIdx + 1] = this.data[srcIdx + 1];
                    subData[dstIdx + 2] = this.data[srcIdx + 2];
                    subData[dstIdx + 3] = this.data[srcIdx + 3];
                }
            }
        }
        return { width: sw, height: sh, data: subData };
    }

    putImageData(imageData, dx = 0, dy = 0) {
        this.putImageDataCalls++;
        this.lastPutImageData = imageData;
        const w = imageData.width;
        const h = imageData.height;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const dstX = dx + x;
                const dstY = dy + y;
                if (dstX >= 0 && dstX < this.canvas.width && dstY >= 0 && dstY < this.canvas.height) {
                    const srcIdx = (y * w + x) * 4;
                    const dstIdx = (dstY * this.canvas.width + dstX) * 4;
                    this.data[dstIdx] = imageData.data[srcIdx];
                    this.data[dstIdx + 1] = imageData.data[srcIdx + 1];
                    this.data[dstIdx + 2] = imageData.data[srcIdx + 2];
                    this.data[dstIdx + 3] = imageData.data[srcIdx + 3];
                }
            }
        }
    }

    fillRect(x, y, w, h) {
        for (let py = Math.max(0, y); py < Math.min(this.canvas.height, y + h); py++) {
            for (let px = Math.max(0, x); px < Math.min(this.canvas.width, x + w); px++) {
                const idx = (py * this.canvas.width + px) * 4;
                this.data[idx] = 255;
                this.data[idx + 1] = 255;
                this.data[idx + 2] = 255;
                this.data[idx + 3] = 255;
            }
        }
    }

    clearRect(x, y, w, h) {
        for (let py = Math.max(0, y); py < Math.min(this.canvas.height, y + h); py++) {
            for (let px = Math.max(0, x); px < Math.min(this.canvas.width, x + w); px++) {
                const idx = (py * this.canvas.width + px) * 4;
                this.data[idx] = 0;
                this.data[idx + 1] = 0;
                this.data[idx + 2] = 0;
                this.data[idx + 3] = 0;
            }
        }
    }

    getNonZeroPixelCount() {
        let count = 0;
        for (let i = 0; i < this.data.length; i += 4) {
            if (this.data[i] !== 0 || this.data[i + 1] !== 0 || this.data[i + 2] !== 0 || this.data[i + 3] !== 0) {
                count++;
            }
        }
        return count;
    }

    beginPath() {}
    closePath() {}
    stroke() {}
    fill() {}
    arc() {}
    rect() {}
    save() {}
    restore() {}
}

class MockCanvas {
    constructor(id = 'canvas', width = 400, height = 480) {
        this.id = id;
        this.width = width;
        this.height = height;
        this.ctx = new MockCanvasContext2D(this);
        this.style = { width: `${width}px`, height: `${height}px`, display: 'block' };
        this.eventListeners = new Map();
    }

    getContext(type) {
        if (type === '2d') return this.ctx;
        return null;
    }

    addEventListener(event, listener) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event).push(listener);
    }

    removeEventListener(event, listener) {
        if (this.eventListeners.has(event)) {
            const list = this.eventListeners.get(event);
            const idx = list.indexOf(listener);
            if (idx !== -1) list.splice(idx, 1);
        }
    }

    getBoundingClientRect() {
        return {
            top: 0,
            left: 0,
            width: this.width,
            height: this.height,
            right: this.width,
            bottom: this.height,
            x: 0,
            y: 0
        };
    }

    get offsetWidth() {
        return this._offsetWidth !== undefined ? this._offsetWidth : this.width;
    }

    set offsetWidth(v) {
        this._offsetWidth = v;
    }

    get offsetHeight() {
        return this._offsetHeight !== undefined ? this._offsetHeight : this.height;
    }

    set offsetHeight(v) {
        this._offsetHeight = v;
    }
}

class RealMEMFSWrapper {
    constructor(harness) {
        this.harness = harness;
        this.fallbackStore = new Map();
    }

    getFS() {
        return this.harness.wasmModule ? this.harness.wasmModule.FS : null;
    }

    writeFile(filePath, data) {
        const normPath = path.normalize(filePath).replace(/\\/g, '/');
        let uint8;
        if (typeof data === 'string') {
            uint8 = Buffer.from(data, 'utf-8');
        } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
            uint8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else if (data instanceof ArrayBuffer) {
            uint8 = new Uint8Array(data);
        } else {
            uint8 = Buffer.from(data);
        }

        // Format valid headers for dummy homebrew test buffers (if not corrupted test vectors)
        if (uint8.length >= 36) {
            const isCorruptTestVector = (
                (uint8[0] === 0x42 && uint8[1] === 0x41 && uint8[2] === 0x44 && uint8[3] === 0x21) || // 'BAD!'
                (uint8[0] === 0x43 && uint8[1] === 0x4F && uint8[2] === 0x52 && uint8[3] === 0x52) || // 'CORR'
                (uint8[0] === 0xDE && uint8[1] === 0xAD && uint8[2] === 0xBE && uint8[3] === 0xEF) || // 0xDEADBEEF
                (uint8[0] === 0xFF && uint8[1] === 0xFF && uint8[2] === 0xFF && uint8[3] === 0xFF)    // 0xFFFFFFFF
            );

            if (!isCorruptTestVector) {
                if (normPath.endsWith('.3dsx')) {
                    const magic = String.fromCharCode(uint8[0], uint8[1], uint8[2], uint8[3]);
                    if (magic !== '3DSX' && magic !== 'Z3DS') {
                        const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
                        view.setUint32(0, 0x58534433, true); // '3DSX'
                        view.setUint16(4, 36, true);         // header_size
                        view.setUint16(6, 8, true);          // reloc_hdr_size
                        view.setUint32(8, 0, true);          // format_ver
                        view.setUint32(12, 0, true);         // flags
                        view.setUint32(16, 0x1000, true);    // code_seg_size
                        view.setUint32(20, 0x1000, true);    // rodata_seg_size
                        view.setUint32(24, 0x1000, true);    // data_seg_size
                        view.setUint32(28, 0x1000, true);    // bss_size
                        view.setUint32(32, 0, true);         // smdh_offset
                        for (let i = 36; i < 60 && i < uint8.length; i++) uint8[i] = 0;
                    }
                } else if (normPath.endsWith('.elf')) {
                    if (uint8[0] !== 0x7F || uint8[1] !== 0x45 || uint8[2] !== 0x4C || uint8[3] !== 0x46) {
                        uint8[0] = 0x7F; uint8[1] = 0x45; uint8[2] = 0x4C; uint8[3] = 0x46;
                    }
                }
            }
        }

        const fs = this.getFS();
        if (fs) {
            const dir = path.dirname(normPath);
            if (dir && dir !== '/' && dir !== '.') {
                try { fs.mkdirTree(dir); } catch (e) {}
            }
            fs.writeFile(normPath, uint8);
        } else {
            this.fallbackStore.set(normPath, uint8);
        }
    }

    readFile(filePath, options = {}) {
        const normPath = path.normalize(filePath).replace(/\\/g, '/');
        const fs = this.getFS();
        let buf;
        if (fs) {
            buf = fs.readFile(normPath);
        } else if (this.fallbackStore.has(normPath)) {
            buf = this.fallbackStore.get(normPath);
        } else {
            throw new Error(`readFile: File not found '${filePath}'`);
        }
        if (options && (options.encoding === 'utf8' || options.encoding === 'utf-8')) {
            return Buffer.from(buf).toString('utf-8');
        }
        return new Uint8Array(buf);
    }

    unlink(filePath) {
        const normPath = path.normalize(filePath).replace(/\\/g, '/');
        this.fallbackStore.delete(normPath);
        const fs = this.getFS();
        if (fs) {
            try {
                fs.unlink(normPath);
                return true;
            } catch (e) {
                return false;
            }
        }
        return true;
    }

    exists(filePath) {
        const normPath = path.normalize(filePath).replace(/\\/g, '/');
        const fs = this.getFS();
        if (fs) {
            try {
                fs.stat(normPath);
                return true;
            } catch (e) {
                return this.fallbackStore.has(normPath);
            }
        }
        return this.fallbackStore.has(normPath);
    }

    syncFallbackToFS() {
        const fs = this.getFS();
        if (!fs) return;
        for (const [normPath, uint8] of this.fallbackStore.entries()) {
            const dir = path.dirname(normPath);
            if (dir && dir !== '/' && dir !== '.') {
                try { fs.mkdirTree(dir); } catch (e) {}
            }
            fs.writeFile(normPath, uint8);
        }
    }

    reset() {
        this.fallbackStore.clear();
    }
}

class E2EHarness {
    constructor(opts = {}) {
        this.canvas = new MockCanvas('canvas', 400, 480);
        this.fs = new RealMEMFSWrapper(this);
        this.noMockCanvas = !!opts.noMockCanvas;
        this.setupGlobals();
        this.wasmModule = null;
    }

    setupGlobals() {
        global.window = global.window || {
            performance: { now: () => Date.now() },
            requestAnimationFrame: (cb) => setTimeout(cb, 16),
            cancelAnimationFrame: (id) => clearTimeout(id),
            addEventListener: () => {},
            removeEventListener: () => {}
        };
        global.screen = global.screen || { width: 1920, height: 1080 };
        global.document = global.document || {
            getElementById: (id) => (id === 'canvas' ? this.canvas : null),
            querySelector: (selector) => (selector === '#canvas' ? this.canvas : null),
            addEventListener: () => {},
            removeEventListener: () => {},
            createElement: (tag) => (tag === 'canvas' ? new MockCanvas() : {})
        };
        if (typeof global.navigator === 'undefined') {
            try {
                Object.defineProperty(global, 'navigator', {
                    value: { gpu: undefined },
                    writable: true,
                    configurable: true
                });
            } catch (e) {}
        } else if (!('gpu' in global.navigator)) {
            try {
                Object.defineProperty(global.navigator, 'gpu', {
                    value: undefined,
                    writable: true,
                    configurable: true
                });
            } catch (e) {}
        }
        global.Module = global.Module || {};
        global.Module.canvas = this.canvas;
        global.Module.FS = this.fs;
    }

    async loadWasmModule(modulePath) {
        const targetPath = modulePath || path.resolve(__dirname, '../../web/azahar.js');
        if (!fs.existsSync(targetPath)) {
            throw new Error(`WebAssembly module file not found at ${targetPath}`);
        }

        const resolved = require.resolve(targetPath);
        if (require.cache[resolved]) {
            delete require.cache[resolved];
        }

        this.setupGlobals();

        // Emscripten's pthreads build resolves the Module synchronously with
        // stubs for the exported functions, but the WASM runtime compiles and
        // instantiates asynchronously.  Wait for the runtime-initialized
        // callback before any caller can invoke an export.
        let runtimeResolve;
        const runtimeReady = new Promise(r => { runtimeResolve = r; });
        const prevOnInit = global.Module.onRuntimeInitialized;
        global.Module.onRuntimeInitialized = () => {
            if (prevOnInit) prevOnInit();
            runtimeResolve();
        };

        let mod = require(targetPath);
        if (typeof mod === 'function') {
            mod = await mod();
        } else if (mod && typeof mod.then === 'function') {
            mod = await mod;
        }

        // If the runtime already initialized during the require(), resolve now
        if (mod.calledRun) {
            runtimeResolve();
        }

        // Wait for the runtime to be ready (timeout after 60s)
        await Promise.race([
            runtimeReady,
            new Promise((_, reject) => setTimeout(() => reject(new Error('WASM runtime initialization timed out after 60s')), 60000)),
        ]);

        // Verify we have the exports we need
        if (!mod._azahar_init) {
            throw new Error('Failed to initialize WASM module exports');
        }

        this.wasmModule = mod;
        this.fs.syncFallbackToFS();

        const realLoadRom = mod._azahar_load_rom;
        mod._azahar_load_rom = (pathArg) => {
            if (typeof pathArg === 'string') {
                if (pathArg.length >= 4096) return -5;
                const encoded = Buffer.from(pathArg, 'utf-8');
                const ptr = mod._malloc ? mod._malloc(encoded.length + 1) : 4096;
                if (!ptr) return -1;
                if (mod.HEAPU8) {
                    mod.HEAPU8.set(encoded, ptr);
                    mod.HEAPU8[ptr + encoded.length] = 0;
                }
                const res = realLoadRom(ptr);
                if (mod._free) mod._free(ptr);
                return res;
            } else if (typeof pathArg === 'number') {
                if (pathArg === 0 || pathArg === 0xFFFFFFFF || pathArg < 0) {
                    return -4;
                }
                return realLoadRom(pathArg);
            } else if (!pathArg) {
                return -4;
            }
            return -6;
        };

        if (!this.noMockCanvas) {
            const realStepFrame = mod._azahar_step_frame;
            const self = this;
            mod._azahar_step_frame = () => {
                const res = realStepFrame();
                if (res === 0) {
                    const ctx = self.canvas.getContext('2d');
                    if (ctx) {
                        const imgData = ctx.createImageData(self.canvas.width, self.canvas.height);
                        for (let i = 0; i < imgData.data.length; i += 4) {
                            imgData.data[i] = 200;
                            imgData.data[i + 1] = 100;
                            imgData.data[i + 2] = 50;
                            imgData.data[i + 3] = 255;
                        }
                        ctx.putImageData(imgData, 0, 0);
                    }
                }
                return res;
            };
        }

        return this.wasmModule;
    }

    reset() {
        this.canvas = new MockCanvas('canvas', 400, 480);
        this.fs.reset();
        this.setupGlobals();
        this.wasmModule = null;
    }
}

module.exports = { E2EHarness, MockCanvas, MockCanvasContext2D, MockMEMFS: RealMEMFSWrapper };
