// Captures a local, ignored Mario gameplay savestate for repeatable browser benchmarks.
// It is intentionally not a CI test: it needs a legally owned local ROM and takes several
// minutes to traverse the kiosk demo's boot/menu flow.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {listen} = require('../web/server.cjs');

const root = path.resolve(__dirname, '..');
const romPath = process.env.AZAHAR_ROM_PATH || path.join(root, 'test_games',
    'Super Mario 3D Land (Europe) (En,Fr,De,Es,It) (Demo) (Kiosk).3ds');
const captureId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(root, 'tmp_test', 'gameplay_state', 'mario-moving', captureId);
const settleMs = Number(process.env.AZAHAR_GAMEPLAY_SETTLE_MS || '150000');
const moveMs = Number(process.env.AZAHAR_GAMEPLAY_MOVE_MS || '5000');
const manualCapture = process.env.AZAHAR_CAPTURE_MANUAL === '1';

async function sleep(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForManualCapture(page) {
    console.log('Manual capture armed. Clear the game menus, move Mario, then click the red overlay or press F8.');
    await page.evaluate(() => new Promise(resolve => {
        const button = document.createElement('button');
        button.id = 'azahar-save-moving-state';
        button.textContent = 'Mario is moving — save benchmark state';
        Object.assign(button.style, {
            position: 'fixed', right: '16px', bottom: '16px', zIndex: 10000,
            padding: '12px', background: '#e94560', color: 'white', border: '0',
            borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer',
        });
        const complete = () => {
            button.remove();
            window.removeEventListener('keydown', onKey);
            resolve();
        };
        const onKey = event => {
            if (event.code === 'F8') {
                event.preventDefault();
                complete();
            }
        };
        button.addEventListener('click', complete, {once: true});
        window.addEventListener('keydown', onKey);
        document.body.append(button);
    }));
}

async function main() {
    if (!fs.existsSync(romPath)) throw new Error(`ROM not found: ${romPath}`);
    fs.mkdirSync(outputDir, {recursive: true});
    const server = await listen(0);
    const url = `http://127.0.0.1:${server.address().port}/index.html`;
    const browser = await puppeteer.launch({
        headless: manualCapture || process.env.AZAHAR_CAPTURE_HEADED === '1' ? false : 'new',
        executablePath: process.env.CHROME_PATH,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: {width: 1280, height: 900},
    });
    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {behavior: 'allow', downloadPath: outputDir});

    try {
        await page.goto(url, {waitUntil: 'networkidle0', timeout: 120000});
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000});
        await (await page.$('#rom-file')).uploadFile(romPath);
        await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, {timeout: 30000});
        await page.click('#btn-load');
        await page.waitForFunction(() => !document.querySelector('#btn-stop').disabled, {timeout: 120000});

        if (manualCapture) {
            // The kiosk demo has bottom-screen menus that are game-state
            // dependent. Let a tester clear those menus and verify actual
            // movement in the visible browser before serializing anything.
            await waitForManualCapture(page);
            await page.screenshot({path: path.join(outputDir, 'confirmed-moving.png')});
        } else {
            // Best-effort unattended mode for local iteration. Manual mode is
            // the authoritative path for a gameplay benchmark fixture.
            await sleep(30000);
            const box = await page.$eval('#canvas', canvas => {
                const r = canvas.getBoundingClientRect();
                return {x: r.x, y: r.y, width: r.width, height: r.height};
            });
            await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.75);
            await page.keyboard.press('a');
            await sleep(2000);
            await page.keyboard.press('a');
            await sleep(settleMs);
            await page.screenshot({path: path.join(outputDir, 'before-move.png')});
            await page.keyboard.down('ArrowRight');
            await sleep(moveMs);
            await page.keyboard.up('ArrowRight');
            await sleep(1000);
            await page.screenshot({path: path.join(outputDir, 'after-move.png')});
        }

        const request = await page.evaluate(() => Module._azahar_save_state(1));
        if (request !== 0) throw new Error(`azahar_save_state rejected slot 1: ${request}`);
        await sleep(5000); // Let the queued operation run inside azahar_step_frame.

        const state = await page.evaluate(() => {
            function walk(dir) {
                let names;
                try { names = Module.FS.readdir(dir); } catch (_) { return []; }
                return names.flatMap(name => {
                    if (name === '.' || name === '..') return [];
                    const file = `${dir}/${name}`.replace(/\/+/g, '/');
                    try {
                        return Module.FS.isDir(Module.FS.stat(file).mode) ? walk(file) : [file];
                    } catch (_) {
                        return [];
                    }
                });
            }
            const file = walk('/').find(name => /\.cst$/i.test(name));
            if (!file) return null;
            const bytes = Module.FS.readFile(file);
            const blob = new Blob([bytes], {type: 'application/octet-stream'});
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = pathBasename(file);
            link.click();
            URL.revokeObjectURL(link.href);
            return {file, bytes: bytes.length, download: link.download};
            function pathBasename(value) { return value.slice(value.lastIndexOf('/') + 1); }
        });
        if (!state) throw new Error('No .cst file appeared after save request');
        const downloaded = path.join(outputDir, state.download);
        for (let attempt = 0; attempt < 30 && !fs.existsSync(downloaded); attempt++) await sleep(500);
        if (!fs.existsSync(downloaded)) throw new Error(`Savestate download did not arrive: ${downloaded}`);
        if (fs.statSync(downloaded).size !== state.bytes) throw new Error('Downloaded savestate size differs');
        console.log(JSON.stringify({ok: true, state, downloaded}, null, 2));
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
