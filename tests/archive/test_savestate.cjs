/**
 * Minimal save state test — verifies the restore flow works with current build.
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

const statePath = path.join(root, 'tmp_test', 'gameplay_state', 'mario-moving',
    '2026-08-07T00-10-38-307Z', '000400000007D500.01.cst');
const stateBuffer = fs.readFileSync(statePath);
const stateName = path.basename(statePath);

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

async function main() {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const addr = server.address();
    console.log(`Server: http://127.0.0.1:${addr.port}/index.html`);

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
        console.log('Loading page...');
        await page.goto(`http://127.0.0.1:${addr.port}/index.html`,
            { waitUntil: 'networkidle0', timeout: 120000 });
        await page.waitForFunction(() => {
            const s = document.querySelector('#status');
            return s && s.textContent.includes('Emulator ready');
        }, { timeout: 120000 });
        console.log('Page ready.');

        // Step 1: Load ROM
        console.log('\n--- Step 1: Load ROM ---');
        await page.evaluate(async (ext) => {
            const resp = await fetch('/bench_rom');
            const bytes = new Uint8Array(await resp.arrayBuffer());
            Module.FS.writeFile('/bench' + ext, bytes, {canOwn: false});
        }, romExt);
        const loadResult = await page.evaluate((ext) => {
            return Module.ccall('azahar_load_rom', 'number', ['string'], ['/bench' + ext]);
        }, romExt);
        console.log(`azahar_load_rom returned: ${loadResult}`);

        // Step 2: Verify step_frame works before state
        console.log('\n--- Step 2: Pre-state step_frame (2 frames) ---');
        for (let i = 0; i < 2; i++) {
            const res = await page.evaluate(() => Module._azahar_step_frame());
            console.log(`  frame ${i}: result=${res}`);
        }

        // Step 3: Write and load save state
        console.log('\n--- Step 3: Write save state ---');
        const stateResult = await page.evaluate((sn) => {
            try {
                const stateDir = '/home/web_user/.local/share/azahar-emu/states';
                Module.FS.mkdirTree(stateDir);
                Module.FS.writeFile(stateDir + '/' + sn, new Uint8Array(0), {canOwn: false});
                // Write actual bytes via separate fetch
                return 'mkdirTree ok';
            } catch (e) { return 'ERROR: ' + e.message; }
        }, stateName);
        console.log(`mkdirTree: ${stateResult}`);

        // Fetch and write save state in one evaluate call
        console.log('\n--- Step 4: Fetch + write + load state ---');
        const loadStateResult = await page.evaluate(async (sn) => {
            const stateDir = '/home/web_user/.local/share/azahar-emu/states';
            const resp = await fetch('/bench_state');
            if (!resp.ok) return 'fetch failed: ' + resp.status;
            const bytes = new Uint8Array(await resp.arrayBuffer());
            Module.FS.writeFile(stateDir + '/' + sn, bytes, {canOwn: false});

            // Verify file exists
            try {
                const stat = Module.FS.stat(stateDir + '/' + sn);
                if (stat.size === 0) return 'file is empty!';
            } catch (e) { return 'stat failed: ' + e.message; }

            const req = Module._azahar_load_state(1);
            return 'load_state queued, slot=1, result=' + req + ', size=' + bytes.length;
        }, stateName);
        console.log(`State: ${loadStateResult}`);

        // Step 5: Step frames to consume the load signal
        console.log('\n--- Step 5: Post-state step_frame (3 frames) ---');
        for (let i = 0; i < 3; i++) {
            const t0 = Date.now();
            let res;
            try {
                res = await page.evaluate(() => {
                    if (typeof Module._azahar_step_frame !== 'function')
                        return 'NOT_A_FUNCTION';
                    try {
                        return Module._azahar_step_frame();
                    } catch (e) { return 'THREW: ' + e.message; }
                });
            } catch (e) {
                res = 'PAGE_EVALUATE_THREW: ' + e.message;
            }
            const elapsed = Date.now() - t0;
            console.log(`  frame ${i}: ${res} (${elapsed}ms)`);
            if (typeof res === 'string') break;
        }

        // Dump logs
        if (logs.length > 0) {
            console.log('\n--- Browser logs ---');
            console.log(logs.join('\n'));
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
