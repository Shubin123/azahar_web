#!/usr/bin/env node
/**
 * End-to-end check for the software artifact reconstructed under port/.
 *
 * The test loads the production UI from a staged directory, mounts a real ROM,
 * advances the emulator until software-renderer pixels appear, and rejects the
 * browser-only UDP/WebSocket startup loop that originally prevented readiness.
 */
'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const cfg = require('./config.cjs');
const {createWebServer} = require('../web/server.cjs');

const root = path.resolve(__dirname, '..');
const webDir = path.resolve(process.env.AZAHAR_WEB_DIR || '/tmp/azahar-staged');
const romPath = cfg.argVal('--rom', process.env.AZAHAR_ROM_PATH || cfg.romPath);
const timeoutMs = Number(cfg.argVal('--timeout-ms', '90000'));
const testSaveState = cfg.argFlag('--save-state');

if (!romPath || !fs.existsSync(romPath)) {
    throw new Error('No ROM found. Put one in test_games/, set AZAHAR_ROM_PATH, or pass --rom PATH.');
}
for (const name of ['index.html', 'azahar.js', 'azahar.wasm']) {
    assert.ok(fs.existsSync(path.join(webDir, name)), `staged file missing: ${path.join(webDir, name)}`);
}

async function main() {
    const webServer = createWebServer(webDir);
    const romSize = fs.statSync(romPath).size;
    const server = http.createServer((request, response) => {
        if (new URL(request.url, 'http://localhost').pathname === '/__rebuilt_rom') {
            response.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': romSize,
                'Cache-Control': 'no-store',
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Resource-Policy': 'cross-origin',
            });
            fs.createReadStream(romPath).pipe(response);
            return;
        }
        webServer.emit('request', request, response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.CHROME_PATH || cfg.chromePath || 'chrome',
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: {width: 1280, height: 900},
        protocolTimeout: timeoutMs + 60000,
    });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.stack || String(error)));
    page.on('console', message => {
        if (message.type() === 'error') browserErrors.push(message.text());
    });
    await page.evaluateOnNewDocument(() => {
        const NativeWebSocket = window.WebSocket;
        window.__azaharWebSocketAttempts = [];
        window.WebSocket = function (...args) {
            window.__azaharWebSocketAttempts.push(String(args[0]));
            return new NativeWebSocket(...args);
        };
        window.WebSocket.prototype = NativeWebSocket.prototype;
    });

    try {
        const url = `http://127.0.0.1:${server.address().port}/index.html?renderer=software&autostart=0`;
        await page.goto(url, {waitUntil: 'domcontentloaded'});
        await page.waitForFunction(() =>
            typeof window.Module?._azahar_init === 'function' &&
            /Emulator initialized successfully/.test(document.querySelector('#log')?.textContent || ''),
        {timeout: timeoutMs});

        const result = await page.evaluate(async ({timeout, testSaveState}) => {
            const module = window.Module;
            const bytes = new Uint8Array(await (await fetch('/__rebuilt_rom')).arrayBuffer());
            module.FS.writeFile('/rebuilt-smoke.3ds', bytes, {canOwn: true});
            const load = module.ccall('azahar_load_rom', 'number', ['string'], ['/rebuilt-smoke.3ds']);
            if (load !== 0) return {load, step: null, pixels: -1, frames: 0};

            const deadline = performance.now() + timeout;
            let step = 0;
            let pixels = 0;
            let frames = 0;
            while (performance.now() < deadline && pixels < 1000) {
                step = module._azahar_step_frame();
                frames++;
                if (step !== 0) break;
                pixels = module._azahar_framebuffer_nonblack_pixels();
                await new Promise(requestAnimationFrame);
            }
            const programIdPointer = module._malloc(8);
            let programId;
            try {
                const programIdResult = module._azahar_get_program_id(programIdPointer, 2);
                if (programIdResult !== 0) {
                    return {load, step, pixels, frames, programIdResult};
                }
                const view = new DataView(module.HEAPU8.buffer, programIdPointer, 8);
                const low = view.getUint32(0, true);
                const high = view.getUint32(4, true);
                programId = high.toString(16).padStart(8, '0') +
                    low.toString(16).padStart(8, '0');
            } finally {
                module._free(programIdPointer);
            }

            let saveState = null;
            if (testSaveState) {
                const slot = 10;
                const statesDir = '/home/web_user/.local/share/azahar-emu/states';
                const statePath = `${statesDir}/${programId.toUpperCase()}.${slot}.cst`;
                module.FS.mkdirTree(statesDir);
                try { module.FS.unlink(statePath); } catch (_) {}

                const saveRequest = module._azahar_save_state(slot);
                let saveStep = null;
                let stateBytes = 0;
                const saveDeadline = performance.now() + timeout;
                while (performance.now() < saveDeadline) {
                    saveStep = module._azahar_step_frame();
                    if (saveStep !== 0) break;
                    try { stateBytes = module.FS.stat(statePath).size; } catch (_) {}
                    if (module._azahar_get_state_operation() === 0 && stateBytes >= 256) break;
                    await new Promise(requestAnimationFrame);
                }

                const loadRequest = stateBytes >= 256 ? module._azahar_load_state(slot) : null;
                const loadStep = loadRequest === 0 ? module._azahar_step_frame() : null;
                saveState = {saveRequest, saveStep, stateBytes, loadRequest, loadStep};
                try { module.FS.unlink(statePath); } catch (_) {}
            }

            return {load, step, pixels, frames, programId, saveState,
                websocketAttempts: window.__azaharWebSocketAttempts.slice()};
        }, {timeout: timeoutMs, testSaveState});

        assert.equal(result.load, 0, `azahar_load_rom returned ${result.load}`);
        assert.equal(result.step, 0, `azahar_step_frame returned ${result.step}`);
        assert.ok(result.pixels >= 1000,
            `no rendered scene after ${result.frames} frames (non-black pixels: ${result.pixels})`);
        assert.match(result.programId || '', /^[0-9a-f]{16}$/i,
            `invalid program ID result: ${JSON.stringify(result)}`);
        assert.notEqual(result.programId, '0000000000000000', 'program ID must not be zero');
        if (testSaveState) {
            assert.equal(result.saveState?.saveRequest, 0, 'save-state request was rejected');
            assert.equal(result.saveState?.saveStep, 0, 'save-state emulation step failed');
            assert.ok(result.saveState?.stateBytes >= 256,
                `save-state file was not created: ${JSON.stringify(result.saveState)}`);
            assert.equal(result.saveState?.loadRequest, 0, 'load-state request was rejected');
            assert.equal(result.saveState?.loadStep, 0, 'load-state emulation step failed');
        }
        assert.deepEqual(result.websocketAttempts, [],
            `unexpected browser socket attempts: ${result.websocketAttempts.join(', ')}`);
        assert.deepEqual(browserErrors, [], `browser errors:\n${browserErrors.join('\n')}`);

        console.log('Rebuilt browser smoke passed:');
        console.log(`  ROM load: 0`);
        console.log(`  Frames:   ${result.frames}`);
        console.log(`  Pixels:   ${result.pixels} non-black`);
        console.log(`  Title ID: ${result.programId.toUpperCase()}`);
        if (testSaveState) {
            console.log(`  Save/load: slot 10 (${result.saveState.stateBytes} bytes)`);
        }
        console.log('  Startup WebSockets: 0');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
