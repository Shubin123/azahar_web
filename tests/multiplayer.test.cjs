/**
 * multiplayer.test.cjs
 * Plays games' local wireless modes between two browsers over Local Play.
 *
 * For each pairing in tests/multiplayer_games.json, two separate browsers boot
 * their ROMs, jump straight to the captured lobby fixtures (lobby-host and
 * lobby-guest), link over WebRTC by exchanging invite and reply codes as two
 * people would, and run the guest's steps to join the host's room. A pairing
 * passes once the host accepts a node and the guest joins as one. Pairings of
 * different builds (demo and retail) must also show the guest finding the
 * host's network through cross-version play.
 *
 * Pairings whose ROM, decrypted dump or fixtures are missing are skipped with
 * the reason; capture fixtures as described in multiplayer_games.json.
 *
 * --link-smoke checks the engine side without lobby fixtures: two consoles
 * running a real title link up under their own, distinct addresses and see
 * each other's title.
 *
 * Usage:
 *   node tests/multiplayer.test.cjs [--game smash] [--pair full:kiosk]
 *       [--renderer software|webgl2] [--gpu] [--timeout SECONDS]
 *   node tests/multiplayer.test.cjs --link-smoke [--rom PATH]
 *   add --via lobby to link through a public lobby (local tracker) instead of codes
 */
'use strict';

const puppeteer = require('puppeteer-core');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { listen } = require('../web/server.cjs');
const { restoreState } = require('./fixture_state.cjs');
const { startTracker } = require('./lobby_tracker.cjs');
const cfg = require('./config.cjs');

const PORT = 8797;
const GAMES = JSON.parse(fs.readFileSync(path.join(__dirname, 'multiplayer_games.json'), 'utf8'));
const OUTPUT = path.join(cfg.ROOT, 'tmp_test', 'multiplayer');
const renderer = cfg.argVal('--renderer', 'software');
const timeoutMs = Number(cfg.argVal('--timeout', 300)) * 1000;
// --via lobby links the consoles by hosting and joining a public lobby (through a
// local tracker) instead of exchanging invite codes.
const viaLobby = cfg.argVal('--via', 'codes') === 'lobby';
let tracker = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const GPU_ARGS = ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'];

const fixtureDirectory = rom =>
    path.join(cfg.ROOT, 'tmp_test', 'fixtures', path.basename(rom, path.extname(rom)).replace(/[^a-zA-Z0-9_-]/g, '_'));

function findFixture(rom, scene) {
    const directory = path.join(fixtureDirectory(rom), scene);
    try {
        const file = fs.readdirSync(directory).find(entry => entry.endsWith('.cst'));
        return file ? path.join(directory, file) : null;
    } catch {
        return null;
    }
}

// Azahar runs decrypted dumps only. The NoCrypto flag is unreliable (some
// decrypters leave it clear), so also accept a readable extended header name.
function isDecrypted(rom) {
    const handle = fs.openSync(rom, 'r');
    try {
        const read = (offset, length) => {
            const buffer = Buffer.alloc(length);
            fs.readSync(handle, buffer, 0, length, offset);
            return buffer;
        };
        const partition = read(0x120, 4).readUInt32LE(0) * 0x200;
        if (read(partition + 0x100, 4).toString('latin1') !== 'NCCH') return true; // Not an NCSD image.
        if (read(partition + 0x18F, 1)[0] & 0x4) return true;
        const name = read(partition + 0x200, 8).toString('latin1').replace(/\0+$/, '');
        return name.length > 0 && /^[\x20-\x7E]+$/.test(name);
    } finally {
        fs.closeSync(handle);
    }
}

async function launch() {
    return puppeteer.launch({ executablePath: cfg.chromePath, headless: true,
        defaultViewport: { width: 1100, height: 1400 }, protocolTimeout: 300000,
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...(cfg.argFlag('--gpu') ? GPU_ARGS : [])] });
}

// Opens the page and runs a ROM, optionally restoring a fixture straight away.
async function boot(browser, rom, nick, statePath) {
    const page = await browser.newPage();
    page.errors = [];
    page.on('pageerror', error => page.errors.push(String(error)));
    const trackers = tracker ? `&trackers=${encodeURIComponent(tracker.url)}` : '';
    await page.goto(`http://127.0.0.1:${PORT}/index.html?renderer=${renderer}&nick=${nick}${trackers}`,
        { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('Emulator ready'),
        { timeout: 120000 });
    await (await page.$('#rom-file')).uploadFile(rom);
    await page.waitForFunction(() => !document.getElementById('btn-load').disabled, { timeout: 60000 });
    await page.click('#btn-load');
    await page.waitForFunction(() => window.AzaharUI?.isRunning() || !document.getElementById('btn-run').disabled,
        { timeout: 180000 });
    if (!(await page.evaluate(() => window.AzaharUI.isRunning()))) await page.click('#btn-run');
    if (statePath) await restoreState(page, statePath);
    return page;
}

// The same exchange two people make through the Local Play card.
async function link(host, guest) {
    if (viaLobby) return linkViaLobby(host, guest);
    const invite = await host.evaluate(() => {
        window.AzaharNetplay.useStun = false;
        return window.AzaharNetplay.createInvite();
    });
    const reply = await guest.evaluate(invite => {
        window.AzaharNetplay.useStun = false;
        return window.AzaharNetplay.acceptInvite(invite);
    }, invite);
    await host.evaluate(reply => window.AzaharNetplay.acceptReply(reply), reply);
    for (const page of [host, guest]) {
        await page.waitForFunction(() => {
            const state = window.AzaharNetplay.status();
            return state.joined && state.peers.some(peer => peer.open && peer.mac);
        }, { timeout: 60000 });
    }
    return Promise.all([host, guest].map(page => page.evaluate(() => window.AzaharNetplay.status())));
}

// Host a public lobby and join it from the guest's lobby list.
async function linkViaLobby(host, guest) {
    for (const page of [host, guest]) await page.evaluate(() => { window.AzaharNetplay.useStun = false; });
    await host.waitForFunction(() => window.AzaharNetplay.titleId(), { timeout: 120000 });
    await host.evaluate(() => window.AzaharLobbies.host('Multiplayer test'));
    await guest.evaluate(() => window.AzaharLobbies.browse());
    await guest.waitForFunction(() => window.AzaharLobbies.status().lobbies.some(l => l.name === 'Multiplayer test'),
        { timeout: 60000 });
    await guest.evaluate(() => window.AzaharLobbies.join(
        window.AzaharLobbies.status().lobbies.find(l => l.name === 'Multiplayer test').host));
    for (const page of [host, guest]) {
        await page.waitForFunction(() => {
            const state = window.AzaharNetplay.status();
            return state.joined && state.peers.some(peer => peer.open && peer.mac);
        }, { timeout: 60000 });
    }
    return Promise.all([host, guest].map(page => page.evaluate(() => window.AzaharNetplay.status())));
}

async function runSteps(page, steps) {
    for (const step of steps) {
        const [action, ...args] = step.split(/\s+/);
        if (action === 'wait') {
            await sleep(Number(args[0]));
        } else if (action === 'key') {
            await page.keyboard.down(args[0]);
            await sleep(Number(args[1] || 250));
            await page.keyboard.up(args[0]);
        } else if (action === 'touch') {
            const box = await (await page.$('#canvas')).boundingBox();
            await page.mouse.move(box.x + box.width * Number(args[0]), box.y + box.height * Number(args[1]));
            await page.mouse.down();
            await sleep(Number(args[2] || 250));
            await page.mouse.up();
        } else {
            throw new Error(`Unknown step: ${step}`);
        }
    }
}

const logText = page => page.$eval('#log', element => element.textContent);

async function waitForLog(page, pattern, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (pattern.test(await logText(page))) return;
        await sleep(1000);
    }
    throw new Error(`${label}: no "${pattern.source}" in the log after ${timeoutMs / 1000}s`);
}

async function screenshot(page, directory, name) {
    fs.mkdirSync(directory, { recursive: true });
    await (await page.$('#canvas')).screenshot({ path: path.join(directory, `${name}.png`) });
}

function preflight(game, hostBuild, guestBuild) {
    const reasons = [];
    const sides = [['host', game.builds[hostBuild], game.host], ['guest', game.builds[guestBuild], game.guest]];
    for (const [side, build, plan] of sides) {
        if (!build) { reasons.push(`no build for the ${side}`); continue; }
        const rom = path.join(cfg.ROOT, build.rom);
        if (build.localWireless === false) reasons.push(`${build.rom}: ${build.note}`);
        else if (!fs.existsSync(rom)) reasons.push(`${build.rom} is missing`);
        else if (!isDecrypted(rom)) reasons.push(`${build.rom} is an encrypted dump; Azahar needs a decrypted one`);
        else if (plan.fixture && !findFixture(rom, plan.fixture)) {
            reasons.push(`${build.rom} has no ${plan.fixture} fixture under ${path.relative(cfg.ROOT, fixtureDirectory(rom))}`);
        }
    }
    return [...new Set(reasons)];
}

async function playPairing(key, game, hostBuild, guestBuild) {
    const label = `${key} ${hostBuild} hosts, ${guestBuild} joins`;
    const reasons = preflight(game, hostBuild, guestBuild);
    if (reasons.length) {
        console.log(`SKIP ${label}\n  - ${reasons.join('\n  - ')}`);
        return 'skip';
    }
    const directory = path.join(OUTPUT, `${key}-${hostBuild}-${guestBuild}`);
    const browsers = [await launch(), await launch()];
    try {
        const hostRom = path.join(cfg.ROOT, game.builds[hostBuild].rom);
        const guestRom = path.join(cfg.ROOT, game.builds[guestBuild].rom);
        const [host, guest] = await Promise.all([
            // A side without a fixture boots fresh and reaches its lobby through its steps.
            boot(browsers[0], hostRom, 'Host', game.host.fixture && findFixture(hostRom, game.host.fixture)),
            boot(browsers[1], guestRom, 'Guest', game.guest.fixture && findFixture(guestRom, game.guest.fixture)),
        ]);
        const [hostState, guestState] = await link(host, guest);
        assert.notStrictEqual(hostState.mac, guestState.mac,
            'the host and guest fixtures came from one console; capture them in separate sessions');
        await runSteps(host, game.host.steps);
        await runSteps(guest, game.guest.steps);
        try {
            if (hostBuild !== guestBuild) {
                await waitForLog(guest, /Presented a beacon from another build/, 'cross-version scan');
            }
            await waitForLog(host, /Node \d+ joined the hosted network/, 'host');
            await waitForLog(guest, /Joined a network as node \d+/, 'guest');
        } finally {
            await screenshot(host, directory, 'host');
            await screenshot(guest, directory, 'guest');
        }
        // Optional next phase, such as the host starting the match from the room.
        if (game.host.afterJoin || game.guest.afterJoin) {
            const joinsBefore = (await logText(host)).match(/Node \d+ joined the hosted network/g).length;
            await Promise.all([runSteps(host, game.host.afterJoin || []), runSteps(guest, game.guest.afterJoin || [])]);
            await sleep(Number(game.afterJoinWaitMs || 30000));
            await screenshot(host, directory, 'host-after');
            await screenshot(guest, directory, 'guest-after');
            const hostLog = await logText(host);
            const joins = hostLog.match(/Node \d+ joined the hosted network/g).length - joinsBefore;
            const hosting = hostLog.match(/Hosting network wlan_comm_id=0x[0-9A-F]+/g) || [];
            console.log(`  after join: host networks ${[...new Set(hosting)].join(', ')}; ${joins} more join(s) on the host`);
        }
        const errors = [...host.errors, ...guest.errors];
        assert.deepStrictEqual(errors, [], 'no page errors');
        const stats = await guest.evaluate(() => window.AzaharNetplay.status().stats);
        console.log(`PASS ${label} (guest exchanged ${stats.sent} sent / ${stats.delivered} delivered frames; ` +
            `screens in ${path.relative(cfg.ROOT, directory)})`);
        return 'pass';
    } catch (error) {
        console.log(`FAIL ${label}: ${error.message}`);
        // Frame counters tell a silent host apart from frames the guest never received.
        for (const [index, browser] of browsers.entries()) {
            const [page] = (await browser.pages().catch(() => [])).slice(-1);
            const stats = page && await page.evaluate(() => window.AzaharNetplay?.status().stats).catch(() => null);
            if (stats) console.log(`  ${index ? 'guest' : 'host'} frames: ${JSON.stringify(stats)}`);
            const lines = page && await page.$eval('#log', element => element.textContent.split('\n')
                .filter(line => /NWM|DLP|dlp:|uds/i.test(line)).slice(-12)
                .map(line => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^.*?\] (?=[A-Z])/, '').slice(0, 170)))
                .catch(() => []);
            for (const line of lines || []) console.log(`    ${line}`);
        }
        return 'fail';
    } finally {
        await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
    }
}

// Two consoles running a real title link under their own, distinct addresses.
async function linkSmoke() {
    const rom = path.resolve(cfg.argVal('--rom', path.join(cfg.ROOT, GAMES.smash.builds.kiosk.rom)));
    assert.ok(fs.existsSync(rom) && isDecrypted(rom), `--link-smoke needs a decrypted ROM: ${rom}`);
    const browsers = [await launch(), await launch()];
    try {
        // One console restores a fixture when there is one; the other boots fresh,
        // so the two never share a console identity.
        const fixture = findFixture(rom, 'main-menu');
        const [first, second] = await Promise.all([
            boot(browsers[0], rom, 'Alpha', fixture),
            boot(browsers[1], rom, 'Beta', null),
        ]);
        const [a, b] = await link(first, second);
        assert.match(a.mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/, 'joined under a MAC address');
        assert.notStrictEqual(a.mac, b.mac, 'distinct console addresses');
        assert.strictEqual(a.peers[0].mac, b.mac, 'the host knows the guest\'s address');
        assert.strictEqual(b.peers[0].title, a.title, 'the guest sees the host\'s title');
        assert.match(await logText(first), /Joined direct link as Alpha with MAC/, 'the engine joined');
        if (fixture) {
            // A save state restored while linked must keep the link under its address.
            await restoreState(first, fixture);
            const after = await first.evaluate(() => window.AzaharNetplay.status());
            assert.ok(after.joined && after.mac === a.mac, 'still linked after a state load');
        }
        const errors = [...first.errors, ...second.errors];
        assert.deepStrictEqual(errors, [], 'no page errors');
        console.log(`PASS link smoke: ${path.basename(rom)} consoles ${a.mac} and ${b.mac} linked`);
        return 'pass';
    } finally {
        await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
    }
}

async function main() {
    assert.ok(cfg.chromePath, 'Chrome not found; set CHROME_PATH');
    const server = await listen(PORT, '127.0.0.1');
    if (viaLobby) tracker = await startTracker();
    const results = [];
    try {
        if (cfg.argFlag('--link-smoke')) {
            results.push(await linkSmoke());
        } else {
            const only = cfg.argVal('--game', null);
            const pair = cfg.argVal('--pair', null);
            for (const [key, game] of Object.entries(GAMES)) {
                if (key.startsWith('$') || (only && key !== only)) continue;
                for (const [hostBuild, guestBuild] of game.pairings) {
                    if (pair && pair !== `${hostBuild}:${guestBuild}`) continue;
                    results.push(await playPairing(key, game, hostBuild, guestBuild));
                }
            }
        }
    } finally {
        server.close();
        await tracker?.close();
    }
    const count = kind => results.filter(result => result === kind).length;
    console.log(`multiplayer.test: ${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`);
    if (count('fail')) process.exitCode = 1;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
