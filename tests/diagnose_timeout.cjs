/**
 * Diagnostic with longer timeout — does uncapped dispatch eventually return?
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
        protocolTimeout: 300000, // 5 minutes
    });

    const page = await browser.newPage();
    page.on('console', msg => console.log(`  [browser ${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => console.log(`  [PAGE ERROR] ${err.message}`));

    const startTime = Date.now();

    try {
        console.log('1. Loading page...');
        await page.goto(webUrl, { waitUntil: 'networkidle0', timeout: 120000 });
        await page.waitForFunction(() => {
            const s = document.querySelector('#status');
            return s && s.textContent.includes('Emulator ready');
        }, { timeout: 120000 });
        console.log('   Ready.');

        await page.evaluate(() => { Module._azahar_shutdown(); });
        await page.evaluate(() => { Module._azahar_init(); });

        console.log('2. Loading ROM...');
        await page.evaluate(async (ext) => {
            const resp = await fetch('/bench_rom');
            const bytes = new Uint8Array(await resp.arrayBuffer());
            Module.FS.writeFile('/testrom' + ext, bytes, { canOwn: false });
        }, romExt);
        const loadResult = await page.evaluate((ext) => {
            return Module.ccall('azahar_load_rom', 'number', ['string'], ['/testrom' + ext]);
        }, romExt);
        console.log('   Load result: ' + loadResult);

        // Step frame WITHOUT cap — use very long timeout
        console.log('3. Stepping frame (uncapped, max 5min wait)...');
        const stepStart = Date.now();
        const stepResult = await page.evaluate(() => {
            return Module._azahar_step_frame();
        });
        const stepElapsed = Date.now() - stepStart;
        console.log('   step_frame returned: ' + stepResult + ' after ' + stepElapsed + 'ms');

        // Try a second step
        console.log('4. Second step...');
        const step2Start = Date.now();
        const step2Result = await page.evaluate(() => {
            return Module._azahar_step_frame();
        });
        const step2Elapsed = Date.now() - step2Start;
        console.log('   step_frame returned: ' + step2Result + ' after ' + step2Elapsed + 'ms');

        const totalTime = (Date.now() - startTime) / 1000;
        console.log('\n=== Done in ' + totalTime.toFixed(1) + 's ===');
    } catch (err) {
        const elapsed = (Date.now() - startTime) / 1000;
        console.error('FAILED after ' + elapsed.toFixed(1) + 's: ' + err.message);
        process.exitCode = 1;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
