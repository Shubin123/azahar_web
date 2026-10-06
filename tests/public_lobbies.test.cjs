/**
 * public_lobbies.test.cjs
 * Public Local Play lobbies through a local WebTorrent-style tracker:
 *   1. a host running a title publishes a lobby;
 *   2. another browser finds it, with the host's name and title, while the
 *      host still has no Local Play peers (browsing is not joining);
 *   3. joining turns that connection into the Local Play link on both sides,
 *      and frames flow over it;
 *   4. a third browser then sees the lobby with two players.
 *
 * Usage: node tests/public_lobbies.test.cjs [--rom PATH]
 */
'use strict';

const puppeteer = require('puppeteer-core');
const assert = require('node:assert');
const path = require('node:path');
const { listen } = require('../web/server.cjs');
const { startTracker } = require('./lobby_tracker.cjs');
const cfg = require('./config.cjs');

const PORT = 8805;
const romPath = cfg.argVal('--rom', path.join(cfg.ROOT, 'test_games', 'Cubic_Ninja_(USA)_(En,Fr,Es)_Decrypted.3ds'));

async function openPage(browser, tracker, query = '') {
    const page = await browser.newPage();
    page.errors = [];
    page.on('pageerror', error => page.errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${PORT}/index.html?renderer=software&trackers=${encodeURIComponent(tracker.url)}${query}`,
        { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('Emulator ready'),
        { timeout: 120000 });
    await page.evaluate(() => { window.AzaharNetplay.useStun = false; });
    return page;
}

async function main() {
    assert.ok(cfg.chromePath, 'Chrome not found; set CHROME_PATH');
    const tracker = await startTracker();
    const server = await listen(PORT, '127.0.0.1');
    const browsers = [];
    const launch = async () => {
        const browser = await puppeteer.launch({ executablePath: cfg.chromePath, headless: true, args: ['--no-sandbox'] });
        browsers.push(browser);
        return browser;
    };
    try {
        // 1. Host a lobby from a running title.
        const host = await openPage(await launch(), tracker, '&nick=Hosty');
        await (await host.$('#rom-file')).uploadFile(romPath);
        await host.waitForFunction(() => !document.getElementById('btn-load').disabled, { timeout: 60000 });
        await host.click('#btn-load');
        await host.waitForFunction(() => window.AzaharNetplay.titleId(), { timeout: 120000 });
        await host.evaluate(() => {
            document.getElementById('public-lobby-name').value = 'Test room';
            document.getElementById('btn-public-lobby-host').click();
        });
        await host.waitForFunction(() => window.AzaharLobbies.status().trackers.some(t => t.open), { timeout: 15000 });
        const title = await host.evaluate(() => window.AzaharNetplay.titleId());
        console.log(`PASS host lists "Test room" for ${title}`);

        // 2. Another browser finds it.
        const guest = await openPage(await launch(), tracker, '&nick=Guesty');
        await guest.evaluate(() => document.getElementById('btn-public-lobby-find').click());
        await guest.waitForFunction(() => window.AzaharLobbies.status().lobbies.some(l => l.name === 'Test room'),
            { timeout: 30000 }).catch(() => { throw new Error(`lobby not found (tracker ${JSON.stringify(tracker.stats)})`); });
        const listed = await guest.evaluate(() => window.AzaharLobbies.status().lobbies.find(l => l.name === 'Test room'));
        assert.strictEqual(listed.title, title, 'the lobby advertises the host\'s title');
        assert.strictEqual(listed.players, 1, 'only the host is playing');
        assert.strictEqual(await host.evaluate(() => window.AzaharNetplay.peers.size), 0,
            'a browser looking at lobbies is not a Local Play peer');
        assert.match(await guest.$eval('#public-lobby-list', element => element.textContent), /Test room/);
        console.log('PASS another browser finds the lobby without joining it');

        // 3. Join through the page's Join button.
        await guest.evaluate(() => document.querySelector('#public-lobby-list button').click());
        await guest.waitForFunction(() => {
            const state = window.AzaharNetplay.status();
            return state.mode === 'direct-guest' && state.peers.some(peer => peer.open && peer.name === 'Hosty');
        }, { timeout: 20000 });
        await host.waitForFunction(() => window.AzaharNetplay.status().peers.some(peer => peer.open && peer.name === 'Guesty'),
            { timeout: 20000 });
        await guest.evaluate(() => window.AzaharNetplay.sendFrame(new Uint8Array([1, 1, 1, 0x40, 0xF4, 0x07, 0, 0, 9,
            255, 255, 255, 255, 255, 255, 0, 0, 0, 1, 9])));
        await host.waitForFunction(() => window.AzaharNetplay.stats.received >= 1, { timeout: 10000 });
        assert.strictEqual(await guest.evaluate(() => window.AzaharLobbies.status().role), null, 'joining stops browsing');
        console.log('PASS joining makes the lobby connection the Local Play link');

        // 4. A newcomer sees two players.
        const third = await openPage(await launch(), tracker, '&nick=Third');
        await third.evaluate(() => window.AzaharLobbies.browse());
        await third.waitForFunction(() => window.AzaharLobbies.status().lobbies.some(l => l.name === 'Test room' && l.players === 2),
            { timeout: 30000 });
        console.log('PASS the lobby shows its player count to newcomers');

        const errors = [host, guest, third].flatMap(page => page.errors);
        assert.deepStrictEqual(errors, [], 'no page errors');
        console.log('public_lobbies.test: all checks passed');
    } finally {
        await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
        server.close();
        await tracker.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
