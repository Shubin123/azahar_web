/**
 * library_replay.test.cjs
 * Drives the real emulator through the library UI and verifies that a
 * second title (or the same title again) can be started from the table, the
 * "Downloaded & ready" list, and the file picker. The native core cannot
 * load twice into one WebAssembly instance, so each follow-up load must hand
 * over to a fresh session instead of trapping ("unreachable").
 *
 * Archive downloads are served from local test_games/ ROMs.
 */
'use strict';

const puppeteer = require('puppeteer-core');
const { listen } = require('../web/server.cjs');
const cfg = require('./config.cjs');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const GAME_A = { search: 'Cubic Ninja', urlPart: 'Cubic%20Ninja',
    file: 'Cubic_Ninja_(USA)_(En,Fr,Es)_Decrypted.3ds' };
const GAME_B = { search: 'Adventure Time - Explore', urlPart: 'Adventure%20Time%20-%20Explore',
    file: "Adventure_Time_-_Explore_the_Dungeon_because_I_DON'T_KNOW!_(Europe)_(En,Fr,De,Es,It)_Decrypted.3ds" };
const TRAP_PATTERN = /unreachable|memory access out of bounds|Load error|Run error/i;

function romFile(game) {
    return path.join(cfg.ROOT, 'test_games', game.file);
}

async function runTests() {
    if (!cfg.chromePath) {
        console.log('SKIP: Chrome not found (set CHROME_PATH).');
        return;
    }
    const missing = [GAME_A, GAME_B].filter(game => !fs.existsSync(romFile(game)));
    if (missing.length) {
        console.log(`SKIP: missing test ROMs in test_games/: ${missing.map(g => g.file).join(', ')}`);
        return;
    }

    console.log('--- Starting Library Replay Tests (real emulator) ---');
    const port = 8791;
    const server = await listen(port, '127.0.0.1', {
        virtualFiles: {
            '/__test_roms/a.3ds': fs.readFileSync(romFile(GAME_A)),
            '/__test_roms/b.3ds': fs.readFileSync(romFile(GAME_B))
        }
    });
    const browser = await puppeteer.launch({
        executablePath: cfg.chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
    });

    const pageErrors = [];
    const dialogs = [];
    try {
        const page = await browser.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
        // Each document counts its own archive downloads.
        await page.evaluateOnNewDocument((a, b) => {
            const originalFetch = window.fetch.bind(window);
            window.__downloads = [];
            window.fetch = (input, options) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url.startsWith('https://archive.org/download/')) {
                    const local = url.includes(a) ? '/__test_roms/a.3ds' : url.includes(b) ? '/__test_roms/b.3ds' : null;
                    if (local) {
                        window.__downloads.push(url);
                        return originalFetch(local, options);
                    }
                }
                return originalFetch(input, options);
            };
        }, GAME_A.urlPart, GAME_B.urlPart);

        const status = () => page.$eval('#status', el => el.textContent);
        const logText = () => page.$eval('#log', el => el.textContent);
        async function waitForRunning(label) {
            await page.waitForFunction(() => window.AzaharUI?.isRunning()
                && document.getElementById('status').textContent.includes('Visible game graphics'),
                { timeout: 120000 }).catch(async error => {
                console.error(`${label} did not start:`, await status(), '\n', (await logText()).slice(-800));
                throw error;
            });
            assert.doesNotMatch(await logText(), TRAP_PATTERN, `${label} must not trap the core`);
            console.log(`  ✓ ${label}: ${await status()}`);
        }
        async function clickTablePlay(game) {
            await page.waitForFunction(() => window.AzaharLibrary?.getAllGames().length > 0, { timeout: 30000 });
            await page.$eval('#library-search', (el, query) => {
                el.value = query;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }, game.search);
            await page.waitForSelector('#library-list .play-btn:not([disabled])');
            await page.click('#library-list .play-btn');
        }
        async function readyTitles() {
            return page.$$eval('#library-ready-list .game-name', els => els.map(el => el.textContent));
        }

        await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('Emulator ready'),
            { timeout: 60000 });

        // 1. First play from the table downloads and runs the game.
        console.log('Test 1: first play from the library table...');
        await clickTablePlay(GAME_A);
        await waitForRunning('First play');
        assert.strictEqual((await page.evaluate(() => window.__downloads)).length, 1);
        await page.waitForFunction(() => document.querySelectorAll('#library-ready-list li').length === 1,
            { timeout: 30000 });

        // 2. Playing the same title again hands over to a fresh session that
        //    loads it from the cache without another download.
        console.log('Test 2: replay the running title from the ready list...');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
            page.click('#library-ready-list button[data-action="play-ready"]')
        ]);
        assert.ok(new URL(page.url()).searchParams.has('play'), 'Replay must request the title in the new session');
        await waitForRunning('Replay from ready list');
        assert.deepStrictEqual(await page.evaluate(() => window.__downloads), [],
            'A cached replay must not download the game again');
        assert.ok(!new URL(page.url()).searchParams.has('play'),
            'The handed-over play request must be cleared once the game runs');

        // 3. Switching to a different game while one is running works.
        console.log('Test 3: switch to a different title while one is running...');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
            clickTablePlay(GAME_B)
        ]);
        await waitForRunning('Switch to second title');
        assert.strictEqual((await page.evaluate(() => window.__downloads)).length, 1,
            'An uncached title is downloaded once in the fresh session');
        await page.waitForFunction(() => document.querySelectorAll('#library-ready-list li').length === 2,
            { timeout: 30000 });

        // 4. After a manual reload, both titles are still listed as ready and
        //    play from the cache.
        console.log('Test 4: ready list survives a reload and plays from cache...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelectorAll('#library-ready-list li').length === 2,
            { timeout: 30000 });
        const titles = await readyTitles();
        assert.ok(titles.some(t => t.includes('Cubic Ninja')) && titles.some(t => t.includes('Adventure Time')),
            `Both played titles must be listed as ready, got ${JSON.stringify(titles)}`);
        await page.evaluate(() => [...document.querySelectorAll('#library-ready-list li')]
            .find(li => li.textContent.includes('Cubic Ninja'))
            .querySelector('button[data-action="play-ready"]').click());
        await waitForRunning('Ready list play after reload');
        assert.deepStrictEqual(await page.evaluate(() => window.__downloads), []);

        // 5. A file chosen with the picker while a game runs is handed over
        //    through the cache, too.
        console.log('Test 5: pick a local ROM file while a game is running...');
        const input = await page.$('#rom-file');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }),
            input.uploadFile(romFile(GAME_B))
        ]);
        await waitForRunning('File picker second load');
        assert.ok((await readyTitles()).some(t => t === GAME_B.file),
            'A handed-over local file is listed as ready');

        // 6. Removing entries empties the ready list.
        console.log('Test 6: remove every ready entry...');
        while (await page.$('#library-ready-list button[data-action="remove-ready"]')) {
            const before = (await readyTitles()).length;
            await page.click('#library-ready-list button[data-action="remove-ready"]');
            await page.waitForFunction(n => document.querySelectorAll('#library-ready-list li').length < n,
                { timeout: 10000 }, before);
        }
        assert.ok(await page.$eval('#library-ready', el => el.hidden), 'Empty ready list must be hidden');

        assert.deepStrictEqual(dialogs, [], 'No error dialogs should appear');
        assert.deepStrictEqual(pageErrors.filter(msg => TRAP_PATTERN.test(msg)), [],
            'No WebAssembly traps should surface');
        console.log('\n--- ALL LIBRARY REPLAY TESTS PASSED! ---');
    } finally {
        await browser.close();
        server.close();
    }
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
