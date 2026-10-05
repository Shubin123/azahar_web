/**
 * fullscreen.test.cjs
 * Checks the fullscreen view: the layout keeps both screens' aspect ratios,
 * keeps the bottom screen within the user's bounds of the top screen, and
 * fits the display; the engine canvas follows the display and returns to the
 * native 400x480 frame on exit. Runs a homebrew title when one is available
 * (AZAHAR_FULLSCREEN_ROM, default tmp_test/homebrew/craftus_reloaded.3dsx).
 *
 * Usage: node tests/fullscreen.test.cjs [--renderer=software]
 *   AZAHAR_CAPTURE_DIR=<dir>  also save screenshots of the fullscreen view
 */
'use strict';

const puppeteer = require('puppeteer-core');
const { listen } = require('../web/server.cjs');
const cfg = require('./config.cjs');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const romPath = process.env.AZAHAR_FULLSCREEN_ROM ||
    path.join(cfg.ROOT, 'tmp_test', 'homebrew', 'craftus_reloaded.3dsx');
const software = process.argv.includes('--renderer=software');
const captureDir = process.env.AZAHAR_CAPTURE_DIR;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function checkLayout(layout, width, height, settings, label) {
    const { top, bottom } = layout;
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    assert.ok(near(top.w / top.h, 400 / 240), `${label}: top screen keeps 5:3`);
    assert.ok(near(bottom.w / bottom.h, 320 / 240), `${label}: bottom screen keeps 4:3`);
    const ratio = bottom.h / top.h;
    assert.ok(ratio >= settings.bottomMin / 100 - 1e-6 && ratio <= settings.bottomMax / 100 + 1e-6,
        `${label}: bottom screen ${ratio} within ${settings.bottomMin}-${settings.bottomMax}%`);
    for (const [name, rect] of [['top', top], ['bottom', bottom]]) {
        assert.ok(rect.x >= -1e-6 && rect.y >= -1e-6 && rect.x + rect.w <= width + 1e-6 &&
            rect.y + rect.h <= height + 1e-6, `${label}: ${name} screen fits the display`);
    }
    const overlapX = Math.min(top.x + top.w, bottom.x + bottom.w) - Math.max(top.x, bottom.x);
    const overlapY = Math.min(top.y + top.h, bottom.y + bottom.h) - Math.max(top.y, bottom.y);
    assert.ok(overlapX <= 1e-6 || overlapY <= 1e-6, `${label}: screens do not overlap`);
}

async function runTests() {
    if (!cfg.chromePath) {
        console.log('SKIP: Chrome not found (set CHROME_PATH).');
        return;
    }
    console.log(`--- Starting Fullscreen Tests (${software ? 'software' : 'WebGL2'}) ---`);
    const port = 8793;
    const server = await listen(port, '127.0.0.1');
    const browser = await puppeteer.launch({
        executablePath: cfg.chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=metal', '--enable-gpu',
            '--ignore-gpu-blocklist']
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
        const query = software ? 'renderer=software' : 'renderer=webgl2';
        await page.goto(`http://127.0.0.1:${port}/index.html?${query}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.AzaharFullscreen && window.AzaharUI?.isInitialized(),
            { timeout: 120000 });

        console.log('Test 1: layouts keep shapes and bounds on many displays...');
        const cases = [];
        for (const [width, height] of [[1920, 1080], [1280, 720], [2560, 1080], [1024, 768],
            [800, 1280], [390, 844], [844, 390], [600, 600]]) {
            for (const settings of [{ bottomMin: 40, bottomMax: 70 }, { bottomMin: 20, bottomMax: 20 },
                { bottomMin: 90, bottomMax: 100 }, { bottomMin: 50, bottomMax: 100 }]) {
                for (const arrangement of ['auto', 'side', 'stacked']) {
                    cases.push({ width, height, settings: { ...settings, arrangement } });
                }
            }
        }
        const layouts = await page.evaluate(cases => {
            const results = [];
            const min = document.getElementById('fullscreen-bottom-min');
            const max = document.getElementById('fullscreen-bottom-max');
            const arrangement = document.getElementById('fullscreen-arrangement');
            for (const c of cases) {
                max.value = '100'; max.dispatchEvent(new Event('input'));
                min.value = String(c.settings.bottomMin); min.dispatchEvent(new Event('input'));
                max.value = String(c.settings.bottomMax); max.dispatchEvent(new Event('input'));
                arrangement.value = c.settings.arrangement; arrangement.dispatchEvent(new Event('change'));
                results.push(window.AzaharFullscreen.computeLayout(c.width, c.height));
            }
            return results;
        }, cases);
        cases.forEach((c, i) => checkLayout(layouts[i], c.width, c.height, c.settings,
            `${c.width}x${c.height} ${JSON.stringify(c.settings)}`));
        // On a 16:9 display with room to spare the bottom screen grows to its maximum.
        const wide = await page.evaluate(() => {
            const set = (id, value, type = 'input') => {
                const el = document.getElementById(id);
                el.value = value;
                el.dispatchEvent(new Event(type));
            };
            set('fullscreen-bottom-max', '70');
            set('fullscreen-bottom-min', '40');
            set('fullscreen-arrangement', 'auto', 'change');
            return window.AzaharFullscreen.computeLayout(1920, 1080);
        });
        assert.strictEqual(wide.kind, 'side', 'Wide display puts the screens side by side');
        assert.ok(wide.bottom.h < wide.top.h, 'Bottom screen is smaller than the top screen');
        console.log(`  1920x1080: top ${wide.top.w}x${wide.top.h}, bottom ${wide.bottom.w}x${wide.bottom.h}`);

        if (fs.existsSync(romPath)) {
            console.log('Test 2: a running title draws into the fullscreen canvas...');
            await (await page.$('#rom-file')).uploadFile(romPath);
            await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, { timeout: 60000 });
            await page.click('#btn-load');
            await page.waitForFunction(() => window.AzaharUI.isRunning(), { timeout: 120000 });
            await sleep(software ? 15000 : 8000);
        } else {
            console.log(`  (no homebrew at ${romPath}; checking the idle canvas only)`);
        }

        // The button on the emulator screen enters fullscreen and hides there.
        await page.click('#btn-fullscreen-stage');
        await page.waitForFunction(() => window.AzaharFullscreen.isActive());
        assert.strictEqual(await page.$eval('#btn-fullscreen-stage', el => el.offsetParent), null,
            'On-screen fullscreen button is hidden while fullscreen');
        await page.waitForFunction(() => document.getElementById('canvas').width !== 400, { timeout: 5000 });
        const state = await page.evaluate(() => {
            const stage = document.getElementById('screen-stage');
            const canvas = document.getElementById('canvas');
            return {
                stage: [stage.clientWidth, stage.clientHeight],
                canvas: [canvas.width, canvas.height],
                css: [canvas.clientWidth, canvas.clientHeight],
                native: !!document.fullscreenElement,
                settingsInOverlay: !!document.querySelector('#fullscreen-overlay-panel #fullscreen-settings'),
                layout: window.AzaharFullscreen.computeLayout(stage.clientWidth, stage.clientHeight)
            };
        });
        console.log(`  stage ${state.stage.join('x')}, canvas ${state.canvas.join('x')}, ` +
            `${state.native ? 'browser fullscreen' : 'window-filling view'}`);
        const stageAspect = state.stage[0] / state.stage[1];
        const canvasAspect = state.canvas[0] / state.canvas[1];
        assert.ok(Math.abs(stageAspect - canvasAspect) < 0.01, 'Canvas has the display shape (no stretching)');
        assert.deepStrictEqual(state.css, state.stage, 'Canvas fills the display');
        assert.ok(state.settingsInOverlay, 'Screen size controls move into the overlay');
        if (!software) assert.deepStrictEqual(state.canvas, state.stage, 'Accelerated canvas is at device resolution');

        if (fs.existsSync(romPath)) {
            await sleep(1500);
            await page.$eval('#fullscreen-overlay', el => { el.style.visibility = 'hidden'; });
            const shot = await page.screenshot({ encoding: 'binary' });
            await page.$eval('#fullscreen-overlay', el => { el.style.visibility = ''; });
            if (captureDir) {
                fs.mkdirSync(captureDir, { recursive: true });
                fs.writeFileSync(path.join(captureDir, `fullscreen-${software ? 'sw' : 'gl'}.png`), shot);
            }
            // Sample pixels inside each screen and in the letterbox to see
            // the screens drawn where the layout put them.
            const samples = await page.evaluate(async (b64, layout) => {
                const image = new Image();
                image.src = `data:image/png;base64,${b64}`;
                await image.decode();
                const c = document.createElement('canvas');
                c.width = image.width; c.height = image.height;
                const ctx = c.getContext('2d');
                ctx.drawImage(image, 0, 0);
                const lit = rect => {
                    const data = ctx.getImageData(Math.round(rect.x) + 2, Math.round(rect.y) + 2,
                        Math.max(1, Math.round(rect.w) - 4), Math.max(1, Math.round(rect.h) - 4)).data;
                    let count = 0;
                    for (let i = 0; i < data.length; i += 4) {
                        if (data[i] + data[i + 1] + data[i + 2] > 30) count++;
                    }
                    return count / (data.length / 4);
                };
                const { top, bottom } = layout;
                const gaps = [];
                if (top.x > 4) gaps.push({ x: 0, y: 0, w: top.x - 2, h: image.height });
                if (top.y > 4) gaps.push({ x: 0, y: 0, w: image.width, h: top.y - 2 });
                if (bottom.y + bottom.h < image.height - 4) {
                    gaps.push({ x: bottom.x, y: bottom.y + bottom.h + 2, w: bottom.w,
                        h: image.height - bottom.y - bottom.h - 2 });
                }
                return { top: lit(top), bottom: lit(bottom), gaps: gaps.map(lit) };
            }, Buffer.from(shot).toString('base64'), state.layout);
            console.log(`  lit pixels: top ${(samples.top * 100).toFixed(1)}%, bottom ` +
                `${(samples.bottom * 100).toFixed(1)}%, letterbox ${samples.gaps.map(v => (v * 100).toFixed(1) + '%').join(', ')}`);
            assert.ok(samples.top > 0.2, 'Top screen is drawn at its layout position');
            assert.ok(samples.gaps.every(v => v < 0.01), 'Nothing is drawn outside the screens');

            // Craftus's title menu: "New World" sits at about (26%, 85%) of
            // the bottom screen and opens a different bottom-screen page.
            if (path.basename(romPath).startsWith('craftus')) {
                const bottomPixels = async () => {
                    const { bottom } = state.layout;
                    const image = await page.screenshot({ encoding: 'base64', clip: {
                        x: bottom.x, y: bottom.y, width: bottom.w, height: bottom.h } });
                    return image;
                };
                const beforeTap = await bottomPixels();
                const { bottom } = state.layout;
                await page.mouse.move(bottom.x + bottom.w * 0.26, bottom.y + bottom.h * 0.85);
                await page.mouse.down();
                await sleep(250);
                await page.mouse.up();
                await sleep(2500);
                const afterTap = await bottomPixels();
                if (captureDir) {
                    fs.writeFileSync(path.join(captureDir, `fullscreen-${software ? 'sw' : 'gl'}-tap.png`),
                        await page.screenshot());
                }
                assert.notStrictEqual(afterTap, beforeTap, 'A tap on the scaled bottom screen reaches the game');
                console.log('  tap on the scaled bottom screen reached the game');
            }
        }

        console.log('Test 3: changing the bounds while fullscreen relays out the screens...');
        await page.click('#btn-fullscreen-settings');
        const before = await page.evaluate(() => window.AzaharFullscreen.computeLayout(
            document.getElementById('screen-stage').clientWidth, document.getElementById('screen-stage').clientHeight));
        await page.evaluate(() => {
            const set = (id, value) => {
                const el = document.getElementById(id);
                el.value = value;
                el.dispatchEvent(new Event('input'));
            };
            set('fullscreen-bottom-max', '30');
        });
        const after = await page.evaluate(() => window.AzaharFullscreen.computeLayout(
            document.getElementById('screen-stage').clientWidth, document.getElementById('screen-stage').clientHeight));
        assert.ok(after.r <= 0.3 + 1e-6 && after.r < before.r, 'Lower maximum shrinks the bottom screen');
        assert.strictEqual(await page.$eval('#fullscreen-bottom-min', el => el.value), '30',
            'Minimum follows a maximum moved below it');

        console.log('Test 4: leaving fullscreen restores the native frame...');
        await page.click('#btn-fullscreen-exit');
        await page.waitForFunction(() => !window.AzaharFullscreen.isActive());
        await page.waitForFunction(() => {
            const canvas = document.getElementById('canvas');
            return canvas.width === 400 && canvas.height === 480;
        }, { timeout: 5000 });
        assert.ok(await page.evaluate(() =>
            !!document.querySelector('#fullscreen-card #fullscreen-settings')), 'Controls return to the card');

        console.log('Test 5: the card button toggles fullscreen too...');
        await page.click('#btn-fullscreen');
        await page.waitForFunction(() => window.AzaharFullscreen.isActive());
        await page.click('#btn-fullscreen-exit');
        await page.waitForFunction(() => !window.AzaharFullscreen.isActive());

        console.log('--- Fullscreen Tests passed ---');
    } finally {
        await browser.close();
        server.close();
    }
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
