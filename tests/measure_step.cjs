/**
 * Measure exact step_frame timing with 10K cap.
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
    page.on('console', msg => console.log(`  [browser ${msg.type()}] ${msg.text()}`));

    try {
        await page.goto(webUrl, { waitUntil: 'networkidle0', timeout: 120000 });
        await page.waitForFunction(() => {
            const s = document.querySelector('#status');
            return s && s.textContent.includes('Emulator ready');
        }, { timeout: 120000 });
        console.log('Page ready.');

        // Load ROM (separate step to measure timing)
        await page.evaluate(async (ext) => {
            const resp = await fetch('/bench_rom');
            const bytes = new Uint8Array(await resp.arrayBuffer());
            Module.FS.writeFile('/bench' + ext, bytes, { canOwn: false });
        }, romExt);

        console.log('Loading ROM...');
        const t0 = Date.now();
        const loadResult = await page.evaluate((ext) => {
            return Module.ccall('azahar_load_rom', 'number', ['string'], ['/bench' + ext]);
        }, romExt);
        console.log(`ROM loaded: result=${loadResult} in ${(Date.now() - t0)}ms`);

        // Measure 10 individual step_frame calls
        console.log('\nMeasuring step_frame times:');
        const times = [];
        for (let i = 0; i < 10; i++) {
            const t1 = Date.now();
            const result = await page.evaluate(() => Module._azahar_step_frame());
            const elapsed = Date.now() - t1;
            times.push(elapsed);
            console.log(`  #${i}: result=${result}  ${elapsed}ms`);
        }

        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        console.log(`\nAverage: ${avg.toFixed(0)}ms  Min: ${Math.min(...times)}ms  Max: ${Math.max(...times)}ms`);

        console.log('\nAll measurements complete.');
    } catch (err) {
        console.error('FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
