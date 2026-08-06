/**
 * Direct canvas diagnostic: verifies the full SDL→canvas pipeline.
 * Waits for software renderer to produce non-black pixels, then
 * immediately checks whether those pixels actually reach the canvas.
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {listen: listenWeb} = require('../web/server.cjs');

const ROM_PATH = process.env.AZAHAR_ROM_PATH ||
    path.resolve(__dirname, '..', 'test_games',
        'Super Mario 3D Land (Europe) (En,Fr,De,Es,It) (Demo) (Kiosk).3ds');

async function main() {
    const server = await listenWeb(0);
    const addr = server.address();
    const url = `http://127.0.0.1:${addr.port}/index.html`;

    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.CHROME_PATH,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: {width: 1280, height: 900},
    });

    const page = await browser.newPage();
    page.on('console', m => {
        if (m.type() === 'error') console.log('[PAGE_ERR]', m.text());
    });

    try {
        console.log('Loading page...');
        await page.goto(url, {waitUntil: 'networkidle0', timeout: 120000});

        await page.waitForFunction(() => {
            const s = document.querySelector('#status');
            return s && s.textContent.includes('Emulator ready');
        }, {timeout: 120000});
        console.log('WASM ready, uploading ROM...');

        const romInput = await page.$('#rom-file');
        await romInput.uploadFile(ROM_PATH);
        await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, {timeout: 30000});
        await page.click('#btn-load');

        await page.waitForFunction(() => {
            const btn = document.querySelector('#btn-stop');
            return btn && !btn.disabled;
        }, {timeout: 120000});
        console.log('ROM loaded, emulation running.');

        // Poll every 2s: check BOTH renderer framebuffer AND canvas.
        // Log progress so we can see what's happening.
        const startWall = Date.now();
        let lastRendererNonzero = false;

        for (let poll = 0; poll < 90; poll++) { // 90 × 2s = 3 min max
            await new Promise(r => setTimeout(r, 2000));

            const diag = await page.evaluate(() => {
                let rendererNonZero = 0;
                if (typeof Module !== 'undefined' && Module._azahar_framebuffer_nonblack_pixels) {
                    rendererNonZero = Module._azahar_framebuffer_nonblack_pixels();
                }

                const canvas = document.querySelector('#canvas');
                const ctx = canvas.getContext('2d');
                const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = img.data;
                let canvasNonZero = 0;
                const colors = new Set();
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i] || data[i + 1] || data[i + 2]) {
                        canvasNonZero++;
                        if (canvasNonZero <= 100) { // sample first 100 non-black pixels
                            colors.add(`${data[i]},${data[i+1]},${data[i+2]}`);
                        }
                    }
                }

                const fpsEl = document.querySelector('#fps');
                const statusEl = document.querySelector('#status');
                return {
                    rendererNonZero,
                    canvasNonZero,
                    canvasColors: colors.size,
                    fps: fpsEl ? fpsEl.textContent : '',
                    status: statusEl ? statusEl.textContent : '',
                };
            });

            const elapsed = ((Date.now() - startWall) / 1000).toFixed(1);
            console.log(`[${elapsed}s] renderer=${diag.rendererNonZero} canvas_nonzero=${diag.canvasNonZero} ` +
                `canvas_colors=${diag.canvasColors} fps="${diag.fps}" status="${diag.status}"`);

            if (diag.rendererNonZero > 0 && !lastRendererNonzero) {
                console.log(`*** Renderer started producing pixels at ${elapsed}s ***`);
                lastRendererNonzero = true;
                // Take screenshot now!
                await page.screenshot({path: path.join(__dirname, 'canvas_firstlight.png')});
                console.log('Screenshot saved: canvas_firstlight.png');
            }

            if (diag.canvasNonZero > 0) {
                console.log(`*** CANVAS HAS ${diag.canvasNonZero} NON-ZERO PIXELS! Pipeline works. ***`);
                await page.screenshot({path: path.join(__dirname, 'canvas_working.png')});
                console.log('Screenshot saved: canvas_working.png');

                // Run another 5s for more rendering then capture
                await new Promise(r => setTimeout(r, 5000));
                await page.screenshot({path: path.join(__dirname, 'canvas_5s_later.png')});
                console.log('Screenshot saved: canvas_5s_later.png');
                break;
            }
        }

        if (!lastRendererNonzero) {
            console.log('WARNING: Renderer never produced non-black pixels within timeout.');
        }

        // Final state
        const final = await page.evaluate(() => {
            const canvas = document.querySelector('#canvas');
            const ctx = canvas.getContext('2d');
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let nonZero = 0;
            for (let i = 0; i < img.data.length; i += 4) {
                if (img.data[i] || img.data[i+1] || img.data[i+2]) nonZero++;
            }
            const statusEl = document.querySelector('#status');
            return {
                canvasNonZero: nonZero,
                status: statusEl ? statusEl.textContent : '',
                fps: document.querySelector('#fps')?.textContent || '',
            };
        });
        console.log('Final state:', JSON.stringify(final));

    } catch (err) {
        console.error('FATAL:', err.message);
        try { await page.screenshot({path: path.join(__dirname, 'canvas_fatal.png')}); } catch (_) {}
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
