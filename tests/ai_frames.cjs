'use strict';
// Saves what the AI player's model sees while a game runs: AzaharAIPlayer's 256x256 input
// (input_NNNN.png) and the top screen it was made from (raw_NNNN.png), read from the
// canvas right after a frame. scripts/nitrogen/nitrogen_validate.py checks the model on
// them. Random keys are held between captures so the scenes change.
//
//   node tests/ai_frames.cjs --rom ROM --out DIR [--state STATE.cst] [--frames 40]
//        [--every-ms 1500] [--boot-seconds 20] [--seed 1]
//
// Captures hold game images: keep them under the ignored tmp_test, never publish them.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {listen} = require('../web/server.cjs');
const cfg = require('./config.cjs');
const {restoreState} = require('./fixture_state.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
};

// Keys a player would press: the Circle Pad, D-pad, face buttons and shoulders.
const KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyS', 'KeyZ', 'KeyX',
    'KeyT', 'KeyG', 'KeyF', 'KeyH', 'KeyQ', 'KeyW'];

async function bootGame(page, rom, state, bootSeconds) {
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Emulator ready'),
        {timeout: 120000});
    await (await page.$('#rom-file')).uploadFile(rom);
    await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, {timeout: 60000});
    await page.click('#btn-load');
    await page.waitForFunction(() => window.AzaharUI?.isPlaying?.(), {timeout: 180000});
    if (state) await restoreState(page, state);
    else await sleep(bootSeconds * 1000);
}

// One frame's input and top screen as PNGs (base64).
function captureFrame(page) {
    return page.evaluate(async () => {
        const seen = await window.AzaharAIPlayer.nextFrameInput();
        if (!seen) return null;
        const png = async (width, height, rgba) => {
            const canvas = new OffscreenCanvas(width, height);
            canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
            const bytes = new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer());
            let text = '';
            for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(text);
        };
        const rgba = new Uint8ClampedArray(256 * 256 * 4);
        for (let i = 0, o = 0; i < seen.input.length; i += 3, o += 4) {
            rgba[o] = seen.input[i]; rgba[o + 1] = seen.input[i + 1]; rgba[o + 2] = seen.input[i + 2]; rgba[o + 3] = 255;
        }
        return {input: await png(256, 256, rgba),
            raw: await png(seen.raw.width, seen.raw.height, seen.raw.data),
            width: seen.raw.width, height: seen.raw.height, guestUs: seen.guestUs};
    });
}

async function main() {
    const rom = option('--rom');
    const out = option('--out');
    if (!rom || !out) throw new Error('Usage: node tests/ai_frames.cjs --rom ROM --out DIR [--state STATE.cst]');
    const frames = Number(option('--frames', 40));
    const everyMs = Number(option('--every-ms', 1500));
    let seed = Number(option('--seed', 1));
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    fs.mkdirSync(out, {recursive: true});
    const server = await listen(0, '127.0.0.1', {root: cfg.webDir});
    const browser = await puppeteer.launch({executablePath: cfg.chromePath, headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 180000,
        defaultViewport: {width: 1280, height: 1100}});
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, {waitUntil: 'load'});
        await bootGame(page, path.resolve(rom), option('--state'), Number(option('--boot-seconds', 20)));
        const saved = [];
        for (let index = 0; index < frames; index++) {
            const held = KEYS.filter(() => random() < 0.12);
            await page.evaluate(codes => window.AzaharInput.setSourceCodes('test', codes), held);
            await sleep(everyMs * (0.5 + random()));
            await page.evaluate(() => window.AzaharInput.setSourceCodes('test', []));
            const frame = await captureFrame(page);
            if (!frame) throw new Error('No frame to capture');
            const name = String(index).padStart(4, '0');
            fs.writeFileSync(path.join(out, `input_${name}.png`), Buffer.from(frame.input, 'base64'));
            fs.writeFileSync(path.join(out, `raw_${name}.png`), Buffer.from(frame.raw, 'base64'));
            saved.push({name, held, width: frame.width, height: frame.height, guestUs: frame.guestUs});
        }
        fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify({rom: path.basename(rom),
            state: option('--state') ? path.basename(option('--state')) : null, frames: saved, errors}, null, 1));
        if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
        console.log(`Saved ${saved.length} frames (${saved[0].width}x${saved[0].height} top screen) in ${out}`);
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch(error => {
    console.error(`ai_frames failed: ${error.message}`);
    process.exitCode = 1;
});
