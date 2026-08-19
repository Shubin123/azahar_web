/**
 * Full benchmark — tests both software and WebGL2 renderers, producing
 * a JSON report suitable for the artifact page.
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

const FRAMES = 200;
const WARMP = 20;

function stats(times) {
    const sorted = [...times].sort((a, b) => a - b);
    const n = sorted.length;
    const avg = times.reduce((a, b) => a + b, 0) / n;
    const p50 = sorted[Math.floor(n * 0.50)];
    const p95 = sorted[Math.floor(n * 0.95)];
    const p99 = sorted[Math.floor(n * 0.99)];
    const min = sorted[0];
    const max = sorted[n - 1];
    return {avg: +avg.toFixed(2), p50, p95, p99, min, max, n};
}

async function benchArtifact(artifact, indexPath) {
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
        webServer.emit('request', req, res);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const addr = server.address();
    const webUrl = `http://127.0.0.1:${addr.port}/${indexPath}`;
    console.log(`  [${artifact}] Server: ${webUrl}`);

    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: { width: 1280, height: 900 },
        protocolTimeout: 120000,
    });

    const page = await browser.newPage();
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

    try {
        console.log(`  [${artifact}] Loading page...`);
        await page.goto(webUrl, { waitUntil: 'networkidle0', timeout: 120000 });
        await page.waitForFunction(() => {
            const s = document.querySelector('#status');
            return s && s.textContent.includes('Emulator ready');
        }, { timeout: 120000 });

        // Load ROM
        await page.evaluate(async (ext) => {
            const resp = await fetch('/bench_rom');
            const bytes = new Uint8Array(await resp.arrayBuffer());
            Module.FS.writeFile('/bench' + ext, bytes, { canOwn: false });
        }, romExt);

        const loadStart = Date.now();
        const loadResult = await page.evaluate((ext) => {
            return Module.ccall('azahar_load_rom', 'number', ['string'], ['/bench' + ext]);
        }, romExt);
        const loadMs = Date.now() - loadStart;
        console.log(`  [${artifact}] ROM loaded: result=${loadResult} in ${loadMs}ms`);

        // Warmup
        console.log(`  [${artifact}] Warming up (${WARMP} frames)...`);
        for (let i = 0; i < WARMP; i++) {
            await page.evaluate(() => Module._azahar_step_frame());
        }

        // Benchmark
        console.log(`  [${artifact}] Benchmarking ${FRAMES} frames...`);
        const times = [];
        for (let i = 0; i < FRAMES; i++) {
            const t1 = Date.now();
            await page.evaluate(() => Module._azahar_step_frame());
            times.push(Date.now() - t1);
        }

        // Perf stats
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

        // Non-black pixels
        const nonblackPixels = await page.evaluate(() => {
            if (!Module._azahar_framebuffer_nonblack_pixels) return -1;
            return Module._azahar_framebuffer_nonblack_pixels();
        });

        return {
            artifact,
            loadMs,
            loadResult,
            frameStats: stats(times),
            perfStats,
            nonblackPixels,
            logCount: logs.length,
            logTail: logs.slice(-5),
        };
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

async function main() {
    console.log(`ROM: ${romName} (${(romBuffer.length / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`Frames: ${FRAMES}  Warmup: ${WARMP}\n`);

    const results = [];

    // Software renderer
    console.log('=== Software Renderer (azahar) ===');
    try {
        results.push(await benchArtifact('azahar', 'index.html'));
    } catch (err) {
        results.push({ artifact: 'azahar', error: err.message });
        console.error(`  FAILED: ${err.message}`);
    }

    // WebGL2 renderer
    console.log('\n=== WebGL2 Renderer (azahar_webgl2) ===');
    try {
        results.push(await benchArtifact('azahar_webgl2', 'index_webgl2.html'));
    } catch (err) {
        results.push({ artifact: 'azahar_webgl2', error: err.message });
        console.error(`  FAILED: ${err.message}`);
    }

    // Write results
    const outPath = path.join(root, 'tests', 'benchmark_results.json');
    const report = {
        timestamp: new Date().toISOString(),
        rom: romName,
        romSizeMb: +(romBuffer.length / 1024 / 1024).toFixed(2),
        frames: FRAMES,
        warmup: WARMP,
        results,
    };
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nResults written to ${outPath}`);

    // Summary
    for (const r of results) {
        if (r.error) {
            console.log(`  ${r.artifact}: ERROR — ${r.error}`);
        } else {
            console.log(`  ${r.artifact}: avg=${r.frameStats.avg}ms  p95=${r.frameStats.p95}ms  speed=${(r.perfStats?.emulationSpeed*100).toFixed(1)}%  nonblack=${r.nonblackPixels}`);
        }
    }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
