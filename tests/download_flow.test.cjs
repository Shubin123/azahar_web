/**
 * download_flow.test.cjs
 * Exercises the library download pipeline end to end in a real browser
 * without any game: archive.org and the local proxy are intercepted and
 * answered with synthetic bytes, and the emulator loader is replaced with a
 * recorder. Safe to run in CI (no ROMs, no network).
 */
'use strict';

const puppeteer = require('puppeteer-core');
const { listen } = require('../web/server.cjs');
const cfg = require('./config.cjs');
const assert = require('node:assert');

// Large enough to arrive in several stream chunks.
const PAYLOAD = Buffer.alloc(3 * 1024 * 1024 + 123);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 31 + (i >> 11)) & 0xff;

const ARCHIVE_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Type': 'application/octet-stream',
};

async function runTests() {
    if (!cfg.chromePath) {
        console.log('SKIP: Chrome not found (set CHROME_PATH).');
        return;
    }

    console.log('--- Starting Download Flow Tests (synthetic ROM bytes) ---');
    const port = 8792;
    const server = await listen(port, '127.0.0.1');
    const browser = await puppeteer.launch({
        executablePath: cfg.chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader']
    });

    // Per-URL behaviour for intercepted downloads:
    //   'ok'   – serve PAYLOAD
    //   'fail' – HTTP 503
    //   'hang' – never answer (used for cancellation)
    const directMode = new Map();
    const proxyMode = new Map();
    const requests = { direct: [], proxy: [] };
    const hanging = [];

    function answer(request, mode) {
        if (mode === 'hang') {
            hanging.push(request);
            return Promise.resolve();
        }
        if (mode === 'ok') {
            return request.respond({
                status: 200,
                headers: { ...ARCHIVE_HEADERS, 'Content-Length': String(PAYLOAD.length) },
                body: PAYLOAD
            });
        }
        return request.respond({ status: 503, headers: ARCHIVE_HEADERS, body: 'unavailable' });
    }

    try {
        const page = await browser.newPage();
        const dialogs = [];
        page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
        page.on('pageerror', error => console.error('Page error:', error.message));

        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.isInterceptResolutionHandled()) return;
            const url = new URL(request.url());
            let handled = null;
            if (url.hostname.endsWith('archive.org') && url.pathname.startsWith('/download/')) {
                requests.direct.push(request.url());
                handled = answer(request, directMode.get(request.url()) || 'fail');
            } else if (url.origin === `http://127.0.0.1:${port}` && url.pathname === '/api/rom-proxy') {
                const target = url.searchParams.get('url');
                requests.proxy.push(target);
                handled = answer(request, proxyMode.get(target) || 'fail');
            } else if (url.hostname.endsWith('archive.org')) {
                // Never let a test touch the real Internet Archive.
                handled = request.abort('blockedbyclient');
            } else {
                handled = request.continue();
            }
            handled.catch(() => {});
        });

        await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.AzaharLibrary?.getAllGames().length > 0
            && typeof window.AzaharUI?.loadRomBytes === 'function', { timeout: 30000 });
        await page.evaluate(() => window.AzaharRomFS?.store?.available?.());

        // Record what the library hands to the emulator instead of booting it.
        await page.evaluate(() => {
            window.__loads = [];
            window.AzaharUI.loadRomBytes = async (data, name, shouldAutoStart, sourceUrl) => {
                const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
                let checksum = 0;
                for (let i = 0; i < bytes.length; i += 4093) checksum = (checksum * 33 + bytes[i]) >>> 0;
                window.__loads.push({
                    name, shouldAutoStart, sourceUrl, length: bytes.length, checksum,
                    speedText: document.getElementById('active-download-speed')?.textContent
                });
            };
        });
        const expectedChecksum = (() => {
            let checksum = 0;
            for (let i = 0; i < PAYLOAD.length; i += 4093) checksum = (checksum * 33 + PAYLOAD[i]) >>> 0;
            return checksum;
        })();

        // Finds a catalog row, records its download URL and clicks Play.
        async function play(search) {
            await page.$eval('#library-search', (el, query) => {
                el.value = query;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }, search);
            await page.waitForFunction(query => {
                const name = document.querySelector('#library-list tr .game-name');
                return name && name.textContent.toLowerCase().includes(query.toLowerCase());
            }, { timeout: 5000 }, search);
            const game = await page.$eval('#library-list tr', row => ({
                url: row.querySelector('a[download]').href,
                romName: row.querySelector('.game-filename')?.textContent
            }));
            await page.click('#library-list tr .play-btn');
            return game;
        }
        const loads = () => page.evaluate(() => window.__loads);
        async function waitForLoads(count, label) {
            await page.waitForFunction(n => window.__loads.length >= n, { timeout: 20000 }, count).catch(async error => {
                console.error(`${label} did not load:`, await page.$eval('#status', el => el.textContent), dialogs);
                throw error;
            });
            return (await loads())[count - 1];
        }
        function assertPayload(load, game, label) {
            assert.strictEqual(load.length, PAYLOAD.length, `${label}: emulator must receive the whole download`);
            assert.strictEqual(load.checksum, expectedChecksum, `${label}: emulator must receive the downloaded bytes intact`);
            assert.strictEqual(load.sourceUrl, game.url, `${label}: loader must know where the game came from`);
            assert.strictEqual(load.shouldAutoStart, true, `${label}: downloaded games auto-start`);
        }

        // Resolve catalog URLs up front so each intercepted request finds its mode.
        const urlFor = search => page.evaluate(query => window.AzaharLibrary.getAllGames()
            .find(game => game.title.toLowerCase().includes(query.toLowerCase())).downloadUrl, search);

        // 1. Direct download streams the ROM to disk and loads it.
        console.log('Test 1: direct download from archive.org...');
        directMode.set(await urlFor('Pascal'), 'ok');
        const pascal = await play('Pascal');
        let load = await waitForLoads(1, 'Direct download');
        assertPayload(load, pascal, 'Direct download');
        assert.strictEqual(load.name, pascal.romName, 'Loader must receive the catalog ROM filename');
        assert.deepStrictEqual(requests.direct, [pascal.url], 'Exactly one archive request expected');
        assert.deepStrictEqual(requests.proxy, [], 'The proxy must not be used when archive.org answers');
        assert.ok(await page.$eval('#library-active-download', el => el.hidden), 'Download card hides after loading');
        await page.waitForFunction(async () => {
            const entries = await window.AzaharRomFS.store.list();
            return entries.length === 1;
        }, { timeout: 5000 });
        const stored = await page.evaluate(async () => (await window.AzaharRomFS.store.list())[0]);
        assert.strictEqual(stored.size, PAYLOAD.length, 'The streamed ROM must be stored on disk in full');
        assert.strictEqual(stored.url, pascal.url);
        await page.waitForFunction(() => document.querySelectorAll('#library-ready-list li').length === 1, { timeout: 5000 });
        console.log('  ✓ streamed, stored and loaded');

        // 2. Playing it again uses the local cache without a request.
        console.log('Test 2: replay comes from the local cache...');
        await play('Pascal');
        load = await waitForLoads(2, 'Cached replay');
        assertPayload(load, pascal, 'Cached replay');
        assert.ok(load.speedText.includes('local game cache'), 'Replay must report the local cache');
        assert.strictEqual(requests.direct.length, 1, 'Replay must not download again');
        console.log('  ✓ no second download');

        const proxyUrl = await urlFor('Cubic Ninja');
        const storageUrl = await urlFor('Adventure Time - Explore');
        const cancelUrl = await urlFor('Picross');
        const brokenUrl = await urlFor('Zelda');
        directMode.set(proxyUrl, 'fail');
        proxyMode.set(proxyUrl, 'ok');
        directMode.set(storageUrl, 'ok');
        directMode.set(cancelUrl, 'hang');
        directMode.set(brokenUrl, 'fail');
        proxyMode.set(brokenUrl, 'fail');

        // 3. A failed direct request falls back to the local proxy.
        console.log('Test 3: proxy fallback when archive.org fails...');
        const viaProxy = await play('Cubic Ninja');
        assert.strictEqual(viaProxy.url, proxyUrl);
        load = await waitForLoads(3, 'Proxy fallback');
        assertPayload(load, viaProxy, 'Proxy fallback');
        assert.deepStrictEqual(requests.proxy, [proxyUrl], 'The proxy must be asked for the same URL');
        console.log('  ✓ loaded through /api/rom-proxy');

        // 4. If browser storage refuses the stream, the game downloads again
        //    into memory and still plays.
        console.log('Test 4: storage failure falls back to an in-memory download...');
        await page.evaluate(() => {
            const store = window.AzaharRomFS.store;
            window.__originalCreateWriter = store.createWriter;
            store.createWriter = async () => ({
                write: async () => { throw new DOMException('disk full', 'InvalidStateError'); },
                close: async () => { throw new Error('unreachable'); },
                abort: async () => {}
            });
        });
        const viaMemory = await play('Adventure Time - Explore');
        assert.strictEqual(viaMemory.url, storageUrl);
        load = await waitForLoads(4, 'Storage fallback');
        assertPayload(load, viaMemory, 'Storage fallback');
        assert.strictEqual(requests.direct.filter(url => url === storageUrl).length, 2,
            'A refused store write must restart the download into memory');
        await page.evaluate(() => { window.AzaharRomFS.store.createWriter = window.__originalCreateWriter; });
        console.log('  ✓ restarted in memory and loaded');

        // 5. Cancelling an in-flight download stops without loading.
        console.log('Test 5: cancelling a download...');
        await play('Picross');
        await page.waitForFunction(() => !document.getElementById('library-active-download').hidden, { timeout: 5000 });
        const waitHanging = Date.now();
        while (!hanging.length && Date.now() - waitHanging < 5000) await new Promise(r => setTimeout(r, 50));
        assert.ok(hanging.length, 'The cancellable request must be in flight');
        await page.click('#active-download-cancel');
        await page.waitForFunction(() => document.getElementById('status').textContent.includes('Download cancelled'),
            { timeout: 5000 });
        assert.ok(await page.$eval('#library-active-download', el => el.hidden), 'Cancel hides the download card');
        assert.strictEqual((await loads()).length, 4, 'A cancelled download must not reach the emulator');
        assert.deepStrictEqual(dialogs, [], 'Cancelling is not an error');
        console.log('  ✓ cancelled cleanly');

        // 6. When both archive.org and the proxy fail, the user is told.
        console.log('Test 6: unreachable download reports an error...');
        await play('Zelda');
        await page.waitForFunction(() => document.getElementById('status').textContent.includes('Failed to stream ROM'),
            { timeout: 10000 });
        assert.strictEqual(dialogs.length, 1, 'A failed download must alert the user');
        assert.match(dialogs[0], /Proxy download returned HTTP 503/);
        assert.strictEqual((await loads()).length, 4, 'A failed download must not reach the emulator');
        assert.ok(await page.$eval('#library-active-download', el => el.hidden));
        const readyCount = await page.$$eval('#library-ready-list li', items => items.length);
        assert.strictEqual(readyCount, 3, 'Only successful downloads are listed as ready');
        console.log('  ✓ error surfaced, nothing cached');

        console.log('\n--- ALL DOWNLOAD FLOW TESTS PASSED! ---');
    } finally {
        await browser.close();
        server.close();
    }
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
