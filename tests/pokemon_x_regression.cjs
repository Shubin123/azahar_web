'use strict';
// Pokemon X gameplay regression: cold-boots the title in the production UI,
// confirms the language menu, presses A through the title and the opening,
// and samples the canvas every 20 seconds once the 3D intro starts.
//
// It fails on:
//   - a stripe artifact: Pokemon X/Y's outline pass reads the depth buffer
//     back as colour, and when that reinterpretation is wrong the 3D scene
//     shows a striped overlay with every few framebuffer rows dark;
//   - on the software renderer, a game that stops presenting frames: a racy
//     physical-memory lookup once sent GPU reads to the wrong memory, so a
//     command list read as zeros and the opening froze;
//   - an emulator run error (the UI's "Run error" log line), a stopped
//     emulator, or a guest that keeps running but stops presenting frames.
//
// Environment:
//   AZAHAR_POKEMON_X_ROM   decrypted Pokemon X image (default: test_games/Pokemon_X*.3ds)
//   AZAHAR_RENDERER        webgl2 (default) or software
//   AZAHAR_WEB_DIR         web root to serve (default: web/)
//   AZAHAR_CAPTURE_DIR     where sampled frames are written (default: tmp_test/pokemon-x)
//   AZAHAR_POKEMON_X_SECONDS  wall-clock length of the run (default 280)
// Captures stay under the ignored tmp_test; never publish game data.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {listen: listenWeb} = require('../web/server.cjs');
const cfg = require('./config.cjs');

const root = path.resolve(__dirname, '..');
const webDir = path.resolve(process.env.AZAHAR_WEB_DIR || path.join(root, 'web'));
const renderer = process.env.AZAHAR_RENDERER || 'webgl2';
const captureDir = process.env.AZAHAR_CAPTURE_DIR || path.join(root, 'tmp_test', 'pokemon-x');
const totalSeconds = Number(process.env.AZAHAR_POKEMON_X_SECONDS || 280);
// The language menu is up about a minute after boot at full speed.
const languageMenuSeconds = 62;
// Sampling starts once the title and opening are past their 2D screens.
const firstSampleSeconds = 150;
const sampleEverySeconds = 20;
// Rendered scenes measure 0.6-0.9; the striped overlay measured 3.5.
const maxStripeAnisotropy = Number(process.env.AZAHAR_MAX_STRIPE_ANISOTROPY || 2.5);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function findRom() {
    if (process.env.AZAHAR_POKEMON_X_ROM) return process.env.AZAHAR_POKEMON_X_ROM;
    const directory = path.join(root, 'test_games');
    try {
        const name = fs.readdirSync(directory).find(file =>
            /pok[eé]mon[ _-]?x[ _(]/i.test(file) && /\.(3ds|cci|cia)$/i.test(file));
        return name ? path.join(directory, name) : null;
    } catch (_) {
        return null;
    }
}

// Ratio of horizontal to vertical neighbour differences over the top screen
// of a canvas screenshot (the upper half of the 400x480 layout).
async function stripeAnisotropy(page, pngBase64) {
    return page.evaluate(async data => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        context.drawImage(image, 0, 0);
        const {width, height} = canvas;
        const pixels = context.getImageData(0, 0, width, height).data;
        // Screenshots are the CSS size (2x the native canvas); compare
        // native pixels so the scaling itself does not count as detail.
        const step = Math.max(1, Math.round(width / 400));
        const luma = (x, y) => {
            const i = (y * width + x) * 4;
            return pixels[i] + pixels[i + 1] + pixels[i + 2];
        };
        let horizontal = 0;
        let vertical = 0;
        let count = 0;
        for (let y = 2 * step; y < height / 2 - 2 * step; y += step) {
            for (let x = 2 * step; x < width - 2 * step; x += step) {
                const value = luma(x, y);
                horizontal += Math.abs(value - luma(x + step, y));
                vertical += Math.abs(value - luma(x, y + step));
                ++count;
            }
        }
        // A floor of two luma steps per pixel keeps flat screens (a white
        // top screen, a fade) near 1 instead of dividing by almost nothing.
        const floor = 2 * count;
        return (horizontal + floor) / (vertical + floor);
    }, pngBase64);
}

async function main() {
    const rom = findRom();
    if (!rom || !fs.existsSync(rom)) {
        console.log('Skipped: no Pokemon X image (set AZAHAR_POKEMON_X_ROM).');
        return;
    }
    fs.mkdirSync(captureDir, {recursive: true});
    const server = await listenWeb(0, '127.0.0.1', {root: webDir});
    const browser = await puppeteer.launch({
        headless: process.env.AZAHAR_HEADLESS === '0' ? false : 'new',
        executablePath: process.env.CHROME_PATH || cfg.chromePath || 'chrome',
        protocolTimeout: 120000,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: {width: 1280, height: 1200},
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    const samples = [];
    try {
        const url = `http://127.0.0.1:${server.address().port}/index.html?renderer=${renderer}`;
        await page.goto(url, {waitUntil: 'networkidle0', timeout: 120000});
        await page.waitForFunction(
            () => document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000});
        await (await page.$('#rom-file')).uploadFile(rom);
        await page.waitForFunction(() => !document.querySelector('#btn-load').disabled,
            {timeout: 60000});
        await page.click('#btn-load');
        await page.waitForFunction(() => !document.querySelector('#btn-stop').disabled,
            {timeout: 120000});

        const started = Date.now();
        const elapsed = () => (Date.now() - started) / 1000;
        const pressA = async () => {
            await page.keyboard.down('a');
            await sleep(150);
            await page.keyboard.up('a');
        };
        let nextPress = languageMenuSeconds;
        let nextSample = firstSampleSeconds;
        while (elapsed() < totalSeconds) {
            await sleep(250);
            const state = await page.evaluate(() => ({
                running: !document.querySelector('#btn-stop')?.disabled,
                log: document.querySelector('#log')?.textContent || '',
            }));
            const runError = /Run error: [^\n]*/.exec(state.log);
            if (runError) throw new Error(`${runError[0]} at ${elapsed().toFixed(0)} s`);
            if (!state.running) throw new Error(`Emulation stopped at ${elapsed().toFixed(0)} s`);
            if (elapsed() >= nextPress) {
                await pressA();
                // Dialogue in the opening needs repeated confirmation.
                nextPress = elapsed() + 4;
            }
            if (elapsed() >= nextSample) {
                const canvas = await page.$('#canvas');
                const png = await canvas.screenshot({encoding: 'base64'});
                const name = `t${String(Math.round(elapsed())).padStart(4, '0')}.png`;
                fs.writeFileSync(path.join(captureDir, name), Buffer.from(png, 'base64'));
                const anisotropy = await stripeAnisotropy(page, png);
                const fps = await page.$eval('#fps', element => element.textContent);
                samples.push({seconds: Math.round(elapsed()), anisotropy, fps, file: name});
                console.log(`  t=${Math.round(elapsed())}s stripes=${anisotropy.toFixed(2)} ${fps}`);
                nextSample += sampleEverySeconds;
                // The opening never stops presenting for 20 s; a guest that
                // deadlocks keeps emulating but presents nothing.
                const presenting = sample => !/^0 game FPS/.test(sample.fps || '');
                if (samples.length >= 2 && !samples.slice(-2).some(presenting)) {
                    throw new Error(`Game stopped presenting frames by ${Math.round(elapsed())} s`);
                }
            }
        }
        const striped = samples.filter(sample => sample.anisotropy > maxStripeAnisotropy);
        if (striped.length) {
            throw new Error(`Stripe artifact in ${striped.length} of ${samples.length} frames ` +
                `(anisotropy ${striped.map(s => s.anisotropy.toFixed(2)).join(', ')} > ` +
                `${maxStripeAnisotropy}); see ${captureDir}`);
        }
        if (pageErrors.length) throw new Error(`Page errors: ${pageErrors.join('; ')}`);
        console.log(`--- POKEMON X ${renderer.toUpperCase()} REGRESSION PASSED ` +
            `(${samples.length} frames, max anisotropy ` +
            `${Math.max(...samples.map(s => s.anisotropy)).toFixed(2)}) ---`);
    } finally {
        fs.writeFileSync(path.join(captureDir, 'samples.json'), JSON.stringify(samples, null, 2));
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(`Pokemon X regression failed: ${error.message}`);
    process.exitCode = 1;
});
