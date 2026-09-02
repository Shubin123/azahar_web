// Real-gameplay compositor and input gate for future renderer backends.
// ROMs, .cst files, and optional captures remain local/ignored.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {createWebServer} = require('../../web/server.cjs');

const root = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
function argValue(flag, fallback = null) {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] || fallback : fallback;
}

const romPath = process.env.AZAHAR_ROM_PATH || path.join(root, 'test_games',
    'Super Mario 3D Land (Europe) (En,Fr,De,Es,It) (Demo) (Kiosk).3ds');
const statePath = argValue('--state', process.env.AZAHAR_GAMEPLAY_STATE_PATH);
const captureDir = argValue('--capture-dir');
const artifact = argValue('--artifact', 'software');

if (!['software', 'webgl2'].includes(artifact)) {
    throw new Error('Usage: --artifact software|webgl2');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function serveFixture(rom, state) {
    const webServer = createWebServer(path.join(root, 'web'));
    const files = {
        '/gameplay_rom': fs.readFileSync(rom),
        '/gameplay_state': fs.readFileSync(state),
    };
    return http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const bytes = files[pathname];
        if (bytes) {
            response.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': bytes.length,
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Resource-Policy': 'cross-origin',
                'Cache-Control': 'no-store',
            });
            response.end(bytes);
            return;
        }
        webServer.emit('request', request, response);
    });
}

async function captureVisibleFrame(page, destination) {
    const clip = await page.$eval('#canvas', canvas => {
        const rect = canvas.getBoundingClientRect();
        return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
    });
    const png = await page.screenshot({encoding: 'base64', clip});
    if (destination) fs.writeFileSync(destination, Buffer.from(png, 'base64'));
    return page.evaluate(async encoded => {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded}`;
        await image.decode();
        const sample = document.createElement('canvas');
        sample.width = image.naturalWidth;
        sample.height = image.naturalHeight;
        const context = sample.getContext('2d', {willReadFrequently: true});
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
        const thumbnail = [];
        let nonBlack = 0;
        let colorful = 0;
        let samples = 0;
        for (let y = 0; y < sample.height; y += 16) {
            for (let x = 0; x < sample.width; x += 16) {
                const index = (y * sample.width + x) * 4;
                const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
                const high = Math.max(red, green, blue);
                if (high > 8) nonBlack++;
                if (high - Math.min(red, green, blue) > 24) colorful++;
                thumbnail.push(red >> 4, green >> 4, blue >> 4);
                samples++;
            }
        }
        return {width: sample.width, height: sample.height, samples,
            nonBlackCoverage: nonBlack / samples, colorfulCoverage: colorful / samples, thumbnail};
    }, png);
}

function visibleGameFrame(frame) {
    return frame.nonBlackCoverage >= 0.05 && frame.colorfulCoverage >= 0.01;
}

function changedCoverage(before, after) {
    let changed = 0;
    const pixels = Math.min(before.thumbnail.length, after.thumbnail.length) / 3;
    for (let i = 0; i < pixels; i++) {
        const offset = i * 3;
        if (Math.max(
            Math.abs(before.thumbnail[offset] - after.thumbnail[offset]),
            Math.abs(before.thumbnail[offset + 1] - after.thumbnail[offset + 1]),
            Math.abs(before.thumbnail[offset + 2] - after.thumbnail[offset + 2]),
        ) >= 2) changed++;
    }
    return changed / pixels;
}

async function main() {
    if (!statePath) throw new Error('Pass --state <moving-gameplay.cst> or AZAHAR_GAMEPLAY_STATE_PATH');
    for (const file of [romPath, statePath]) {
        if (!fs.existsSync(file)) throw new Error(`Fixture not found: ${file}`);
    }
    if (captureDir) fs.mkdirSync(captureDir, {recursive: true});
    const server = serveFixture(romPath, statePath);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const browser = await puppeteer.launch({
        headless: 'new', executablePath: process.env.CHROME_PATH,
        args: ['--no-sandbox', '--disable-dev-shm-usage'], defaultViewport: {width: 1280, height: 900},
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    const consoleMessages = [];
    page.on('console', message => {
        consoleMessages.push(`${message.type()}: ${message.text()}`);
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    try {
        const port = server.address().port;
        const pageName = artifact === 'webgl2' ? 'index_webgl2.html' : 'index.html';
        await page.goto(`http://127.0.0.1:${port}/${pageName}`, {waitUntil: 'networkidle0', timeout: 120000});
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000});
        // A WebGL2 page may deliberately navigate to the stable software page
        // when context creation fails. That is a valid user-facing fallback,
        // but it cannot satisfy an experimental renderer gate: assert the
        // requested backend before a compositor pass can be misattributed.
        if (artifact === 'webgl2') {
            const webgl2Active = await page.evaluate(() => {
                const canvas = document.querySelector('#canvas');
                return window.AzaharWebConfig?.renderer === 'webgl2' &&
                    canvas?.getContext('webgl2') !== null;
            });
            if (!webgl2Active) {
                const pageState = await page.evaluate(() => ({
                    renderer: window.AzaharWebConfig?.renderer,
                    status: document.querySelector('#status')?.textContent,
                }));
                throw new Error(`Requested WebGL2 artifact fell back before gameplay gate: ${JSON.stringify({url: page.url(), ...pageState, console: consoleMessages.slice(-20)})}`);
            }
        }
        await (await page.$('#rom-file')).uploadFile(romPath);
        await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, {timeout: 30000});
        await page.click('#btn-load');
        await page.waitForFunction(() => !document.querySelector('#btn-stop').disabled, {timeout: 120000});
        // The button flips as soon as the browser loop starts, before the ROM
        // has completed its first render. Queueing a state load in that gap is
        // nondeterministic: it can be accepted but apply during boot. Wait for
        // the same renderer-ready milestone shown to a real browser user.
        await page.waitForFunction(() => {
            const status = document.querySelector('#status')?.textContent || '';
            return status.includes('Renderer graphics ready') ||
                status.includes('Running. Visible game graphics detected');
        }, {timeout: 180000});
        const restoreResult = await page.evaluate(async stateName => {
            const response = await fetch('/gameplay_state');
            if (!response.ok) throw new Error(`state download failed: ${response.status}`);
            Module.FS.mkdirTree('/home/web_user/.local/share/azahar-emu/states');
            Module.FS.writeFile(`/home/web_user/.local/share/azahar-emu/states/${stateName}`,
                new Uint8Array(await response.arrayBuffer()), {canOwn: false});
            return Module._azahar_load_state(1);
        }, path.basename(statePath));
        if (restoreResult !== 0) throw new Error(`azahar_load_state rejected slot 1: ${restoreResult}`);
        await sleep(3000);
        const before = await captureVisibleFrame(page, captureDir && path.join(captureDir, 'before-input.png'));
        const rendererPixels = artifact === 'webgl2' ? -2 :
            await page.evaluate(() => Module._azahar_framebuffer_nonblack_pixels());
        // The compositor capture is the compatibility condition. The native
        // count remains diagnostic only: a future GPU-resident WebGL2 surface
        // does not need to mirror every pixel through a CPU staging buffer.
        if (!visibleGameFrame(before)) {
            throw new Error(`Restored state is not visibly rendered: ${JSON.stringify({rendererPixels,
                before: {...before, thumbnail: undefined}})}`);
        }
        await page.keyboard.down('ArrowRight');
        await sleep(2500);
        await page.keyboard.up('ArrowRight');
        await sleep(500);
        const after = await captureVisibleFrame(page, captureDir && path.join(captureDir, 'after-input.png'));
        const motion = changedCoverage(before, after);
        if (!visibleGameFrame(after) || motion < 0.002) {
            throw new Error(`Gameplay input did not change a visible frame: ${JSON.stringify({after: {...after,
                thumbnail: undefined}, motion})}`);
        }
        if (consoleErrors.length) throw new Error(`Browser errors: ${JSON.stringify(consoleErrors)}`);
        console.log(JSON.stringify({ok: true, artifact, rendererPixels, before: {...before, thumbnail: undefined},
            after: {...after, thumbnail: undefined}, motion}, null, 2));
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
