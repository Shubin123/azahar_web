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
    const progressEl = document.getElementById('progress');
    const logEl = document.getElementById('log');

    // ── State ─────────────────────────────────────────────────────
    let wasmModule = null;
    let romData = null;
    let romMounted = false;
    let romName = '';
    let romPath = '/rom.bin';
    let initialized = false;
    let initializing = false;
    let romLoaded = false;
    let running = false;
    let runAnimationFrame = null;
    let frameCount = 0;
    let runStartedAt = 0;
    let nextBootStatusAt = 0;
    let gameGraphicsDetected = false;

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

    function showProgress(value) {
        progressEl.hidden = false;
        if (value === null || value === undefined) {
            progressEl.removeAttribute('value');
        } else {
            progressEl.value = Math.max(0, Math.min(100, value));
        }
    }

    function hideProgress() {
        progressEl.hidden = true;
        progressEl.value = 0;
    }

    function yieldToBrowser() {
        return new Promise(resolve => requestAnimationFrame(resolve));
    }

    function memfsRomPath(filename) {
        // Loader::GetLoader uses an extension as a fallback when a container
        // (notably CIA) cannot be identified from its header. Keep only the
        // final, safe extension: browser filenames are untrusted input and
        // need not become filesystem paths in MEMFS.
        const match = /\.[a-z0-9]+$/i.exec(filename);
        return `/rom${match ? match[0].toLowerCase() : '.bin'}`;
    }

    // ── File picker ───────────────────────────────────────────────
    romInput.addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (!file) return;

        romName = file.name;
        romPath = memfsRomPath(romName);
        fileLabel.textContent = `📄 ${romName} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;

        const reader = new FileReader();
        btnLoad.disabled = true;
        showProgress(0);
        setStatus('Reading ROM... 0%');
        reader.onprogress = function (event) {
            if (!event.lengthComputable) {
                showProgress(null);
                setStatus(`Reading ROM... ${(event.loaded / 1024 / 1024).toFixed(1)} MB`);
                return;
            }
            const percent = Math.round(event.loaded / event.total * 100);
            showProgress(percent);
            setStatus(`Reading ROM... ${percent}%`);
        };
        reader.onload = function () {
            romData = new Uint8Array(reader.result);
            romMounted = false;
            log(`File loaded: ${romName} (${romData.length} bytes)`);
            showProgress(100);
            setStatus(initialized ? `ROM ready: ${romName}` :
                `ROM ready; starting emulator...`, 'ok');
            btnLoad.disabled = !initialized;
            window.setTimeout(hideProgress, 250);
        };
        reader.onerror = function () {
            hideProgress();
            setStatus('Failed to read file!', 'error');
            log('ERROR: FileReader failed');
        };
        reader.readAsArrayBuffer(file);
    });

    // ── WASM Module Loading ──────────────────────────────────────
    async function loadWasmModule() {
        await ensureCrossOriginIsolated();
        log('Loading azahar.js glue script...');
        setStatus('Loading WebAssembly module...');

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'azahar.js';
            // SDL2's Emscripten backend must use the UI canvas that already
            // exists in the page. Set this before loading the generated glue
            // script so it does not create an unbound canvas target.
            window.Module = window.Module || {};
            window.Module.canvas = canvas;
            // Keep native frontend/core diagnostics visible in the browser UI.
            // Emscripten invokes these hooks for stdout and stderr after the
            // generated runtime starts, which lets real-ROM testing expose
            // service/configuration failures instead of appearing as a
            // permanently black canvas.
            window.Module.print = function (message) {
                log(`[native] ${message}`);
            };
            window.Module.printErr = function (message) {
                log(`[native] ${message}`);
            };
            window.Module.setStatus = function (message) {
                if (message) {
                    showProgress(null);
                    setStatus(`WASM: ${message}`);
                }
            };
            script.onload = function () {
                // Emscripten-generated Module object
                if (typeof Module !== 'undefined') {
                    Module['onRuntimeInitialized'] = function () {
                        log('WebAssembly runtime initialized.');
                        wasmModule = Module;
                        setStatus('WASM ready. Starting emulator...', 'ok');
                        resolve(Module);
                    };
                    // In case it's already initialized
                    if (Module.calledRun) {
                        log('WebAssembly already initialized.');
                        wasmModule = Module;
                        setStatus('WASM ready. Starting emulator...', 'ok');
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
                            setStatus('WASM ready. Starting emulator...', 'ok');
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

    async function ensureCrossOriginIsolated() {
        if (window.crossOriginIsolated) {
            try { sessionStorage.removeItem('azahar-coi-reload'); } catch (_) {}
            return;
        }

        // GitHub Pages and other static hosts cannot set COOP/COEP headers.
        // The local service worker can add them after one controlled reload.
        const canUseServiceWorker = 'serviceWorker' in navigator &&
            (window.location.protocol === 'https:' ||
                window.location.hostname === 'localhost' ||
                window.location.hostname === '127.0.0.1');
        if (!canUseServiceWorker) {
            throw new Error('This server is missing COOP/COEP headers. Use serve_web.bat or HTTPS with coi-serviceworker.js.');
        }

        let attemptedReload = false;
        try { attemptedReload = sessionStorage.getItem('azahar-coi-reload') === '1'; } catch (_) {}
        if (attemptedReload) {
            throw new Error('Browser isolation is unavailable after reload. Serve web/ with COOP: same-origin and COEP: require-corp.');
        }

        try {
            try { sessionStorage.setItem('azahar-coi-reload', '1'); } catch (_) {}
            setStatus('Enabling threaded WebAssembly; reloading once...', 'ok');
            showProgress(null);
            await navigator.serviceWorker.register('coi-serviceworker.js', {scope: './'});
            await navigator.serviceWorker.ready;
            window.location.reload();
            await new Promise(() => {});
        } catch (error) {
            throw new Error(`Unable to enable browser isolation: ${error.message}`);
        }
    }

    // ── Initialize Emulator ──────────────────────────────────────
    async function initializeEmulator() {
        if (initialized || initializing) return;
        initializing = true;
        btnInit.disabled = true;
        showProgress(null);
        setStatus('Initializing emulator...');

        try {
            if (!wasmModule) await loadWasmModule();
            await yieldToBrowser();
            const result = wasmModule._azahar_init();
            if (result !== 0) {
                setStatus(`Init failed (code ${result})`, 'error');
                log(`ERROR: azahar_init returned ${result}`);
                btnInit.disabled = false;
                return;
            }
            initialized = true;
            log('Emulator initialized successfully.');
            hideProgress();
            setStatus('Emulator ready. Choose a ROM to load and run.', 'ok');
            if (romData) btnLoad.disabled = false;
        } catch (err) {
            hideProgress();
            setStatus(`Init error: ${err.message}`, 'error');
            log(`ERROR: ${err.message}`);
            btnInit.disabled = false;
        } finally {
            initializing = false;
        }
    }

    btnInit.addEventListener('click', function () {
        void initializeEmulator();
    });

    // ── Load ROM ─────────────────────────────────────────────────
    async function loadAndRunRom() {
        if (!initialized || (!romData && !romMounted)) {
            setStatus('Initialize emulator and select a ROM first.', 'error');
            return;
        }

        try {
            setStatus('Mounting ROM...');
            showProgress(null);
            btnLoad.disabled = true;
            await yieldToBrowser();

            // Write ROM to MEMFS so the C++ side can read it. Preserve the
            // selected extension because the native loader uses it as a
            // fallback for encrypted CIA containers.
            // A retail .3ds image can be 1 GiB.  The default MEMFS write
            // copies the FileReader buffer, briefly keeping two full browser
            // heap copies alive before the core begins loading it.  Let
            // MEMFS take ownership instead; the selected file can be chosen
            // again if the user needs to retry with another image.
            if (romData) {
                wasmModule.FS.writeFile(romPath, romData, {canOwn: true});
                romData = null;
                romMounted = true;
                log(`ROM written to MEMFS: ${romPath}`);
            }

            setStatus('Opening game...');
            await yieldToBrowser();
            const result = wasmModule.ccall('azahar_load_rom', 'number', ['string'], [romPath]);
            if (result === 0) {
                romLoaded = true;
                log('ROM loaded successfully!');
                hideProgress();
                btnStep.disabled = true;
                startRunning();
            } else if (result === -4) {
                hideProgress();
                setStatus('ROM is encrypted. Use a decrypted dump with your own keys.', 'error');
                log('ERROR: azahar_load_rom rejected an encrypted ROM');
                btnLoad.disabled = false;
            } else {
                hideProgress();
                setStatus(`ROM load failed (code ${result})`, 'error');
                log(`ERROR: azahar_load_rom returned ${result}`);
                btnLoad.disabled = false;
            }
        } catch (err) {
            hideProgress();
            setStatus(`Load error: ${err.message}`, 'error');
            log(`ERROR: ${err.message}`);
            btnLoad.disabled = false;
        }
    }

    btnLoad.addEventListener('click', function () {
        void loadAndRunRom();
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
    function updateBootStatus(now) {
        if (now < nextBootStatusAt) return;
        nextBootStatusAt = now + 500;
        if (!gameGraphicsDetected && wasmModule._azahar_framebuffer_nonblack_pixels) {
            gameGraphicsDetected = wasmModule._azahar_framebuffer_nonblack_pixels() > 0;
        }
        if (gameGraphicsDetected) {
            hideProgress();
            setStatus(`Running. Game graphics detected after ${((now - runStartedAt) / 1000).toFixed(1)}s`, 'ok');
        } else {
            showProgress(null);
            setStatus(`Booting game... ${((now - runStartedAt) / 1000).toFixed(1)}s (step ${frameCount})`, 'ok');
        }
    }

    function startRunning() {
        if (!romLoaded || running) return;

        running = true;
        runStartedAt = performance.now();
        nextBootStatusAt = runStartedAt;
        gameGraphicsDetected = false;
        btnRun.disabled = true;
        btnStop.disabled = false;
        btnStep.disabled = true;
        log('Starting run loop at display refresh rate...');
        showProgress(null);

        function tick(now) {
            if (!running) return;

            try {
                frameCount++;
                const result = wasmModule._azahar_step_frame();

                if (result === 0) {
                    updateCanvasFromWasm();
                    updateBootStatus(now);
                    runAnimationFrame = requestAnimationFrame(tick);
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

        requestAnimationFrame(tick);
    }

    btnRun.addEventListener('click', startRunning);

    btnStop.addEventListener('click', function () {
        stopRunning();
    });

    function stopRunning() {
        running = false;
        if (runAnimationFrame !== null) {
            cancelAnimationFrame(runAnimationFrame);
            runAnimationFrame = null;
        }
        hideProgress();
        btnRun.disabled = !romLoaded;
        btnStop.disabled = true;
        btnStep.disabled = !romLoaded;
        if (romLoaded) setStatus(`Stopped at step ${frameCount}`, '');
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
    showProgress(null);
    loadWasmModule().then(function () {
        return initializeEmulator();
    }).catch(function (err) {
        hideProgress();
        log(`WASM load failed: ${err.message}`);
        setStatus(`Failed to load WASM: ${err.message}. Ensure azahar.js and azahar.wasm are in the same directory.`, 'error');
        // Allow manual retry via Init button
        btnInit.disabled = false;
    });
})();
