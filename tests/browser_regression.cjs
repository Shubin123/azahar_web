const path = require('path');
const fs = require('fs');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {listen: listenWeb} = require('../web/server.cjs');
const cfg = require('./config.cjs');

const root = path.resolve(__dirname, '..');
const romPath = process.env.AZAHAR_ROM_PATH ||
    path.join(root, 'test_games', 'Super Mario 3D Land (Europe) (En,Fr,De,Es,It) (Demo) (Kiosk).3ds');
// The visible-frame gate is deliberately enabled by default. Set this to 0
// only when running a fast, loader-only diagnostic with another fixture.
const realRomBootMs = process.env.AZAHAR_REAL_ROM_BOOT_MS === undefined ? 35000 :
    Number.parseInt(process.env.AZAHAR_REAL_ROM_BOOT_MS, 10);
const capturePath = process.env.AZAHAR_CAPTURE_PATH;
const statePath = process.env.AZAHAR_STATE_PATH || cfg.statePath;
const extraChromeArgs = (process.env.AZAHAR_CHROME_ARGS || '')
    .split(/\s+/).filter(Boolean);
const staticHostMode = process.env.AZAHAR_STATIC_HOST === '1';
const headless = process.env.AZAHAR_HEADLESS === '0' ? false : 'new';
const sustainMs = Number.parseInt(process.env.AZAHAR_SUSTAIN_MS || '1000', 10);

async function waitForStatus(page, predicate, timeout = 120000) {
    await page.waitForFunction(predicate, {timeout});
}

// Canvas readback observes the backing store, not the browser compositor. It
// can therefore succeed even while the SDL/Emscripten presentation path leaves
// the user-visible canvas black (and it is unavailable when WebGL owns the
// canvas). Decode a clipped browser screenshot instead: these are the pixels
// a user sees. Quantising colours avoids counting anti-aliased variants alone.
async function readVisibleCanvasStats(page) {
    const clip = await page.$eval('#canvas', canvas => {
        const rect = canvas.getBoundingClientRect();
        return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
    });
    const screenshot = await page.screenshot({encoding: 'base64', clip});
    return page.evaluate(async encoded => {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded}`;
        await image.decode();

        const sample = document.createElement('canvas');
        sample.width = image.naturalWidth;
        sample.height = image.naturalHeight;
        const context = sample.getContext('2d', {willReadFrequently: true});
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, sample.width, sample.height).data;
        const colorCounts = new Map();
        let nonBlackSamples = 0;
        let colorfulSamples = 0;
        let samples = 0;

        // Cover the full visible canvas while keeping analysis inexpensive.
        for (let index = 0; index < data.length; index += 16) {
            const red = data[index];
            const green = data[index + 1];
            const blue = data[index + 2];
            const maximum = Math.max(red, green, blue);
            const minimum = Math.min(red, green, blue);
            if (maximum > 8) nonBlackSamples++;
            if (maximum - minimum > 24) colorfulSamples++;
            const color = (red >> 4) << 8 | (green >> 4) << 4 | (blue >> 4);
            colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
            samples++;
        }
        let entropy = 0;
        for (const count of colorCounts.values()) {
            const probability = count / samples;
            entropy -= probability * Math.log2(probability);
        }
        return {width: sample.width, height: sample.height, samples, nonBlackSamples,
            nonBlackCoverage: nonBlackSamples / samples, colorfulSamples,
            colorfulCoverage: colorfulSamples / samples, paletteSize: colorCounts.size, entropy};
    }, screenshot);
}

function hasVisibleGameFrame(stats) {
    // A CSS-black canvas still contributes a thin grey border. These coverage
    // and entropy thresholds deliberately reject that low-information image,
    // while accepting the Mario title/splash frames captured by the working
    // build. Renderer state remains an independent diagnostic below.
    return stats.nonBlackCoverage >= 0.03 && stats.colorfulCoverage >= 0.005 &&
        stats.paletteSize >= 8 && stats.entropy >= 0.75;
}

async function main() {
    // Use the project server by default: it supplies the COOP/COEP headers
    // required for Emscripten pthreads and makes this regression self-contained.
    const localStatePath = !process.env.AZAHAR_WEB_URL && statePath && fs.existsSync(statePath) ?
        statePath : null;
    const virtualFiles = localStatePath ?
        {'/__azahar_test_state.cst': fs.readFileSync(localStatePath)} : {};
    const server = process.env.AZAHAR_WEB_URL ? null :
        await listenWeb(0, '127.0.0.1', {
            virtualFiles,
            // Exercise the same service-worker isolation bootstrap required
            // by GitHub Pages, which cannot provide COOP/COEP response headers.
            crossOriginIsolation: !staticHostMode,
        });
    const address = server?.address();
    // Enter through the actual deployment URL. Adapter preflight may keep the
    // accelerated artifact or navigate to compatibility mode; both outcomes
    // must produce playable, composited output in the browser under test.
    const webUrl = process.env.AZAHAR_WEB_URL ||
        `http://127.0.0.1:${address.port}/index.html?autostart=0`;
    const browser = await puppeteer.launch({
        headless,
        executablePath: process.env.CHROME_PATH || cfg.chromePath || "chrome",
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...extraChromeArgs],
        defaultViewport: {width: 1280, height: 900},
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    const consoleMessages = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on('console', message => {
        consoleMessages.push(`[${message.type()}] ${message.text()}`);
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => pageErrors.push(error.stack || String(error)));
    page.on('error', error => pageErrors.push(`Renderer process error: ${error.stack || error}`));
    page.on('requestfailed', request => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));

    try {
        console.log(`phase: navigate ${webUrl}`);
        await page.goto(webUrl, {
            waitUntil: 'networkidle0',
            timeout: 120000,
        });
        console.log('phase: wait for emulator initialization');
        await waitForStatus(page, () => document.querySelector('#status').textContent.includes('Emulator ready'));
        const crossOriginIsolated = await page.evaluate(() => crossOriginIsolated);
        if (!crossOriginIsolated) {
            throw new Error('Web page is not cross-origin isolated; COOP/COEP headers are required for pthreads');
        }
        const wasmReadyStatus = await page.$eval('#status', element => element.textContent);
        const selectedRenderer = await page.evaluate(() => window.AzaharWebConfig?.renderer);
        const heapBytes = await page.evaluate(() => Module.HEAPU8.byteLength);
        const rendererModes = await page.$$eval('#renderer-mode option', options =>
            options.map(option => option.value));
        if (rendererModes.join(',') !== 'auto,webgl2,software') {
            throw new Error(`Unified renderer toggle is missing or stale: ${JSON.stringify(rendererModes)}`);
        }

        console.log('phase: upload ROM');
        await (await page.$('#rom-file')).uploadFile(romPath);
        await waitForStatus(page, () => !document.querySelector('#btn-load').disabled, 30000);
        const selectedStatus = await page.$eval('#status', element => element.textContent);

        console.log('phase: load ROM');
        await page.click('#btn-load');
        console.log('phase: load click dispatched');
        await waitForStatus(page, () => {
            const status = document.querySelector('#status').textContent;
            return document.querySelector('#btn-run').disabled === false ||
                status.startsWith('ROM load failed') ||
                status.startsWith('ROM is encrypted') || status.startsWith('Load error');
        });
        const loadStatus = await page.$eval('#status', element => element.textContent);
        const readyAfterLoad = await page.$eval('#btn-run', element => !element.disabled);
        if (!readyAfterLoad) {
            throw new Error(`ROM load failed in browser: ${loadStatus}`);
        }

        if (localStatePath) {
            console.log('phase: install and queue playable save state');
            const stateName = path.basename(localStatePath);
            const stateResult = await page.evaluate(async name => {
                const response = await fetch('/__azahar_test_state.cst');
                if (!response.ok) return -10;
                const bytes = new Uint8Array(await response.arrayBuffer());
                const stateDir = '/home/web_user/.local/share/azahar-emu/states';
                Module.FS.mkdirTree(stateDir);
                Module.FS.writeFile(`${stateDir}/${name}`, bytes, {canOwn: false});
                return Module._azahar_load_state(1);
            }, stateName);
            if (stateResult !== 0) {
                throw new Error(`Save-state setup failed: ${stateResult}`);
            }
        }

        await page.click('#btn-run');
        console.log('phase: continuous emulation started');
        const emulationStartMs = await page.evaluate(() => performance.now());

        // The default UI path starts the display-scheduled loop as soon as
        // loading succeeds. Let it run briefly to exercise worker creation
        // and verify that it remains active before stopping it explicitly.
        await new Promise(resolve => setTimeout(resolve, 1000));
        const stillRunning = await page.$eval('#btn-stop', element => !element.disabled);
        if (!stillRunning) {
            throw new Error(`Continuous emulation failed to start: ${loadStatus}`);
        }

        // A real title takes appreciably longer than a synthetic fixture to
        // initialize. This gate verifies both the renderer's framebuffer and
        // the composited canvas pixels; canvas backing-store readback alone
        // misses a broken SDL-to-browser presentation path.
        let visibleFrame = null;
        if (realRomBootMs > 0) {
            console.log(`phase: wait up to ${realRomBootMs} ms for visible game frame`);
            const visualDeadline = Date.now() + realRomBootMs;
            do {
                const rendererNonblackPixels = await page.evaluate(() =>
                    typeof Module !== 'undefined' && Module._azahar_framebuffer_nonblack_pixels ?
                        Module._azahar_framebuffer_nonblack_pixels() : -1);
                visibleFrame = {
                    elapsedMs: await page.evaluate(startMs => performance.now() - startMs,
                        emulationStartMs),
                    rendererNonblackPixels,
                    ...(await readVisibleCanvasStats(page)),
                };
                const gpuResidentFramebuffer = await page.evaluate(() =>
                    window.AzaharWebConfig?.renderer === 'webgl2');
                const rendererReady = rendererNonblackPixels > 0 ||
                    (gpuResidentFramebuffer && rendererNonblackPixels === -2);
                if (rendererReady && hasVisibleGameFrame(visibleFrame)) break;
                await new Promise(resolve => setTimeout(resolve, 500));
            } while (Date.now() < visualDeadline);

            const gpuResidentFramebuffer = await page.evaluate(() =>
                window.AzaharWebConfig?.renderer === 'webgl2');
            const rendererReady = visibleFrame.rendererNonblackPixels > 0 ||
                (gpuResidentFramebuffer && visibleFrame.rendererNonblackPixels === -2);
            if (!rendererReady || !hasVisibleGameFrame(visibleFrame)) {
                throw new Error(`No visible game framebuffer after ${realRomBootMs} ms: ` +
                    JSON.stringify(visibleFrame));
            }
            if (capturePath) await page.screenshot({path: capturePath, fullPage: true});
        }

        // Keep the real rAF-driven UI alive after the first valid frame. This
        // catches renderer-process exits, runaway heap growth, and event-loop
        // starvation that a one-frame screenshot check cannot observe.
        console.log(`phase: sustain responsive gameplay for ${sustainMs} ms`);
        const sustainedSamples = [];
        const sustainDeadline = Date.now() + sustainMs;
        while (Date.now() < sustainDeadline) {
            await new Promise(resolve => setTimeout(resolve, Math.min(1000,
                Math.max(1, sustainDeadline - Date.now()))));
            sustainedSamples.push(await page.evaluate(() => ({
                now: performance.now(),
                heapBytes: Module.HEAPU8.byteLength,
                status: document.querySelector('#status').textContent,
                stopEnabled: !document.querySelector('#btn-stop').disabled,
            })));
            if (!sustainedSamples.at(-1).stopEnabled) {
                throw new Error(`Emulation stopped during sustained run: ${JSON.stringify(sustainedSamples.at(-1))}`);
            }
        }

        console.log('phase: stop emulation');
        await page.click('#btn-stop');
        await waitForStatus(page, () => /^Stopped at step \d+$/.test(document.querySelector('#status').textContent));
        const finalStatus = await page.$eval('#status', element => element.textContent);
        const frameMatch = /^Stopped at step (\d+)$/.exec(finalStatus);
        if (!frameMatch || Number(frameMatch[1]) < 2) {
            throw new Error(`Continuous emulation did not advance: ${finalStatus}`);
        }

        const canvasStats = await readVisibleCanvasStats(page);
        const canvasDimensions = await page.$eval('#canvas', canvas => ({
            backingWidth: canvas.width,
            backingHeight: canvas.height,
            clientWidth: canvas.clientWidth,
            clientHeight: canvas.clientHeight,
        }));
        const backingAspectError = Math.abs(
            canvasDimensions.backingWidth / canvasDimensions.backingHeight - 5 / 6);
        const clientAspectError = Math.abs(
            canvasDimensions.clientWidth / canvasDimensions.clientHeight - 5 / 6);
        if (backingAspectError > 0.01 || clientAspectError > 0.01) {
            throw new Error(`Dual-screen canvas aspect ratio regressed: ${JSON.stringify(canvasDimensions)}`);
        }
        if (canvasDimensions.clientWidth !== canvasDimensions.backingWidth * 2 ||
            canvasDimensions.clientHeight !== canvasDimensions.backingHeight * 2) {
            throw new Error(`Desktop canvas lost exact 2x pixel scaling: ${JSON.stringify(canvasDimensions)}`);
        }
        if (consoleErrors.length || pageErrors.length) {
            throw new Error(`Browser errors: ${JSON.stringify({consoleErrors, pageErrors})}`);
        }

        console.log(JSON.stringify({
            ok: true,
            staticHostMode,
            selectedRenderer,
            rendererModes,
            heapBytes,
            sustainMs,
            sustainedSamples: sustainedSamples.length,
            finalHeapBytes: sustainedSamples.at(-1)?.heapBytes || heapBytes,
            wasmReadyStatus,
            selectedStatus,
            loadStatus,
            finalStatus,
            canvasDimensions,
            canvasStats,
            visibleFrame,
        }));
    } catch (error) {
        const diagnostics = await page.evaluate(() => ({
            status: document.querySelector('#status')?.textContent,
            log: document.querySelector('#log')?.textContent,
            initDisabled: document.querySelector('#btn-init')?.disabled,
            moduleState: typeof Module === 'undefined' ? 'undefined' : {
                calledRun: Module.calledRun,
                runtimeInitialized: Module.runtimeInitialized,
                heapBytes: Module.HEAPU8?.byteLength,
                romFiles: Module.FS.readdir('/')
                    .filter(name => /^rom\./i.test(name))
                    .map(name => ({name, size: Module.FS.stat(`/${name}`).size})),
            },
        })).catch(() => ({}));
        console.error(JSON.stringify({
            error: error.stack || String(error),
            diagnostics,
            consoleMessages,
            consoleErrors,
            pageErrors,
            failedRequests,
        }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
        await new Promise(resolve => server?.close(resolve) || resolve());
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
