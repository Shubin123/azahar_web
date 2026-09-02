/**
 * Find the instruction cap where speed falls off a cliff.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');
const { createWebServer } = require('../web/server.cjs');

const root = path.resolve(__dirname, '..');
const testGamesDir = path.join(root, 'test_games');
const romPath = fs.readdirSync(testGamesDir)
    .find(e => e.toLowerCase().endsWith('.3ds') || e.toLowerCase().endsWith('.cia'));
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

const CAPS_TO_TEST = [10000, 100000, 300000, 500000, 800000, 1145777];

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
    page.on('console', msg => {
        if (msg.text().includes('[timer]')) logs.push(msg.text());
    });

    try {
        for (const cap of CAPS_TO_TEST) {
            console.log(`\n--- Testing cap=${cap} ---`);
            await page.goto(webUrl, { waitUntil: 'networkidle0', timeout: 120000 });
            await page.waitForFunction(() => {
                const s = document.querySelector('#status');
                return s && s.textContent.includes('Emulator ready');
            }, { timeout: 120000 });

            await page.evaluate(() => { Module._azahar_shutdown(); });
            await page.evaluate(() => { Module._azahar_init(); });

            await page.evaluate(async (ext) => {
                const resp = await fetch('/bench_rom');
                const bytes = new Uint8Array(await resp.arrayBuffer());
                Module.FS.writeFile('/testrom' + ext, bytes, { canOwn: false });
            }, romExt);

            await page.evaluate((ext) => {
                return Module.ccall('azahar_load_rom', 'number', ['string'], ['/testrom' + ext]);
            }, romExt);

            // Do 3 step_frames (warm up), then measure 2
            const times = [];
            for (let i = 0; i < 5; i++) {
                const t0 = Date.now();
                try {
                    const result = await page.evaluate(() => {
                        return Module._azahar_step_frame();
                    });
                    const elapsed = Date.now() - t0;
                    if (i >= 3) times.push(elapsed);
                    console.log(`  step_frame #${i}: result=${result} ${elapsed}ms`);
                } catch (e) {
                    console.log(`  step_frame #${i}: FAILED after ${Date.now() - t0}ms - ${e.message}`);
                    break;
                }
            }

            if (times.length > 0) {
                const avg = times.reduce((a, b) => a + b, 0) / times.length;
                console.log(`  Avg (measured): ${avg.toFixed(0)}ms per step_frame`);
            }
        }
    } catch (err) {
        console.error('FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
