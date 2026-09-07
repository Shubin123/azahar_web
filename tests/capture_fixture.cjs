'use strict';
// Local CDP fixture session. Start with `serve ROM`; use `shot`, `key KEY MS`,
// `touch X Y` (fractions of canvas), `save SCENE`, and `close` from another shell.
// Captures stay under ignored tmp_test; never publish game data.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cfg = require('./config.cjs');
const { createWebServer } = require('../web/server.cjs');
const port = Number(process.env.AZAHAR_FIXTURE_PORT || 18765);
const [command, ...args] = process.argv.slice(2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    if (command !== 'serve') {
        const response = await fetch(`http://127.0.0.1:${port}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command, args }),
        });
        const result = await response.json();
        console.log(JSON.stringify(result));
        if (!response.ok) process.exitCode = 1;
        return;
    }
    const rom = path.resolve(args[0]);
    if (!fs.statSync(rom).isFile()) throw new Error('ROM required');
    const directory = path.join(cfg.ROOT, 'tmp_test', 'fixtures',
        path.basename(rom, path.extname(rom)).replace(/[^a-zA-Z0-9_-]/g, '_'));
    fs.mkdirSync(directory, { recursive: true });
    const web = createWebServer(cfg.webDir);
    await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
    const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: cfg.chromePath,
        headless: true, defaultViewport: { width: 1100, height: 1400 },
        args: ['--no-sandbox'], protocolTimeout: 120000 });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const shot = async name => {
        const file = path.join(directory, `${name}.png`);
        await (await page.$('#canvas')).screenshot({ path: file });
        return file;
    };
    let busy = false;
    const control = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.headers.origin) { res.writeHead(403).end(); return; }
        if (busy) { res.writeHead(409).end('{}'); return; }
        busy = true;
        try {
            let body = '';
            for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error('Request too large'); }
            const { command: action, args: parameters } = JSON.parse(body);
            let result;
            if (action === 'speed') {
                const speed = Math.max(1, Math.min(4, Number(parameters[0]) || 1));
                await page.$eval('#fast-forward', (element, value) => {
                    element.value = String(value);
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                }, speed);
            } else if (action === 'key') {
                await page.keyboard.down(parameters[0]);
                await sleep(Math.min(10000, Math.max(50, Number(parameters[1] || 250))));
                await page.keyboard.up(parameters[0]);
            } else if (action === 'touch') {
                const box = await (await page.$('#canvas')).boundingBox();
                await page.mouse.move(box.x + box.width * Number(parameters[0]),
                    box.y + box.height * Number(parameters[1]));
                await page.mouse.down(); await sleep(250); await page.mouse.up();
            } else if (action === 'save') {
                const scene = parameters[0];
                if (!/^[a-zA-Z0-9_-]+$/.test(scene)) throw new Error('Use a simple scene slug');
                await page.click('#btn-stop');
                const screenshot = await shot(scene);
                await page.click('#btn-save-state');
                await page.waitForFunction(() => /^(Saved|Save failed)/.test(
                    document.querySelector('#save-state-status').textContent), { timeout: 60000 });
                const saved = await page.evaluate(async () => {
                    const status = document.querySelector('#save-state-status').textContent;
                    if (!status.startsWith('Saved')) throw new Error(status);
                    const store = await AzaharSaveStateStore.open();
                    const record = (await store.list())[0];
                    const bytes = new Uint8Array(await record.data.arrayBuffer());
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += 16384) {
                        binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
                    }
                    return { programId: record.programId, size: record.size, base64: btoa(binary) };
                });
                const sceneDirectory = path.join(directory, scene);
                fs.mkdirSync(sceneDirectory, { recursive: true });
                const state = path.join(sceneDirectory, `${saved.programId}.01.cst`);
                fs.writeFileSync(state, Buffer.from(saved.base64, 'base64'));
                result = { rom, scene, programId: saved.programId, size: saved.size, state, screenshot,
                    capturedAt: new Date().toISOString(), errors };
                fs.writeFileSync(path.join(directory, `${scene}.json`), JSON.stringify(result, null, 2));
                await page.click('#btn-run');
            } else if (action === 'close') {
                await browser.close(); web.close(); control.close();
                result = { closed: true };
            } else if (action !== 'shot') throw new Error('Unknown action');
            if (!result) result = { screenshot: await shot('latest'), errors,
                status: await page.$eval('#status', element => element.textContent) };
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
        } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
        finally { busy = false; }
    });
    await page.goto(`http://127.0.0.1:${web.address().port}/?speed=4`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Emulator ready'),
        { timeout: 120000 });
    await (await page.$('#rom-file')).uploadFile(rom);
    await page.waitForFunction(() => !document.querySelector('#btn-load').disabled);
    await page.click('#btn-load');
    await page.waitForFunction(() => !document.querySelector('#btn-stop').disabled, { timeout: 120000 });
    await new Promise(resolve => control.listen(port, '127.0.0.1', resolve));
    console.log(JSON.stringify({ ready: true, port, rom, directory }));
}
main().catch(error => { console.error(error); process.exit(1); });
