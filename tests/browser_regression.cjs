const path = require('path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {listen: listenWeb} = require('../web/server.cjs');

const root = path.resolve(__dirname, '..');
const romPath = process.env.AZAHAR_ROM_PATH ||
    path.join(root, 'test_games', 'Super Mario 3D Land (Europe) (En,Fr,De,Es,It) (Demo) (Kiosk).3ds');
// The visible-frame gate is deliberately enabled by default. Set this to 0
// only when running a fast, loader-only diagnostic with another fixture.
const realRomBootMs = process.env.AZAHAR_REAL_ROM_BOOT_MS === undefined ? 35000 :
    Number.parseInt(process.env.AZAHAR_REAL_ROM_BOOT_MS, 10);
const capturePath = process.env.AZAHAR_CAPTURE_PATH;

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
    const server = process.env.AZAHAR_WEB_URL ? null : await listenWeb(0);
    const address = server?.address();
    const webUrl = process.env.AZAHAR_WEB_URL ||
        `http://127.0.0.1:${address.port}/index.html`;
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.CHROME_PATH,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
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
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('requestfailed', request => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));

    try {
        await page.goto(webUrl, {
            waitUntil: 'networkidle0',
            timeout: 120000,
        });
        await waitForStatus(page, () => document.querySelector('#status').textContent.includes('Emulator ready'));
        const crossOriginIsolated = await page.evaluate(() => crossOriginIsolated);
        if (!crossOriginIsolated) {
            throw new Error('Web page is not cross-origin isolated; COOP/COEP headers are required for pthreads');
        }
        const wasmReadyStatus = await page.$eval('#status', element => element.textContent);

        await (await page.$('#rom-file')).uploadFile(romPath);
        await waitForStatus(page, () => !document.querySelector('#btn-load').disabled, 30000);
        const selectedStatus = await page.$eval('#status', element => element.textContent);

        await page.click('#btn-load');
        await waitForStatus(page, () => {
            const status = document.querySelector('#status').textContent;
            return document.querySelector('#btn-stop').disabled === false ||
                status.startsWith('ROM load failed') ||
                status.startsWith('ROM is encrypted') || status.startsWith('Load error');
        });
        const loadStatus = await page.$eval('#status', element => element.textContent);
        const runningAfterLoad = await page.$eval('#btn-stop', element => !element.disabled);
        if (!runningAfterLoad) {
            throw new Error(`ROM load failed in browser: ${loadStatus}`);
        }
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
                if (rendererNonblackPixels > 0 && hasVisibleGameFrame(visibleFrame)) break;
                await new Promise(resolve => setTimeout(resolve, 500));
            } while (Date.now() < visualDeadline);

            if (visibleFrame.rendererNonblackPixels <= 0 || !hasVisibleGameFrame(visibleFrame)) {
                throw new Error(`No visible game framebuffer after ${realRomBootMs} ms: ` +
                    JSON.stringify(visibleFrame));
            }
            if (capturePath) await page.screenshot({path: capturePath, fullPage: true});
        }

        await page.click('#btn-stop');
        await waitForStatus(page, () => /^Stopped at step \d+$/.test(document.querySelector('#status').textContent));
        const finalStatus = await page.$eval('#status', element => element.textContent);
        const frameMatch = /^Stopped at step (\d+)$/.exec(finalStatus);
        if (!frameMatch || Number(frameMatch[1]) < 2) {
            throw new Error(`Continuous emulation did not advance: ${finalStatus}`);
        }

        const canvasStats = await readVisibleCanvasStats(page);
        if (consoleErrors.length || pageErrors.length) {
            throw new Error(`Browser errors: ${JSON.stringify({consoleErrors, pageErrors})}`);
        }

        console.log(JSON.stringify({
            ok: true,
            wasmReadyStatus,
            selectedStatus,
            loadStatus,
            finalStatus,
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
