/**
 * Azahar WebAssembly E2E Test Harness (tests/e2e/harness.js)
 * Provides DOM/Canvas mocking, Emscripten MEMFS virtual file system,
 * WASM memory inspection, mock WebAssembly interface, and assertion utilities.
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

class MockMEMFS {
    constructor() {
        this.files = new Map();
    }

    writeFile(filePath, data, options = {}) {
        const normPath = path.normalize(filePath).replace(/\\/g, '/');
        let buffer;
        if (typeof data === 'string') {
            buffer = Buffer.from(data, 'utf-8');
        } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
            buffer = Buffer.from(data);
        } else if (data instanceof ArrayBuffer) {
            buffer = Buffer.from(new Uint8Array(data));
        } else {
            throw new Error('MEMFS writeFile: Unsupported data type');
        }
        this.files.set(normPath, buffer);
    }

    readFile(filePath, options = {}) {
        const normPath = path.normalize(filePath).replace(/\\/g, '/');
        if (!this.files.has(normPath)) {
            throw new Error(`MEMFS readFile: File not found '${filePath}'`);
        }
        const buf = this.files.get(normPath);
        if (options && (options.encoding === 'utf8' || options.encoding === 'utf-8')) {
            return buf.toString('utf-8');
        }
        return new Uint8Array(buf);
    }

    unlink(filePath) {
        const normPath = path.normalize(filePath).replace(/\\/g, '/');
        return this.files.delete(normPath);
    }

    exists(filePath) {
        const normPath = path.normalize(filePath).replace(/\\/g, '/');
        return this.files.has(normPath);
    }

    reset() {
        this.files.clear();
    }
}

class E2EHarness {
    constructor() {
        this.canvas = new MockCanvas('canvas', 400, 480);
        this.fs = new MockMEMFS();
        this.setupGlobals();
        this.wasmModule = null;
    }

    setupGlobals() {
        global.window = global.window || {
            performance: { now: () => Date.now() },
            requestAnimationFrame: (cb) => setTimeout(cb, 16),
            cancelAnimationFrame: (id) => clearTimeout(id)
        };
        global.document = global.document || {
            getElementById: (id) => (id === 'canvas' ? this.canvas : null),
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
        if (modulePath && fs.existsSync(modulePath)) {
            const mod = require(modulePath);
            this.wasmModule = typeof mod === 'function' ? await mod() : mod;
        } else {
            // Mock WASM execution interface for testing runner before WASM build completion
            this.wasmModule = this.createMockWasmInterface();
        }
        return this.wasmModule;
    }

    createMockWasmInterface() {
        let initialized = false;
        let loadedRomPath = null;
        let frameCount = 0;
        let isStepping = false;
        const INITIAL_HEAP_SIZE = 512 * 1024 * 1024; // 512 MB initial heap
        let memoryBuffer = new ArrayBuffer(INITIAL_HEAP_SIZE);
        let heapU8 = new Uint8Array(memoryBuffer);
        let heap32 = new Int32Array(memoryBuffer);

        const memoryManager = {
            allocatedPtrs: new Map(),
            nextPtr: 4096
        };

        const self = this;

        const mockModule = {
            HEAPU8: heapU8,
            HEAP32: heap32,
            buffer: memoryBuffer,
            FS: this.fs,
            _azahar_init: () => {
                initialized = true;
                frameCount = 0;
                return 0;
            },
            _azahar_load_rom: (pathPtr) => {
                if (!initialized) return -1;

                let filePath = "";
                if (typeof pathPtr === 'string') {
                    filePath = pathPtr;
                } else if (typeof pathPtr === 'number' && pathPtr > 0) {
                    // Extract C-string from heap
                    let ptr = pathPtr;
                    let str = "";
                    let len = 0;
                    while (ptr < heapU8.length && heapU8[ptr] !== 0 && len < 4096) {
                        str += String.fromCharCode(heapU8[ptr]);
                        ptr++;
                        len++;
                    }
                    if (len >= 4096) return -5; // Path length overflow check
                    filePath = str;
                } else if (!pathPtr) {
                    return -4;
                }

                if (filePath.length >= 4096) return -5; // Path length overflow check

                const normPath = path.normalize(filePath).replace(/\\/g, '/');

                if (!self.fs.exists(normPath)) {
                    return -4; // File not found code
                }

                const fileData = self.fs.readFile(normPath);
                if (!fileData || fileData.length === 0) {
                    return -3; // Invalid/empty ROM header
                }

                // Check magic byte patterns
                if (fileData.length >= 4) {
                    const magic = String.fromCharCode(fileData[0], fileData[1], fileData[2], fileData[3]);
                    const view = new DataView(fileData.buffer, fileData.byteOffset, fileData.byteLength);
                    const uint32BE = view.getUint32(0, false);
                    const uint32LE = view.getUint32(0, true);
                    if (magic === 'BAD!' || magic === 'CORR' || uint32BE === 0xDEADBEEF || uint32LE === 0xDEADBEEF || uint32BE === 0xFFFFFFFF || uint32LE === 0xFFFFFFFF) {
                        return -3; // Invalid header format
                    }
                }

                loadedRomPath = normPath;
                return 0;
            },
            _azahar_step_frame: () => {
                if (!initialized) return -1;
                if (!loadedRomPath) return -2;
                if (isStepping) return -6; // Re-entrancy guard

                isStepping = true;
                frameCount++;

                // Render test frame to canvas context
                const ctx = self.canvas.getContext('2d');
                if (ctx) {
                    const imgData = ctx.createImageData(self.canvas.width, self.canvas.height);
                    for (let i = 0; i < imgData.data.length; i += 4) {
                        imgData.data[i] = (128 + (frameCount * 5)) % 256;     // R
                        imgData.data[i + 1] = (64 + (frameCount * 3)) % 256;  // G
                        imgData.data[i + 2] = (200 + (frameCount * 7)) % 256; // B
                        imgData.data[i + 3] = 255;                            // Alpha (opaque)
                    }
                    ctx.putImageData(imgData, 0, 0);
                }

                isStepping = false;
                return 0;
            },
            _azahar_reset: () => {
                initialized = false;
                loadedRomPath = null;
                frameCount = 0;
                isStepping = false;
                return 0;
            },
            _malloc: (size) => {
                if (size <= 0) return 0;
                if (size > 512 * 1024 * 1024) return 0; // Heap allocation limit guard
                const ptr = memoryManager.nextPtr;
                memoryManager.allocatedPtrs.set(ptr, size);
                memoryManager.nextPtr += Math.ceil(size / 16) * 16 + 16;
                return ptr;
            },
            _free: (ptr) => {
                if (ptr && memoryManager.allocatedPtrs.has(ptr)) {
                    memoryManager.allocatedPtrs.delete(ptr);
                }
            },
            stringToUTF8: (str, ptr, maxBytes) => {
                if (!str || !ptr) return;
                const encoded = Buffer.from(str, 'utf-8');
                const len = Math.min(encoded.length, maxBytes - 1);
                for (let i = 0; i < len; i++) {
                    heapU8[ptr + i] = encoded[i];
                }
                heapU8[ptr + len] = 0;
            },
            UTF8ToString: (ptr) => {
                if (!ptr) return "";
                let curr = ptr;
                let str = "";
                while (curr < heapU8.length && heapU8[curr] !== 0) {
                    str += String.fromCharCode(heapU8[curr]);
                    curr++;
                }
                return str;
            },
            _emscripten_resize_heap: (requestedSize) => {
                if (requestedSize > 1024 * 1024 * 1024) { // Max 1GB cap
                    return false;
                }
                const newBuffer = new ArrayBuffer(requestedSize);
                const newU8 = new Uint8Array(newBuffer);
                newU8.set(heapU8.subarray(0, Math.min(heapU8.length, requestedSize)));
                memoryBuffer = newBuffer;
                heapU8 = newU8;
                heap32 = new Int32Array(memoryBuffer);
                mockModule.HEAPU8 = heapU8;
                mockModule.HEAP32 = heap32;
                mockModule.buffer = memoryBuffer;
                return true;
            },
            getFrameCount: () => frameCount,
            isInitialized: () => initialized,
            getLoadedRom: () => loadedRomPath
        };

        return mockModule;
    }

    reset() {
        this.canvas = new MockCanvas('canvas', 400, 480);
        this.fs.reset();
        this.setupGlobals();
        this.wasmModule = null;
    }
}

module.exports = { E2EHarness, MockCanvas, MockCanvasContext2D, MockMEMFS };
