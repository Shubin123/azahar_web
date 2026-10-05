/**
 * local_play.test.cjs
 * Checks the serverless Local Play transport without a game:
 *   1. the engine exports the direct-link entry points;
 *   2. two tabs of one browser link through BroadcastChannel, see each other,
 *      and carry frames both ways;
 *   3. two separate browsers link over WebRTC by swapping the invite and reply
 *      codes (no STUN, as on one network), and a host relays frames between
 *      two guests;
 *   4. leaving unlinks the engine and tells the other side.
 *
 * Usage: node tests/local_play.test.cjs
 */
'use strict';

const puppeteer = require('puppeteer-core');
const assert = require('node:assert');
const { listen } = require('../web/server.cjs');
const cfg = require('./config.cjs');

const PORT = 8795;
const URL = `http://127.0.0.1:${PORT}/index.html?autostart=0&renderer=software`;
// Keep background tabs running so both sides of a same-browser link advance.
const ARGS = ['--no-sandbox', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

async function openPage(browser, query = '') {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.errors = errors;
    await page.goto(URL + query, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('Emulator ready'),
        { timeout: 120000 });
    return page;
}

const status = page => page.evaluate(() => window.AzaharNetplay.status());
// A frame shaped like the engine's: message id 1 (WiFi packet), type, channel,
// transmitter and destination MACs, then a length-prefixed payload.
const sendTestFrame = (page, tag) => page.evaluate(tag => {
    const frame = new Uint8Array([1, 1, 1, 0x40, 0xF4, 0x07, 0, 0, tag, 255, 255, 255, 255, 255, 255,
        0, 0, 0, 1, tag]);
    window.AzaharNetplay.sendFrame(frame);
}, tag);

async function waitForReceived(page, count, label) {
    await page.waitForFunction(count => window.AzaharNetplay.stats.received >= count,
        { timeout: 10000 }, count).catch(() => { throw new Error(`${label}: frames did not arrive`); });
}

async function main() {
    assert.ok(cfg.chromePath, 'Chrome not found; set CHROME_PATH');
    const server = await listen(PORT, '127.0.0.1');
    const browsers = [];
    const launch = async () => {
        const browser = await puppeteer.launch({ executablePath: cfg.chromePath, headless: true, args: ARGS });
        browsers.push(browser);
        return browser;
    };
    try {
        // 1 + 2. Same-browser tabs.
        const browser = await launch();
        const first = await openPage(browser, '&link=tabs:test-room&nick=Alpha');
        const exports = await first.evaluate(() => ['_azahar_net_join', '_azahar_net_leave',
            '_azahar_net_receive', '_azahar_net_set_cross_version', '_azahar_net_console_mac']
            .filter(name => typeof window.AzaharUI.getModule()?.[name] !== 'function'));
        assert.deepStrictEqual(exports, [], `missing engine exports: ${exports}`);
        const second = await openPage(browser, '&link=tabs:test-room&nick=Beta');
        await first.waitForFunction(() => window.AzaharNetplay.status().peers.some(peer => peer.name === 'Beta'),
            { timeout: 10000 });
        await second.waitForFunction(() => window.AzaharNetplay.status().peers.some(peer => peer.name === 'Alpha'),
            { timeout: 10000 });
        // Without a running title the consoles have no address yet, so the engine
        // stays detached; multiplayer.test.cjs covers attachment with games.
        assert.strictEqual((await status(first)).joined, false, 'no title, no engine attachment');
        await sendTestFrame(first, 1);
        await waitForReceived(second, 1, 'tabs A->B');
        await sendTestFrame(second, 2);
        await waitForReceived(first, 1, 'tabs B->A');
        const card = await first.$eval('#local-play-status', element => element.textContent);
        assert.match(card, /Linked \(tabs\)/, 'the card reports the link');
        await second.evaluate(() => window.AzaharNetplay.leave());
        await first.waitForFunction(() => window.AzaharNetplay.status().peers.length === 0, { timeout: 10000 });
        assert.strictEqual((await status(second)).mode, null, 'leaving ends the link');
        console.log('PASS same-browser tabs link, exchange frames and leave');

        // 3. Direct WebRTC between separate browsers, one host and two guests.
        const host = await openPage(await launch(), '&nick=Host');
        const guests = [await openPage(await launch(), '&nick=GuestOne'),
            await openPage(await launch(), '&nick=GuestTwo')];
        for (const guest of guests) {
            const invite = await host.evaluate(async () => {
                window.AzaharNetplay.useStun = false;
                return window.AzaharNetplay.createInvite();
            });
            assert.match(invite, /^AZLINK1\./, 'invite code format');
            const reply = await guest.evaluate(async invite => {
                window.AzaharNetplay.useStun = false;
                return window.AzaharNetplay.acceptInvite(invite);
            }, invite);
            assert.match(reply, /^AZREPLY1\./, 'reply code format');
            await host.evaluate(reply => window.AzaharNetplay.acceptReply(reply), reply);
            await guest.waitForFunction(() => window.AzaharNetplay.status().peers.some(peer => peer.open && peer.name === 'Host'),
                { timeout: 20000 });
        }
        await host.waitForFunction(() => window.AzaharNetplay.status().peers.filter(peer => peer.open).length === 2,
            { timeout: 20000 });
        await sendTestFrame(guests[0], 3);
        await waitForReceived(host, 1, 'guest->host');
        await waitForReceived(guests[1], 1, 'guest->guest via host relay');
        assert.ok((await status(host)).stats.relayed >= 1, 'host relayed the frame');
        await sendTestFrame(host, 4);
        await waitForReceived(guests[0], 1, 'host->guest');
        console.log('PASS direct WebRTC link with invite/reply codes and host relay');

        await guests[1].evaluate(() => window.AzaharNetplay.leave());
        await host.waitForFunction(() => window.AzaharNetplay.status().peers.length === 1, { timeout: 15000 });
        console.log('PASS a guest leaving is seen by the host');

        const errors = [first, second, host, ...guests].flatMap(page => page.errors);
        assert.deepStrictEqual(errors, [], 'no page errors');
        console.log('local_play.test: all checks passed');
    } finally {
        await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
        server.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
