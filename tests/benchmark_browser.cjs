/**
 * Azahar WebAssembly Browser Benchmark (tests/benchmark_browser.cjs)
 *
 * Runs the WASM emulator benchmark in Chrome via Puppeteer.
 * Required because the Emscripten pthreads build needs a browser environment
 * (SharedArrayBuffer, Web Workers) that raw Node.js cannot provide.
 *
 * Usage:
 *   node tests/benchmark_browser.cjs [--duration-seconds N] [--warmup-seconds N] [--rom PATH] [--output PATH]
 *
 * Options:
 *   --duration-seconds N Benchmark duration after the title-screen warmup (default: 15)
 *   --warmup-seconds N   Warmup duration before measuring (default: 30)
 *   --rom PATH    ROM file path (default: first .3ds/.3dsx/.cia in test_games/)
 *   --output PATH JSON output path (default: tests/benchmark_results.json)
 *   --repeat N    Repeat the benchmark N times (default: 3)
 *   --profile     Sample perf counters every ~1s during benchmark
 *   --interactive Run in a visible Chrome window for real-display validation
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
const OUTPUT_PATH = argVal('--output', path.join(__dirname, 'benchmark_results.json'));
const REPEAT = Number(argVal('--repeat', '3'));
const PROFILE = argFlag('--profile');
const INTERACTIVE = argFlag('--interactive');

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
function createBenchServer(romPath) {
    const webServer = createWebServer(path.join(root, 'web'));
    const romBuffer = fs.readFileSync(romPath);
    const romName = path.basename(romPath);

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
        // Delegate everything else to the web server
        webServer.emit('request', req, res);
    });

    return { server, romName };
}

// ── Benchmark script (runs inside page.evaluate) ──────────────────
async function runBenchInPage(page, romExt, benchSeconds, warmupSeconds, enableProfile) {
    return await page.evaluate(async ({
        romExt_, benchSeconds_, warmupSeconds_, enableProfile_
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

        function presentToUiCanvas() {
            const target = document.querySelector('#canvas');
            if (!target || !Module.canvas || Module.canvas === target) return;
            target.getContext('2d').drawImage(Module.canvas, 0, 0, target.width, target.height);
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
                    const t0 = perf.now();
                    const result = Module._azahar_step_frame();
                    presentToUiCanvas();
                    perFrame.push(perf.now() - t0);
                    if (samplePerf && timestamp >= nextSampleAt) {
                        samples.push({frame: perFrame.length, elapsedMs: timestamp - startedAt, perf: readPerfStats()});
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
                }
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
            if (warmupSeconds_ > 0) warmupStats = await runForDuration(warmupSeconds_, false);

            // Benchmark the sustained post-warmup browser path.
            const bench = await runForDuration(benchSeconds_, enableProfile_);
            const perfStats = readPerfStats();
            const heapAfter = Module.HEAPU8 ? Module.HEAPU8.length : 0;

            Module._azahar_shutdown();

            runs.push({
                run: rep + 1,
                initMs, loadMs,
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
                profileSamples: bench.samples,
            });
        }
        return runs;
    }, {
        romExt_: path.extname(findRom()).toLowerCase() || '.bin',
        benchSeconds_: benchSeconds,
        warmupSeconds_: warmupSeconds,
        enableProfile_: enableProfile,
    });
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
    const romPath = findRom();
    const romSizeMB = (fs.statSync(romPath).size / 1024 / 1024).toFixed(1);

    console.log(`# Azahar Web Benchmark (browser)`);
    console.log(`# ROM: ${path.basename(romPath)} (${romSizeMB} MB)`);
    console.log(`# Duration: ${BENCH_SECONDS}s  Warmup: ${WARMUP_SECONDS}s  Repeats: ${REPEAT}`);
    console.log(`# Mode: ${INTERACTIVE ? 'interactive browser' : 'headless diagnostic'}`);
    console.log(`# Profile: ${PROFILE ? 'on' : 'off'}`);
    console.log(`# Started: ${new Date().toISOString()}`);
    console.log('');

    // Start the combined web + ROM server
    const { server, romName } = createBenchServer(romPath);
    const romExt = path.extname(romPath).toLowerCase() || '.bin';
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    const addr = server.address();
    const webUrl = `http://127.0.0.1:${addr.port}/index.html`;
    console.log(`   Server: ${webUrl}`);

    // Launch browser
    const browser = await puppeteer.launch({
        // Headless measurements are useful for repeatability but are not a
        // substitute for the actual visible browser. Use --interactive when
        // comparing against user-observed frame rates.
        headless: INTERACTIVE ? false : 'new',
        executablePath: process.env.CHROME_PATH,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: { width: 1280, height: 900 },
    });

    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const allRuns = [];

    try {
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

            const runs = await runBenchInPage(page, romExt, BENCH_SECONDS, WARMUP_SECONDS, PROFILE);

            for (const run of runs) {
                const b = run.bench;
                console.log(`   Init: ${run.initMs.toFixed(0)}ms  Load: ${run.loadMs.toFixed(0)}ms`);
                if (run.warmup) {
                    console.log(`   Warmup: avg ${run.warmup.avg.toFixed(2)}ms/frame`);
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
            benchmarkVersion: 3,
            runner: 'browser',
            timestamp: new Date().toISOString(),
            config: {
                benchSeconds: BENCH_SECONDS,
                warmupSeconds: WARMUP_SECONDS,
                repeats: REPEAT,
                profileEnabled: PROFILE,
                interactive: INTERACTIVE,
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
            console.log(`\n   Console errors (${consoleErrors.length}):`);
            consoleErrors.slice(0, 5).forEach(e => console.log(`     - ${e}`));
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
