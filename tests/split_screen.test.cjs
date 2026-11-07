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
 *   5. with --rom, two consoles play a real title's local wireless mode: the
 *      steps for that title in multiplayer_games.json (--game, default
 *      mario-kart-7) host a room on Player 1's screen and join it on Player 2's,
 *      then (unless --no-race) start the match and check that both screens
 *      agree on it. Waits and holds count emulated time, since consoles that
 *      share a device may run below full speed.
 *
 * Usage:
 *   node tests/split_screen.test.cjs
 *   node tests/split_screen.test.cjs --rom PATH [--game mario-kart-7] [--renderer webgl2|software]
 *       [--no-race] [--gpu] [--timeout SECONDS] [--web DIR] [--query cpuJit=0] [--players N]
 *   --players N (2-8) puts N consoles in the game's room: players 1 and 2 on their keyboard
 *   keys, the others on a controller each; the race check needs two players.
 *   add --base URL to test a deployed site (https://shubin123.github.io/azahar_web) instead of web/
 */
'use strict';

const puppeteer = require('puppeteer-core');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { listen } = require('../web/server.cjs');
const cfg = require('./config.cjs');
const { checkSync } = require('./sync_check.cjs');
const { guestSleep } = require('./guest_time.cjs');
const { installFrameTrace, saveFrameTrace } = require('./frame_trace.cjs');

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
    const page = await openSplit(browser, 'players=3&renderer=software', dummy);
    await ringChecks(page);
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
        if (action === 'wait') {
            await guestSleep(frame, Number(args[0]));
        } else if (action === 'key') {
            await holdKey(frame, args[0], true);
            await guestSleep(frame, Number(args[1] || 250));
            await holdKey(frame, args[0], false);
        } else if (action === 'touch') {
            const touch = mouseLock.then(async () => {
                const box = await canvas.boundingBox();
                await page.mouse.move(box.x + box.width * Number(args[0]), box.y + box.height * Number(args[1]));
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
        console.log(`  t+${seconds}s P1 ${await read(host)} | P2 ${await read(guest)} | shares ${shares}`);
        if (film) await page.screenshot({ path: path.join(directory, `film-${String(seconds).padStart(4, '0')}.png`) }).catch(() => {});
    }, 15000);
    const screenshot = name => page.screenshot({ path: path.join(directory, `${name}.png`) });
    fs.mkdirSync(directory, { recursive: true });
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
        const stats = await guest.evaluate(() => window.AzaharNetplay.status().stats);
        console.log(`PASS ${game.title}: all ${players} players are in one room, players 1 and 2 on one keyboard` +
            `${players > 2 ? ` and ${players - 2} on controllers` : ''} (Player 1 hosts network ` +
            `0x${(hostRoom.wlanCommId >>> 0).toString(16)} with nodes ${hostRoom.nodes.map(node => node.id).join(', ')}; ` +
            `${stats.delivered} frames delivered to Player 2)`);
        // The next phase, such as the host starting a race, and whether both consoles agree on it.
        if (players === 2 && !cfg.argFlag('--no-race') && (game.host.afterJoin || game.guest.afterJoin)) {
            await Promise.all([runSteps(page, host, game.host.afterJoin || [], holdKey),
                runSteps(page, guest, game.guest.afterJoin || [], holdKey)]);
            await guestSleep(host, Number(game.afterJoinWaitMs || 30000));
            await screenshot('after-join');
            if (game.syncCheck) {
                const io = {
                    shoot: async frame => (await frame.$('#canvas')).screenshot({ encoding: 'base64' }),
                    hold: holdKey,
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
        clearInterval(monitor);
        await screenshot('split');
        for (const [index, frame] of frames.entries()) {
            await saveFrameTrace(frame, path.join(directory, `frames-${index + 1}.txt`)).catch(() => {});
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

async function main() {
    assert.ok(cfg.chromePath, 'Chrome not found; set CHROME_PATH');
    const root = cfg.argVal('--web', null);
    const server = cfg.argVal('--base', null) ? null :
        await listen(PORT, '127.0.0.1', root ? { root: path.resolve(root) } : {});
    const browser = await launch();
    try {
        await linkChecks(browser);
        const rom = cfg.argVal('--rom', null);
        if (rom) await playGame(browser, path.resolve(rom));
        else console.log('SKIP game session (pass --rom PATH to play a title between two consoles)');
    } finally {
        await browser.close().catch(() => {});
        server?.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
