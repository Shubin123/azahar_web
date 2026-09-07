const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {listen: listenWeb} = require('../web/server.cjs');
const cfg = require('./config.cjs');

const root = path.resolve(__dirname, '..');
const romPath = process.env.AZAHAR_ROM_PATH || path.join(root, 'test_games',
    'Super Mario 3D Land (Europe) (En,Fr,De,Es,It) (Demo) (Kiosk).3ds');
const titleWaitMs = Number.parseInt(process.env.AZAHAR_TITLE_WAIT_MS || '18000', 10);
const transitionWaitMs = Number.parseInt(process.env.AZAHAR_TRANSITION_WAIT_MS || '45000', 10);
const heartbeatLimitMs = Number.parseInt(process.env.AZAHAR_HEARTBEAT_LIMIT_MS || '5000', 10);
const captureDir = process.env.AZAHAR_CAPTURE_DIR || path.join(root, 'tmp_test', 'title-transition');
const extraChromeArgs = (process.env.AZAHAR_CHROME_ARGS || '').split(/\s+/).filter(Boolean);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function readRuntimeState(page) {
    return page.evaluate(() => {
        let perf = null;
        if (Module._azahar_get_perf_stats) {
            const buffer = Module._malloc(64);
            if (Module._azahar_get_perf_stats(buffer, 8) === 0) {
                const values = new Float64Array(Module.HEAPU8.buffer, buffer, 8);
                perf = {
                    gameFps: values[0],
                    systemFps: values[1],
                    emulationSpeed: values[2],
                    gpuSeconds: values[3],
                };
            }
            Module._free(buffer);
        }
        return {
            now: performance.now(),
            status: document.querySelector('#status')?.textContent,
            fpsText: document.querySelector('#fps')?.textContent,
            running: !document.querySelector('#btn-stop')?.disabled,
            heapBytes: Module.HEAPU8.byteLength,
            perf,
        };
    });
}

async function main() {
    if (!fs.existsSync(romPath)) throw new Error(`ROM fixture not found: ${romPath}`);
    fs.mkdirSync(captureDir, {recursive: true});
    const server = await listenWeb(0, '127.0.0.1');
    const browser = await puppeteer.launch({
        headless: process.env.AZAHAR_HEADLESS === '0' ? false : 'new',
        executablePath: process.env.CHROME_PATH || cfg.chromePath || 'chrome',
        protocolTimeout: 120000,
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...extraChromeArgs],
        defaultViewport: {width: 1280, height: 1200},
    });
    const page = await browser.newPage();
    const consoleMessages = [];
    const pageErrors = [];
    page.on('console', message => {
        const text = `[${message.type()}] ${message.text()}`;
        consoleMessages.push(text);
        if (text.includes('[Azahar GL upload failure]') ||
            text.includes('[Azahar GL readback failure]')) console.log(text);
    });
    page.on('pageerror', error => pageErrors.push(error.stack || String(error)));
    page.on('error', error => pageErrors.push(`Renderer process error: ${error.stack || error}`));

    if (process.env.AZAHAR_GL_DIAGNOSTICS === '1') {
        await page.evaluateOnNewDocument(() => {
            const original = WebGL2RenderingContext.prototype.texSubImage2D;
            const originalReadPixels = WebGL2RenderingContext.prototype.readPixels;
            let reported = 0;
            WebGL2RenderingContext.prototype.texSubImage2D = function (...args) {
                while (this.getError() !== this.NO_ERROR) {}
                const result = original.apply(this, args);
                const error = this.getError();
                if (error !== this.NO_ERROR && reported++ < 1) {
                    const data = args[8];
                    console.info('[Azahar GL upload failure] ' + JSON.stringify({
                        error,
                        argCount: args.length,
                        width: args[4],
                        height: args[5],
                        format: args[6],
                        type: args[7],
                        byteLength: data?.byteLength,
                        elementLength: data?.length,
                        srcOffset: args[9],
                        unpackAlignment: this.getParameter(this.UNPACK_ALIGNMENT),
                        unpackRowLength: this.getParameter(this.UNPACK_ROW_LENGTH),
                        unpackSkipPixels: this.getParameter(this.UNPACK_SKIP_PIXELS),
                        unpackSkipRows: this.getParameter(this.UNPACK_SKIP_ROWS),
                        unpackBuffer: Boolean(this.getParameter(this.PIXEL_UNPACK_BUFFER_BINDING)),
                        boundTexture: Boolean(this.getParameter(this.TEXTURE_BINDING_2D)),
                        stack: new Error().stack,
                    }));
                }
                return result;
            };
            WebGL2RenderingContext.prototype.readPixels = function (...args) {
                while (this.getError() !== this.NO_ERROR) {}
                const result = originalReadPixels.apply(this, args);
                const error = this.getError();
                if (error !== this.NO_ERROR && reported++ < 2) {
                    const data = args[6];
                    console.info('[Azahar GL readback failure] ' + JSON.stringify({
                        error,
                        width: args[2],
                        height: args[3],
                        format: args[4],
                        type: args[5],
                        byteLength: data?.byteLength,
                        elementLength: data?.length,
                        packAlignment: this.getParameter(this.PACK_ALIGNMENT),
                        packRowLength: this.getParameter(this.PACK_ROW_LENGTH),
                        framebuffer: Boolean(this.getParameter(this.READ_FRAMEBUFFER_BINDING)),
                        stack: new Error().stack,
                    }));
                }
                return result;
            };
        });
    }

    try {
        const url = `http://127.0.0.1:${server.address().port}/index.html`;
        console.log(`phase: navigate ${url}`);
        await page.goto(url, {waitUntil: 'networkidle0', timeout: 120000});
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000});
        const renderer = await page.evaluate(() => window.AzaharWebConfig?.renderer);
        const adapter = consoleMessages.find(message => message.includes('WebGL2 adapter:')) || '';

        console.log('phase: load ROM and cold-boot title');
        await (await page.$('#rom-file')).uploadFile(romPath);
        await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, {timeout: 30000});
        await page.click('#btn-load');
        await page.waitForFunction(() => !document.querySelector('#btn-stop').disabled, {timeout: 120000});
        await sleep(titleWaitMs);
        const before = await readRuntimeState(page);
        await page.screenshot({path: path.join(captureDir, 'before-touch.png'), fullPage: true});

        console.log('phase: click center of emulated lower touch screen');
        const touchPoint = await page.$eval('#canvas', canvas => {
            canvas.scrollIntoView({block: 'center', inline: 'center'});
            const rect = canvas.getBoundingClientRect();
            // The combined canvas is 400x480. The title button occupies the
            // bottom of the 320x240 touch display (roughly native y=450).
            return {x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.94};
        });
        await page.mouse.move(touchPoint.x, touchPoint.y);
        await page.mouse.down();
        await sleep(120);
        await page.mouse.up();

        await sleep(transitionWaitMs);
        const heartbeatStarted = Date.now();
        const after = await readRuntimeState(page);
        const heartbeatMs = Date.now() - heartbeatStarted;
        await page.screenshot({path: path.join(captureDir, 'after-touch.png'), fullPage: true});
        if (heartbeatMs > heartbeatLimitMs) {
            throw new Error(`Browser main thread stalled for ${heartbeatMs} ms after title touch`);
        }
        if (!after.fpsText || after.fpsText === before.fpsText) {
            throw new Error(`Emulation display counters stopped after title touch: ${JSON.stringify({before, after})}`);
        }
        if (!after.running || !after.status?.startsWith('Running')) {
            throw new Error(`Emulation stopped during the title transition: ${JSON.stringify({before, after})}`);
        }
        const invalidUploads = consoleMessages.filter(message =>
            message.includes('texSubImage2D') &&
            (message.includes('INVALID_OPERATION') || message.includes('not big enough')));
        if (invalidUploads.length) {
            throw new Error(`Invalid WebGL texture uploads after title touch: ${JSON.stringify(invalidUploads.slice(0, 10))}`);
        }
        if (pageErrors.length) throw new Error(`Browser errors: ${JSON.stringify(pageErrors)}`);

        console.log(JSON.stringify({
            ok: true,
            renderer,
            adapter,
            titleWaitMs,
            transitionWaitMs,
            heartbeatMs,
            before,
            after,
            captures: captureDir,
        }, null, 2));
    } catch (error) {
        const diagnostics = await page.evaluate(() => ({
            status: document.querySelector('#status')?.textContent,
            fpsText: document.querySelector('#fps')?.textContent,
            log: document.querySelector('#log')?.textContent,
            heapBytes: typeof Module === 'undefined' ? null : Module.HEAPU8?.byteLength,
        })).catch(() => ({}));
        console.error(JSON.stringify({
            error: error.stack || String(error),
            diagnostics,
            consoleMessages: consoleMessages.filter(message =>
                !message.includes('texSubImage2D: ArrayBufferView not big enough')).slice(-150),
            pageErrors,
        }, null, 2));
        process.exitCode = 1;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
