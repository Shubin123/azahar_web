/**
 * Simple benchmark — measures step_frame performance using individual
 * page.evaluate calls (avoiding the 30s page.evaluate timeout).
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

const COUNT = 200;  // frames to sample

async function main() {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const addr = server.address();
    const webUrl = `http://127.0.0.1:${addr.port}/index.html`;
    console.log(`Server: ${webUrl}`);

    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: { width: 1280, height: 900 },
        protocolTimeout: 120000,
    });

    const page = await browser.newPage();
    const logs = [];
    page.on('console', msg => { logs.push(`[browser ${msg.type()}] ${msg.text()}`); });

    try {
        console.log('Loading page...');
        await page.goto(webUrl, { waitUntil: 'networkidle0', timeout: 120000 });
        await page.waitForFunction(() => {
            const s = document.querySelector('#status');
            return s && s.textContent.includes('Emulator ready');
        }, { timeout: 120000 });
        console.log('Page ready.');

        // Load ROM
        await page.evaluate(async (ext) => {
            const resp = await fetch('/bench_rom');
            const bytes = new Uint8Array(await resp.arrayBuffer());
            Module.FS.writeFile('/bench' + ext, bytes, { canOwn: false });
        }, romExt);

        const t0 = Date.now();
        await page.evaluate((ext) => {
            return Module.ccall('azahar_load_rom', 'number', ['string'], ['/bench' + ext]);
        }, romExt);
        console.log(`ROM loaded in ${Date.now() - t0}ms`);

        // Warmup: 20 frames (discarded)
        console.log('Warming up (20 frames)...');
        for (let i = 0; i < 20; i++) {
            await page.evaluate(() => Module._azahar_step_frame());
        }

        // Benchmark: COUNT frames
        console.log(`Benchmarking ${COUNT} frames...`);
        const times = [];
        let nonblack = 0;
        for (let i = 0; i < COUNT; i++) {
            const t1 = Date.now();
            await page.evaluate(() => Module._azahar_step_frame());
            const elapsed = Date.now() - t1;
            times.push(elapsed);

            if (i % 20 === 0) {
                const np = await page.evaluate(() => Module._azahar_framebuffer_nonblack_pixels());
                if (np > 0) nonblack = np;
                process.stdout.write(`  frame ${i}: ${elapsed}ms  nonblack_pixels=${np}\n`);
            }
        }

        // Read perf stats
        const perfStats = await page.evaluate(() => {
            if (!Module._azahar_get_perf_stats) return null;
            const buf = Module._malloc(64);
            if (Module._azahar_get_perf_stats(buf, 8) !== 0) { Module._free(buf); return null; }
            const v = new Float64Array(Module.HEAPU8.buffer, buf, 8);
            const stats = { gameFps: v[0], systemFps: v[1], emulationSpeed: v[2],
                timeGpu: v[3], timeSwap: v[4], timeVblank: v[5],
                meanFrametime: v[6], frameLimitPct: v[7] };
            Module._free(buf);
            return stats;
        });

        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const sorted = [...times].sort((a, b) => a - b);
        console.log(`\n=== Results ===`);
        console.log(`Frames sampled: ${COUNT}`);
        console.log(`Frame times (wall): avg=${avg.toFixed(1)}ms  p50=${sorted[Math.floor(COUNT*0.5)].toFixed(1)}ms  p95=${sorted[Math.floor(COUNT*0.95)].toFixed(1)}ms`);
        console.log(`Non-black pixels: ${nonblack}`);
        if (perfStats) {
            console.log(`Game FPS: ${perfStats.gameFps.toFixed(2)}  System FPS: ${perfStats.systemFps.toFixed(2)}  Speed: ${(perfStats.emulationSpeed*100).toFixed(1)}%`);
            console.log(`GPU: ${(perfStats.timeGpu*1000).toFixed(2)}ms  Swap: ${(perfStats.timeSwap*1000).toFixed(2)}ms  VBlank: ${(perfStats.timeVblank*1000).toFixed(2)}ms`);
        }
        if (logs.length > 0) {
            console.log(`\nBrowser logs:\n${logs.join('\n')}`);
        }
    } catch (err) {
        console.error('FAILED:', err.message);
        if (logs.length > 0) console.log(`Recent logs:\n${logs.slice(-10).join('\n')}`);
        process.exitCode = 1;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
