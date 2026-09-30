/**
 * audio.test.cjs
 * Loads a real ROM through the UI and verifies game audio end to end: the
 * AudioWorklet attaches, drains the engine's ring buffer at the native rate,
 * the samples are not silent, audio survives a save-state restore, and the
 * Sound button mutes and unmutes.
 *
 * Usage: node tests/audio.test.cjs [--rom PATH]
 */
'use strict';

const puppeteer = require('puppeteer-core');
const assert = require('node:assert');
const fs = require('node:fs');
const { listen } = require('../web/server.cjs');
const cfg = require('./config.cjs');

// Prefer a title known to play music during boot; some (2in1 Horses 3D)
// stay silent until the player acts.
function defaultRom() {
    const dir = require('node:path').join(cfg.ROOT, 'test_games');
    try {
        const match = fs.readdirSync(dir).find(name => /^Cubic_Ninja.*\.3ds$/i.test(name));
        if (match) return require('node:path').join(dir, match);
    } catch (_) { /* no test_games directory */ }
    return cfg.romPath;
}
const romPath = cfg.argVal('--rom', process.env.AZAHAR_ROM_PATH || defaultRom());
const NATIVE_RATE = 32728;

async function runTests() {
    if (!cfg.chromePath) {
        console.log('SKIP: Chrome not found (set CHROME_PATH).');
        return;
    }
    if (!romPath || !fs.existsSync(romPath)) {
        console.log('SKIP: no test ROM (place one in test_games/ or pass --rom).');
        return;
    }

    console.log('--- Starting Audio Tests (real emulator) ---');
    const server = await listen(8793, '127.0.0.1');
    const browser = await puppeteer.launch({
        executablePath: cfg.chromePath,
        headless: true,
        // Headless runs have no user gesture to unlock audio.
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
    });
    const pageErrors = [];
    try {
        const page = await browser.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto('http://127.0.0.1:8793/index.html?autostart=0&renderer=software',
            { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('Emulator ready'),
            { timeout: 60000 });

        console.log('Test 1: audio attaches when a title loads...');
        await (await page.$('#rom-file')).uploadFile(romPath);
        await page.waitForFunction(() => !document.getElementById('btn-load').disabled, { timeout: 30000 });
        await page.click('#btn-load');
        await page.waitForFunction(() => window.AzaharUI?.isRunning()
            || !document.getElementById('btn-run').disabled, { timeout: 120000 });
        if (!(await page.evaluate(() => window.AzaharUI.isRunning()))) await page.click('#btn-run');
        await page.waitForFunction(() => window.AzaharAudio.getState().running, { timeout: 30000 });
        console.log('  ✓ AudioWorklet attached and running');

        // Let the title reach music.
        await new Promise(resolve => setTimeout(resolve, 20000));

        // Measures worklet consumption and the loudest ring sample over 3 s.
        const measure = () => page.evaluate(async () => {
            const pointer = Module._azahar_audio_ring();
            const header = () => new Uint32Array(Module.HEAPU8.buffer, pointer, 4);
            const capacity = header()[2];
            const readSamples = () => new Int16Array(Module.HEAPU8.buffer, pointer + 16, capacity * 2);
            const startRead = header()[1];
            const startAt = performance.now();
            let peak = 0;
            while (performance.now() - startAt < 3000) {
                for (const value of readSamples()) peak = Math.max(peak, Math.abs(value));
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            const seconds = (performance.now() - startAt) / 1000;
            return { rate: ((header()[1] - startRead) >>> 0) / seconds, peak, sampleRate: header()[3] };
        });

        console.log('Test 2: the worklet drains the ring at the native rate...');
        const sample = await measure();
        assert.strictEqual(sample.sampleRate, NATIVE_RATE, 'ring should advertise the native DSP rate');
        assert.ok(Math.abs(sample.rate - NATIVE_RATE) < NATIVE_RATE * 0.1,
            `worklet should consume ~${NATIVE_RATE} frames/s, got ${sample.rate.toFixed(0)}`);
        console.log(`  ✓ consumed ${sample.rate.toFixed(0)} frames/s`);
        assert.ok(sample.peak > 64, `game audio should not be silent (peak ${sample.peak})`);
        console.log(`  ✓ audible samples (peak amplitude ${sample.peak})`);

        // SDL's old ScriptProcessor output broke after state restoration,
        // which is why web audio used to be disabled.
        console.log('Test 3: audio survives saving and restoring a state...');
        const waitForStateIdle = () => page.waitForFunction(
            () => Module._azahar_get_state_operation() === 0, { timeout: 60000 });
        assert.strictEqual(await page.evaluate(() => Module._azahar_save_state(9)), 0);
        await new Promise(resolve => setTimeout(resolve, 500));
        await waitForStateIdle();
        assert.strictEqual(await page.evaluate(() => Module._azahar_load_state(9)), 0);
        await new Promise(resolve => setTimeout(resolve, 500));
        await waitForStateIdle();
        await new Promise(resolve => setTimeout(resolve, 3000));
        const restored = await measure();
        assert.ok(Math.abs(restored.rate - NATIVE_RATE) < NATIVE_RATE * 0.1,
            `audio should keep flowing after a restore, got ${restored.rate.toFixed(0)} frames/s`);
        assert.ok(restored.peak > 64, `audio should be audible after a restore (peak ${restored.peak})`);
        console.log(`  ✓ ${restored.rate.toFixed(0)} frames/s, peak ${restored.peak} after restore`);

        console.log('Test 4: the Sound button mutes and unmutes...');
        await page.click('#btn-sound');
        assert.strictEqual(await page.evaluate(() => window.AzaharAudio.isMuted()), true);
        assert.match(await page.$eval('#btn-sound', el => el.textContent), /Off/);
        await page.click('#btn-sound');
        assert.strictEqual(await page.evaluate(() => window.AzaharAudio.isMuted()), false);
        assert.match(await page.$eval('#btn-sound', el => el.textContent), /On/);
        console.log('  ✓ mute toggles');

        assert.deepStrictEqual(pageErrors, [], 'no page errors');
        console.log('\n--- ALL AUDIO TESTS PASSED! ---');
    } finally {
        await browser.close();
        server.close();
    }
}

runTests().catch(error => {
    console.error('Test failed with error:', error);
    process.exit(1);
});
