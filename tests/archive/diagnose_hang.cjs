/**
 * Minimal diagnostic — find exactly where the static build hangs.
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
        protocolTimeout: 30000,
    });

    const page = await browser.newPage();
    page.on('console', msg => console.log(`  [browser ${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => console.log(`  [browser PAGE ERROR] ${err.message}`));

    try {
        console.log('1. Loading page...');
        await page.goto(webUrl, { waitUntil: 'networkidle0', timeout: 120000 });

        await page.waitForFunction(() => {
            const s = document.querySelector('#status');
            return s && s.textContent.includes('Emulator ready');
        }, { timeout: 120000 });
        console.log('   Page loaded, emulator ready.');

        // Step 1: Shutdown
        console.log('2. Calling _azahar_shutdown()...');
        const shutdownResult = await page.evaluate(() => {
            try { Module._azahar_shutdown(); return 'ok'; }
            catch(e) { return 'error: ' + e.message; }
        });
        console.log('   Shutdown: ' + shutdownResult);

        // Step 2: Re-init
        console.log('3. Calling _azahar_init()...');
        const initResult = await page.evaluate(() => {
            try {
                const r = Module._azahar_init();
                return 'result=' + r;
            } catch(e) { return 'error: ' + e.message; }
        });
        console.log('   Init: ' + initResult);

        // Step 3: Write ROM to MEMFS
        console.log('4. Writing ROM to MEMFS...');
        const writeResult = await page.evaluate(async (ext) => {
            try {
                const resp = await fetch('/bench_rom');
                const bytes = new Uint8Array(await resp.arrayBuffer());
                const memfsPath = '/benchmark' + ext;
                Module.FS.writeFile(memfsPath, bytes, { canOwn: false });
                return 'ok, ' + bytes.length + ' bytes at ' + memfsPath;
            } catch(e) { return 'error: ' + e.message; }
        }, romExt);
        console.log('   Write: ' + writeResult);

        // Step 4: Load ROM via ccall
        console.log('5. Calling _azahar_load_rom()...');
        const loadResult = await page.evaluate((ext) => {
            try {
                const memfsPath = '/benchmark' + ext;
                const r = Module.ccall('azahar_load_rom', 'number', ['string'], [memfsPath]);
                return 'result=' + r;
            } catch(e) { return 'error: ' + e.message; }
        }, romExt);
        console.log('   Load ROM: ' + loadResult);

        // Step 5: Step one frame
        console.log('6. Calling _azahar_step_frame()...');
        const stepResult = await page.evaluate(() => {
            try {
                const r = Module._azahar_step_frame();
                return 'result=' + r;
            } catch(e) { return 'error: ' + e.message; }
        });
        console.log('   Step frame: ' + stepResult);

        console.log('\n=== All steps completed! ===');
    } catch (err) {
        console.error('FAILED at step:', err.message);
        console.error(err.stack);
        process.exitCode = 1;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
