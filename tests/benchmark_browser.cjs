/**
 * Azahar WebAssembly Browser Benchmark (tests/benchmark_browser.cjs)
 *
 * Runs the WASM emulator benchmark in Chrome via Puppeteer.
 * Required because the Emscripten pthreads build needs a browser environment
 * (SharedArrayBuffer, Web Workers) that raw Node.js cannot provide.
 *
 * Usage:
 *   node tests/benchmark_browser.cjs [--artifact software|webgl2] [--duration-seconds N] [--warmup-seconds N] [--rom PATH] [--state PATH] [--output PATH]
 *
 * Options:
 *   --duration-seconds N Benchmark duration after the title-screen warmup (default: 15)
 *   --warmup-seconds N   Warmup duration before measuring (default: 30)
 *   --rom PATH    ROM file path (default: first .3ds/.3dsx/.cia in test_games/)
 *   --state PATH  Local .cst fixture to restore after ROM load; measures real gameplay rather than boot/title
 *   --artifact KIND  Test the stable software or experimental WebGL2 artifact (default: software)
 *   --output PATH JSON output path (default: tests/benchmark_results.json)
 *   --repeat N    Repeat the benchmark N times (default: 3)
 *   --profile     Sample perf counters every ~1s during benchmark
 *   --interactive Run in a visible Chrome window for real-display validation
 *   --manual-start (interactive only) run until F8/click after reaching gameplay, then sample
 *
 * Environment:
 *   CHROME_PATH   Path to Chrome/Chromium executable
 *   AZAHAR_PUPPETEER_MODULE  Puppeteer module to require (default: puppeteer-core)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const { createWebServer } = require('../web/server.cjs');

// ── CLI argument parsing ──────────────────────────────────────────
const argv = require('process').argv.slice(2);
function argVal(flag, fallback) {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
function argFlag(flag) { return argv.includes(flag); }

// rAF is intentionally used for both phases. Durations, rather than frame
// counts, are essential here: at 3 FPS a 1,800-frame warmup would take ten
// minutes and measure a different workload from a 30-second title-screen run.
const BENCH_SECONDS = Number(argVal('--duration-seconds', '15'));
const WARMUP_SECONDS = Number(argVal('--warmup-seconds', '30'));
const ROM_ARG = argVal('--rom', null);
const STATE_ARG = argVal('--state', null);
const ARTIFACT = argVal('--artifact', 'software');
const OUTPUT_PATH = argVal('--output', path.join(__dirname, 'benchmark_results.json'));
const REPEAT = Number(argVal('--repeat', '3'));
const PROFILE = argFlag('--profile');
const INTERACTIVE = argFlag('--interactive');
const MANUAL_START = argFlag('--manual-start');

if (!['software', 'webgl2'].includes(ARTIFACT)) {
    throw new Error('Usage: --artifact software|webgl2');
}

const root = path.resolve(__dirname, '..');
const testGamesDir = path.join(root, 'test_games');

// ── ROM discovery ─────────────────────────────────────────────────
function findRom() {
    if (ROM_ARG && fs.existsSync(ROM_ARG)) return ROM_ARG;
    if (ROM_ARG) throw new Error(`ROM not found: ${ROM_ARG}`);
    try {
        const entries = fs.readdirSync(testGamesDir);
        for (const ext of ['.3dsx', '.3ds', '.cia', '.elf', '.cci', '.cxi', '.app']) {
            const match = entries.find(e => e.toLowerCase().endsWith(ext));
            if (match) return path.join(testGamesDir, match);
        }
    } catch (_) {}
    throw new Error('No ROM found. Place a .3ds/.cia/.3dsx file in test_games/ or use --rom');
}

// ── Combined server: web/ + ROM endpoint ──────────────────────────
function createBenchServer(romPath, statePath) {
    const webServer = createWebServer(path.join(root, 'web'));
    const romBuffer = fs.readFileSync(romPath);
    const romName = path.basename(romPath);
    const stateBuffer = statePath ? fs.readFileSync(statePath) : null;
    const stateName = statePath ? path.basename(statePath) : null;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/bench_rom') {
            // Serve the ROM file for fetch() from the browser
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': romBuffer.length,
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Resource-Policy': 'cross-origin',
                'Cache-Control': 'no-store',
            });
            res.end(romBuffer);
            return;
        }
        if (url.pathname === '/bench_state' && stateBuffer) {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': stateBuffer.length,
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Resource-Policy': 'cross-origin',
                'Cache-Control': 'no-store',
            });
            res.end(stateBuffer);
            return;
        }
        // Delegate everything else to the web server
        webServer.emit('request', req, res);
    });

    return { server, romName, stateName };
}

// ── Benchmark script (runs inside page.evaluate) ──────────────────
async function runBenchInPage(page, romExt, benchSeconds, warmupSeconds, enableProfile, manualStart,
    stateName, artifact) {
    // Disable the 30s default evaluate timeout — ROM load + warmup + benchmark
    // may run in a single rAF-driven loop that spans tens of seconds.
    page.setDefaultTimeout(0);
    return await page.evaluate(async ({
        romExt_, benchSeconds_, warmupSeconds_, enableProfile_, manualStart_, stateName_, artifact_
    }) => {
        const perf = performance;
        const Module = window.Module;
        const memfsPath = '/benchmark' + romExt_;

        // Fetch ROM from the server
        const response = await fetch('/bench_rom');
        if (!response.ok) throw new Error('Failed to fetch ROM: ' + response.status);
        const romBytes = new Uint8Array(await response.arrayBuffer());

        function readPerfStats() {
            if (!Module._azahar_get_perf_stats) return null;
            const buf = Module._malloc(64);
            let stats = null;
            if (Module._azahar_get_perf_stats(buf, 8) === 0) {
                const v = new Float64Array(Module.HEAPU8.buffer, buf, 8);
                stats = {
                    gameFps: v[0], systemFps: v[1], emulationSpeed: v[2],
                    timeGpu: v[3], timeSwap: v[4], timeVblank: v[5],
                    meanFrametime: v[6], frameLimitPct: v[7],
                };
            }
            Module._free(buf);
            return stats;
        }

        function readRendererStats() {
            if (!Module._azahar_get_renderer_stats) return null;
            const rendererStatsCount = 67; // 24 stable + 32 profile + 10 bridge diag + 1 gl error
            const buf = Module._malloc(rendererStatsCount * 8);
            let stats = null;
            if (Module._azahar_get_renderer_stats(buf, rendererStatsCount) === 0) {
                const v = new Float64Array(Module.HEAPU8.buffer, buf, rendererStatsCount);
                stats = {
                    rendererKind: v[0], picaStage: v[1], acceleratedDrawBatches: v[2],
                    hardwareDrawAttempts: v[3], softwareDrawBatches: v[4],
                    softwareTriangles: v[5], indexedDrawAttempts: v[6],
                    displayTransferAttempts: v[7], textureCopyAttempts: v[8], fillAttempts: v[9],
                    cpuVertexCandidateBatches: v[10], cpuVertexCandidateTriangles: v[11],
                    cpuVertexRejectedBatches: v[12], cpuVertexBridgeFailures: v[13],
                    cpuVertexRejectionMask: v[14],
                    cpuVertexFramebufferRejects: v[15], cpuVertexOutputMergerRejects: v[16],
                    cpuVertexTexturingRejects: v[17], cpuVertexRasterizerRejects: v[18],
                    cpuVertexPipelineRejects: v[19], cpuVertexProfileVertices: v[20],
                    cpuVertexProfileMaxVertices: v[21], cpuVertexModalRejectMask: v[22],
                    cpuVertexModalRejectBatches: v[23],
                    cpuVertexProfileFeatures: Array.from(v.slice(24, 56)),
                    cpuVertexBridgeFailObjects: v[56], cpuVertexBridgeFailMemory: v[57],
                    cpuVertexBridgeFailSurface: v[58], cpuVertexBridgeFailTexture: v[59],
                    cpuVertexBridgeFailGlError: v[60], cpuVertexBridgeSuccess: v[61],
                    cpuVertexBridgeLastGlError: v[62],
                    cpuVertexBridgeFailPreDraw: v[63],
                    cpuVertexBridgeFailFbo: v[64],
                    cpuVertexBridgeLastVertexCount: v[65],
                    cpuVertexBridgeFailStep: v[66],
                };
            }
            Module._free(buf);
            return stats;
        }

        function presentToUiCanvas() {
            // The WebGL2 artifact owns #canvas. Never acquire a 2D context
            // there, even if a future SDL integration changes Module.canvas.
            if (artifact_ === 'webgl2') return;
            const target = document.querySelector('#canvas');
            if (!target || !Module.canvas || Module.canvas === target) return;
            target.getContext('2d').drawImage(Module.canvas, 0, 0, target.width, target.height);
        }

        async function readCanvasSceneStats() {
            const canvas = document.querySelector('#canvas');
            if (!canvas?.width || !canvas?.height) return null;
            // Sampling is done through a detached 2D canvas. In particular,
            // do not call getContext('2d') on the WebGL2 production canvas:
            // a context claim would invalidate the backend under test.
            const sample = document.createElement('canvas');
            sample.width = canvas.width;
            sample.height = canvas.height;
            const context = sample.getContext('2d', {willReadFrequently: true});
            if (!context) return null;
            let bitmap = null;
            try {
                if (typeof createImageBitmap === 'function') {
                    bitmap = await createImageBitmap(canvas);
                    context.drawImage(bitmap, 0, 0);
                } else {
                    context.drawImage(canvas, 0, 0);
                }
            } catch (_) {
                // Some browsers reject createImageBitmap for a live WebGL
                // canvas. Drawing it as a source still leaves the production
                // context untouched, so use that compatible fallback.
                context.drawImage(canvas, 0, 0);
            } finally {
                bitmap?.close?.();
            }
            const data = context.getImageData(0, 0, sample.width, sample.height).data;
            let samples = 0;
            let nonBlack = 0;
            let colorful = 0;
            for (let i = 0; i < data.length; i += 64) {
                const r = data[i], g = data[i + 1], b = data[i + 2];
                const high = Math.max(r, g, b);
                if (high > 8) nonBlack++;
                if (high - Math.min(r, g, b) > 24) colorful++;
                samples++;
            }
            return {samples, nonBlackCoverage: nonBlack / samples,
                colorfulCoverage: colorful / samples,
                rendererNonblackPixels: Module._azahar_framebuffer_nonblack_pixels?.() ?? -1,
                rendererStats: readRendererStats()};
        }

        async function restoreState() {
            // The web frontend stores per-user states here.  The file name encodes
            // the title id and slot, and the core performs validation while loading.
            const response = await fetch('/bench_state');
            if (!response.ok) throw new Error('Failed to fetch savestate: ' + response.status);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const stateDir = '/home/web_user/.local/share/azahar-emu/states';
            Module.FS.mkdirTree(stateDir);
            Module.FS.writeFile(`${stateDir}/${stateName_}`, bytes, {canOwn: false});
            const request = Module._azahar_load_state(1);
            if (request !== 0) throw new Error(`azahar_load_state rejected slot 1: ${request}`);
            // SendSignal is consumed by the emulation loop.  Give the restored
            // scene a short, unmeasured settle window before collecting samples.
            const settle = await runForDuration(3, false);
            Module._azahar_reset_renderer_stats?.();
            const visual = await readCanvasSceneStats();
            if (!visual || visual.nonBlackCoverage < 0.03 || visual.colorfulCoverage < 0.005) {
                throw new Error(`Restored state did not produce a rendered game scene: ${JSON.stringify(visual)}`);
            }
            return {...settle, visual};
        }

        // Execute through the same browser refresh loop and canvas-copy path
        // as the UI. A synchronous WASM loop measures neither real browser
        // pacing nor the presentation work users experience.
        function runForDuration(seconds, samplePerf) {
            return new Promise((resolve, reject) => {
                const perFrame = [];
                const samples = [];
                let previousTick = null;
                let nextSampleAt = 0;
                const startedAt = perf.now();

                function finish() {
                    const sorted = perFrame.slice().sort((a, b) => a - b);
                    const sum = perFrame.reduce((a, b) => a + b, 0);
                    const len = perFrame.length;
                    const avg = len ? sum / len : 0;
                    const variance = len ? perFrame.reduce((s, v) => s + (v - avg) ** 2, 0) / len : 0;
                    const elapsedMs = perf.now() - startedAt;
                    resolve({
                        count: len, sum, elapsedMs,
                        // callback FPS is the browser-visible delivery rate;
                        // callback work is reported separately from it.
                        fps: len ? len * 1000 / elapsedMs : 0,
                        avg, stddev: Math.sqrt(variance),
                        min: sorted[0] || 0, max: sorted[len - 1] || 0,
                        p50: sorted[Math.floor(len * 0.50)] || 0,
                        p95: sorted[Math.floor(len * 0.95)] || 0,
                        p99: sorted[Math.floor(len * 0.99)] || 0,
                        p999: sorted[Math.floor(len * 0.999)] || 0,
                        perFrame, samples,
                    });
                }

                function tick(timestamp) {
                    try {
                        const t0 = perf.now();
                        const result = Module._azahar_step_frame();
                        presentToUiCanvas();
                        perFrame.push(perf.now() - t0);
                        if (samplePerf && timestamp >= nextSampleAt) {
                            samples.push({frame: perFrame.length, elapsedMs: timestamp - startedAt,
                                perf: readPerfStats(), renderer: readRendererStats()});
                            nextSampleAt = timestamp + 1000;
                        }
                        previousTick = timestamp;
                        if (result !== 0 && result !== 1) {
                            reject(new Error(`step_frame returned ${result} at ${perFrame.length}`));
                        } else if (result === 1 || timestamp - startedAt >= seconds * 1000) {
                            finish();
                        } else {
                            requestAnimationFrame(tick);
                        }
                    } catch (err) {
                        reject(new Error(`step_frame threw at frame ${perFrame.length}: ${err.message || err}`));
                    }
                }
                requestAnimationFrame(tick);
            });
        }

        // A game-specific scene cannot be inferred reliably from a generic
        // splash/title framebuffer. In manual mode keep emulation running
        // until the tester reaches real gameplay and explicitly starts the
        // sample. F8 is deliberately not a default 3DS control binding.
        function runUntilManualStart() {
            return new Promise((resolve, reject) => {
                const control = document.createElement('button');
                control.id = 'azahar-benchmark-start';
                control.textContent = 'Gameplay ready — start measured sample';
                Object.assign(control.style, {
                    position: 'fixed', right: '16px', bottom: '16px', zIndex: 10000,
                    padding: '10px', background: '#e94560', color: 'white', border: '0',
                    borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer',
                });
                document.body.append(control);
                let started = false;
                const start = () => { started = true; };
                control.addEventListener('click', start, {once: true});
                window.addEventListener('keydown', event => {
                    if (event.code === 'F8') start();
                });
                const tick = () => {
                    try {
                        const result = Module._azahar_step_frame();
                        presentToUiCanvas();
                        if (result !== 0 && result !== 1) {
                            control.remove();
                            reject(new Error(`step_frame returned ${result} before manual start`));
                        } else if (result === 1) {
                            control.remove();
                            reject(new Error('emulation ended before manual start'));
                        } else if (started) {
                            control.remove();
                            resolve();
                        } else {
                            requestAnimationFrame(tick);
                        }
                    } catch (err) {
                        control.remove();
                        reject(new Error(`step_frame threw before manual start: ${err.message || err}`));
                    }
                };
                requestAnimationFrame(tick);
            });
        }

        const runs = [];
        for (let rep = 0; rep < 1; rep++) {
            // Init
            const t0 = perf.now();
            if (Module._azahar_init() !== 0) throw new Error('azahar_init failed');
            const initMs = perf.now() - t0;

            // Write ROM to MEMFS
            Module.FS.writeFile(memfsPath, romBytes, { canOwn: false });
            const heapAfterWrite = Module.HEAPU8 ? Module.HEAPU8.length : 0;

            // Load ROM using ccall for proper string → C pointer marshaling
            const t1 = perf.now();
            const loadResult = Module.ccall('azahar_load_rom', 'number', ['string'], [memfsPath]);
            if (loadResult !== 0) throw new Error(`azahar_load_rom returned ${loadResult}`);
            const loadMs = perf.now() - t1;

            // Warmup
            let warmupStats = null;
            let restoreStats = null;
            if (stateName_) {
                restoreStats = await restoreState();
            } else if (manualStart_) {
                await runUntilManualStart();
            } else if (warmupSeconds_ > 0) {
                warmupStats = await runForDuration(warmupSeconds_, false);
            }

            // Benchmark the sustained post-warmup browser path.
            const bench = await runForDuration(benchSeconds_, enableProfile_);
            const perfStats = readPerfStats();
            const rendererStats = readRendererStats();
            const heapAfter = Module.HEAPU8 ? Module.HEAPU8.length : 0;

            Module._azahar_shutdown();

            runs.push({
                run: rep + 1,
                initMs, loadMs,
                restoredState: stateName_ || null,
                restore: restoreStats ? { avg: restoreStats.avg, fps: restoreStats.fps,
                    p50: restoreStats.p50, p95: restoreStats.p95, visual: restoreStats.visual } : null,
                heapInit: heapAfterWrite,
                heapAfter,
                warmup: warmupStats ? { avg: warmupStats.avg, fps: warmupStats.fps, p50: warmupStats.p50, p95: warmupStats.p95 } : null,
                bench: {
                    avg: bench.avg, fps: bench.fps, stddev: bench.stddev,
                    min: bench.min, max: bench.max,
                    p50: bench.p50, p95: bench.p95, p99: bench.p99, p999: bench.p999,
                    perFrame: bench.perFrame,
                },
                perfStats,
                rendererStats,
                profileSamples: bench.samples,
            });
        }
        return runs;
    }, {
        romExt_: path.extname(findRom()).toLowerCase() || '.bin',
        benchSeconds_: benchSeconds,
        warmupSeconds_: warmupSeconds,
        enableProfile_: enableProfile,
        manualStart_: manualStart,
        stateName_: stateName,
        artifact_: artifact,
    });
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
    const romPath = findRom();
    if (STATE_ARG && !fs.existsSync(STATE_ARG)) throw new Error(`Savestate not found: ${STATE_ARG}`);
    if (STATE_ARG && path.extname(STATE_ARG).toLowerCase() !== '.cst') {
        throw new Error(`Savestate must be a .cst file: ${STATE_ARG}`);
    }
    const romSizeMB = (fs.statSync(romPath).size / 1024 / 1024).toFixed(1);

    console.log(`# Azahar Web Benchmark (browser)`);
    console.log(`# ROM: ${path.basename(romPath)} (${romSizeMB} MB)`);
    console.log(`# Duration: ${BENCH_SECONDS}s  Warmup: ${WARMUP_SECONDS}s  Repeats: ${REPEAT}`);
    console.log(`# Mode: ${INTERACTIVE ? 'interactive browser' : 'headless diagnostic'}`);
    console.log(`# Start: ${MANUAL_START ? 'manual gameplay marker (F8/click)' : 'timed warmup'}`);
    console.log(`# State: ${STATE_ARG ? path.basename(STATE_ARG) : 'none (boot/title path)'}`);
    console.log(`# Artifact: ${ARTIFACT}`);
    console.log(`# Profile: ${PROFILE ? 'on' : 'off'}`);
    console.log(`# Started: ${new Date().toISOString()}`);
    console.log('');

    // Start the combined web + ROM server
    const { server, romName, stateName } = createBenchServer(romPath, STATE_ARG);
    const romExt = path.extname(romPath).toLowerCase() || '.bin';
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    const addr = server.address();
    const pageName = ARTIFACT === 'webgl2' ? 'index_webgl2.html' : 'index.html';
    const webUrl = `http://127.0.0.1:${addr.port}/${pageName}`;
    console.log(`   Server: ${webUrl}`);

    // Launch browser
    const browser = await puppeteer.launch({
        // Headless measurements are useful for repeatability but are not a
        // substitute for the actual visible browser. Use --interactive when
        // comparing against user-observed frame rates.
        headless: INTERACTIVE ? false : 'new',
        executablePath: "/Program Files/Google/Chrome/Application/chrome.exe",
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: { width: 1280, height: 900 },
        // The evaluate() call wraps init + ROM load + warmup + benchmark
        // inside a single Promise, so the protocol timeout must cover the
        // full wall-clock duration (25 s + overhead).
        protocolTimeout: 120000,
    });

    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
            consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
        }
    });

    const allRuns = [];

    try {
        if (MANUAL_START && !INTERACTIVE) {
            throw new Error('--manual-start requires --interactive');
        }
        // Navigate and wait for WASM + emulator to be ready
        console.log('Loading page and initializing WASM...');
        await page.goto(webUrl, { waitUntil: 'networkidle0', timeout: 120000 });

        await page.waitForFunction(() => {
            const status = document.querySelector('#status');
            return status && (
                status.textContent.includes('Emulator ready') ||
                status.textContent.includes('ROM ready')
            );
        }, { timeout: 120000 });
        console.log('   WASM and emulator ready.');

        const environment = await page.evaluate(() => ({
            userAgent: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency,
            devicePixelRatio: window.devicePixelRatio,
            viewport: {width: innerWidth, height: innerHeight},
            crossOriginIsolated,
        }));
        console.log(`   Browser: ${environment.hardwareConcurrency || 'unknown'} logical CPUs, `
            + `${environment.viewport.width}x${environment.viewport.height}, DPR ${environment.devicePixelRatio}`);

        // Verify Module access
        const hasModule = await page.evaluate(() => {
            return typeof Module !== 'undefined' && !!Module._azahar_init;
        });
        if (!hasModule) throw new Error('Module._azahar_init not available');

        // Shut down the UI's auto-initialized emulator so we control init/load
        await page.evaluate(() => { if (Module._azahar_shutdown) Module._azahar_shutdown(); });

        // Run benchmarks.  Reload the page for each repeat so the WASM
        // module and emulator start from a clean state.
        for (let rep = 0; rep < REPEAT; rep++) {
            console.log(`\n## Run ${rep + 1}/${REPEAT}`);

            if (rep > 0) {
                // Reload the page for a fresh WASM context
                await page.goto(webUrl, { waitUntil: 'networkidle0', timeout: 120000 });
                await page.waitForFunction(() => {
                    const status = document.querySelector('#status');
                    return status && (
                        status.textContent.includes('Emulator ready') ||
                        status.textContent.includes('ROM ready')
                    );
                }, { timeout: 120000 });
                await page.evaluate(() => { if (Module._azahar_shutdown) Module._azahar_shutdown(); });
            }

            const runs = await runBenchInPage(page, romExt, BENCH_SECONDS, WARMUP_SECONDS, PROFILE,
                MANUAL_START, stateName, ARTIFACT);

            for (const run of runs) {
                const b = run.bench;
                console.log(`   Init: ${run.initMs.toFixed(0)}ms  Load: ${run.loadMs.toFixed(0)}ms`);
                if (run.warmup) {
                    console.log(`   Warmup: avg ${run.warmup.avg.toFixed(2)}ms/frame`);
                }
                if (run.restore) {
                    console.log(`   State restore settle: avg ${run.restore.avg.toFixed(2)}ms/frame`);
                    console.log(`   Restored scene: nonblack ${(run.restore.visual.nonBlackCoverage * 100).toFixed(1)}% `
                        + `colorful ${(run.restore.visual.colorfulCoverage * 100).toFixed(1)}% `
                        + `renderer=${run.restore.visual.rendererNonblackPixels}`);
                }
                console.log(`   Browser rAF: avg ${b.avg.toFixed(2)}ms/callback, `
                    + `${b.fps.toFixed(1)} callbacks/s`);
                console.log(`   Stats: p50=${b.p50.toFixed(2)}ms p95=${b.p95.toFixed(2)}ms `
                    + `p99=${b.p99.toFixed(2)}ms σ=${b.stddev.toFixed(2)}ms `
                    + `min=${b.min.toFixed(2)}ms max=${b.max.toFixed(2)}ms`);
                if (run.perfStats) {
                    const ps = run.perfStats;
                    console.log(`   Native: game_fps=${ps.gameFps.toFixed(1)} `
                        + `speed=${(ps.emulationSpeed * 100).toFixed(0)}% `
                        + `gpu=${(ps.timeGpu * 1000).toFixed(2)}ms `
                        + `swap=${(ps.timeSwap * 1000).toFixed(2)}ms`);
                }
                if (run.rendererStats?.rendererKind === 1) {
                    const rs = run.rendererStats;
                    console.log(`   WebGL2 PICA: stage=${rs.picaStage} accelerated=`
                        + `${rs.acceleratedDrawBatches}/${rs.hardwareDrawAttempts} attempted `
                        + `software_batches=${rs.softwareDrawBatches} `
                        + `triangles=${rs.softwareTriangles} `
                        + `cpu_vertex_candidates=${rs.cpuVertexCandidateBatches} `
                        + `rejected=${rs.cpuVertexRejectedBatches} `
                        + `bridge_failures=${rs.cpuVertexBridgeFailures}`);
                    console.log(`   Bridge fail: objects=${rs.cpuVertexBridgeFailObjects} `
                        + `mem=${rs.cpuVertexBridgeFailMemory} `
                        + `surf=${rs.cpuVertexBridgeFailSurface} `
                        + `tex=${rs.cpuVertexBridgeFailTexture} `
                        + `pre_draw=${rs.cpuVertexBridgeFailPreDraw} `
                        + `fbo_incomplete=${rs.cpuVertexBridgeFailFbo} `
                        + `gl=${rs.cpuVertexBridgeFailGlError} `
                        + `success=${rs.cpuVertexBridgeSuccess} `
                        + `gl_code=0x${rs.cpuVertexBridgeLastGlError.toString(16)}`
                        + ` last_vcount=${rs.cpuVertexBridgeLastVertexCount}`);
                    console.log(`   Reject bits: FB=${rs.cpuVertexFramebufferRejects} `
                        + `OM=${rs.cpuVertexOutputMergerRejects} `
                        + `TEX=${rs.cpuVertexTexturingRejects} `
                        + `RAST=${rs.cpuVertexRasterizerRejects} `
                        + `PIPE=${rs.cpuVertexPipelineRejects} `
                        + `mask=0x${rs.cpuVertexRejectionMask.toString(16)}`
                        + ` modal_mask=0x${rs.cpuVertexModalRejectMask.toString(16)}`
                        + ` modal_batches=${rs.cpuVertexModalRejectBatches}`);
                    // Profile feature counters for TEV modes
                    if (rs.cpuVertexProfileFeatures && rs.cpuVertexProfileFeatures.length >= 32) {
                        const pf = rs.cpuVertexProfileFeatures;
                        console.log(`   Profile: FragLightOff=${pf[15]} LightOff=${pf[16]} `
                            + `FogOff=${pf[17]} PrimTev=${pf[18]} `
                            + `Tex0Rep=${pf[19]} Tex0Mod=${pf[20]} `
                            + `BlendOff=${pf[5]} AlphaTestOff=${pf[7]} `
                            + `DepthOff=${pf[9]} DepthWriteOff=${pf[10]} `
                            + `ScissorOff=${pf[23]} CullOff=${pf[21]} `
                            + `Tex0Only=${pf[11]}`);
                    }
                }
                console.log(`   Heap: ${(run.heapAfter / 1024 / 1024).toFixed(0)}MB`);

                allRuns.push({
                    run: allRuns.length + 1,
                    rom: romName,
                    romSizeMB: parseFloat(romSizeMB),
                    ...run,
                });
            }
        }

        // Aggregate
        const benchRuns = allRuns.map(r => r.bench);
        const avgs = benchRuns.map(b => b.avg);
        const fpsValues = benchRuns.map(b => b.fps);
        const aggregate = {
            avgFrameMs: avgs.reduce((a, b) => a + b, 0) / avgs.length,
            minFrameMs: Math.min(...avgs),
            maxFrameMs: Math.max(...avgs),
            avgFps: fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length,
            bestFps: Math.max(...fpsValues),
            worstFps: Math.min(...fpsValues),
        };

        const results = {
            benchmarkVersion: 4,
            runner: 'browser',
            timestamp: new Date().toISOString(),
            config: {
                benchSeconds: BENCH_SECONDS,
                warmupSeconds: WARMUP_SECONDS,
                repeats: REPEAT,
                profileEnabled: PROFILE,
                interactive: INTERACTIVE,
                manualStart: MANUAL_START,
                savestate: STATE_ARG ? path.basename(STATE_ARG) : null,
                artifact: ARTIFACT,
            },
            environment,
            aggregate,
            runs: allRuns,
        };

        if (consoleErrors.length) results.consoleErrors = consoleErrors;

        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');

        console.log('');
        console.log(`## Aggregate (${allRuns.length} runs):`);
        console.log(`   Browser callbacks/s: ${aggregate.avgFps.toFixed(1)} `
            + `(best ${aggregate.bestFps.toFixed(1)}, worst ${aggregate.worstFps.toFixed(1)})`);
        console.log(`   Frame: ${aggregate.avgFrameMs.toFixed(2)}ms avg`);
        console.log(`   Written to: ${OUTPUT_PATH}`);

        if (consoleErrors.length) {
            console.log(`\n   Console messages (${consoleErrors.length}):`);
            consoleErrors.slice(0, 10).forEach(e => console.log(`     - ${e}`));
        }
    } catch (error) {
        console.error('Benchmark failed:', error.message);
        console.error(error.stack);
        process.exitCode = 1;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
