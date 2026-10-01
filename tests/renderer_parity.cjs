'use strict';
// Renderer parity: boots each title in the production UI on the WebGL2 and
// the software renderer, captures the top screen at several guest times in
// a window, and compares the colour distributions of the two series.
// Asset loads finish in host time, so the renderers reach a given scene at
// slightly different guest times; a distribution over a window tolerates
// that drift, and a coarse histogram ignores filtering and edge differences.
//
// It does not tolerate whole-scene errors: WebGL2 once rendered fog, lighting
// and procedural textures from never-uploaded lookup tables, which turned
// Super Mario 3D Land's level into sky and erased Animal Crossing's and Fire
// Emblem's backgrounds.
//
// Environment:
//   AZAHAR_PARITY_TITLES  comma-separated name:fromSeconds-toSeconds entries; names
//                         match test_games files by prefix (default: built-in list)
//   AZAHAR_SM3DL_ROM      path to the Super Mario 3D Land kiosk demo, if not in test_games
//   AZAHAR_PARITY_GPU     1 to run WebGL2 on the host GPU (ANGLE/Vulkan) instead of SwiftShader
//   AZAHAR_WEB_DIR        web root to serve (default: web/)
//   AZAHAR_CAPTURE_DIR    where frames are written (default: tmp_test/renderer-parity)
//   AZAHAR_MAX_PARITY_DIFF  failure threshold, total variation distance of the
//                         colour histograms, 0-1 (default 0.45). Measured with
//                         an NVIDIA GPU: correct builds 0.15-0.30, the LUT bug
//                         0.66 (Animal Crossing) and 0.80 (Mario).
// Captures stay under the ignored tmp_test; never publish game data.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {listen: listenWeb} = require('../web/server.cjs');
const cfg = require('./config.cjs');

const root = path.resolve(__dirname, '..');
const webDir = path.resolve(process.env.AZAHAR_WEB_DIR || path.join(root, 'web'));
const captureDir = process.env.AZAHAR_CAPTURE_DIR || path.join(root, 'tmp_test', 'renderer-parity');
const maxDiff = Number(process.env.AZAHAR_MAX_PARITY_DIFF || 0.45);
const gpuArgs = process.env.AZAHAR_PARITY_GPU === '1' ?
    ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] : [];
// Guest-time windows (seconds) covering each title's 3D title scene, which
// is reached without input. Cubic Ninja is a control the LUT bug never
// affected. Titles whose boot logos run for host-dependent lengths (such as
// Adventure Time) drift too far between the renderers to compare.
const defaultTitles = 'Super Mario 3D Land:18-40,Animal_Crossing:25-45,Cubic_Ninja:20-40';
// Frames captured per window.
const framesPerWindow = 8;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function findRom(name) {
    if (/^super mario 3d land/i.test(name) && process.env.AZAHAR_SM3DL_ROM) {
        return process.env.AZAHAR_SM3DL_ROM;
    }
    const directory = path.join(root, 'test_games');
    try {
        const prefix = name.toLowerCase().replace(/[ _]/g, '');
        const file = fs.readdirSync(directory).find(entry =>
            entry.toLowerCase().replace(/[ _]/g, '').startsWith(prefix) &&
            /\.(3ds|cci|cia)$/i.test(entry));
        return file ? path.join(directory, file) : null;
    } catch (_) {
        return null;
    }
}

// Normalised 8x8x8-bin colour histogram of the top screen (upper half of
// the 400x480 canvas layout), from a screenshot at any scale.
async function topScreenHistogram(page, pngBase64) {
    return page.evaluate(async data => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, Math.floor(image.height / 2)).data;
        const histogram = new Array(512).fill(0);
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            histogram[(pixels[i] >> 5) * 64 + (pixels[i + 1] >> 5) * 8 + (pixels[i + 2] >> 5)]++;
            count++;
        }
        return histogram.map(value => value / count);
    }, pngBase64);
}

function totalVariation(a, b) {
    let total = 0;
    for (let i = 0; i < a.length; ++i) total += Math.abs(a[i] - b[i]);
    return total / 2;
}

async function captureSeries(browser, port, rom, renderer, from, to, filePrefix) {
    const page = await browser.newPage();
    try {
        await page.goto(`http://127.0.0.1:${port}/index.html?renderer=${renderer}`,
            {waitUntil: 'networkidle0', timeout: 120000});
        await page.waitForFunction(
            () => document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000});
        await (await page.$('#rom-file')).uploadFile(rom);
        await page.waitForFunction(() => !document.querySelector('#btn-load').disabled,
            {timeout: 60000});
        await page.click('#btn-load');
        await page.waitForFunction(() => !document.querySelector('#btn-stop').disabled,
            {timeout: 120000});
        const readGuestSeconds = () => page.evaluate(() => {
            if (!Module._azahar_get_perf_stats) return 0;
            const buffer = Module._malloc(88);
            Module._azahar_get_perf_stats(buffer, 11);
            const guestUs = new Float64Array(Module.HEAPU8.buffer, buffer, 11)[10];
            Module._free(buffer);
            return guestUs / 1e6;
        });
        const frames = [];
        const deadline = Date.now() + 900000;
        for (let n = 0; n < framesPerWindow; ++n) {
            const target = from + (to - from) * n / (framesPerWindow - 1);
            let guest = 0;
            while ((guest = await readGuestSeconds()) < target) {
                const log = await page.$eval('#log', element => element.textContent);
                const runError = /Run error: [^\n]*/.exec(log);
                if (runError) throw new Error(`${renderer}: ${runError[0]}`);
                if (Date.now() > deadline) {
                    throw new Error(`${renderer}: guest reached only ${guest.toFixed(1)} s`);
                }
                await sleep(50);
            }
            const png = await (await page.$('#canvas')).screenshot({encoding: 'base64'});
            fs.writeFileSync(`${filePrefix}_${String(Math.round(guest)).padStart(3, '0')}.png`,
                Buffer.from(png, 'base64'));
            frames.push(png);
        }
        return {frames, page};
    } catch (error) {
        await page.close();
        throw error;
    }
}

async function main() {
    const titles = (process.env.AZAHAR_PARITY_TITLES || defaultTitles).split(',').map(entry => {
        const [name, window = '20-40'] = entry.split(':');
        const [from, to] = window.split('-').map(Number);
        return {name, from, to, rom: findRom(name)};
    }).filter(title => title.rom && fs.existsSync(title.rom));
    if (!titles.length) {
        console.log('Skipped: none of the parity titles are available.');
        return;
    }
    fs.mkdirSync(captureDir, {recursive: true});
    const server = await listenWeb(0, '127.0.0.1', {root: webDir});
    const browser = await puppeteer.launch({
        headless: process.env.AZAHAR_HEADLESS === '0' ? false : 'new',
        executablePath: process.env.CHROME_PATH || cfg.chromePath || 'chrome',
        protocolTimeout: 180000,
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...gpuArgs],
        defaultViewport: {width: 1280, height: 1200},
    });
    const failures = [];
    const results = [];
    try {
        for (const title of titles) {
            const slug = title.name.replace(/[^a-z0-9]+/gi, '_');
            const series = {};
            for (const renderer of ['software', 'webgl2']) {
                series[renderer] = await captureSeries(browser, server.address().port, title.rom,
                    renderer, title.from, title.to, path.join(captureDir, `${slug}_${renderer}`));
            }
            const page = series.webgl2.page;
            const histograms = {};
            for (const [renderer, {frames}] of Object.entries(series)) {
                const sum = new Array(512).fill(0);
                for (const png of frames) {
                    (await topScreenHistogram(page, png)).forEach((value, i) => sum[i] += value);
                }
                histograms[renderer] = sum.map(value => value / frames.length);
            }
            for (const capture of Object.values(series)) await capture.page.close();
            const worst = totalVariation(histograms.software, histograms.webgl2);
            results.push({title: title.name, from: title.from, to: title.to, distance: worst});
            console.log(`  ${title.name} @${title.from}-${title.to}s: distance ${worst.toFixed(2)}` +
                `${worst > maxDiff ? '  <-- MISMATCH' : ''}`);
            if (worst > maxDiff) failures.push(`${title.name} (${worst.toFixed(2)})`);
        }
    } finally {
        fs.writeFileSync(path.join(captureDir, 'results.json'), JSON.stringify(results, null, 2));
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
    if (failures.length) {
        throw new Error(`WebGL2 and software frames differ beyond ${maxDiff}: ${failures.join(', ')}; ` +
            `see ${captureDir}`);
    }
    console.log(`--- RENDERER PARITY PASSED (${results.length} titles) ---`);
}

main().catch(error => {
    console.error(`Renderer parity failed: ${error.message}`);
    process.exitCode = 1;
});
