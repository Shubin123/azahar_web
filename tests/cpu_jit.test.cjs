/**
 * cpu_jit.test.cjs
 * The ARM CPU's compiled code (the engine's WebAssembly JIT with interpreter fallback):
 *   1. the engine exports the CPU controls, and the page's CPU choice switches the running
 *      engine between compiled code and the interpreter and is kept;
 *   2. with --rom, a game runs with compiled code (most instructions compiled, frames drawn,
 *      no flood of unmapped memory accesses);
 *   3. with --rom, verify mode runs every compiled run against the interpreter: none differ;
 *   4. with --rom, the interpreter alone runs the game too.
 * --state STATE.cst starts from a save state; --seconds N sets each run's length; --bench also
 * compares guest speed at 4x fast-forward with and without compiled code.
 *
 * Usage: node tests/cpu_jit.test.cjs [--rom PATH] [--state STATE] [--seconds 20] [--bench]
 */
'use strict';

const puppeteer = require('puppeteer-core');
const assert = require('node:assert');
const path = require('node:path');
const { listen } = require('../web/server.cjs');
const { restoreState } = require('./fixture_state.cjs');
const cfg = require('./config.cjs');

const PORT = 8798;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const seconds = Number(cfg.argVal('--seconds', '20'));

async function openPage(browser, query) {
    const page = await browser.newPage();
    page.errors = [];
    page.on('pageerror', error => page.errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${PORT}/index.html?autoFallback=0&${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('Emulator ready'),
        { timeout: 120000 });
    return page;
}

const cpu = page => page.evaluate(() => window.AzaharUI.getCpuJit());

async function controls(browser) {
    const page = await openPage(browser, 'autostart=0');
    const exports = await page.evaluate(() => ['_azahar_set_cpu_jit', '_azahar_get_cpu_jit_stats']
        .filter(name => typeof window.AzaharUI.getModule()?.[name] !== 'function'));
    assert.deepStrictEqual(exports, [], `missing engine exports: ${exports}`);
    assert.strictEqual((await cpu(page)).mode, 1, 'compiled code is on by default');
    await page.select('#cpu-mode', 'interpreter');
    assert.strictEqual((await cpu(page)).mode, 0, 'Interpreter only applies at once');
    assert.match(await page.$eval('#cpu-mode-help', element => element.textContent), /interpreted/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('Emulator ready'),
        { timeout: 120000 });
    assert.strictEqual(await page.$eval('#cpu-mode', element => element.value), 'interpreter', 'the choice is kept');
    assert.strictEqual((await cpu(page)).mode, 0, 'and applied to a new session');
    await page.select('#cpu-mode', 'auto');
    assert.strictEqual((await cpu(page)).mode, 1);
    assert.deepStrictEqual(page.errors, [], 'no page errors');
    await page.close();
    console.log('PASS the CPU choice switches the running engine and is kept');
}

async function play(browser, rom, state, query, speed = 1) {
    const page = await openPage(browser, `${query}&speed=${speed}`);
    await (await page.$('#rom-file')).uploadFile(rom);
    await page.waitForFunction(() => !document.getElementById('btn-load').disabled, { timeout: 60000 });
    await page.click('#btn-load');
    await page.waitForFunction(() => window.AzaharUI.isRunning(), { timeout: 180000 });
    if (state) await restoreState(page, state);
    const sample = () => page.evaluate(() => {
        const module = window.AzaharUI.getModule();
        const pointer = module._malloc(11 * 8);
        module._azahar_get_perf_stats(pointer, 11);
        const stats = new Float64Array(module.HEAPU8.buffer, pointer, 11);
        const result = { fps: stats[0], guestUs: stats[10], at: performance.now() };
        module._free(pointer);
        return { ...result, cpu: window.AzaharUI.getCpuJit() };
    });
    await sleep(3000);
    const first = await sample();
    await sleep(seconds * 1000);
    const last = await sample();
    const speedPercent = (last.guestUs - first.guestUs) / ((last.at - first.at) * 10);
    const running = await page.evaluate(() => window.AzaharUI.isRunning());
    const errors = page.errors;
    await page.close();
    return { first, last, speedPercent, running, errors };
}

async function main() {
    assert.ok(cfg.chromePath, 'Chrome not found; set CHROME_PATH');
    const server = await listen(PORT, '127.0.0.1');
    const browser = await puppeteer.launch({ executablePath: cfg.chromePath, headless: true, protocolTimeout: 600000,
        args: ['--no-sandbox'], defaultViewport: { width: 1200, height: 1000 } });
    try {
        await controls(browser);
        const romArg = cfg.argVal('--rom', null);
        const rom = romArg ? path.resolve(romArg) : null;
        if (!rom) {
            console.log('SKIP game runs (pass --rom PATH)');
            return;
        }
        const state = cfg.argVal('--state', null) && path.resolve(cfg.argVal('--state', null));
        const name = path.basename(rom);

        const compiled = await play(browser, rom, state, 'cpuJit=1');
        const share = compiled.last.cpu.compiled / compiled.last.cpu.instructions;
        const unmapped = compiled.last.cpu.unmapped - compiled.first.cpu.unmapped;
        assert.ok(compiled.running, 'the game keeps running with compiled code');
        assert.ok(compiled.last.fps > 0, 'and draws frames');
        assert.ok(share > 0.5, `most instructions run compiled (${(share * 100).toFixed(1)}%)`);
        assert.ok(unmapped < 100 * seconds, `no flood of unmapped accesses (${unmapped})`);
        assert.deepStrictEqual(compiled.errors, [], 'no page errors');
        console.log(`PASS ${name} with compiled code: ${(share * 100).toFixed(1)}% of instructions compiled, ` +
            `${compiled.last.fps.toFixed(0)} game FPS, ${compiled.speedPercent.toFixed(0)}% speed`);

        const verify = await play(browser, rom, state, 'cpuJit=verify');
        assert.ok(verify.running, 'the game keeps running in verify mode');
        assert.ok(verify.last.cpu.verified > 1000, `compiled runs were checked (${verify.last.cpu.verified})`);
        assert.strictEqual(verify.last.cpu.mismatches, 0, 'compiled code and the interpreter agree');
        console.log(`PASS ${name} verify mode: ${verify.last.cpu.verified.toLocaleString()} compiled runs ` +
            'matched the interpreter');

        const interpreted = await play(browser, rom, state, 'cpuJit=0');
        assert.ok(interpreted.running && interpreted.last.fps > 0, 'the interpreter runs the game');
        assert.strictEqual(interpreted.last.cpu.compiled, 0, 'nothing is compiled');
        console.log(`PASS ${name} on the interpreter: ${interpreted.speedPercent.toFixed(0)}% speed`);

        if (cfg.argFlag('--bench')) {
            const runs = [];
            for (const query of ['cpuJit=0', 'cpuJit=1']) {
                runs.push(await play(browser, rom, state, query, 4));
            }
            console.log(`BENCH ${name} at 4x: interpreter ${runs[0].speedPercent.toFixed(0)}%, ` +
                `compiled ${runs[1].speedPercent.toFixed(0)}%`);
        }
    } finally {
        await browser.close().catch(() => {});
        server.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
