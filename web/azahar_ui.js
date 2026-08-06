/**
 * Azahar Web UI — azahar_ui.js
 * Loads the Azahar WebAssembly module and provides the emulator UI.
 */

(function () {
    'use strict';

    // ── DOM refs ──────────────────────────────────────────────────
    const canvas = document.getElementById('canvas');
    const romInput = document.getElementById('rom-file');
    const fileLabel = document.getElementById('file-label');
    const btnLoad = document.getElementById('btn-load');
    const btnInit = document.getElementById('btn-init');
    const btnStep = document.getElementById('btn-step');
    const btnRun = document.getElementById('btn-run');
    const btnStop = document.getElementById('btn-stop');
    const statusEl = document.getElementById('status');
    const logEl = document.getElementById('log');

    // ── State ─────────────────────────────────────────────────────
    let wasmModule = null;
    let romData = null;
    let romName = '';
    let initialized = false;
    let romLoaded = false;
    let running = false;
    let runTimer = null;
    let frameCount = 0;

    // ── Logging ───────────────────────────────────────────────────
    function log(msg) {
        const time = new Date().toLocaleTimeString();
        logEl.textContent += `[${time}] ${msg}\n`;
        logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(msg, cls) {
        statusEl.textContent = msg;
        statusEl.className = cls || '';
    }

    // ── File picker ───────────────────────────────────────────────
    romInput.addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (!file) return;

        romName = file.name;
        fileLabel.textContent = `📄 ${romName} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;

        const reader = new FileReader();
        reader.onload = function () {
            romData = new Uint8Array(reader.result);
            log(`File loaded: ${romName} (${romData.length} bytes)`);
            setStatus(`ROM ready: ${romName}`, 'ok');
            btnLoad.disabled = false;
        };
        reader.onerror = function () {
            setStatus('Failed to read file!', 'error');
            log('ERROR: FileReader failed');
        };
        reader.readAsArrayBuffer(file);
    });

    // ── WASM Module Loading ──────────────────────────────────────
    async function loadWasmModule() {
        log('Loading azahar.js glue script...');
        setStatus('Loading WebAssembly module...');

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'azahar.js';
            script.onload = function () {
                // Emscripten-generated Module object
                if (typeof Module !== 'undefined') {
                    Module['onRuntimeInitialized'] = function () {
                        log('WebAssembly runtime initialized.');
                        wasmModule = Module;
                        setStatus('WASM ready. Click "Initialize Emulator".', 'ok');
                        btnInit.disabled = false;
                        resolve(Module);
                    };
                    // In case it's already initialized
                    if (Module.calledRun) {
                        log('WebAssembly already initialized.');
                        wasmModule = Module;
                        setStatus('WASM ready.', 'ok');
                        btnInit.disabled = false;
                        resolve(Module);
                    }
                } else {
                    // If no Module object, script may be self-initializing
                    log('Waiting for WASM runtime...');
                    // Poll for Module
                    const check = setInterval(() => {
                        if (typeof Module !== 'undefined' && Module.calledRun) {
                            clearInterval(check);
                            wasmModule = Module;
                            log('WebAssembly runtime detected.');
                            setStatus('WASM ready.', 'ok');
                            btnInit.disabled = false;
                            resolve(Module);
                        }
                    }, 200);
                    setTimeout(() => { clearInterval(check); reject(new Error('WASM timeout')); }, 30000);
                }
            };
            script.onerror = function () {
                reject(new Error('Failed to load azahar.js'));
            };
            document.head.appendChild(script);
        });
    }

    // ── Initialize Emulator ──────────────────────────────────────
    btnInit.addEventListener('click', async function () {
        try {
            btnInit.disabled = true;
            setStatus('Initializing emulator...');

            if (!wasmModule) {
                await loadWasmModule();
            }

            const result = wasmModule._azahar_init();
            if (result === 0) {
                initialized = true;
                log('Emulator initialized successfully.');
                setStatus('Emulator ready. Load a ROM to begin.', 'ok');
                if (romData) btnLoad.disabled = false;
            } else {
                setStatus(`Init failed (code ${result})`, 'error');
                log(`ERROR: azahar_init returned ${result}`);
                btnInit.disabled = false;
            }
        } catch (err) {
            setStatus(`Init error: ${err.message}`, 'error');
            log(`ERROR: ${err.message}`);
            btnInit.disabled = false;
        }
    });

    // ── Load ROM ─────────────────────────────────────────────────
    btnLoad.addEventListener('click', function () {
        if (!initialized || !romData) {
            setStatus('Initialize emulator and select a ROM first.', 'error');
            return;
        }

        try {
            setStatus('Loading ROM...');
            btnLoad.disabled = true;

            // Write ROM to MEMFS so the C++ side can read it
            const romPath = '/rom.bin';
            wasmModule.FS.writeFile(romPath, romData);
            log(`ROM written to MEMFS: ${romPath}`);

            const result = wasmModule.ccall('azahar_load_rom', 'number', ['string'], [romPath]);
            if (result === 0) {
                romLoaded = true;
                log('ROM loaded successfully!');
                setStatus('ROM loaded. Click "Step Frame" or "Run".', 'ok');
                btnStep.disabled = false;
                btnRun.disabled = false;
            } else {
                setStatus(`ROM load failed (code ${result})`, 'error');
                log(`ERROR: azahar_load_rom returned ${result}`);
                btnLoad.disabled = false;
            }
        } catch (err) {
            setStatus(`Load error: ${err.message}`, 'error');
            log(`ERROR: ${err.message}`);
            btnLoad.disabled = false;
        }
    });

    // ── Step One Frame ───────────────────────────────────────────
    btnStep.addEventListener('click', function () {
        if (!romLoaded) {
            setStatus('Load a ROM first.', 'error');
            return;
        }

        try {
            frameCount++;
            const result = wasmModule._azahar_step_frame();

            if (result === 0) {
                // Copy the Emscripten GL/Canvas framebuffer to our canvas
                // SDL2 in Emscripten renders to the default canvas; we grab it
                updateCanvasFromWasm();
                setStatus(`Frame ${frameCount} OK`, 'ok');
            } else if (result === 1) {
                setStatus('Emulation ended (shutdown)', 'error');
                log('Emulator requested shutdown.');
                stopRunning();
            } else {
                setStatus(`Frame step error (code ${result})`, 'error');
                log(`ERROR: azahar_step_frame returned ${result}`);
            }
        } catch (err) {
            setStatus(`Step error: ${err.message}`, 'error');
            log(`ERROR: ${err.message}`);
        }
    });

    // ── Run Loop ─────────────────────────────────────────────────
    btnRun.addEventListener('click', function () {
        if (!romLoaded || running) return;

        running = true;
        btnRun.disabled = true;
        btnStop.disabled = false;
        btnStep.disabled = true;
        log('Starting run loop at ~60 FPS...');
        setStatus('Running...', 'ok');

        function tick() {
            if (!running) return;

            try {
                frameCount++;
                const result = wasmModule._azahar_step_frame();

                if (result === 0) {
                    updateCanvasFromWasm();
                    runTimer = setTimeout(tick, 16); // ~60 FPS
                } else if (result === 1) {
                    log('Emulation ended.');
                    setStatus('Emulation ended.', '');
                    stopRunning();
                } else {
                    log(`Frame error: ${result}`);
                    setStatus(`Frame error (code ${result})`, 'error');
                    stopRunning();
                }
            } catch (err) {
                log(`Run error: ${err.message}`);
                setStatus(`Error: ${err.message}`, 'error');
                stopRunning();
            }
        }

        tick();
    });

    btnStop.addEventListener('click', function () {
        stopRunning();
    });

    function stopRunning() {
        running = false;
        if (runTimer) { clearTimeout(runTimer); runTimer = null; }
        btnRun.disabled = !romLoaded;
        btnStop.disabled = true;
        btnStep.disabled = !romLoaded;
        if (romLoaded) setStatus(`Stopped at frame ${frameCount}`, '');
    }

    // ── Canvas Update ────────────────────────────────────────────
    function updateCanvasFromWasm() {
        // SDL2 on Emscripten renders to its own canvas (Module.canvas).
        // Our canvas (#canvas) is separate, so we copy the pixels.
        // If Module.canvas is different, blit from it.
        var srcCanvas = null;
        if (wasmModule && wasmModule.canvas) {
            srcCanvas = wasmModule.canvas;
        } else {
            // Fallback: find the canvas SDL2 creates
            var canvases = document.querySelectorAll('canvas');
            if (canvases.length > 1) {
                srcCanvas = canvases[1]; // SDL often creates a second canvas
            }
        }

        if (srcCanvas && srcCanvas !== canvas) {
            var ctx = canvas.getContext('2d');
            ctx.drawImage(srcCanvas, 0, 0, canvas.width, canvas.height);
        }
    }

    // ── Auto-init on page load ───────────────────────────────────
    log('Azahar Web UI ready.');
    setStatus('Loading WASM module...');
    loadWasmModule().catch(function (err) {
        log(`WASM load failed: ${err.message}`);
        setStatus(`Failed to load WASM: ${err.message}. Ensure azahar.js and azahar.wasm are in the same directory.`, 'error');
        // Allow manual retry via Init button
        btnInit.disabled = false;
    });
})();
