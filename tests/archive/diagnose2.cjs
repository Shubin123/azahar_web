/**
 * Diagnostic #2 — test step_frame on auto-initialized emulator (no shutdown/reinit)
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
        protocolTimeout: 60000,
    });

    const page = await browser.newPage();
    page.on('console', msg => console.log(`  [browser ${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => console.log(`  [PAGE ERROR] ${err.message}`));

    try {
        // Load page and wait for auto-init
        console.log('1. Loading page (auto-init)...');
        await page.goto(webUrl, { waitUntil: 'networkidle0', timeout: 120000 });
        await page.waitForFunction(() => {
            const s = document.querySelector('#status');
            return s && s.textContent.includes('Emulator ready');
        }, { timeout: 120000 });
        console.log('   Auto-init ready.');

        // NO shutdown — use auto-init directly
        // Write ROM and load it
        console.log('2. Writing ROM to MEMFS...');
        await page.evaluate(async (ext) => {
            const resp = await fetch('/bench_rom');
            const bytes = new Uint8Array(await resp.arrayBuffer());
            Module.FS.writeFile('/testrom' + ext, bytes, { canOwn: false });
        }, romExt);

        console.log('3. Loading ROM...');
        const loadOk = await page.evaluate((ext) => {
            const r = Module.ccall('azahar_load_rom', 'number', ['string'], ['/testrom' + ext]);
            return r;
        }, romExt);
        console.log('   Load result: ' + loadOk);

        if (loadOk !== 0) {
            console.log('   ROM load failed, trying step anyway...');
        }

        // Try step_frame with a JS-level timeout
        console.log('4. Stepping frame (with JS timeout)...');
        const result = await page.evaluate(() => {
            return new Promise((resolve) => {
                // Run step_frame on next rAF to avoid blocking
                requestAnimationFrame(() => {
                    try {
                        const r = Module._azahar_step_frame();
                        resolve('step_frame returned: ' + r);
                    } catch(e) {
                        resolve('step_frame threw: ' + e.message);
                    }
                });
                // Timeout after 5 seconds
                setTimeout(() => resolve('TIMEOUT - step_frame did not return in 5s'), 5000);
            });
        });
        console.log('   ' + result);

        console.log('\n=== Done ===');
    } catch (err) {
        console.error('FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
