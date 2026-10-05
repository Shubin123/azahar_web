#!/usr/bin/env node
/**
 * WebKit / iPhone regression (tests/webkit_mobile.test.cjs)
 *
 * Every iOS browser is WebKit. Runs the production page in Playwright's
 * WebKit with iPhone emulation, picks a ROM through the real file input and
 * checks that the game runs, in three configurations:
 *
 *   default      server sends the isolation headers
 *   static host  no headers; coi-serviceworker.js must provide isolation
 *   memory limit shared memories over 2 GiB are refused, as a phone may do;
 *                the UI must retry with a smaller maximum
 *
 * Found on 2026-10-04: WebKit services a worker's Blob reads on the main
 * thread, so azahar_romfs.js's lazy reader deadlocked ("Mounting ROM..."
 * forever) for every picked file, on iOS and on Safari for macOS. The reader
 * now detects that and serves reads from a copy in the Origin Private File
 * System; this test requires that path to be taken in WebKit.
 *
 * Playwright is optional, so the normal suite does not depend on it:
 *   npm install --no-save playwright && npx playwright install webkit
 *
 * Usage:
 *   node tests/webkit_mobile.test.cjs [--rom PATH] [--device "iPhone 15 Pro"]
 *   AZAHAR_WEB_DIR=path  serve another copy of web/ (e.g. a negative control)
 *
 * Any small ROM works; the freely released homebrew Craftus Reloaded
 * (github.com/RSDuck/craftus_reloaded) at tmp_test/homebrew/ is used when
 * present and no ROM is given.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config.cjs');
const { createWebServer } = require('../web/server.cjs');

let playwright;
try {
    playwright = require('playwright');
} catch (_) {
    console.log('SKIP: Playwright is not installed ' +
        '(npm install --no-save playwright && npx playwright install webkit).');
    process.exit(0);
}

const homebrew = path.join(cfg.ROOT, 'tmp_test', 'homebrew', 'craftus_reloaded.3dsx');
const romPath = cfg.argVal('--rom', fs.existsSync(homebrew) ? homebrew : cfg.romPath);
const deviceName = cfg.argVal('--device', 'iPhone 15 Pro');
if (!romPath || !fs.existsSync(romPath)) {
    console.log('SKIP: no test ROM (pass --rom, or place one in test_games/ or tmp_test/homebrew/).');
    process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A deadlocked page never answers evaluate(); bound every call to it so the
// test fails instead of hanging.
const bounded = (promise, ms, fallback) =>
    Promise.race([promise.catch(() => fallback), sleep(ms).then(() => fallback)]);
const CASE_TIMEOUT_MS = 240000;

async function runCase(name, options) {
    const result = await Promise.race([
        runCaseUnbounded(name, options),
        sleep(CASE_TIMEOUT_MS).then(() => 'timeout'),
    ]);
    if (result === 'timeout') {
        console.log(`FAIL ${name}: no result after ${CASE_TIMEOUT_MS / 1000} s`);
        return false;
    }
    return result;
}

async function runCaseUnbounded(name, { staticHost = false, memoryLimitPages = 0 } = {}) {
    const webDir = process.env.AZAHAR_WEB_DIR ?
        path.resolve(process.env.AZAHAR_WEB_DIR) : path.join(cfg.ROOT, 'web');
    const server = createWebServer(webDir, {},
        staticHost ? { crossOriginIsolation: false } : {});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    // OPFS needs a persistent profile in Playwright's WebKit.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'azahar-webkit-'));
    const context = await playwright.webkit.launchPersistentContext(profile, {
        ...playwright.devices[deviceName],
    });
    const errors = [];
    try {
        if (memoryLimitPages) {
            await context.addInitScript(limit => {
                const Native = WebAssembly.Memory;
                function Limited(descriptor) {
                    if (descriptor && descriptor.shared && descriptor.maximum > limit) {
                        throw new RangeError('Out of memory (simulated device limit)');
                    }
                    return new Native(descriptor);
                }
                Limited.prototype = Native.prototype;
                WebAssembly.Memory = Limited;
            }, memoryLimitPages);
        }
        const page = context.pages()[0] || await context.newPage();
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
        const status = () => bounded(page.$eval('#status', element => element.textContent), 3000, '');
        const waitFor = async (predicate, timeoutMs, what) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const text = await status();
                if (predicate(text)) return text;
                if (/error|failed/i.test(text)) throw new Error(`${what}: ${text}`);
                await sleep(500);
            }
            throw new Error(`${what}: timed out; status "${await status()}"`);
        };
        await waitFor(text => /Emulator ready/i.test(text), 90000, 'initialization');
        await page.setInputFiles('#rom-file', romPath);
        await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, null,
            { timeout: 30000 });
        await page.click('#btn-load');
        // Status reads stop answering while the main thread is deadlocked, so
        // the timeout below is what catches the old reader.
        await waitFor(text => /Visible game graphics/i.test(text), 90000, 'loading the ROM');
        await sleep(5000);
        const fps = await bounded(page.$eval('#fps', element => element.textContent), 3000, '');
        const uiLog = await bounded(page.$eval('#log', element => element.textContent), 3000, '');
        if (!/staged copy for this browser/.test(uiLog)) {
            throw new Error('the ROM was not served from a staged copy in WebKit');
        }
        if (memoryLimitPages && !/maximum was refused/.test(uiLog)) {
            throw new Error('the shared-memory fallback did not run');
        }
        if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
        console.log(`PASS ${name}: ${fps}`);
        return true;
    } catch (error) {
        console.log(`FAIL ${name}: ${error.message}`);
        return false;
    } finally {
        await bounded(context.close(), 10000);
        server.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

(async () => {
    console.log(`# WebKit mobile regression (${deviceName}, ${path.basename(romPath)})`);
    const results = [
        await runCase('default'),
        await runCase('static host (service worker isolation)', { staticHost: true }),
        await runCase('2 GiB shared memory limit', { memoryLimitPages: 32768 }),
    ];
    // Exit explicitly: a browser left behind by a timed-out case keeps Node alive.
    process.exit(results.every(Boolean) ? 0 : 1);
})();
