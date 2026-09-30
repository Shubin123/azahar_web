/**
 * audio.test.cjs
 * Loads a real ROM through the UI and verifies game audio end to end:
 *   1. the AudioWorklet attaches, drains the engine's ring at the native rate,
 *      and plays without dropouts once running;
 *   2. game sound reaches the output stage (after volume and mute);
 *   3. the Audio widget's mute button and volume slider change the output;
 *   4. the buffer (pacing) setting reaches the engine and changes buffering;
 *   5. the time-stretching toggle reaches the engine;
 *   6. audio keeps flowing after a save-state restore;
 *   7. settings persist across a reload, and the resampling path used by
 *      browsers that reject the native rate also plays sound.
 *
 * Usage: node tests/audio.test.cjs [--rom PATH]
 */
'use strict';

const puppeteer = require('puppeteer-core');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { listen } = require('../web/server.cjs');
const cfg = require('./config.cjs');

// Prefer a title known to play music during boot; some (2in1 Horses 3D)
// stay silent until the player acts.
function defaultRom() {
    const dir = path.join(cfg.ROOT, 'test_games');
    try {
        const match = fs.readdirSync(dir).find(name => /^Cubic_Ninja.*\.3ds$/i.test(name));
        if (match) return path.join(dir, match);
    } catch (_) { /* no test_games directory */ }
    return cfg.romPath;
}

const romPath = cfg.argVal('--rom', process.env.AZAHAR_ROM_PATH || defaultRom());
const NATIVE_RATE = 32728;
const PORT = 8793;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startTitle(page, query) {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?autostart=0&renderer=software${query}`,
        { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('Emulator ready'),
        { timeout: 60000 });
    await (await page.$('#rom-file')).uploadFile(romPath);
    await page.waitForFunction(() => !document.getElementById('btn-load').disabled, { timeout: 30000 });
    await page.click('#btn-load');
    await page.waitForFunction(() => window.AzaharUI?.isRunning()
        || !document.getElementById('btn-run').disabled, { timeout: 120000 });
    if (!(await page.evaluate(() => window.AzaharUI.isRunning()))) await page.click('#btn-run');
    await page.waitForFunction(() => window.AzaharAudio.getState().running, { timeout: 30000 });
}

// Worklet consumption rate and loudest ring sample over `ms`.
function measureRing(page, ms = 3000) {
    return page.evaluate(async duration => {
        const pointer = Module._azahar_audio_ring();
        const header = () => new Uint32Array(Module.HEAPU8.buffer, pointer, 4);
        const capacity = header()[2];
        const ring = () => new Int16Array(Module.HEAPU8.buffer, pointer + 16, capacity * 2);
        const startRead = header()[1];
        const startAt = performance.now();
        let peak = 0;
        while (performance.now() - startAt < duration) {
            for (const value of ring()) peak = Math.max(peak, Math.abs(value));
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const seconds = (performance.now() - startAt) / 1000;
        return { rate: ((header()[1] - startRead) >>> 0) / seconds, peak, sampleRate: header()[3] };
    }, ms);
}

// Loudest sample leaving the volume stage over `ms`.
function measureOutput(page, ms = 1500) {
    return page.evaluate(async duration => {
        let peak = 0;
        const startAt = performance.now();
        while (performance.now() - startAt < duration) {
            peak = Math.max(peak, window.AzaharAudio.outputPeak());
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        return peak;
    }, ms);
}

async function setVolume(page, percent) {
    await page.$eval('#audio-volume', (input, value) => {
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, percent);
}

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
    const server = await listen(PORT, '127.0.0.1');
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

        console.log('Test 1: audio attaches and drains the ring at the native rate...');
        await startTitle(page, '');
        await sleep(20000); // let the title reach music
        const ring = await measureRing(page);
        assert.strictEqual(ring.sampleRate, NATIVE_RATE, 'ring should advertise the native DSP rate');
        assert.ok(Math.abs(ring.rate - NATIVE_RATE) < NATIVE_RATE * 0.1,
            `worklet should consume ~${NATIVE_RATE} frames/s, got ${ring.rate.toFixed(0)}`);
        assert.ok(ring.peak > 64, `game audio should not be silent (ring peak ${ring.peak})`);
        console.log(`  ✓ ${ring.rate.toFixed(0)} frames/s, ring peak ${ring.peak}`);
        const dropoutsBefore = await page.evaluate(() => window.AzaharAudio.getState().underruns);
        await sleep(5000);
        const dropouts = await page.evaluate(() => window.AzaharAudio.getState().underruns) - dropoutsBefore;
        assert.strictEqual(dropouts, 0, 'steady full-speed playback should not drop out');
        console.log('  ✓ no dropouts over 5 s of steady playback');

        console.log('Test 2: game sound reaches the output stage...');
        const widget = await page.evaluate(() => ({
            volume: document.getElementById('audio-volume')?.value,
            latency: document.getElementById('audio-latency')?.value,
            stretching: document.getElementById('audio-stretching')?.checked,
            status: document.getElementById('audio-status')?.textContent,
        }));
        assert.deepStrictEqual([widget.volume, widget.latency, widget.stretching], ['80', '100', true],
            'the Audio widget should show the defaults');
        assert.match(widget.status, /^Playing · \d+ ms buffered/, `status should report playback: ${widget.status}`);
        const loud = await measureOutput(page);
        assert.ok(loud > 0.005, `output should carry game sound (peak ${loud.toFixed(4)})`);
        console.log(`  ✓ output peak ${loud.toFixed(3)}; status "${widget.status}"`);

        console.log('Test 3: mute and volume change the output...');
        await page.click('#btn-sound');
        assert.match(await page.$eval('#btn-sound', el => el.textContent), /Off/);
        await sleep(300);
        const muted = await measureOutput(page, 800);
        assert.ok(muted < 1e-4, `muted output should be silent (peak ${muted})`);
        await page.click('#btn-sound');
        assert.match(await page.$eval('#btn-sound', el => el.textContent), /On/);
        await setVolume(page, 0);
        await sleep(300);
        const zero = await measureOutput(page, 800);
        assert.ok(zero < 1e-4, `volume 0 should be silent (peak ${zero})`);
        assert.strictEqual(await page.$eval('#audio-volume-value', el => el.textContent), '0%');
        await setVolume(page, 30);
        await sleep(300);
        const quiet = await measureOutput(page);
        await setVolume(page, 100);
        await sleep(300);
        const full = await measureOutput(page);
        assert.ok(quiet > 0 && full > quiet * 2,
            `volume should scale the output (30%: ${quiet.toFixed(4)}, 100%: ${full.toFixed(4)})`);
        console.log(`  ✓ muted ${muted}, volume 0 ${zero}, 30% ${quiet.toFixed(3)}, 100% ${full.toFixed(3)}`);

        console.log('Test 4: the audio buffer setting paces the engine...');
        async function bufferedAt(ms) {
            await page.select('#audio-latency', String(ms));
            assert.strictEqual(await page.evaluate(() => Module._azahar_get_audio_latency_ms()), ms);
            await sleep(1500);
            const samples = [];
            for (let i = 0; i < 10; i++) {
                samples.push(await page.evaluate(() => window.AzaharAudio.getState().bufferedMs));
                await sleep(100);
            }
            return samples.reduce((a, b) => a + b) / samples.length;
        }
        const large = await bufferedAt(200);
        const small = await bufferedAt(50);
        assert.ok(large > 120 && small < 90 && large > small + 60,
            `buffering should follow the setting (200 ms -> ${large.toFixed(0)}, 50 ms -> ${small.toFixed(0)})`);
        const smallRate = (await measureRing(page, 2000)).rate;
        assert.ok(Math.abs(smallRate - NATIVE_RATE) < NATIVE_RATE * 0.1,
            `a 50 ms buffer should still keep up (${smallRate.toFixed(0)} frames/s)`);
        console.log(`  ✓ 200 ms setting buffers ${large.toFixed(0)} ms; 50 ms buffers ${small.toFixed(0)} ms`);

        console.log('Test 5: time stretching reaches the engine...');
        await page.click('#audio-stretching');
        assert.strictEqual(await page.evaluate(() => Module._azahar_get_audio_stretching()), 0);
        await page.click('#audio-stretching');
        assert.strictEqual(await page.evaluate(() => Module._azahar_get_audio_stretching()), 1);
        console.log('  ✓ toggles the engine setting');

        // SDL's old ScriptProcessor output broke after state restoration,
        // which is why web audio used to be disabled.
        console.log('Test 6: audio survives saving and restoring a state...');
        const waitForStateIdle = () => page.waitForFunction(
            () => Module._azahar_get_state_operation() === 0, { timeout: 60000 });
        assert.strictEqual(await page.evaluate(() => Module._azahar_save_state(9)), 0);
        await sleep(500);
        await waitForStateIdle();
        assert.strictEqual(await page.evaluate(() => Module._azahar_load_state(9)), 0);
        await sleep(500);
        await waitForStateIdle();
        await sleep(3000);
        const restored = await measureRing(page);
        assert.ok(Math.abs(restored.rate - NATIVE_RATE) < NATIVE_RATE * 0.1,
            `audio should keep flowing after a restore, got ${restored.rate.toFixed(0)} frames/s`);
        assert.ok(restored.peak > 64, `audio should be audible after a restore (peak ${restored.peak})`);
        console.log(`  ✓ ${restored.rate.toFixed(0)} frames/s, ring peak ${restored.peak} after restore`);

        console.log('Test 7: settings persist, and the resampling path plays sound...');
        await setVolume(page, 65);
        await page.select('#audio-latency', '150');
        await startTitle(page, '&audioResample=1');
        const persisted = await page.evaluate(() => ({
            volume: document.getElementById('audio-volume').value,
            latency: document.getElementById('audio-latency').value,
            engineLatency: Module._azahar_get_audio_latency_ms(),
            state: window.AzaharAudio.getState(),
        }));
        assert.deepStrictEqual([persisted.volume, persisted.latency, persisted.engineLatency], ['65', '150', 150],
            'volume and buffer choices should survive a reload and reach the engine');
        assert.ok(persisted.state.resampling, 'the forced path should resample');
        await sleep(15000);
        const resampled = await measureRing(page);
        const resampledOut = await measureOutput(page);
        assert.ok(Math.abs(resampled.rate - NATIVE_RATE) < NATIVE_RATE * 0.1,
            `resampling should still consume the native rate (${resampled.rate.toFixed(0)} frames/s)`);
        assert.ok(resampledOut > 0.005, `resampled output should carry sound (${resampledOut.toFixed(4)})`);
        console.log(`  ✓ persisted; ${persisted.state.contextRate} Hz context consumes `
            + `${resampled.rate.toFixed(0)} frames/s, output peak ${resampledOut.toFixed(3)}`);

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
