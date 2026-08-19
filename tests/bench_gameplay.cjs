/**
 * Gameplay benchmark — loads save state, measures real gameplay performance.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');
const { createWebServer } = require('../web/server.cjs');

const root = path.resolve(__dirname, '..');
const testGamesDir = path.join(root, 'test_games');
const romPath = fs.readdirSync(testGamesDir)
    .find(e => e.toLowerCase().endsWith('.3ds'));
const romBuffer = fs.readFileSync(path.join(testGamesDir, romPath));
const romExt = path.extname(romPath).toLowerCase();
const romName = romPath;

// Use the confirmed-moving save state
const statePath = path.join(root, 'tmp_test', 'gameplay_state', 'mario-moving',
    '2026-08-07T00-10-38-307Z', '000400000007D500.01.cst');
const stateBuffer = fs.readFileSync(statePath);
const stateName = path.basename(statePath);

const BENCH_SECS = 15;

function stats(times) {
    const sorted = [...times].sort((a, b) => a - b);
    const n = sorted.length;
    const avg = times.reduce((a, b) => a + b, 0) / n;
    return {
        count: n,
        avg: +avg.toFixed(2),
        fps: +(n / (times.reduce((a, b) => a + b, 0) / 1000)).toFixed(2),
        p50: +sorted[Math.floor(n * 0.50)].toFixed(2),
        p95: +sorted[Math.floor(n * 0.95)].toFixed(2),
        p99: +sorted[Math.floor(n * 0.99)].toFixed(2),
        min: +sorted[0].toFixed(2),
        max: +sorted[n - 1].toFixed(2),
    };
}

async function runArtifact(artifact, indexPath) {
    const webServer = createWebServer(path.join(root, 'web'));
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/bench_rom') {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': romBuffer.length,
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
            });
            res.end(romBuffer);
            return;
        }
        if (url.pathname === '/bench_state') {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': stateBuffer.length,
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
            });
            res.end(stateBuffer);
            return;
        }
        webServer.emit('request', req, res);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const addr = server.address();
    console.log(`\n=== ${artifact.toUpperCase()} ===  http://127.0.0.1:${addr.port}/${indexPath}`);

    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: { width: 1280, height: 900 },
        protocolTimeout: 120000,
    });

    const page = await browser.newPage();
    const logs = [];
    page.on('console', msg => { logs.push(`[${msg.type()}] ${msg.text()}`); });

    try {
        // Page load + WASM init
        console.log('  Loading page...');
        await page.goto(`http://127.0.0.1:${addr.port}/${indexPath}`,
            { waitUntil: 'networkidle0', timeout: 120000 });
        await page.waitForFunction(() => {
            const s = document.querySelector('#status');
            return s && s.textContent.includes('Emulator ready');
        }, { timeout: 120000 });

        // Load ROM
        await page.evaluate(async (ext) => {
            const resp = await fetch('/bench_rom');
            const bytes = new Uint8Array(await resp.arrayBuffer());
            Module.FS.writeFile('/bench' + ext, bytes, {canOwn: false});
        }, romExt);

        const loadRes = await page.evaluate((ext) =>
            Module.ccall('azahar_load_rom', 'number', ['string'], ['/bench' + ext]), romExt);
        console.log(`  ROM loaded: result=${loadRes}`);

        if (loadRes !== 0) throw new Error('ROM load failed');

        // Write + load save state (all in one evaluate to measure timing)
        console.log('  Restoring save state...');
        const restoreResult = await page.evaluate(async (sn) => {
            const t0 = performance.now();
            const stateDir = '/home/web_user/.local/share/azahar-emu/states';
            Module.FS.mkdirTree(stateDir);
            const resp = await fetch('/bench_state');
            const bytes = new Uint8Array(await resp.arrayBuffer());
            Module.FS.writeFile(stateDir + '/' + sn, bytes, {canOwn: false});
            Module._azahar_load_state(1);

            // Consume the load signal via step_frame (may be slow — decompress+restore)
            const s0 = performance.now();
            const res = Module._azahar_step_frame();
            const loadMs = performance.now() - s0;

            // Reset renderer stats so we measure gameplay, not boot
            Module._azahar_reset_renderer_stats?.();

            // Check for visible output
            const nonblack = Module._azahar_framebuffer_nonblack_pixels?.() ?? -1;

            return { loadMs: +loadMs.toFixed(0), result: res, nonblackPixels: nonblack };
        }, stateName);
        console.log(`  State restored: ${restoreResult.loadMs}ms  nonblack_pixels=${restoreResult.nonblackPixels}`);

        if (restoreResult.nonblackPixels === 0) {
            console.log('  WARNING: No visible output after restore — may still be booting');
        }

        // Settle: run a few frames to let the scene stabilize
        console.log('  Settling (10 frames)...');
        for (let i = 0; i < 10; i++) {
            await page.evaluate(() => Module._azahar_step_frame());
        }

        // Benchmark: measure individual step_frame calls for BENCH_SECS seconds
        console.log(`  Benchmarking (${BENCH_SECS}s)...`);
        const times = [];
        const benchStart = Date.now();
        while (Date.now() - benchStart < BENCH_SECS * 1000) {
            const t0 = Date.now();
            await page.evaluate(() => Module._azahar_step_frame());
            times.push(Date.now() - t0);
        }

        // Read perf + renderer stats
        const perfStats = await page.evaluate(() => {
            if (!Module._azahar_get_perf_stats) return null;
            const buf = Module._malloc(64);
            if (Module._azahar_get_perf_stats(buf, 8) !== 0) { Module._free(buf); return null; }
            const v = new Float64Array(Module.HEAPU8.buffer, buf, 8);
            const s = { gameFps: v[0], systemFps: v[1], emulationSpeed: v[2],
                timeGpu: v[3], timeSwap: v[4], timeVblank: v[5],
                meanFrametime: v[6], frameLimitPct: v[7] };
            Module._free(buf);
            return s;
        });

        const nonblack = await page.evaluate(() =>
            Module._azahar_framebuffer_nonblack_pixels?.() ?? -1);

        const st = stats(times);

        console.log(`  Frames: ${st.count}  FPS: ${st.fps}  Avg: ${st.avg}ms  p50: ${st.p50}ms  p95: ${st.p95}ms`);
        if (perfStats) {
            console.log(`  Speed: ${(perfStats.emulationSpeed*100).toFixed(1)}%  `
                + `SysFPS: ${perfStats.systemFps.toFixed(1)}  `
                + `GPU: ${(perfStats.timeGpu*1000).toFixed(1)}ms`);
        }
        console.log(`  Non-black pixels: ${nonblack}  VBlank: ${perfStats?.timeVblank?.toFixed(2)}s`);

        return {
            artifact,
            restoreMs: restoreResult.loadMs,
            frameStats: st,
            perfStats,
            nonblackPixels: nonblack,
            logTail: logs.slice(-3),
        };
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

async function main() {
    console.log(`ROM: ${romName}  State: ${stateName}`);
    console.log(`Duration: ${BENCH_SECS}s per renderer\n`);

    const results = [];

    console.log('=== Software Renderer ===');
    try {
        results.push(await runArtifact('azahar', 'index.html'));
    } catch (err) {
        results.push({ artifact: 'azahar', error: err.message });
        console.error(`  FAILED: ${err.message}`);
    }

    console.log('\n=== WebGL2 Renderer ===');
    try {
        results.push(await runArtifact('azahar_webgl2', 'index_webgl2.html'));
    } catch (err) {
        results.push({ artifact: 'azahar_webgl2', error: err.message });
        console.error(`  FAILED: ${err.message}`);
    }

    // Write results
    const report = {
        timestamp: new Date().toISOString(),
        rom: romName, romSizeMb: +(romBuffer.length / 1024 / 1024).toFixed(1),
        statePath: stateName,
        benchSeconds: BENCH_SECS,
        results,
    };
    const outPath = path.join(root, 'tests', 'benchmark_results.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nResults: ${outPath}`);

    // Final table
    console.log('\n=== SUMMARY ===');
    for (const r of results) {
        if (r.error) {
            console.log(`  ${r.artifact}: ERROR — ${r.error}`);
        } else {
            console.log(`  ${r.artifact}: ${r.frameStats.count}f  ${r.frameStats.fps}fps  `
                + `avg=${r.frameStats.avg}ms  p95=${r.frameStats.p95}ms  `
                + `speed=${(r.perfStats?.emulationSpeed*100).toFixed(1)}%  `
                + `nonblack=${r.nonblackPixels}`);
        }
    }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
