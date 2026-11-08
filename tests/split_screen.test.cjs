/**
 * split_screen.test.cjs
 * Local Play between consoles on one device (web/split.html):
 *   1. the shared-memory rings keep message order and boundaries across the
 *      ring's end, and drop (and count) messages only when a reader stops;
 *   2. split.html opens one console per player, links them through shared
 *      memory, and carries frames between every pair of consoles;
 *   3. the page gives a console that finishes early less of each refresh and
 *      the others the rest, and a stopped console its fair share back;
 *   4. the real keyboard reaches only the console whose screen has focus;
 *   5. ↺ restarts one console, which gets the game and the link again while the
 *      others play on, and a console that stops is restarted on its own;
 *   each player's Screens menu lays out only their console's screens (big top by default,
 *   stretched, or as on a 3DS), kept across restarts, with the join panel over the top screen;
 *   6. with --rom, two consoles play a real title's local wireless mode: the
 *      steps for that title in multiplayer_games.json (--game, default
 *      mario-kart-7) host a room on Player 1's screen and join it on Player 2's,
 *      then (unless --no-race) start the match and check that both screens
 *      agree on it. Waits and holds count emulated time, since consoles that
 *      share a device may run below full speed. A Download Play game
 *      (mario-party-island-tour) is joined by each other screen on its own; once the
 *      host starts it, every guest runs the game's Download Play child in the
 *      host's room. Then (unless --no-recover) the consoles take a checkpoint
 *      together and the guest must show the host's choices (followCheck); Player 2
 *      and then Player 1 are made to stop, and each time every console goes back
 *      to the checkpoint and the screens agree again; ↺ restarts Player 2 afresh
 *      (the host drops it) and ⤺ brings everyone back, Player 2 in the game again.
 *
 * Usage:
 *   node tests/split_screen.test.cjs
 *   node tests/split_screen.test.cjs --rom PATH [--game mario-kart-7] [--renderer webgl2|software]
 *       [--no-race] [--no-recover] [--gpu] [--timeout SECONDS] [--web DIR] [--query cpuJit=0]
 *       [--players N] [--game-only] [--save-logs] [--stall-dump]
 *   --game GAME --roms DIR finds the game's ROM in DIR (see game_roms.cjs) instead of --rom.
 *   --players N (2-8) puts N consoles in the game's room: players 1 and 2 on their keyboard
 *   keys, the others on a controller each; the race check needs two players.
 *   --game-only skips the checks that need no game (multiplayer_suite.cjs runs them once).
 *   --stall-dump writes every guest thread and data channel of both consoles when one stops
 *   reading its race channel or drawing during a race (see watchStall).
 *   add --base URL to test a deployed site (https://shubin123.github.io/azahar_web) instead of web/
 */
'use strict';

const puppeteer = require('puppeteer-core');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { listen } = require('../web/server.cjs');
const cfg = require('./config.cjs');
const { checkSync, regionSignatures } = require('./sync_check.cjs');
const { guestSleep } = require('./guest_time.cjs');
const { installFrameTrace, saveFrameTrace } = require('./frame_trace.cjs');
const { findBuildRom } = require('./game_roms.cjs');

const PORT = 8799;
const BASE = (cfg.argVal('--base', '') || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const GAMES = JSON.parse(fs.readFileSync(path.join(__dirname, 'multiplayer_games.json'), 'utf8'));
const OUTPUT = path.join(cfg.ROOT, 'tmp_test', 'split_screen');
const timeoutMs = Number(cfg.argVal('--timeout', 300)) * 1000;
// Real GPU on macOS (Metal) or elsewhere (Vulkan); headless Chrome otherwise uses SwiftShader.
const GPU_ARGS = process.platform === 'darwin' ?
    ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] :
    ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'];

async function launch() {
    return puppeteer.launch({ executablePath: cfg.chromePath, headless: true, protocolTimeout: 300000,
        defaultViewport: { width: 1400, height: 900 },
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...(cfg.argFlag('--gpu') ? GPU_ARGS : [])] });
}

// A frame shaped like the engine's: message id 1 (WiFi packet), type, channel,
// transmitter and destination MACs, then a length-prefixed payload.
const TEST_FRAME = tag => [1, 1, 1, 0x40, 0xF4, 0x07, 0, 0, tag, 255, 255, 255, 255, 255, 255, 0, 0, 0, 1, tag];

async function ringChecks(page) {
    const result = await page.evaluate(() => {
        const link = window.AzaharSharedLink;
        const buffer = link.create(3, 256);
        const [a, b, c] = [0, 1, 2].map(seat => link.open(buffer, seat));
        const got = [];
        const collect = endpoint => endpoint.receive((kind, bytes, from) => got.push([kind, from, [...bytes]]));
        // Odd lengths walk the write position around the 256-byte ring many times.
        const sent = [];
        for (let round = 0; round < 40; round++) {
            const length = 1 + (round * 37) % 90;
            const bytes = Uint8Array.from({length}, (_, i) => (round + i) & 0xFF);
            if (a.send(round % 2 ? link.KIND_CONTROL : link.KIND_FRAME, bytes, 1) !== 1) return {error: `round ${round} not queued`};
            sent.push([round % 2 ? link.KIND_CONTROL : link.KIND_FRAME, 0, [...bytes]]);
            if (round % 2 === 1) collect(b);
        }
        collect(b);
        const orderKept = JSON.stringify(got) === JSON.stringify(sent);
        // Broadcast reaches every other console and only them.
        got.length = 0;
        const queued = c.send(link.KIND_FRAME, new Uint8Array([9, 9]));
        collect(a); collect(b); collect(c);
        const broadcast = queued === 2 && got.length === 2 && got.every(([, from]) => from === 2);
        // A reader that stops does not hold its sender up: the sender keeps writing, the
        // stopped console loses the oldest messages (counted), and what it reads when it
        // comes back is the newest, intact and in order.
        let accepted = 0;
        for (let i = 0; i < 20; i++) accepted += a.send(link.KIND_FRAME, new Uint8Array(60).fill(i), 2);
        got.length = 0;
        collect(c);
        const newest = got.every(([, , bytes], i) => bytes.length === 60 &&
            bytes.every(value => value === 20 - got.length + i));
        // One pool for many consoles: eight, each hearing the seven others once.
        const eight = link.create(8, 1024);
        const ends = Array.from({length: 8}, (_, seat) => link.open(eight, seat));
        for (const end of ends) end.send(link.KIND_FRAME, new Uint8Array([end.seat]));
        const heard = ends.map(end => {
            const from = [];
            end.receive((kind, bytes, seat) => from.push(seat === bytes[0] ? seat : -1));
            return from.sort().join();
        });
        const everyone = heard.every((list, seat) => list === [0, 1, 2, 3, 4, 5, 6, 7].filter(s => s !== seat).join());
        return {orderKept, broadcast, accepted, received: got.length, dropped: a.dropped(), newest, everyone,
            poolBytes: [link.bytes(2), link.bytes(8)]};
    });
    assert.ok(!result.error, result.error);
    assert.ok(result.orderKept, 'messages arrive in order and intact across the ring end');
    assert.ok(result.broadcast, 'a broadcast reaches each other console once');
    assert.strictEqual(result.accepted, 20, 'a stopped reader does not refuse messages');
    assert.ok(result.received > 0 && result.received < 20, 'it keeps what fits');
    assert.strictEqual(result.dropped, 20 - result.received, 'and the ones it lost are counted');
    assert.ok(result.newest, 'what it reads is the newest, intact and in order');
    assert.ok(result.everyone, 'eight consoles share one pool, each hearing every other once');
    assert.ok(result.poolBytes[1] < result.poolBytes[0] * 5, `the pool grows with consoles, not pairs (${result.poolBytes})`);
    console.log(`PASS shared pool: order across the ring end, broadcast, a stopped reader loses ${result.dropped} ` +
        `old messages without holding others up; 8 consoles in ${(result.poolBytes[1] / 1048576).toFixed(1)} MiB`);
}

// Each console's frame, once its page has loaded (a deployed site's frames load slowly, and
// waits started on a frame still at about:blank never saw it).
const seatFrames = async page => {
    await page.waitForFunction(() => {
        const frames = [...document.querySelectorAll('#seats iframe')];
        return frames.length > 0 && frames.every(frame => frame.contentWindow?.AzaharNetplay);
    }, { timeout: 120000 });
    const handles = await page.$$('#seats iframe');
    return Promise.all(handles.map(handle => handle.contentFrame()));
};

async function openSplit(browser, query, file) {
    const page = await browser.newPage();
    page.errors = [];
    page.on('pageerror', error => page.errors.push(String(error)));
    await page.goto(`${BASE}/split.html?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.crossOriginIsolated && window.AzaharSplit, { timeout: 30000 });
    await (await page.$('#rom-file')).uploadFile(file);
    await page.waitForFunction(() => !document.getElementById('btn-start').disabled, { timeout: 10000 });
    await page.click('#btn-start');
    return page;
}

async function linkChecks(browser) {
    // Without a game the consoles have no address, but the link itself is up:
    // they see each other and count every frame that arrives.
    const dummy = path.join(OUTPUT, 'not-a-game.3ds');
    fs.mkdirSync(OUTPUT, { recursive: true });
    fs.writeFileSync(dummy, Buffer.alloc(4096));
    // joinIdle: a console joins a lobby on its own once left alone for 3 s (joinPanelChecks).
    const page = await openSplit(browser, 'players=3&renderer=software&joinIdle=3', dummy);
    await ringChecks(page);
    await helpChecks(page);
    await page.waitForFunction(() => document.querySelectorAll('#seats iframe').length === 3, { timeout: 10000 });
    const frames = await seatFrames(page);
    for (const frame of frames) {
        await frame.waitForFunction(() => window.AzaharNetplay?.mode === 'shared' &&
            window.AzaharNetplay.status().peers.length === 2, { timeout: 120000 });
    }
    const names = await frames[0].evaluate(() => window.AzaharNetplay.status().peers.map(peer => peer.name).sort());
    assert.deepStrictEqual(names, ['Player 2', 'Player 3'], 'each console sees the others by name');
    for (const [index, frame] of frames.entries()) {
        await frame.evaluate(bytes => window.AzaharNetplay.sendFrame(Uint8Array.from(bytes)), TEST_FRAME(index + 1));
    }
    for (const frame of frames) {
        await frame.waitForFunction(() => window.AzaharNetplay.stats.received >= 2, { timeout: 10000 })
            .catch(() => { throw new Error('frames did not reach every console'); });
    }
    const card = await frames[1].$eval('#local-play-status', element => element.textContent);
    assert.match(card, /Linked \(this device\)/, 'the console reports the link');
    console.log('PASS split.html links three consoles through shared memory and carries frames between all of them');
    await screensChecks(page, frames);
    await keyboardChecks(page, frames);

    // Every console has the whole game, so two can host at once (both pick Download Play, say);
    // then nobody can join, and the page says so and how to fix it.
    await Promise.all(frames.map((frame, index) => frame.evaluate(index => {
        window.AzaharNetplay.gameRoom = () => (index < 2 ? { status: 'host', host: `02:00:00:00:00:0${index}`,
            node: 1, nodes: [{ id: 1, name: 'AZAHAR' }] } : null);
    }, index)));
    await page.waitForFunction(() => /Players 1 and 2 are each hosting a room/.test(document.getElementById('status').textContent),
        { timeout: 5000 }).catch(() => { throw new Error('two consoles hosting at once were not reported'); });
    const hint = await page.$eval('#status', element => element.textContent);
    assert.match(hint, /Local Play/, 'the hint says which menu to join from');
    const hostBadges = await page.$$eval('#seats .seat-room', elements => elements.map(element => element.textContent));
    assert.deepStrictEqual(hostBadges, ['🏠 Hosting a room · 1 player', '🏠 Hosting a room · 1 player', '']);
    await Promise.all(frames.map(frame => frame.evaluate(() => { delete window.AzaharNetplay.gameRoom; })));
    console.log('PASS consoles hosting at once are named, with how to join one room instead');
    await joinPanelChecks(page, frames);

    // Sharing the main thread, driven through the slots the consoles publish.
    const shares = await page.evaluate(async () => {
        const SLOT = window.AzaharSharedLink.SLOT;
        const frames = window.AzaharSplit.seats();
        // Stop the consoles' own reports so the test owns the slots.
        for (const frame of frames) frame.contentWindow.AzaharSplitSeat.report = () => {};
        const slots = frames.map(frame => frame.contentWindow.AzaharNetplay.shared.slot());
        const wait = () => new Promise(resolve => setTimeout(resolve, 400));
        const publish = (slot, stepMs, saturated) => {
            slot[SLOT.heartbeat] = window.AzaharSharedLink.wallNow();
            slot[SLOT.stepMs] = stepMs;
            slot[SLOT.frameMs] = 16.7;
            slot[SLOT.saturated] = saturated;
        };
        const keepAlive = (states) => {
            const timer = setInterval(() => states.forEach((state, i) => state && publish(slots[i], ...state)), 50);
            return () => clearInterval(timer);
        };
        let stop = keepAlive([[5, 1], [5, 1], [5, 1]]);
        await wait();
        const allBusy = window.AzaharSplit.shares();
        stop();
        stop = keepAlive([[1, 0], [5, 1], [5, 1]]);
        await wait();
        const oneLight = window.AzaharSplit.shares();
        stop();
        stop = keepAlive([null, [5, 1], [5, 1]]);
        await new Promise(resolve => setTimeout(resolve, 1500));
        const oneStopped = window.AzaharSplit.shares();
        stop();
        return {allBusy, oneLight, oneStopped};
    });
    const near = (value, expected) => Math.abs(value - expected) < 0.01;
    assert.ok(shares.allBusy.every(share => near(share, 1 / 3)), `three busy consoles split evenly: ${shares.allBusy}`);
    assert.ok(shares.oneLight[0] < 0.2 && near(shares.oneLight[1], shares.oneLight[2]) &&
        near(shares.oneLight.reduce((a, b) => a + b), 1), `a light console yields its spare time: ${shares.oneLight}`);
    assert.ok(near(shares.oneStopped[1], 0.5) && near(shares.oneStopped[2], 0.5),
        `a stopped console's time goes to the others: ${shares.oneStopped}`);
    console.log(`PASS refresh sharing: busy ${fmt(shares.allBusy)}, one light ${fmt(shares.oneLight)}, ` +
        `one stopped ${fmt(shares.oneStopped)}`);
    await resetChecks(page);
    const errors = page.errors.filter(error => !/ROM|load/i.test(error));
    assert.deepStrictEqual(errors, [], 'no page errors');
    await page.close();

    // The Local Play card hands the game picked on index.html to split.html.
    const main = await browser.newPage();
    await main.goto(`${BASE}/index.html?autostart=0&renderer=software`, { waitUntil: 'domcontentloaded' });
    await main.waitForFunction(() => document.getElementById('status')?.textContent.includes('Emulator ready'),
        { timeout: 120000 });
    await (await main.$('#rom-file')).uploadFile(dummy);
    await main.waitForFunction(() => window.AzaharUI.getPlayableSource().file, { timeout: 10000 });
    await Promise.all([main.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
        main.click('#btn-local-play-device')]);
    assert.match(main.url(), /\/split\.html\?.*play=local-file%3Anot-a-game\.3ds/, 'the game travels in the URL');
    await main.waitForFunction(() => document.querySelectorAll('#seats iframe').length === 2, { timeout: 30000 });
    const handed = await main.evaluate(() => [document.getElementById('rom-label').textContent,
        document.getElementById('renderer').value]);
    assert.match(handed[0], /not-a-game\.3ds/, 'split.html starts with the handed-over game');
    assert.strictEqual(handed[1], 'software', 'and with the renderer the main page used');
    console.log('PASS the Local Play card opens split.html with the current game');
    await main.close();
    await libraryHandOff(browser);
    await manyConsoles(browser, dummy);
}

// As many consoles as a local wireless network takes: eight on one page, each linked to the
// seven others through the one shared pool, laid out in a grid.
async function manyConsoles(browser, dummy) {
    const page = await openSplit(browser, 'players=8&renderer=software', dummy);
    const frames = await seatFrames(page);
    assert.strictEqual(frames.length, 8, 'eight consoles');
    for (const frame of frames) {
        await frame.waitForFunction(() => window.AzaharNetplay?.status().peers.length === 7, { timeout: 120000 });
    }
    const columns = await page.$eval('#seats', element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    assert.strictEqual(columns, 3, 'eight screens in three columns');
    await frames[7].evaluate(bytes => window.AzaharNetplay.sendFrame(Uint8Array.from(bytes)), TEST_FRAME(8));
    for (const frame of frames.slice(0, 7)) {
        await frame.waitForFunction(() => window.AzaharNetplay.stats.received >= 1, { timeout: 10000 })
            .catch(() => { throw new Error('a frame from the eighth console did not reach every other one'); });
    }
    console.log('PASS split.html runs eight consoles, each linked to the seven others through one shared pool');
    await page.close();
}

// A game played from the library cache goes to split.html the same way. A stand-in is stored
// under a catalog entry's URL (Mario Party - The Top 100); requests to the archive are blocked,
// so nothing is downloaded.
async function libraryHandOff(browser) {
    const catalog = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, 'web', 'games_library.json'), 'utf8'));
    const game = catalog.games.find(entry => entry.fullName === 'Mario Party - The Top 100 (USA)');
    assert.ok(game, 'the catalog lists Mario Party - The Top 100 (USA)');
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => (new URL(request.url()).hostname.endsWith('archive.org') ?
        request.abort() : request.continue()));
    const ready = () => page.waitForFunction(() => document.getElementById('status')?.textContent.includes('Emulator ready'),
        { timeout: 120000 });
    await page.goto(`${BASE}/index.html?autostart=0&renderer=software`, { waitUntil: 'domcontentloaded' });
    await ready();
    const stored = await page.evaluate(({ url, name, title }) => window.AzaharLibrary.cachePlayable(url,
        new File([new Uint8Array(4096)], name), name, title), { url: game.downloadUrl, name: game.romName, title: game.title });
    assert.ok(stored, 'the stand-in is in browser storage');
    const opensSplit = async () => {
        assert.strictEqual(new URL(page.url()).pathname.split('/').pop(), 'split.html');
        assert.strictEqual(new URL(page.url()).searchParams.get('play'), game.downloadUrl, 'the library URL travels');
        await page.waitForFunction(() => document.querySelectorAll('#seats iframe').length === 2, { timeout: 30000 });
        const label = await page.$eval('#rom-label', element => element.textContent);
        assert.ok(label.includes(game.romName), `split.html starts with the cached game (${label})`);
    };

    // From the list of games in this browser, in one click.
    await page.goto(`${BASE}/index.html?autostart=0&renderer=software`, { waitUntil: 'domcontentloaded' });
    const together = `button[data-action="play-together"][data-url="${game.downloadUrl}"]`;
    await page.waitForSelector(together, { visible: true, timeout: 30000 });
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click(together)]);
    await opensSplit();
    const listed = await page.$$eval('#stored-games option', options => options.map(option => option.textContent));
    assert.ok(listed.some(text => text.includes(game.title)), 'split.html lists it among the games in this browser');
    console.log(`PASS a cached library game (${game.title}) opens on split.html from the games in this browser`);

    // While it plays, from the Local Play card.
    await page.goto(`${BASE}/index.html?autostart=0&renderer=software&play=${encodeURIComponent(game.downloadUrl)}`,
        { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(url => window.AzaharUI?.getPlayableSource?.().url === url, { timeout: 120000 },
        game.downloadUrl).catch(async error => {
        const status = await page.evaluate(() => document.getElementById('status')?.textContent);
        throw new Error(`the cached game did not open (status: ${status}): ${error.message}`);
    });
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
        page.click('#btn-local-play-device')]);
    await opensSplit();
    console.log(`PASS a cached library game (${game.title}) opens on split.html from the Local Play card`);
    await page.close();
}

const fmt = shares => shares.map(share => share.toFixed(2)).join('/');

// The ? on the top bar explains how players join a game room, and closes again.
async function helpChecks(page) {
    await page.click('#btn-help');
    const shown = await page.$eval('#help-dialog', dialog => ({ open: dialog.open, text: dialog.textContent }));
    assert.ok(shown.open, '? opens the help');
    for (const part of ["Join Player 1's Download Play", 'Local Multiplayer', 'Local Play', '↺']) {
        assert.ok(shown.text.includes(part), `the help mentions ${part}`);
    }
    await page.keyboard.press('Escape');
    assert.ok(!(await page.$eval('#help-dialog', dialog => dialog.open)), 'Escape closes it');
    await page.click('#btn-help');
    await page.mouse.click(5, 5);
    assert.ok(!(await page.$eval('#help-dialog', dialog => dialog.open)), 'a click outside closes it');
    console.log('PASS ? on the top bar explains how players join a room (Download Play and the game\'s own menu)');
}

// Player 1 opens a Download Play lobby (the consoles' rooms and joins are stood in for): Player 2,
// in no room, is invited while its player presses keys, then, left alone (?joinIdle=3), counts
// down and joins it with no click, its keys doing nothing while it waits; Leave keeps it out and
// 📥 joins again; Player 3, whose game has its wireless menu open, is only offered 📥; and once
// Player 3 opens a lobby too, it is offered a restart that joins Player 1's.
// Steps give touches and screen regions as fractions of the native 400x480 frame (both screens
// at one size, stacked); a console's Screens setting puts its screens elsewhere on its canvas.
// [x, y, w, h] in the native frame -> the same on the console's canvas. A region is on the
// screen it starts on.
async function onCanvas(frame, rects) {
    return frame.evaluate(rects => {
        const { width, height, top, bottom } = window.AzaharSplitSeat.screens();
        return rects.map(([x, y, w = 0, h = 0]) => {
            // The native frame's touch screen spans x 0.1-0.9 of its lower half.
            const [screen, fx, fw, fy] = y < 0.5 ? [top, x, w, y * 2] : [bottom, (x - 0.1) / 0.8, w / 0.8, y * 2 - 1];
            return [(screen.x + fx * screen.w) / width, (screen.y + fy * screen.h) / height,
                fw * screen.w / width, h * 2 * screen.h / height];
        });
    }, rects);
}

// Where each console's screens are, and its canvas (its drawable and its size on the page).
const screensOf = frames => Promise.all(frames.map(frame => frame.evaluate(() => {
    const canvas = document.getElementById('canvas');
    return { ...window.AzaharSplitSeat.screens(), drawable: [canvas.width, canvas.height],
        frame: [window.innerWidth, window.innerHeight], url: new URLSearchParams(location.search).get('screens') };
})));

// Each player's Screens menu lays out their console's two screens: big top (the default, both
// screens keeping their shape, the touch screen 50-75% of the top one's size), stretched (the
// top screen over all the room the touch screen leaves), or as on a 3DS.
async function screensChecks(page, frames) {
    const near = (a, b, within = 1.5) => Math.abs(a - b) <= within;
    const pick = (index, value) => page.evaluate((i, value) => {
        const select = document.querySelectorAll('#seats .seat-screens')[i];
        select.value = value;
        select.dispatchEvent(new Event('change'));
    }, index, value);
    const inside = (rect, width, height) => rect.x >= -0.5 && rect.y >= -0.5 &&
        rect.x + rect.w <= width + 0.5 && rect.y + rect.h <= height + 0.5;
    const apart = (a, b) => a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 || a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5;

    assert.deepStrictEqual(await page.$$eval('#seats .seat-screens', selects => selects.map(select => select.value)),
        ['top', 'top', 'top'], 'every player starts with the big top screen');
    for (const [index, shown] of (await screensOf(frames)).entries()) {
        const { width, height, top, bottom } = shown;
        const label = `Player ${index + 1}, big top ${JSON.stringify(shown)}`;
        assert.strictEqual(shown.screens, 'top', label);
        assert.deepStrictEqual([width, height], shown.frame, `${label}: the canvas fills the frame`);
        assert.ok(shown.drawable[0] >= 400 && shown.drawable[1] >= 480, `${label}: the drawable is at least the native frame`);
        assert.ok(near(top.w / top.h, 5 / 3, 0.01) && near(bottom.w / bottom.h, 4 / 3, 0.01), `${label}: both screens keep their shape`);
        const ratio = (bottom.w / 320) / (top.w / 400);
        assert.ok(ratio >= 0.5 - 0.001 && ratio <= 0.75 + 0.001, `${label}: the touch screen is 50-75% of the top one (${ratio.toFixed(2)})`);
        assert.ok(inside(top, width, height) && inside(bottom, width, height) && apart(top, bottom), `${label}: both on the canvas, apart`);
        const native = Math.min(width, height * 400 / 480);
        assert.ok(top.w > native * 1.1, `${label}: the top screen is larger than as on a 3DS (${Math.round(top.w)} > ${Math.round(native)} wide)`);
    }

    await pick(1, 'stretch');
    await pick(2, 'native');
    await page.waitForFunction(() => {
        const seats = window.AzaharSplit.seats().map(frame => frame.contentWindow.AzaharSplitSeat.screens()?.screens);
        return seats.join() === 'top,stretch,native';
    }, { timeout: 5000 }).catch(() => { throw new Error('the Screens menus did not reach their consoles'); });
    const [first, stretched, native] = await screensOf(frames);
    assert.strictEqual(first.screens, 'top', 'Player 1 keeps the big top screen');
    {
        const { width, height, top, bottom } = stretched;
        const label = `Player 2, stretched ${JSON.stringify(stretched)}`;
        const filled = (near(top.w, width) && near(top.h + bottom.h, height)) || (near(top.w + bottom.w, width) && near(top.h, height));
        assert.ok(filled, `${label}: the top screen takes all the room the touch screen leaves`);
        assert.ok(near(bottom.w / bottom.h, 4 / 3, 0.01) && inside(bottom, width, height) && apart(top, bottom),
            `${label}: the touch screen keeps its shape`);
    }
    assert.deepStrictEqual(native.drawable, [400, 480], 'Player 3, as on a 3DS: the native frame');
    assert.ok(near(native.width / native.height, 400 / 480, 0.01) && near(native.top.h, native.height / 2),
        `Player 3, as on a 3DS: both screens at one size, stacked (${JSON.stringify(native)})`);
    assert.deepStrictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('azahar-split-screens'))),
        [null, 'stretch', 'native'], 'each player\'s choice is kept in this browser');
    // The pages opened next in this browser (the games too) start from big top again; this page
    // keeps the choices (resetChecks restarts Player 2, which must stay stretched).
    await page.evaluate(() => localStorage.removeItem('azahar-split-screens'));
    console.log('PASS each player\'s Screens menu lays out only their screens: big top by default (a top screen ' +
        `${Math.round(first.top.w)}×${Math.round(first.top.h)} where a 3DS layout fits ` +
        `${Math.round(Math.min(first.width, first.height * 400 / 480))}×${Math.round(Math.min(first.width, first.height * 400 / 480) * 0.6)}` +
        `, the touch screen ${Math.round((first.bottom.w / 320) / (first.top.w / 400) * 100)}% of its size), stretched, or as on a 3DS`);
}

// Where a seat's join panel is, and the top screen of its console, in the page.
const panelAndTop = (page, index) => page.evaluate(i => {
    const seat = document.querySelectorAll('#seats .seat')[i];
    const frame = seat.querySelector('iframe');
    const canvas = frame.contentDocument.getElementById('canvas').getBoundingClientRect();
    const { top } = frame.contentWindow.AzaharSplitSeat.screens();
    const box = frame.getBoundingClientRect();
    const panel = seat.querySelector('.seat-join').getBoundingClientRect();
    return { panel: { left: panel.left, right: panel.right, bottom: panel.bottom },
        top: { left: box.left + canvas.left + top.x, right: box.left + canvas.left + top.x + top.w,
            bottom: box.top + canvas.top + top.y + top.h } };
}, index);

async function joinPanelChecks(page, frames) {
    await Promise.all(frames.map((frame, index) => frame.evaluate(index => {
        const netplay = window.AzaharNetplay;
        const mac = `02:00:00:00:00:0${index}`;
        const idle = { stage: 'idle', host: null, rooms: [] };
        window.testLobby = {
            room: index === 0 ? { status: 'host', host: mac, wlanCommId: 0x2810, networkId: 7, node: 1,
                nodes: [{ id: 1, name: 'Player 1' }], initialized: true } : { status: 'none', initialized: index === 2 },
            join: idle, joins: [],
            saved: { status: netplay.status, join: netplay.joinDownloadPlay, cancel: netplay.cancelDownloadPlay,
                running: window.AzaharUI.isRunning, programId: window.AzaharUI.getProgramId },
        };
        netplay.status = () => ({ ...window.testLobby.saved.status.call(netplay), joined: true, mac,
            gameRoom: window.testLobby.room, downloadPlay: window.testLobby.join });
        netplay.joinDownloadPlay = host => {
            window.testLobby.joins.push(host);
            window.testLobby.join = { stage: 'scanning', host: '00:00:00:00:00:00', rooms: [] };
            return null;
        };
        netplay.cancelDownloadPlay = () => { window.testLobby.join = idle; };
        window.AzaharUI.isRunning = () => true;
        window.AzaharUI.getProgramId = () => '0004000000123400';
    }, index)));
    const panels = () => page.$$eval('#seats .seat-join', elements => elements.map(element => element.hidden ? null : {
        mode: element.dataset.mode, text: element.querySelector('.seat-join-text').textContent,
        buttons: [...element.querySelectorAll('button')].filter(button => !button.hidden).map(button => button.textContent),
    }));
    const waitPanel = (index, mode, label) => page.waitForFunction((i, mode) =>
        document.querySelectorAll('#seats .seat-join')[i].dataset.mode === mode &&
        !document.querySelectorAll('#seats .seat-join')[i].hidden, { timeout: 10000 }, index, mode)
        .catch(async () => { throw new Error(`${label}: ${JSON.stringify(await panels())}`); });
    const click = (index, selector) => page.evaluate((i, selector) =>
        document.querySelectorAll('#seats .seat-join')[i].querySelector(selector).click(), index, selector);
    const setJoin = (index, join) => frames[index].evaluate(join => { window.testLobby.join = join; }, join);

    // Player 2's player is pressing keys: invited, not joined.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('KeyL');
    await waitPanel(1, 'invite', 'Player 2, in use, is invited');
    let shown = await panels();
    assert.deepStrictEqual(shown[1], { mode: 'invite', text: 'Player 1 opened a Download Play lobby.',
        buttons: ["📥 Join Player 1's lobby", 'Not now'] });
    assert.deepStrictEqual(await page.evaluate(() => window.AzaharSplit.joins()[1]), [], 'and does not join yet');
    await waitPanel(1, 'countdown', 'Player 2, left alone, counts down to joining Player 1\'s lobby');
    shown = await panels();
    assert.strictEqual(shown[0], null, 'the host is offered nothing');
    assert.match(shown[1].text, /Player 1 opened a Download Play lobby\. Player 2 joins it in [1-5] s\./);
    assert.deepStrictEqual(shown[1].buttons, ['📥 Join now', 'Not now']);
    const placed = await panelAndTop(page, 1);
    assert.ok(Math.abs(placed.panel.bottom - placed.top.bottom) <= 2 &&
        Math.abs((placed.panel.left + placed.panel.right) / 2 - (placed.top.left + placed.top.right) / 2) <= 2 &&
        placed.panel.left >= placed.top.left && placed.panel.right <= placed.top.right,
    `the panel sits over the lower part of Player 2's top screen, where its Screens setting put it: ${JSON.stringify(placed)}`);
    assert.deepStrictEqual(shown[2], { mode: 'offer', text: '', buttons: ["📥 Join Player 1's Download Play"] },
        'a console whose game has its wireless menu open is only offered 📥');
    await waitPanel(1, 'lobby', 'Player 2 joins on its own');
    assert.deepStrictEqual(await frames[1].evaluate(() => window.testLobby.joins), ['02:00:00:00:00:00'],
        'Player 2 joined Player 1\'s lobby by its address');
    assert.deepStrictEqual(await page.evaluate(() => window.AzaharSplit.joins()), [[], [{ how: 'auto', host: 0 }], []]);
    shown = await panels();
    assert.match(shown[1].text, /Joining Player 1's lobby/);
    assert.deepStrictEqual(shown[1].buttons, ['Leave']);
    assert.deepStrictEqual(shown[2].mode, 'offer', 'Player 3 still only has 📥');

    // Waiting in the lobby, Player 2's keys do nothing (Player 1's still work).
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.down('KeyL');
    await page.keyboard.down('KeyG');
    await sleep(300);
    const held = await Promise.all(frames.map(frame => frame.evaluate(() => window.AzaharInput.getPressedCodes())));
    await page.keyboard.up('KeyL');
    await page.keyboard.up('KeyG');
    assert.deepStrictEqual(held, [['KeyA'], [], []], 'a console in the lobby gets no keys');

    await setJoin(1, { stage: 'joined', host: '02:00:00:00:00:00', rooms: [] });
    await page.waitForFunction(() => /In Player 1's lobby\. Player 1 starts the game/.test(
        document.querySelectorAll('#seats .seat-join-text')[1].textContent), { timeout: 5000 });
    await click(1, '.seat-join-later');
    await waitPanel(1, 'offer', 'Leave leaves the lobby');
    await sleep(6000);
    shown = await panels();
    assert.strictEqual(shown[1].mode, 'offer', 'after Leave it does not join that lobby on its own again');
    assert.strictEqual((await frames[1].evaluate(() => window.testLobby.joins)).length, 1);
    await click(1, '.seat-dlp');
    await waitPanel(1, 'lobby', '📥 joins again');
    assert.deepStrictEqual((await page.evaluate(() => window.AzaharSplit.joins()))[1].map(join => join.how), ['auto', 'button']);

    // Player 3 opens a lobby too.
    await frames[2].evaluate(() => {
        window.testLobby.room = { status: 'host', host: '02:00:00:00:00:02', wlanCommId: 0x2810, networkId: 9,
            node: 1, nodes: [{ id: 1, name: 'Player 3' }], initialized: true };
    });
    await waitPanel(2, 'hosting', 'Player 3, hosting too, is offered a restart');
    shown = await panels();
    assert.match(shown[2].text, /Player 1 opened a lobby too, so nobody can join either/);
    assert.deepStrictEqual(shown[2].buttons, ['↺ Restart and join Player 1', 'Not now']);
    await click(2, '.seat-join-later');
    await page.waitForFunction(() => document.querySelectorAll('#seats .seat-join')[2].hidden, { timeout: 5000 });

    await Promise.all(frames.map(frame => frame.evaluate(() => {
        const { saved } = window.testLobby;
        Object.assign(window.AzaharNetplay, { status: saved.status, joinDownloadPlay: saved.join, cancelDownloadPlay: saved.cancel });
        Object.assign(window.AzaharUI, { isRunning: saved.running, getProgramId: saved.programId });
        delete window.testLobby;
    })));
    await page.waitForFunction(() => [...document.querySelectorAll('#seats .seat-join')].every(panel => panel.hidden),
        { timeout: 5000 }).catch(() => { throw new Error('the join panels stayed after the lobby closed'); });
    console.log('PASS a Download Play lobby on one screen: another screen in no room is asked while in use, then ' +
        'left alone joins it on its own after a countdown (its keys wait), Leave and 📥 work, a screen in its own wireless menu is only offered 📥, ' +
        'and one hosting too is offered a restart that joins');
}

// One console restarts while the others play on: its frame reloads and gets the game and the
// link again, and the others drop the old console and see the new one. A console that stops on
// its own is restarted too, with compiled code off when it stopped with it on.
async function resetChecks(page) {
    const linkOf = index => page.evaluate(i => {
        const netplay = window.AzaharSplit.seats()[i].contentWindow.AzaharNetplay;
        return netplay ? { id: netplay.id, mode: netplay.mode } : null;
    }, index);
    const before = await linkOf(1);
    await page.evaluate(() => document.querySelectorAll('#seats .seat-reset')[1].click());
    await page.waitForFunction(old => {
        const netplay = window.AzaharSplit.seats()[1].contentWindow.AzaharNetplay;
        return netplay && netplay.id !== old && netplay.mode === 'shared';
    }, { timeout: 120000 }, before.id).catch(() => { throw new Error('↺ did not bring player 2\'s console back on the link'); });
    const after = await linkOf(1);
    await page.waitForFunction(id => window.AzaharSplit.seats().every((frame, index) => {
        const peers = frame.contentWindow.AzaharNetplay?.status().peers.map(peer => peer.id) || [];
        return peers.length === 2 && (index === 1 || peers.includes(id));
    }), { timeout: 60000 }, after.id).catch(() => { throw new Error('the others did not see the restarted console rejoin'); });
    const others = await page.evaluate(() => window.AzaharSplit.seats()[0].contentWindow.AzaharNetplay.status().peers.map(peer => peer.id));
    assert.ok(!others.includes(before.id), 'the old console is gone from the others\' peers');
    await page.waitForFunction(() => window.AzaharSplit.seats()[1].contentWindow.AzaharSplitSeat?.screens()?.screens === 'stretch',
        { timeout: 10000 }).catch(() => { throw new Error('player 2 lost their Screens setting when restarted'); });
    console.log('PASS ↺ restarts one console: it gets the game and the link again (its screens as its player set them), ' +
        'and the others drop the old one and see it rejoin');

    await page.evaluate(() => window.AzaharSplit.seats()[2].contentWindow.AzaharSplitSeat.failed('test stop', true));
    await page.waitForFunction(() => {
        const window3 = window.AzaharSplit.seats()[2].contentWindow;
        return /cpuJit=0/.test(window3.location.search) && window3.AzaharNetplay?.mode === 'shared';
    }, { timeout: 120000 }).catch(() => { throw new Error('a console that stopped was not restarted'); });
    const said = await page.$eval('#status', element => element.textContent);
    assert.match(said, /Player 3 stopped \(test stop\)/, 'the page says which console stopped and why');
    assert.match(said, /compiled code off/, 'and that it restarts with compiled code off');
    console.log('PASS a console that stops is restarted on its own, with compiled code off after it stopped with it on');
}

// Each player presses their own keys on the shared keyboard (split.html hands every console
// its player's keys), so both consoles' steps can run at once; the shared mouse is taken one
// touch at a time.
let mouseLock = Promise.resolve();

// Holds `code` (a key of the console's own keymap) with player `index`'s physical key.
async function holdPlayerKey(page, index, code, down) {
    const key = await page.evaluate((index, code) => window.AzaharSplit.keyFor(index, code), index, code);
    assert.ok(key, `player ${index + 1} has a key for ${code}`);
    await (down ? page.keyboard.down(key) : page.keyboard.up(key));
}

async function runSteps(page, frame, steps, holdKey) {
    const canvas = await frame.$('#canvas');
    for (const step of steps) {
        const [action, ...args] = step.split(/\s+/);
        if (action === 'downloadplay') {
            // This screen joins the Download Play lobby another console opened on its own, with
            // no click (split.html counts down, then joins).
            const index = await frame.evaluate(() => Number(new URLSearchParams(location.search).get('seat')));
            await page.waitForFunction(i => window.AzaharSplit.joins()[i]?.length > 0, { timeout: timeoutMs }, index)
                .catch(async () => {
                    const panel = await page.evaluate(i => document.querySelectorAll('#seats .seat-join')[i].textContent, index);
                    throw new Error(`player ${index + 1} did not join the lobby on its own (${panel.trim()}): ` +
                        `${await page.$eval('#status', e => e.textContent)}`);
                });
            const joins = await page.evaluate(i => window.AzaharSplit.joins()[i], index);
            assert.deepStrictEqual(joins, [{ how: 'auto', host: 0 }], `player ${index + 1} joined Player 1's lobby on its own, once`);
            await frame.waitForFunction(() => window.AzaharNetplay.downloadPlay()?.stage !== 'idle', { timeout: 30000 })
                .catch(async () => { throw new Error(`player ${index + 1} is not joining: ${await page.$eval('#status', e => e.textContent)}`); });
        } else if (action === 'wait') {
            await guestSleep(frame, Number(args[0]));
        } else if (action === 'key') {
            await holdKey(frame, args[0], true);
            await guestSleep(frame, Number(args[1] || 250));
            await holdKey(frame, args[0], false);
        } else if (action === 'touch') {
            const touch = mouseLock.then(async () => {
                const box = await canvas.boundingBox();
                const [[x, y]] = await onCanvas(frame, [[Number(args[0]), Number(args[1])]]);
                await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
                await page.mouse.down();
                await guestSleep(frame, Number(args[2] || 250));
                await page.mouse.up();
            });
            mouseLock = touch.catch(() => {});
            await touch;
        } else {
            throw new Error(`Unknown step: ${step}`);
        }
    }
}

// The real keyboard reaches only the console whose screen has focus (Ctrl+N picks it).
// Players share one keyboard: each console gets only its player's keys, translated to the
// console's own keymap (A is KeyA there), whichever screen has focus. Ctrl+N gives one player
// the whole keyboard and Ctrl+0 shares it again. Controllers go to the players one each.
async function keyboardChecks(page, frames) {
    const held = () => Promise.all(frames.map(frame => frame.evaluate(() => window.AzaharInput.getPressedCodes().sort())));
    const expectHeld = async (expected, label) => {
        for (let attempt = 0; attempt < 40; attempt++) {
            if (JSON.stringify(await held()) === JSON.stringify(expected)) return;
            await sleep(50);
        }
        assert.deepStrictEqual(await held(), expected, label);
    };
    const none = frames.map(() => []);
    assert.deepStrictEqual(await page.evaluate(() => window.AzaharSplit.keyLayouts()), ['left', 'right', 'none'],
        'players 1 and 2 split the keyboard; player 3 uses a controller');
    const legends = await page.$$eval('#seats .seat-legend', elements => elements.map(element => element.textContent));
    assert.match(legends[0], /WASD/, 'player 1 sees their keys');
    assert.match(legends[1], /Arrows/, 'player 2 sees theirs');
    await page.evaluate(() => document.activeElement?.blur());

    await page.keyboard.down('KeyG');
    await expectHeld([['KeyA'], [], []], "player 1's G is A on player 1's console only");
    await page.keyboard.down('KeyL');
    await expectHeld([['KeyA'], ['KeyA'], []], "player 2's L is A on player 2's console, at the same time");
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ArrowLeft');
    await expectHeld([['ArrowUp', 'KeyA'], ['ArrowLeft', 'KeyA'], []], 'each moves their own Circle Pad');
    for (const key of ['KeyG', 'KeyL', 'KeyW', 'ArrowLeft']) await page.keyboard.up(key);
    await expectHeld(none, 'releasing the keys releases them on the consoles');

    // A screen with focus (clicked to touch it) passes its keys on to the same routing.
    await page.evaluate(() => document.querySelectorAll('#seats iframe')[1].focus());
    await page.keyboard.down('KeyG');
    await expectHeld([['KeyA'], [], []], "inside player 2's screen, G still belongs to player 1");
    await page.keyboard.up('KeyG');
    await expectHeld(none, 'and is released');

    const ctrl = async digit => {
        await page.keyboard.down('Control');
        await page.keyboard.press(digit);
        await page.keyboard.up('Control');
    };
    await ctrl('Digit2');
    await page.waitForFunction(() => window.AzaharSplit.keyLayouts().join() === 'none,all,none', { timeout: 5000 })
        .catch(() => { throw new Error('Ctrl+2 did not give player 2 the whole keyboard'); });
    await page.keyboard.down('KeyA');
    await expectHeld([[], ['KeyA'], []], "Ctrl+2: the emulator's keymap drives player 2 alone");
    await page.keyboard.up('KeyA');
    const marked = await page.$$eval('#seats .seat', seats => seats.map(seat => seat.classList.contains('has-keyboard')));
    assert.deepStrictEqual(marked, [false, true, false], 'the screen with keys is marked');
    await ctrl('Digit0');
    await page.waitForFunction(() => window.AzaharSplit.keyLayouts().join() === 'left,right,none', { timeout: 5000 })
        .catch(() => { throw new Error('Ctrl+0 did not share the keyboard again'); });
    console.log('PASS players 1 and 2 play on one keyboard with keys of their own; Ctrl+N and Ctrl+0 switch');

    // Two controllers: the first goes to player 1 and the second to player 2.
    await page.evaluate(() => {
        const pad = index => ({ index, id: `Test pad ${index + 1}`, connected: true, mapping: 'standard',
            buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] });
        window.testPads = [pad(0), pad(1)];
        navigator.getGamepads = () => window.testPads;
        window.testPads[0].buttons[1] = { pressed: true, value: 1 };
        window.testPads[1].axes[0] = -1;
    });
    await expectHeld([['KeyA'], ['ArrowLeft'], []], "each controller drives its own player's console");
    await page.evaluate(() => { window.testPads = []; });
    await expectHeld(none, 'and unplugging them lets go');
    console.log('PASS each controller drives its own player\'s console');
}

const logText = frame => frame.evaluate(() => window.AzaharUI.getLog());

async function waitForLog(frame, pattern, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (pattern.test(await logText(frame))) return;
        await sleep(1000);
    }
    throw new Error(`${label}: no "${pattern.source}" in the log after ${timeoutMs / 1000}s`);
}

// Holds `code` (a key of the console's own keymap) on test controller `pad`, through the
// standard mapping the page reads (button for a button, stick axis for a direction).
async function holdPadKey(page, pad, code, down) {
    await page.evaluate((pad, code, down) => {
        const keymap = window.AzaharSplit.seats()[0].contentWindow.AzaharInput.KEYMAP;
        const binding = keymap.find(entry => entry.code === code)?.pad;
        const state = window.testPads[pad];
        if (binding?.button !== undefined) state.buttons[binding.button] = { pressed: down, value: down ? 1 : 0 };
        else if (binding?.axis !== undefined) state.axes[binding.axis] = down ? binding.direction : 0;
        else throw new Error(`no controller binding for ${code}`);
    }, pad, code, down);
}

async function playGame(browser, rom) {
    const key = cfg.argVal('--game', 'mario-kart-7');
    const game = GAMES[key];
    assert.ok(game, `no game ${key} in multiplayer_games.json`);
    const renderer = cfg.argVal('--renderer', 'webgl2');
    // --query passes page options to every console (split.html hands on the ones it knows).
    const extra = cfg.argVal('--query', '');
    const players = Number(cfg.argVal('--players', 2));
    assert.ok(players >= 2 && players <= 8, '--players takes 2 to 8');
    const page = await openSplit(browser, `players=${players}&renderer=${renderer}${extra ? `&${extra}` : ''}`, rom);
    const frames = await seatFrames(page);
    const [host, guest] = frames;
    const guests = frames.slice(1);
    // Players 3 and up play on a controller of their own.
    if (players > 2) {
        await page.evaluate(count => {
            const pad = index => ({ index, id: `Test pad ${index + 1}`, connected: true, mapping: 'standard',
                buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] });
            window.testPads = Array.from({ length: count }, (_, index) => pad(index));
            navigator.getGamepads = () => window.testPads;
        }, players - 2);
        for (let index = 2; index < players; index++) {
            const select = `#seats .seat:nth-child(${index + 1}) .seat-pad`;
            await page.waitForFunction(select => [...document.querySelector(select).options].length > 2,
                { timeout: 10000 }, select);
            await page.select(select, String(index - 2));
        }
    }
    const holdKey = (frame, code, down) => {
        const index = frames.indexOf(frame);
        return index < 2 ? holdPlayerKey(page, index, code, down) : holdPadKey(page, index - 2, code, down);
    };
    for (const frame of frames) {
        await frame.waitForFunction(count => window.AzaharUI?.isRunning() && window.AzaharNetplay.status().joined &&
            window.AzaharNetplay.status().peers.filter(peer => peer.mac).length === count - 1, { timeout: 180000 }, players);
    }
    const states = await Promise.all(frames.map(frame => frame.evaluate(() => window.AzaharNetplay.status())));
    const hostState = states[0];
    assert.strictEqual(new Set(states.map(state => state.mac)).size, players, 'each console has its own address');
    assert.deepStrictEqual(hostState.peers.map(peer => peer.mac).sort(), states.slice(1).map(state => state.mac).sort(),
        'the host sees every other console');
    for (const frame of frames) await installFrameTrace(frame);
    const started = Date.now();
    const directory = path.join(OUTPUT, key);
    // --film keeps a screenshot of both consoles every 15 s, to see where a run went astray.
    const film = cfg.argFlag('--film');
    const monitor = setInterval(async () => {
        const read = frame => frame.evaluate(() => document.getElementById('fps').textContent).catch(() => '?');
        const shares = await page.evaluate(() => window.AzaharSplit.shares().map(s => s.toFixed(2)).join('/')).catch(() => '?');
        const seconds = Math.round((Date.now() - started) / 1000);
        const checkpoints = await page.evaluate(() => JSON.stringify(window.AzaharSplit.checkpointStats())).catch(() => '?');
        console.log(`  t+${seconds}s P1 ${await read(frames[0])} | P2 ${await read(frames[1])} | shares ${shares} | checkpoints ${checkpoints}`);
        if (film) await page.screenshot({ path: path.join(directory, `film-${String(seconds).padStart(4, '0')}.png`) }).catch(() => {});
    }, 15000);
    const screenshot = name => page.screenshot({ path: path.join(directory, `${name}.png`) });
    fs.mkdirSync(directory, { recursive: true });
    // In a game every player has, a player joins from the game's menu with the full game, so
    // they say Not now when their screen, left alone while Player 1 opens a room that takes
    // Download Play players too (Mario Kart 7's does), counts down to joining it that way.
    const declined = new Set();
    let stopWatch = () => {};
    const decliner = game.downloadPlay ? null : setInterval(() => {
        page.evaluate(() => [...document.querySelectorAll('#seats .seat-join')].map((panel, index) => {
            if (panel.hidden || !['countdown', 'invite'].includes(panel.dataset.mode)) return -1;
            panel.querySelector('.seat-join-later').click();
            return index;
        })).then(list => list.forEach(index => index >= 0 && declined.add(index))).catch(() => {});
    }, 300);
    try {
        await runSteps(page, host, game.host.steps, holdKey);
        for (const [index, frame] of guests.entries()) {
            await runSteps(page, frame, game.guest.steps, holdKey);
            await waitForLog(host, new RegExp(`Node ${index + 2} joined the hosted network`), 'host');
            await waitForLog(frame, /Joined a network as node \d+/, `player ${index + 2}`);
        }
        // Everyone in one room, as the consoles see it: the host's network lists every player
        // and each guest is a client of the host's console.
        await page.waitForFunction(() => window.AzaharSplit.together() === 0, { timeout: 30000 }).catch(async () => {
            const rooms = await Promise.all(frames.map(frame => frame.evaluate(() => window.AzaharNetplay.gameRoom())));
            throw new Error(`the players are not in one room: ${JSON.stringify(rooms)}`);
        });
        const rooms = await Promise.all(frames.map(frame => frame.evaluate(() => window.AzaharNetplay.gameRoom())));
        const hostRoom = rooms[0];
        assert.strictEqual(hostRoom.status, 'host');
        assert.deepStrictEqual(hostRoom.nodes.map(node => node.id), frames.map((_, index) => index + 1),
            'the host\'s room has every player');
        for (const room of rooms.slice(1)) {
            assert.strictEqual(room.status, 'client');
            assert.strictEqual(room.host, hostState.mac, 'each guest is in the host\'s room');
            assert.ok(hostRoom.nodes.some(node => node.id === room.node), 'which lists it');
        }
        const badges = await page.$$eval('#seats .seat-room', elements => elements.map(element => element.textContent));
        assert.match(badges[0], new RegExp(`Hosting a room · ${players} players`));
        for (const badge of badges.slice(1)) assert.match(badge, /In Player 1's room/);
        await screenshot('joined');
        // Guests that joined from the game's own menu had its wireless open, so the page did
        // not take them into Download Play on its own.
        const joins = await page.evaluate(() => window.AzaharSplit.joins());
        if (!game.downloadPlay) {
            assert.ok(joins.every(list => !list.length), `no console joined with Download Play: ${JSON.stringify(joins)}`);
            if (declined.size) {
                console.log(`  ${[...declined].map(index => `Player ${index + 1}`).join(', ')} said Not now to joining with Download Play`);
            }
        }
        const stats = await guest.evaluate(() => window.AzaharNetplay.status().stats);
        console.log(`PASS ${game.title}: all ${players} players are in one room, players 1 and 2 on one keyboard` +
            `${players > 2 ? ` and ${players - 2} on controllers` : ''} (Player 1 hosts network ` +
            `0x${(hostRoom.wlanCommId >>> 0).toString(16)} with nodes ${hostRoom.nodes.map(node => node.id).join(', ')}; ` +
            `${stats.delivered} frames delivered to Player 2)`);
        if (game.downloadPlay) {
            await downloadPlayStarts(page, frames, game, holdKey, screenshot);
            // Recovery compares the screens through the game's followCheck.
            if (!cfg.argFlag('--no-recover') && game.followCheck) {
                await recoverConsoles(page, frames, game);
                await screenshot('recovered');
            }
        }
        // The next phase, such as the host starting a race, and whether both consoles agree on it.
        if (!game.downloadPlay && players === 2 && !cfg.argFlag('--no-race') && (game.host.afterJoin || game.guest.afterJoin)) {
            if (cfg.argFlag('--stall-dump')) stopWatch = watchStall(frames, directory);
            await Promise.all([runSteps(page, host, game.host.afterJoin || [], holdKey),
                runSteps(page, guest, game.guest.afterJoin || [], holdKey)]);
            await guestSleep(host, Number(game.afterJoinWaitMs || 30000));
            await screenshot('after-join');
            if (game.syncCheck) {
                const io = {
                    shoot: async frame => (await frame.$('#canvas')).screenshot({ encoding: 'base64' }),
                    hold: holdKey,
                    place: onCanvas,
                };
                const { share, details } = await checkSync(host, guest, game.syncCheck, io);
                await screenshot('sync');
                const pacing = await Promise.all([host, guest].map(frame =>
                    frame.evaluate(() => window.AzaharNetplay.status().pacing)));
                console.log(`  pacing: P1 ${JSON.stringify(pacing[0])}, P2 ${JSON.stringify(pacing[1])}`);
                assert.ok(share >= (game.syncCheck.minShare ?? 0.6),
                    `the consoles disagreed in ${Math.round((1 - share) * 100)}% of samples (${details.join(' | ')})`);
                console.log(`PASS ${game.title}: both consoles show the same race in ` +
                    `${Math.round(share * 100)}% of samples (${details.join(' | ')})`);
            }
        }
    } catch (error) {
        // What a console that stopped drawing is waiting for: each guest thread's state.
        for (const [index, frame] of frames.entries()) {
            const threads = await frame.evaluate(() => {
                const log = () => window.AzaharUI.getLog();
                const before = log().length;
                window.AzaharUI.getModule()?._azahar_debug_threads?.();
                return log().slice(before).split('\n').filter(line => /azahar_debug_threads/.test(line) &&
                    !/WaitArb|WaitSleep|Dormant/.test(line)).map(line => line.replace(/.*azahar_debug_threads:\d+: /, '').slice(0, 160));
            }).catch(() => []);
            const fps = await frame.evaluate(() => document.getElementById('fps').textContent).catch(() => '?');
            console.log(`  Player ${index + 1} (${fps}):`);
            for (const line of threads) console.log(`    ${line}`);
            const log = await frame.evaluate(() => window.AzaharUI.getLog()).catch(() => '');
            fs.writeFileSync(path.join(directory, `player-${index + 1}.log`), log);
            const stats = await frame.evaluate(() => window.AzaharNetplay.status().stats).catch(() => null);
            console.log(`    frames: ${JSON.stringify(stats)}; last seconds of game time:`);
            const trace = await saveFrameTrace(frame, path.join(directory, `frames-${index + 1}.txt`));
            for (const line of trace) console.log(`    ${line.slice(0, 200)}`);
        }
        console.log(`  logs in ${path.relative(cfg.ROOT, directory)}`);
        throw error;
    } finally {
        stopWatch();
        clearInterval(monitor);
        clearInterval(decliner);
        await screenshot('split');
        for (const [index, frame] of frames.entries()) {
            await saveFrameTrace(frame, path.join(directory, `frames-${index + 1}.txt`)).catch(() => {});
            // --save-logs keeps each console's log of a run that passed too (a failure always does).
            if (cfg.argFlag('--save-logs')) {
                const log = await frame.evaluate(() => window.AzaharUI.getLog()).catch(() => '');
                if (log) fs.writeFileSync(path.join(directory, `player-${index + 1}.log`), log);
            }
            // Each bound data channel's queue: packets waiting now and the most ever waiting.
            const uds = await frame.evaluate(() => {
                const log = () => window.AzaharUI.getLog();
                const before = log().length;
                window.AzaharUI.getModule()?._azahar_debug_uds?.();
                return log().slice(before).split('\n').filter(line => /azahar_debug_uds/.test(line))
                    .map(line => line.replace(/.*azahar_debug_uds:\d+: /, ''));
            }).catch(() => []);
            for (const line of uds) console.log(`  Player ${index + 1} ${line}`);
        }
    }
    assert.deepStrictEqual(page.errors, [], 'no page errors');
    console.log(`  screenshots in ${path.relative(cfg.ROOT, directory)}`);
}

// The host starts a Download Play game (its afterJoin steps): every guest restarts into the
// game's Download Play child, which joins the game's own room on the host.
async function downloadPlayStarts(page, frames, game, holdKey, screenshot) {
    const [host] = frames;
    // No console stopped on the way here (the guest idled through the attract intro first).
    const stops = await page.evaluate(() => window.AzaharSplit.events().flat().filter(event => event.kind === 'stopped'));
    assert.deepStrictEqual(stops, [], 'no console stopped while the host gathered players');
    const programId = await host.evaluate(() => window.AzaharUI.getProgramId());
    await runSteps(page, host, game.host.afterJoin || [], holdKey);
    for (const [index, frame] of frames.entries()) {
        if (!index) continue;
        await frame.waitForFunction(() => /^00040001/.test(window.AzaharUI.getProgramId()), { timeout: timeoutMs })
            .catch(async () => {
                const join = await frame.evaluate(() => JSON.stringify(window.AzaharNetplay.downloadPlay()));
                throw new Error(`player ${index + 1} did not start the Download Play game (${join})`);
            });
    }
    // Everyone in the game's own room: the host left its Download Play room for it.
    await page.waitForFunction(() => {
        const host = window.AzaharSplit.seats()[0].contentWindow.AzaharNetplay.gameRoom();
        return window.AzaharSplit.together() === 0 && host?.status === 'host' && host.wlanCommId !== 0x2810;
    }, { timeout: timeoutMs }).catch(async () => {
        const rooms = await Promise.all(frames.map(frame => frame.evaluate(() => window.AzaharNetplay.gameRoom())));
        throw new Error(`the Download Play guests are not in the host's game room: ${JSON.stringify(rooms)}`);
    });
    const child = await frames[1].evaluate(() => window.AzaharUI.getProgramId());
    const hostRoom = await host.evaluate(() => window.AzaharNetplay.gameRoom());
    assert.strictEqual(child.slice(8), programId.slice(8), 'the child belongs to the host\'s game');
    await guestSleep(host, 10000);
    await screenshot('download-play-started');
    console.log(`PASS ${game.title}: the host started the game and all ${frames.length - 1} guest(s) run its Download Play ` +
        `child ${child} in Player 1's game room (network 0x${(hostRoom.wlanCommId >>> 0).toString(16)}, nodes ` +
        `${hostRoom.nodes.map(node => node.id).join(', ')})`);
}

// --stall-dump: while the consoles set up a race, every second, each console's data channels.
// Once both read a race channel, every guest thread of both consoles is written to
// stall-healthy.txt; when a console stops reading (a queue past 40 packets) or stops drawing
// (0 game FPS three times running), to stall-1.txt, and again 4 s later to stall-2.txt.
function watchStall(frames, directory) {
    const read = frame => frame.evaluate(() => {
        const log = () => window.AzaharUI.getLog();
        const module = window.AzaharUI.getModule();
        const before = log().length;
        module?._azahar_debug_uds?.();
        const uds = log().slice(before).split('\n').filter(line => /azahar_debug_uds/.test(line))
            .map(line => line.replace(/.*azahar_debug_uds:\d+: /, ''));
        const middle = log().length;
        module?._azahar_debug_threads?.();
        const threads = log().slice(middle).split('\n').filter(line => /azahar_debug_threads/.test(line))
            .map(line => line.replace(/.*azahar_debug_threads:\d+: /, ''));
        return { uds, threads, fps: document.getElementById('fps').textContent,
            time: window.AzaharNetplay.guestTimeUs() / 1e6 };
    }).catch(() => null);
    const write = (name, states) => fs.writeFileSync(path.join(directory, name), states.map((state, index) =>
        `Player ${index + 1} at ${state?.time?.toFixed(1)} s (${state?.fps}):\n` +
        [...(state?.uds || []), ...(state?.threads || [])].map(line => `  ${line}`).join('\n')).join('\n\n') + '\n');
    let healthy = false;
    let stalledAt = null;
    let zero = [0, 0];
    let done = false;
    const timer = setInterval(async () => {
        if (done) return;
        const states = await Promise.all(frames.slice(0, 2).map(read));
        const queues = states.map(state => (state?.uds || []).filter(line => /channel 243 /.test(line))
            .map(line => Number(/(\d+) packets/.exec(line)?.[1] || 0)));
        zero = states.map((state, index) => /^0 game FPS/.test(state?.fps || '') ? zero[index] + 1 : 0);
        if (!healthy && queues.every(list => list.length)) {
            healthy = true;
            setTimeout(async () => write('stall-healthy.txt', await Promise.all(frames.slice(0, 2).map(read))), 5000);
        }
        const stalled = queues.some(list => list.some(count => count > 40)) || zero.some(count => count >= 3);
        if (stalled && stalledAt === null) {
            stalledAt = Date.now();
            write('stall-1.txt', states);
            console.log(`  stall: queues ${JSON.stringify(queues)}, game FPS ${states.map(state => state?.fps).join(' / ')}`);
            setTimeout(async () => {
                write('stall-2.txt', await Promise.all(frames.slice(0, 2).map(read)));
                done = true;
            }, 4000);
        }
    }, 1000);
    return () => clearInterval(timer);
}

// Whether the guest shows what the host does: the host makes each of the game's followCheck
// choices, and a region that changes with them must look the same on both screens.
async function followsHost(page, frames, check, label) {
    const [host, guest] = frames;
    const io = (frame, step) => runSteps(page, frame, [step], () => {});
    const shoot = async frame => (await frame.$('#canvas')).screenshot({ encoding: 'base64' });
    const mean = (a, b) => a.reduce((sum, grid, k) => sum + grid.reduce((s, v, j) => s + Math.abs(v - b[k][j]), 0) / grid.length, 0) / a.length;
    const seen = [];
    for (const step of check.steps) {
        await io(host, step);
        await guestSleep(host, check.settleMs || 3000);
        const [a, b] = await Promise.all([host, guest].map(shoot));
        const [sa, sb] = await Promise.all([regionSignatures(host, a, await onCanvas(host, check.rects)),
            regionSignatures(guest, b, await onCanvas(guest, check.rects))]);
        const apart = mean(sa, sb);
        assert.ok(apart <= check.agree, `${label}: after "${step}" the guest shows something else than the host ` +
            `(${apart.toFixed(1)} apart, at most ${check.agree} allowed)`);
        seen.push(sa);
    }
    const changed = mean(seen[0], seen[seen.length - 1]);
    assert.ok(changed >= check.differ, `${label}: the host's choices did not change the compared region (${changed.toFixed(1)})`);
    return changed;
}

const seatEvents = (page, index) => page.evaluate(i => window.AzaharSplit.events()[i], index);

// A console stops (its step throws `RuntimeError: null function`, as a WebAssembly trap does):
// every console goes back to the checkpoint they took together, the stopped one reloading, and
// the guest must show the host's choices again.
async function crashAndRecover(page, frames, check, index) {
    const before = (await seatEvents(page, index)).length;
    const restores = (await page.evaluate(() => window.AzaharSplit.restores())).length;
    await frames[index].evaluate(() => {
        window.AzaharUI.getModule()._azahar_step_frame = () => { throw new WebAssembly.RuntimeError('null function (test)'); };
    });
    await page.waitForFunction((i, n, r) => {
        const events = window.AzaharSplit.events()[i].slice(n).map(event => event.kind).join();
        return events === 'stopped,restarted,restored' && window.AzaharSplit.restores()[r]?.restored;
    }, { timeout: timeoutMs }, index, before, restores).catch(async () => {
        throw new Error(`player ${index + 1} stopped and did not come back with the others ` +
            `(${JSON.stringify(await page.evaluate(() => window.AzaharSplit.events()))}): ${await page.$eval('#status', e => e.textContent)}`);
    });
    const fresh = await seatFrames(page);
    frames.splice(0, frames.length, ...fresh);
    for (const [other, frame] of frames.entries()) {
        if (other === index) continue;
        const events = (await seatEvents(page, other)).map(event => event.kind);
        assert.strictEqual(events[events.length - 1], 'restored', `player ${other + 1} went back to the checkpoint too`);
        assert.ok(await frame.evaluate(() => window.AzaharUI.isRunning()), `player ${other + 1} plays on`);
    }
    await page.waitForFunction(() => window.AzaharSplit.together() === 0, { timeout: 60000 })
        .catch(() => { throw new Error(`after player ${index + 1} stopped, the players are not in one room`); });
    const search = await frames[index].evaluate(() => location.search);
    const changed = await followsHost(page, frames, check, `after player ${index + 1} stopped`);
    console.log(`PASS player ${index + 1} stopped: every console went back to the checkpoint they took together` +
        `${/cpuJit=0/.test(search) ? ` (player ${index + 1} with compiled code off)` : ''}, and the guest shows the ` +
        `host's choices again (screens apart by at most ${check.agree}; the choices changed them by ${changed.toFixed(0)})`);
}

// Checkpoints and recovery with a game running in one room: the consoles' screens agree before
// anything happens; a stopped guest and a stopped host each bring everyone back to the checkpoint
// with the screens agreeing again; ↺ restarts the guest afresh (the host drops it from its room)
// and ⤺ brings everyone, it too, back to the checkpoint.
async function recoverConsoles(page, frames, game) {
    const check = game.followCheck;
    assert.ok(check, `${game.title} has no followCheck in multiplayer_games.json`);
    await page.waitForFunction(() => {
        const at = window.AzaharSplit.checkpoints();
        return at.every(value => value !== null && value === at[0]);
    }, { timeout: 180000 }).catch(() => { throw new Error('the consoles took no checkpoint together while in one room'); });
    await followsHost(page, frames, check, 'before any stop');
    console.log('PASS every console took a checkpoint at one moment, and the guest shows the host\'s choices');

    await crashAndRecover(page, frames, check, 1);
    await crashAndRecover(page, frames, check, 0);

    await page.evaluate(() => document.querySelectorAll('#seats .seat-reset')[1].click());
    await frames[0].waitForFunction(() => window.AzaharNetplay.gameRoom()?.nodes.length === 1, { timeout: 60000 })
        .catch(() => { throw new Error('the host kept the restarted console in its room'); });
    await page.waitForFunction(() => window.AzaharSplit.seats()[1].contentWindow.AzaharUI?.isRunning(), { timeout: timeoutMs });
    frames.splice(0, frames.length, ...(await seatFrames(page)));
    const room = await frames[1].evaluate(() => window.AzaharNetplay.gameRoom());
    assert.ok(!room || room.status !== 'client', `the fresh console is in no room (${JSON.stringify(room)})`);
    console.log('PASS ↺ restarts player 2 afresh: Player 1 drops it from its room, so it can join again under its address');

    await page.waitForFunction(() => !document.getElementById('btn-checkpoint-restore').disabled, { timeout: timeoutMs });
    const restores = (await page.evaluate(() => window.AzaharSplit.restores())).length;
    await page.click('#btn-checkpoint-restore');
    await page.waitForFunction(r => window.AzaharSplit.restores()[r]?.restored && window.AzaharSplit.together() === 0,
        { timeout: timeoutMs }, restores).catch(async () => {
        throw new Error(`⤺ did not bring everyone back into one room: ${await page.$eval('#status', e => e.textContent)}`);
    });
    frames.splice(0, frames.length, ...(await seatFrames(page)));
    const programId = await frames[1].evaluate(() => window.AzaharUI.getProgramId());
    assert.match(programId, /^00040001/, 'player 2 runs the Download Play game again');
    await followsHost(page, frames, check, 'after ⤺');
    console.log('PASS ⤺ brings every console, the restarted one too, back to the checkpoint: player 2 is in ' +
        'Player 1\'s game again and shows the host\'s choices');
}

async function main() {
    assert.ok(cfg.chromePath, 'Chrome not found; set CHROME_PATH');
    const root = cfg.argVal('--web', null);
    const server = cfg.argVal('--base', null) ? null :
        await listen(PORT, '127.0.0.1', root ? { root: path.resolve(root) } : {});
    const browser = await launch();
    try {
        if (!cfg.argFlag('--game-only')) await linkChecks(browser);
        let rom = cfg.argVal('--rom', null);
        const gameKey = cfg.argVal('--game', null);
        if (!rom && gameKey) {
            rom = findBuildRom(GAMES[gameKey]?.builds?.full);
            if (!rom) console.log(`SKIP ${gameKey}: no ROM found (pass --rom PATH, or --roms DIR with the game in it)`);
        }
        if (rom) await playGame(browser, path.resolve(rom));
        else if (!gameKey) console.log('SKIP game session (pass --rom PATH to play a title between two consoles)');
    } finally {
        await browser.close().catch(() => {});
        server?.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
