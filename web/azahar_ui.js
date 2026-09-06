/**
 * Azahar Web UI — azahar_ui.js
 * Loads the Azahar WebAssembly module and provides the emulator UI.
 */

(function () {
    'use strict';

    // ── DOM refs ──────────────────────────────────────────────────
    const webConfig = window.AzaharWebConfig || {};
    const isWebGL2Artifact = webConfig.renderer === 'webgl2';
    const artifactName = webConfig.artifact || (isWebGL2Artifact ? 'azahar_webgl2' : 'azahar');
    const softwareFallbackUrl = webConfig.softwareFallbackUrl || 'index.html';
    const autoStart = new URLSearchParams(location.search).get('autostart') !== '0';
    const explicitWebGL2 = new URLSearchParams(location.search).get('renderer') === 'webgl2';
    const canvas = document.getElementById('canvas');
    // The startup presentation guard reads pixels until the first visible
    // game frame arrives.  Request a readback-oriented 2D context once,
    // before Emscripten initializes SDL's software canvas, rather than
    // repeatedly creating an unhinted context in the run loop.
    // A canvas can hold either a 2D or WebGL context, never both. The stable
    // page claims its 2D software canvas here; the separately bootstrapped
    // WebGL2 page intentionally leaves it untouched until SDL creates GLES 3.
    const canvas2dContext = isWebGL2Artifact ? null :
        canvas.getContext('2d', {willReadFrequently: true});
    const romInput = document.getElementById('rom-file');
    const fileLabel = document.getElementById('file-label');
    const btnLoad = document.getElementById('btn-load');
    const btnInit = document.getElementById('btn-init');
    const btnStep = document.getElementById('btn-step');
    const btnRun = document.getElementById('btn-run');
    const btnStop = document.getElementById('btn-stop');
    const statusEl = document.getElementById('status');
    const progressEl = document.getElementById('progress');
    const fpsEl = document.getElementById('fps');
    const logEl = document.getElementById('log');
    const rendererMode = document.getElementById('renderer-mode');
    const rendererModeHelp = document.getElementById('renderer-mode-help');

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
    let rendererGraphicsDetected = false;
    let gameGraphicsDetected = false;
    let lastFpsAt = 0;
    let lastFrameCount = 0;
    let displayFps = 0;
    let emulationSpeed = 0;

    // Renderer changes require a fresh document because a browser canvas may
    // own either a 2D or WebGL context, never both. Keep both builds behind a
    // single deployment page and make that required reload explicit.
    if (rendererMode) {
        const query = new URLSearchParams(location.search);
        rendererMode.value = query.get('renderer') || 'auto';
        if (!rendererMode.options[rendererMode.selectedIndex]) rendererMode.value = 'auto';
        rendererModeHelp.textContent = isWebGL2Artifact ?
            'Active: accelerated WebGL2. Auto falls back if this GPU path is incompatible.' :
            `Active: compatibility renderer${query.has('webgl2-fallback') ? ' (automatic fallback)' : ''}.`;
        rendererMode.addEventListener('change', () => {
            const destination = new URL('index.html', location.href);
            if (rendererMode.value !== 'auto') {
                destination.searchParams.set('renderer', rendererMode.value);
            }
            if (!autoStart) destination.searchParams.set('autostart', '0');
            location.assign(destination.toString());
        });
    }

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

    let softwareFallbackStarted = false;

    function restartInSoftware(reason) {
        if (!isWebGL2Artifact || softwareFallbackStarted) return;
        softwareFallbackStarted = true;
        log(`WebGL2 fallback: ${reason}`);
        setStatus(`WebGL2 unavailable (${reason}). Restarting in software...`, 'error');
        const destination = new URL(softwareFallbackUrl, window.location.href);
        const currentUrl = new URL(window.location.href);
        // Preserve harness/user-flow controls across the fresh-document
        // renderer switch. In particular, losing autostart=0 would begin
        // execution while an uploaded save state is still being installed.
        for (const name of ['autostart']) {
            if (currentUrl.searchParams.has(name)) {
                destination.searchParams.set(name, currentUrl.searchParams.get(name));
            }
        }
        destination.searchParams.set('webgl2-fallback', '1');
        // Preserve the precise preflight/native failure across the required
        // fresh-document fallback. This makes automated backend gates
        // diagnostic without weakening the user-facing recovery path.
        destination.searchParams.set('webgl2-fallback-reason', reason);
        window.setTimeout(() => window.location.replace(destination.toString()), 0);
    }

    function compileWebGL2Probe(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
        const logText = gl.getShaderInfoLog(shader) || '';
        gl.deleteShader(shader);
        return {ok, logText};
    }

    // Validate the exact baseline used by RendererWebGL2 on an isolated probe
    // canvas. This does not touch #canvas, preserving the fresh-session
    // software fallback if context or shader creation fails.
    function preflightWebGL2() {
        if (!isWebGL2Artifact) return true;
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2', {
            alpha: false, antialias: false, depth: true, stencil: true,
        });
        if (!gl) {
            restartInSoftware('WebGL2 context creation failed');
            return false;
        }
        const debugRenderer = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = debugRenderer ?
            gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL) : '';
        log(`WebGL2 adapter: ${renderer || 'masked/unknown'}`);
        // ANGLE/D3D11 can spend about a minute synchronously translating the
        // generated PICA vertex shaders. Keep the WebGL2 rasterizer and select
        // its CPU-vertex path instead; this reaches gameplay in a few seconds
        // and is faster than the full software renderer. Vulkan/native GL keep
        // hardware vertices. `?hwShader=1` remains a diagnostic override.
        const requestedMode = new URLSearchParams(location.search);
        if (requestedMode.get('hwShader') !== '1' && /(?:direct3d|d3d11)/i.test(renderer)) {
            const compatibleUrl = new URL(location.href);
            compatibleUrl.searchParams.set('hwShader', '0');
            history.replaceState(null, '', compatibleUrl);
            log('ANGLE/D3D11 detected: using WebGL2 with CPU vertex translation.');
            if (rendererModeHelp) {
                rendererModeHelp.textContent =
                    'Active: WebGL2 with the D3D11-compatible CPU vertex path.';
            }
        }
        const vertex = compileWebGL2Probe(gl, gl.VERTEX_SHADER, `#version 300 es
precision highp float;
layout(location = 0) in vec2 vert_position;
void main() { gl_Position = vec4(vert_position, 0.0, 1.0); }`);
        const fragment = compileWebGL2Probe(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
out vec4 frag_color;
void main() { frag_color = vec4(1.0); }`);
        if (!vertex.ok || !fragment.ok) {
            restartInSoftware(`GLSL ES 3.00 shader preflight failed: ${vertex.logText || fragment.logText}`);
            return false;
        }

        // Context loss cannot safely become a 2D session in this document.
        // Navigate before title loading so the stable page gets a new canvas.
        canvas.addEventListener('webglcontextlost', event => {
            event.preventDefault();
            restartInSoftware('WebGL2 context lost');
        }, {once: true});
        return true;
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
        if (!preflightWebGL2()) {
            // restartInSoftware has scheduled a navigation to a fresh canvas.
            return new Promise(() => {});
        }
        log(`Loading ${artifactName}.js glue script...`);
        setStatus('Loading WebAssembly module...');

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = `${artifactName}.js`;
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
                if (isWebGL2Artifact && result === -7) {
                    restartInSoftware('native WebGL2 context setup failed');
                    return;
                }
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
                if (autoStart) {
                    btnStep.disabled = true;
                    startRunning();
                } else {
                    btnStep.disabled = false;
                    btnRun.disabled = false;
                    setStatus('ROM loaded successfully. Ready to run.', 'ok');
                }
            } else if (isWebGL2Artifact && result === -7) {
                hideProgress();
                restartInSoftware('native GLSL ES 3.00 setup failed');
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
    function visibleCanvasPixels() {
        if (canvas2dContext) {
            return canvas2dContext.getImageData(0, 0, canvas.width, canvas.height).data;
        }
        // This runs only after the WebGL2 renderer has claimed the canvas.
        // Asking for its existing context is safe; creating a 2D context here
        // would make the experimental fallback contract impossible.
        const gl = canvas.getContext('webgl2');
        if (!gl) return null;
        try {
            const pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            return pixels;
        } catch (_) {
            return null;
        }
    }

    function updateBootStatus(now) {
        if (now < nextBootStatusAt) return;
        nextBootStatusAt = now + 500;
        if (!rendererGraphicsDetected && wasmModule._azahar_framebuffer_nonblack_pixels) {
            const framebufferPixels = wasmModule._azahar_framebuffer_nonblack_pixels();
            // WebGL2 can keep the framebuffer GPU-resident, so it deliberately
            // reports -2 rather than exposing an unsynchronized CPU vector.
            // Continue to the existing compositor readback gate in that case.
            rendererGraphicsDetected = framebufferPixels > 0 ||
                (isWebGL2Artifact && framebufferPixels === -2);
        }
        if (rendererGraphicsDetected && !gameGraphicsDetected) {
            // A non-black software framebuffer proves only that emulation and
            // rasterization work. Confirm that those pixels arrived at the
            // visible UI canvas before reporting graphics as detected.
            const data = visibleCanvasPixels();
            if (data) {
                const colors = new Set();
                let nonBlackSamples = 0;
                for (let index = 0; index < data.length; index += 64) {
                    const red = data[index];
                    const green = data[index + 1];
                    const blue = data[index + 2];
                    if (red || green || blue) {
                        nonBlackSamples++;
                        colors.add(`${red},${green},${blue}`);
                    }
                }
                gameGraphicsDetected = nonBlackSamples >= 16 && colors.size >= 2;
            }
        }
        if (gameGraphicsDetected) {
            hideProgress();
            setStatus(`Running. Visible game graphics detected after ${((now - runStartedAt) / 1000).toFixed(1)}s`, 'ok');
        } else if (rendererGraphicsDetected) {
            // A context and shader preflight are not enough: an experimental
            // backend can still fail to put its drawing buffer on the browser
            // compositor. Recover into the stable artifact rather than
            // leaving the user at a black screen.
            const presentationTimeout = explicitWebGL2 ? 90000 : 10000;
            if (isWebGL2Artifact && now - runStartedAt >= presentationTimeout) {
                restartInSoftware('WebGL2 presentation produced no visible frame');
                return;
            }
            showProgress(null);
            setStatus(`Renderer graphics ready; waiting for canvas presentation... ${((now - runStartedAt) / 1000).toFixed(1)}s`, 'ok');
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
        rendererGraphicsDetected = false;
        gameGraphicsDetected = false;
        lastFpsAt = 0;
        lastFrameCount = 0;
        displayFps = 0;
        emulationSpeed = 0;
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
                    // Update FPS meter every ~500 ms
                    if (now - lastFpsAt >= 500) {
                        if (lastFpsAt > 0) {
                            displayFps = (frameCount - lastFrameCount) /
                                ((now - lastFpsAt) / 1000);
                        }
                        lastFpsAt = now;
                        lastFrameCount = frameCount;
                        // Pull emulation speed from the C++ perf counters
                        if (wasmModule._azahar_get_perf_stats) {
                            var buf = wasmModule._malloc(64); // 8 × f64
                            if (wasmModule._azahar_get_perf_stats(buf, 8) === 0) {
                                emulationSpeed = new Float64Array(
                                    wasmModule.HEAPU8.buffer, buf, 8)[2] * 100;
                            }
                            wasmModule._free(buf);
                        }
                        if (displayFps > 0) {
                            fpsEl.textContent = displayFps.toFixed(0) + ' FPS' +
                                (emulationSpeed > 0 ? ' | ' + emulationSpeed.toFixed(0) + '% speed' : '');
                        }
                    }
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
        fpsEl.textContent = '';
        btnRun.disabled = !romLoaded;
        btnStop.disabled = true;
        btnStep.disabled = !romLoaded;
        if (romLoaded) setStatus(`Stopped at step ${frameCount}`, '');
    }

    // ── Canvas Update ────────────────────────────────────────────
    function updateCanvasFromWasm() {
        if (isWebGL2Artifact || !canvas2dContext) {
            // RendererWebGL2 draws directly to Module.canvas. A 2D blit would
            // either fail or attempt to claim the already-WebGL canvas.
            return;
        }
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
            canvas2dContext.drawImage(srcCanvas, 0, 0, canvas.width, canvas.height);
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
        setStatus(`Failed to load WASM: ${err.message}. Ensure ${artifactName}.js and ${artifactName}.wasm are in the same directory.`, 'error');
        // Allow manual retry via Init button
        btnInit.disabled = false;
    });
})();
