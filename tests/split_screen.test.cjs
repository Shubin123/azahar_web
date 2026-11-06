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
 *       [--no-race] [--gpu] [--timeout SECONDS] [--web DIR] [--query cpuJit=0]
 */
'use strict';

const puppeteer = require('puppeteer-core');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { listen } = require('../web/server.cjs');
const cfg = require('./config.cjs');
const { checkSync } = require('./sync_check.cjs');

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
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
        // A reader that stops: the ring fills, further messages are dropped and counted,
        // and nothing already queued is lost or corrupted.
        let accepted = 0;
        for (let i = 0; i < 20; i++) accepted += a.send(link.KIND_FRAME, new Uint8Array(60).fill(i), 2);
        got.length = 0;
        collect(c);
        const intact = got.every(([, , bytes], i) => bytes.length === 60 && bytes.every(value => value === i));
        return {orderKept, broadcast, accepted, received: got.length, dropped: a.dropped(), intact};
    });
    assert.ok(!result.error, result.error);
    assert.ok(result.orderKept, 'messages arrive in order and intact across the ring end');
    assert.ok(result.broadcast, 'a broadcast reaches each other console once');
    assert.strictEqual(result.accepted, result.received, 'every accepted message arrives');
    assert.ok(result.accepted > 0 && result.accepted < 20, 'a full ring refuses more');
    assert.strictEqual(result.dropped, 20 - result.accepted, 'refused messages are counted');
    assert.ok(result.intact, 'queued messages survive a full ring');
    console.log(`PASS shared rings: order across the ring end, broadcast, ${result.dropped} drops counted when full`);
}

const seatFrames = async page => {
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
    console.log('PASS the keyboard reaches only the console whose screen has focus');

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
}

const fmt = shares => shares.map(share => share.toFixed(2)).join('/');

// Consoles sharing one device can run below full speed, so the steps' waits and
// holds count emulated time: a wait of N ms lasts until the console has run N ms.
async function guestSleep(frame, ms) {
    const target = await frame.evaluate(() => window.AzaharNetplay.guestTimeUs()) + ms * 1000;
    const started = Date.now();
    while (Date.now() - started < Math.max(ms * 30, 30000)) {
        await sleep(Math.min(250, ms));
        if (await frame.evaluate(() => window.AzaharNetplay.guestTimeUs()) >= target) return;
    }
    throw new Error(`the console did not advance ${ms} ms of game time`);
}

// Keys go to one console through its own input path (as controllers do), so both
// consoles' steps can run at once; the shared mouse is taken one touch at a time.
let mouseLock = Promise.resolve();

const holdKey = (frame, code, down) =>
    frame.evaluate((code, down) => window.AzaharInput.setSourceCodes('test', down ? [code] : []), code, down);

async function runSteps(page, frame, steps) {
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
async function keyboardChecks(page, frames) {
    for (const frame of frames) {
        await frame.evaluate(() => {
            window.keysSeen = 0;
            window.addEventListener('keydown', event => { if (event.code === 'KeyX') window.keysSeen++; });
        });
    }
    for (const [index, frame] of frames.entries()) {
        await page.keyboard.down('Control');
        await page.keyboard.press(String(index + 1));
        await page.keyboard.up('Control');
        await page.waitForFunction(index => document.activeElement === document.querySelectorAll('#seats iframe')[index],
            { timeout: 5000 }, index).catch(() => { throw new Error(`Ctrl+${index + 1} did not focus Player ${index + 1}`); });
        await page.keyboard.press('KeyX');
        const seen = await Promise.all(frames.map(other => other.evaluate(() => window.keysSeen)));
        assert.deepStrictEqual(seen.map(count => count > 0), frames.map((_, i) => i <= index),
            `Ctrl+${index + 1} gives Player ${index + 1} the keyboard (keys seen: ${seen})`);
        await sleep(600);
    }
    const marked = await page.$$eval('#seats .seat', seats => seats.map(seat => seat.classList.contains('has-keyboard')));
    assert.deepStrictEqual(marked, frames.map((_, i) => i === frames.length - 1), 'the focused screen is marked');
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

async function playGame(browser, rom) {
    const key = cfg.argVal('--game', 'mario-kart-7');
    const game = GAMES[key];
    assert.ok(game, `no game ${key} in multiplayer_games.json`);
    const renderer = cfg.argVal('--renderer', 'webgl2');
    // --query passes page options to every console (split.html hands on the ones it knows).
    const extra = cfg.argVal('--query', '');
    const page = await openSplit(browser, `renderer=${renderer}${extra ? `&${extra}` : ''}`, rom);
    const [host, guest] = await seatFrames(page);
    for (const frame of [host, guest]) {
        await frame.waitForFunction(() => window.AzaharUI?.isRunning() && window.AzaharNetplay.status().joined &&
            window.AzaharNetplay.status().peers.some(peer => peer.mac), { timeout: 180000 });
    }
    const [hostState, guestState] = await Promise.all([host, guest].map(frame =>
        frame.evaluate(() => window.AzaharNetplay.status())));
    assert.notStrictEqual(hostState.mac, guestState.mac, 'each console has its own address');
    assert.strictEqual(hostState.peers[0]?.mac, guestState.mac, 'the host sees the guest');
    const started = Date.now();
    const monitor = setInterval(async () => {
        const read = frame => frame.evaluate(() => document.getElementById('fps').textContent).catch(() => '?');
        const shares = await page.evaluate(() => window.AzaharSplit.shares().map(s => s.toFixed(2)).join('/')).catch(() => '?');
        console.log(`  t+${Math.round((Date.now() - started) / 1000)}s P1 ${await read(host)} | P2 ${await read(guest)} | shares ${shares}`);
    }, 15000);
    const directory = path.join(OUTPUT, key);
    const screenshot = name => page.screenshot({ path: path.join(directory, `${name}.png`) });
    fs.mkdirSync(directory, { recursive: true });
    try {
        await runSteps(page, host, game.host.steps);
        await runSteps(page, guest, game.guest.steps);
        await waitForLog(host, /Node \d+ joined the hosted network/, 'host');
        await waitForLog(guest, /Joined a network as node \d+/, 'guest');
        await screenshot('joined');
        const stats = await guest.evaluate(() => window.AzaharNetplay.status().stats);
        console.log(`PASS ${game.title}: Player 1 hosted and Player 2 joined on one device ` +
            `(${stats.sent} frames sent, ${stats.delivered} delivered by Player 2)`);
        // The next phase, such as the host starting a race, and whether both consoles agree on it.
        if (!cfg.argFlag('--no-race') && (game.host.afterJoin || game.guest.afterJoin)) {
            await Promise.all([runSteps(page, host, game.host.afterJoin || []),
                runSteps(page, guest, game.guest.afterJoin || [])]);
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
        for (const [index, frame] of [host, guest].entries()) {
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
        }
        throw error;
    } finally {
        clearInterval(monitor);
        await screenshot('split');
    }
    assert.deepStrictEqual(page.errors, [], 'no page errors');
    console.log(`  screenshots in ${path.relative(cfg.ROOT, directory)}`);
}

async function main() {
    assert.ok(cfg.chromePath, 'Chrome not found; set CHROME_PATH');
    const root = cfg.argVal('--web', null);
    const server = await listen(PORT, '127.0.0.1', root ? { root: path.resolve(root) } : {});
    const browser = await launch();
    try {
        await linkChecks(browser);
        const rom = cfg.argVal('--rom', null);
        if (rom) await playGame(browser, path.resolve(rom));
        else console.log('SKIP game session (pass --rom PATH to play a title between two consoles)');
    } finally {
        await browser.close().catch(() => {});
        server.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
