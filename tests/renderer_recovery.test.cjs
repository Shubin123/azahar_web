'use strict';
// A real picked ROM must survive a fresh-document renderer fallback. Repeating
// from its cached library entry also verifies recovery after ?play is cleared.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const {listen} = require('../web/server.cjs');
const cfg = require('./config.cjs');

async function main() {
    const rom = cfg.argVal('--rom', process.env.AZAHAR_ROM_PATH || cfg.romPath);
    if (!rom || !fs.existsSync(rom) || !cfg.chromePath) {
        console.log('SKIP: renderer recovery requires Chrome and a ROM (--rom PATH).');
        return;
    }
    const server = await listen(0, '127.0.0.1', {root: process.env.AZAHAR_WEB_DIR || cfg.webDir});
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await puppeteer.launch({executablePath: cfg.chromePath, headless: true,
        defaultViewport: {width: 1280, height: 1000}});
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const ready = () => page.waitForFunction(() => window.AzaharUI?.getModule(), {timeout: 60000});
        const running = () => page.waitForFunction(() => window.AzaharUI?.isRunning(), {timeout: 60000});
        async function loseContext() {
            const navigation = page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 60000});
            await page.evaluate(() => {
                const gl = document.getElementById('canvas').getContext('webgl2');
                if (!gl) throw new Error('The accelerated renderer must have a live context');
                gl.getExtension('WEBGL_lose_context').loseContext();
            });
            await navigation;
            await ready();
            await running();
            const state = await page.evaluate(() => ({
                renderer: AzaharWebConfig.renderer,
                file: document.getElementById('file-label').textContent,
                mounted: Module.FS.stat('/rom.3ds').size,
                reason: new URLSearchParams(location.search).get('webgl2-fallback-reason'),
                pending: new URLSearchParams(location.search).get('play'),
            }));
            assert.equal(state.renderer, 'software');
            assert.equal(state.reason, 'WebGL2 context lost');
            assert.equal(state.mounted, fs.statSync(rom).size);
            assert.ok(state.file.includes(path.basename(rom)));
            await page.waitForFunction(() => !new URLSearchParams(location.search).has('play'));
            console.log('Recovered with the same ROM:', state.file);
        }
        await page.goto(`${origin}/?renderer=webgl2`, {waitUntil: 'networkidle0'});
        await ready();
        await (await page.$('#rom-file')).uploadFile(rom);
        await page.waitForFunction(() => !document.getElementById('btn-load').disabled);
        await page.click('#btn-load');
        await running();
        await page.waitForFunction(() => document.getElementById('status').textContent.includes('Visible game graphics'), {timeout: 60000});
        console.log('Test 1: picked file survives a real WebGL context loss...');
        await loseContext();
        const playable = await page.evaluate(async () => (await AzaharLibrary.listReadyPlayables())[0].url);
        assert.ok(playable.startsWith('local-file:'));
        console.log('Test 2: cached library replay survives another context loss...');
        const replay = new URL(`${origin}/?renderer=webgl2`);
        replay.searchParams.set('play', playable);
        await page.goto(replay.toString(), {waitUntil: 'domcontentloaded'});
        await running();
        await page.waitForFunction(() => !new URLSearchParams(location.search).has('play'));
        await loseContext();
        console.log('Test 3: a pending library play survives WebGL2 preflight failure...');
        await page.evaluateOnNewDocument(() => {
            if (new URLSearchParams(location.search).get('renderer') !== 'webgl2') return;
            const getContext = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...args) {
                return type === 'webgl2' ? null : getContext.call(this, type, ...args);
            };
        });
        await page.goto(replay.toString(), {waitUntil: 'domcontentloaded'});
        await running();
        assert.equal(await page.evaluate(() => AzaharWebConfig.renderer), 'software');
        assert.equal(new URL(page.url()).searchParams.get('webgl2-fallback-reason'), 'WebGL2 context creation failed');
        await page.waitForFunction(() => !new URLSearchParams(location.search).has('play'));
        assert.deepEqual(errors, []);
        console.log('Renderer recovery tests passed.');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
