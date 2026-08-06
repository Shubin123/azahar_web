const path = require('path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {listen: listenWeb} = require('../web/server.cjs');

const root = path.resolve(__dirname, '..');
const romPath = process.env.AZAHAR_ROM_PATH ||
    path.join(root, 'test_games', 'Super Mario 3D Land (Europe) (EnFrDeEsIt) (Demo) (Kiosk).cia');
const realRomBootMs = Number.parseInt(process.env.AZAHAR_REAL_ROM_BOOT_MS || '0', 10) || 0;
const capturePath = process.env.AZAHAR_CAPTURE_PATH;

async function waitForStatus(page, predicate, timeout = 120000) {
    await page.waitForFunction(predicate, {timeout});
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
        await waitForStatus(page, () => !document.querySelector('#btn-init').disabled);
        const crossOriginIsolated = await page.evaluate(() => crossOriginIsolated);
        if (!crossOriginIsolated) {
            throw new Error('Web page is not cross-origin isolated; COOP/COEP headers are required for pthreads');
        }
        const wasmReadyStatus = await page.$eval('#status', element => element.textContent);

        await page.click('#btn-init');
        await waitForStatus(page, () => document.querySelector('#status').textContent.includes('Emulator ready'));

        await (await page.$('#rom-file')).uploadFile(romPath);
        await waitForStatus(page, () => !document.querySelector('#btn-load').disabled, 30000);
        const selectedStatus = await page.$eval('#status', element => element.textContent);

        await page.click('#btn-load');
        await waitForStatus(page, () => {
            const status = document.querySelector('#status').textContent;
            return status.startsWith('ROM loaded') || status.startsWith('ROM load failed') ||
                status.startsWith('ROM is encrypted') || status.startsWith('Load error');
        });
        const loadStatus = await page.$eval('#status', element => element.textContent);
        if (!loadStatus.startsWith('ROM loaded')) {
            throw new Error(`ROM load failed in browser: ${loadStatus}`);
        }
        await page.click('#btn-step');
        await waitForStatus(page, () => document.querySelector('#status').textContent.includes('Frame 1 OK'));

        // A single export can succeed while an asynchronously scheduled frame
        // attempts to create another worker. Exercise the actual 60 FPS loop
        // and require it to advance before stopping it explicitly.
        await page.click('#btn-run');
        await new Promise(resolve => setTimeout(resolve, 1000));
        const runningStatus = await page.$eval('#status', element => element.textContent);
        if (!runningStatus.startsWith('Running')) {
            throw new Error(`Continuous emulation failed to start: ${runningStatus}`);
        }

        // A real title takes appreciably longer than a synthetic fixture to
        // initialize. This opt-in path verifies a visible, non-black game
        // framebuffer without making the normal smoke test slow.
        let visibleFrame = null;
        if (realRomBootMs > 0) {
            await new Promise(resolve => setTimeout(resolve, realRomBootMs));
            visibleFrame = await page.evaluate(() => {
                const canvas = document.querySelector('#canvas');
                const data = canvas.getContext('2d')
                    .getImageData(0, 0, canvas.width, canvas.height).data;
                const colors = new Set();
                for (let index = 0; index < data.length; index += 32) {
                    colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
                }
                return {
                    colors: colors.size,
                    nonblackPixels: Module._azahar_framebuffer_nonblack_pixels(),
                };
            });
            if (visibleFrame.nonblackPixels === 0 || visibleFrame.colors < 2) {
                throw new Error(`No visible game framebuffer after ${realRomBootMs} ms: ` +
                    JSON.stringify(visibleFrame));
            }
            if (capturePath) await page.screenshot({path: capturePath, fullPage: true});
        }

        await page.click('#btn-stop');
        await waitForStatus(page, () => /^Stopped at frame \d+$/.test(document.querySelector('#status').textContent));
        const finalStatus = await page.$eval('#status', element => element.textContent);
        const frameMatch = /^Stopped at frame (\d+)$/.exec(finalStatus);
        if (!frameMatch || Number(frameMatch[1]) < 2) {
            throw new Error(`Continuous emulation did not advance: ${finalStatus}`);
        }

        const canvasStats = await page.$eval('#canvas', canvas => {
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let nonZero = 0;
            let alpha = 0;
            for (let index = 0; index < data.length; index += 4) {
                if (data[index] || data[index + 1] || data[index + 2] || data[index + 3]) nonZero++;
                if (data[index + 3]) alpha++;
            }
            return {width: canvas.width, height: canvas.height, nonZero, alpha};
        });

        if (canvasStats.nonZero === 0 || canvasStats.alpha === 0) {
            throw new Error(`Canvas remained blank: ${JSON.stringify(canvasStats)}`);
        }
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
