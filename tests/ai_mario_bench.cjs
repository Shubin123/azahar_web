'use strict';
// How far the AI gets through a New Super Mario Bros. 2 level, read from the game's own
// progress bar on the bottom screen (Mario's marker moves from its left end toward the
// Bowser icon at the right): NitroGen alone, NitroGen steered by a fixed plan (head right,
// favour jump and dash), and with --planner NitroGen steered by the planner (System 2) as it
// looks at the screens, the game paused while it thinks. Each setup has --attempts attempts
// from --state (a level's start), in lockstep (every action on its frame, the game as fast as
// the AI decides), each until Mario leaves the level (cleared or lost a life: either takes
// him back to the world map) or --seconds of game time pass.
//
//   node tests/ai_mario_bench.cjs --ckpt ng.pt --rom NSMB2.cci --state level1_1.cst
//        [--attempts 5] [--seconds 60] [--planner qwen3.5-0.8b] [--setups nitrogen,steer,planner]
//        [--save-frames]   (the top screen every half second of game time, to see what happened)
//        [--execute 18]    (actions played from each decision before the next)
// Setups: nitrogen; steer (right, favour B and Y); right (right only); planner; search-planner
// (search with --planner choosing the heading and a button of its own); search: the
// widget's Look ahead (azahar_ai_lookahead.js), which every --commit frames saves the game, lets
// NitroGen play --horizon frames from there under each of a few steering plans, scores those
// futures by how far the screen scrolled (--reader meter: by the progress bar instead), and
// replays the best one's keys from the saved state.
//
// The browser profile (and so the planner's model cache) is kept in tmp_test/ai_mario_bench.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const cfg = require('./config.cjs');
const {restoreState} = require('./fixture_state.cjs');
const common = require('./ai_common.cjs');

const ROOT = path.resolve(__dirname, '..');
const MIRROR_PATH = '/__test/ng.pt';
const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Where Mario is on the level's progress bar, 0 (start) to 1 (goal), and whether a level is
// on screen at all, from the planner's view of both screens (400x480, the bottom screen at
// 40,240): his marker is the red left of the Bowser icon in the bar's rows; a level shows
// the yellow "WORLD" banner above.
const progressNow = page => page.evaluate(async () => {
    // (No frame for 15 s: the game is held; the caller looks into why.)
    const screens = await Promise.race([window.AzaharAIPlayer.nextFrameScreens(),
        new Promise(resolve => setTimeout(() => resolve(null), 15000))]);
    if (!screens) return null;
    const pixel = (x, y) => {
        const i = ((240 + y) * 400 + 40 + x) * 4;
        return [screens.data[i], screens.data[i + 1], screens.data[i + 2]];
    };
    // A canvas read between two game frames can come back blank: no reading then.
    let light = 0;
    for (let i = 240 * 400 * 4; i < screens.data.length; i += 4 * 97) light += screens.data[i] + screens.data[i + 1];
    if (light < 1000) return null;
    let yellow = 0;
    for (let y = 5; y < 30; y++) {
        for (let x = 10; x < 150; x++) {
            const [r, g, b] = pixel(x, y);
            if (r > 200 && g > 170 && b < 90) yellow++;
        }
    }
    let sum = 0, count = 0;
    for (let y = 50; y < 80; y++) {
        for (let x = 0; x < 260; x++) {
            const [r, g, b] = pixel(x, y);
            if (r > 180 && g < 80 && b < 80) {
                sum += x;
                count++;
            }
        }
    }
    const inLevel = yellow > 300;
    return {inLevel, progress: inLevel && count > 20 ? Math.max(0, Math.min(1, (sum / count - 27.5) / (262 - 27.5))) : null,
        guestUs: window.AzaharUI.getGuestTimeUs(), yellow, marker: count};
});

// The top screen and the keys held now, saved as PNG (tmp_test/ai_mario_bench/frames).
async function saveFrame(page, file) {
    const shot = await page.evaluate(async () => {
        // (A frame the game moved on; a read between two pictures comes back blank.)
        let screens = null;
        for (let i = 0; i < 30 && !screens; i++) {
            const next = await window.AzaharAIPlayer.nextFrameScreens(true);
            if (next && next.data.some((value, j) => j % 4 !== 3 && value)) screens = next;
        }
        if (!screens) return null;
        const canvas = new OffscreenCanvas(400, 240);
        canvas.getContext('2d').putImageData(new ImageData(screens.data.slice(0, 400 * 240 * 4), 400, 240), 0, 0);
        const bytes = new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return {png: btoa(text), keys: window.AzaharAIPlayer.stats().codes};
    });
    if (shot) fs.writeFileSync(file, Buffer.from(shot.png, 'base64'));
    return shot?.keys || [];
}

// Setup 'search': the widget's Look ahead (azahar_ai_lookahead.js) plays from the state until
// Mario leaves the level or `seconds` of game time pass; then the top screen once a second
// for 8 s (tmp_test/ai_mario_bench/search_end_N) shows how it ended.
async function searchAttempt(page, state, seconds, options, endDir, saveAt = null) {
    const stepsDir = endDir.replace('search_end_', 'search_steps_');
    fs.rmSync(stepsDir, {recursive: true, force: true});
    await restoreState(page, state);
    await sleep(300);
    await page.evaluate(options => window.AzaharAILookahead.configure({enabled: true, ...options}), options);
    await page.click('#btn-ai-play');
    let best = 0, sawLevel = false, steps = -1, end = 'time', stats = null, stepAt = Date.now();
    const log = [];
    for (;;) {
        await sleep(250);
        stats = await page.evaluate(() => window.AzaharAILookahead.stats());
        if (stats.error) throw new Error(stats.error);
        if (stats.steps === steps) {
            if (Date.now() - stepAt > 300000) throw new Error(`the look-ahead made no step for 5 minutes (${steps} steps)`);
            continue;
        }
        steps = stats.steps;
        stepAt = Date.now();
        if (!steps) continue;
        log.push(`${stats.tried.map(f => `${f.plan} ${!f.alive ? 'dies' : !f.moving ? 'stuck' : 'ok'} ` +
            `${f.progress.toFixed(0)}${f.further ? ` (further: ${f.further})` : ''}`).join(', ')} -> ${stats.chosen}, level ${stats.meter === null ? '-' : (100 * stats.meter).toFixed(1)}%`);
        // The screens each step left, to see what happened (tmp_test/ai_mario_bench/search_steps_N).
        const shot = await page.evaluate(async () => {
            const screens = window.AzaharAILookahead.screens();
            if (!screens) return null;
            const canvas = new OffscreenCanvas(screens.width, screens.height);
            canvas.getContext('2d').putImageData(screens, 0, 0);
            const bytes = new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer());
            let text = '';
            for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(text);
        });
        if (shot) {
            fs.mkdirSync(stepsDir, {recursive: true});
            fs.writeFileSync(path.join(stepsDir, `${String(steps).padStart(3, '0')}.png`), Buffer.from(shot, 'base64'));
        }
        console.log(`  step ${steps} (${stats.gameSeconds.toFixed(1)} s): ${log.at(-1)}; replays so far at most ` +
            `${stats.replayError.toFixed(2)} off (${stats.unaligned} unaligned)` +
            (stats.verifyLog.length ? `; last replay: ${JSON.stringify(stats.verifyLog.at(-1))}` : ''));
        if (stats.inLevel) {
            sawLevel = true;
            if (stats.meter !== null) best = Math.max(best, stats.meter);
            // A state to start from near this point (--save-state-at: a fraction of the level).
            if (saveAt && stats.meter !== null && stats.meter >= saveAt) {
                const bytes = await page.evaluate(() => {
                    const data = window.AzaharAILookahead.checkpointBytes();
                    let text = '';
                    for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
                    return btoa(text);
                });
                const file = path.join(ROOT, 'tmp_test', 'ai_mario_bench', `at_${Math.round(100 * saveAt)}`, path.basename(state));
                fs.mkdirSync(path.dirname(file), {recursive: true});
                fs.writeFileSync(file, Buffer.from(bytes, 'base64'));
                console.log(`  saved the state at ${(100 * stats.meter).toFixed(1)}% of the level: ${file}`);
                saveAt = null;
            }
        } else if (sawLevel) {
            // Out of the level: through the goal or a life lost; the world map shows which.
            end = 'left the level';
            break;
        }
        if (stats.gameSeconds >= seconds) break;
    }
    // (--verify: the first frames where replays parted from their futures.)
    for (const [i, pictures] of (stats.verifyPictures || []).entries()) {
        for (const [name, bytes] of Object.entries(pictures)) {
            fs.writeFileSync(path.join(ROOT, 'tmp_test', 'ai_mario_bench', `parts_${i + 1}_${name}.png`), Buffer.from(bytes));
        }
    }
    await page.click('#btn-ai-play');
    await page.waitForFunction(() => !window.AzaharAILookahead.running(), {timeout: 120000});
    fs.mkdirSync(endDir, {recursive: true});
    for (let i = 1; i <= 8; i++) {
        await sleep(1000);
        await saveFrame(page, path.join(endDir, `${i}s.png`));
    }
    // World 1-1 cleared: on the map the next level's node (top screen, about 291,149) has
    // turned red (it stays dark after a life lost).
    if (end === 'left the level') {
        const red = await page.evaluate(async () => {
            for (let i = 0; i < 30; i++) {
                const s = await window.AzaharAIPlayer.nextFrameScreens(true);
                if (!s || !s.data.some((value, j) => j % 4 !== 3 && value)) continue;
                let red = 0;
                for (let y = 140; y < 158; y++) {
                    for (let x = 278; x < 304; x++) {
                        const k = (y * 400 + x) * 4;
                        if (s.data[k] > 170 && s.data[k + 1] < 90 && s.data[k + 2] < 90) red++;
                    }
                }
                return red;
            }
            return 0;
        });
        end = red > 40 ? 'cleared' : 'lost a life';
    }
    await page.evaluate(() => window.AzaharAILookahead.configure({enabled: false}));
    const tally = {};
    for (const line of log) {
        const chosen = line.split(' -> ')[1].split(',')[0];
        tally[chosen] = (tally[chosen] || 0) + 1;
    }
    return {setup: 'search', best: Math.min(1, best), end, gameSeconds: +stats.gameSeconds.toFixed(1), steps: stats.steps,
        wallSeconds: Math.round(stats.wallSeconds),
        chosen: tally, log, replayError: stats.replayError, unaligned: stats.unaligned, decisions: 0, skipped: 0};
}

// One attempt from the state with `setup`: furthest progress, how it ended, game seconds.
async function attempt(page, state, setup, seconds, framesDir) {
    await restoreState(page, state);
    await page.evaluate(setup => {
        const planner = window.AzaharAIPlanner;
        planner.steer(setup === 'steer' ? {move: 'right', press: ['B', 'Y']} : setup === 'right' ? {move: 'right'} : null);
    }, setup);
    await sleep(300);
    const start = await progressNow(page);
    await page.click('#btn-ai-play');
    let best = start?.progress ?? 0, last = best, end = 'time', sawLevel = Boolean(start?.inLevel);
    const startUs = start?.guestUs ?? await page.evaluate(() => window.AzaharUI.getGuestTimeUs());
    // Out of the level only when several readings in a row, half a second of game time apart, say so.
    let away = null;
    let gameSeconds = 0, nextShot = 0;
    const keyLog = [];
    let lastGuest = startUs, movedAt = Date.now();
    for (;;) {
        const now = await progressNow(page);
        const guest = await page.evaluate(() => window.AzaharUI.getGuestTimeUs());
        if (guest !== lastGuest) {
            lastGuest = guest;
            movedAt = Date.now();
        } else if (Date.now() - movedAt > 120000) {
            const why = await page.evaluate(() => ({hold: window.AzaharAIPlayer.shouldHold(),
                planner: (({name, loaded, thinking, plan, error, looks, lastMs}) => ({name, loaded, thinking, plan, error, looks, lastMs}))(
                    window.AzaharAIPlanner.state()), player: window.AzaharAIPlayer.stats()}));
            throw new Error(`the game stood still for 2 minutes: ${JSON.stringify(why).slice(0, 600)}`);
        }
        if (!now) continue;
        gameSeconds = (now.guestUs - startUs) / 1e6;
        if (framesDir && gameSeconds >= nextShot) {
            const name = `${String(Math.round(gameSeconds * 10)).padStart(4, '0')}.png`;
            keyLog.push({t: +gameSeconds.toFixed(1), progress: now.progress, inLevel: now.inLevel, yellow: now.yellow,
                marker: now.marker, keys: await saveFrame(page, path.join(framesDir, name))});
            nextShot += 0.5;
        }
        if (now.inLevel) {
            sawLevel = true;
            away = null;
            if (now.progress !== null) {
                best = Math.max(best, now.progress);
                last = now.progress;
            }
        } else if (sawLevel) {
            away = away || {count: 0, since: now.guestUs};
            away.count++;
            if (away.count >= 3 && now.guestUs - away.since >= 2e5) {
                end = best >= 0.97 ? 'cleared' : 'lost a life';
                break;
            }
        }
        if (gameSeconds >= seconds) break;
        await sleep(100);
    }
    const stats = await page.evaluate(() => window.AzaharAIPlayer.stats());
    await page.click('#btn-ai-play');
    await page.evaluate(() => window.AzaharAIPlanner.steer(null));
    if (framesDir) fs.writeFileSync(path.join(framesDir, 'keys.json'), JSON.stringify(keyLog, null, 1));
    return {setup, best: +best.toFixed(3), last: +last.toFixed(3), end, gameSeconds: +gameSeconds.toFixed(1),
        decisions: stats.decisions, skipped: stats.skipped};
}

async function main() {
    const ckpt = option('--ckpt'), rom = option('--rom'), state = option('--state');
    if (!ckpt || !rom || !state) throw new Error('--ckpt, --rom and --state are required');
    const attempts = Number(option('--attempts', 5)), seconds = Number(option('--seconds', 60));
    const setups = option('--setups', option('--planner') ? 'nitrogen,steer,planner' : 'nitrogen,steer').split(',');
    const out = path.join(ROOT, 'tmp_test', 'ai_mario_bench');
    fs.mkdirSync(out, {recursive: true});
    const server = await common.startServer({[MIRROR_PATH]: ckpt});
    const browser = await puppeteer.launch({executablePath: cfg.chromePath, headless: cfg.headless,
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...cfg.chromeArgs], protocolTimeout: 3600000,
        userDataDir: path.join(out, 'profile'), defaultViewport: {width: 1280, height: 1100}});
    const results = [];
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html?scheduler=message`, {waitUntil: 'load'});
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000});
        if (!await page.evaluate(() => window.AzaharAIPlayer.readMeta())) {
            await page.evaluate(source => window.AzaharAIPlayer.download({sourceUrl: source}), MIRROR_PATH);
        }
        await page.select('#ai-timing', 'lockstep');
        await page.evaluate(n => window.AzaharAIPlayer.setExecute(n), Number(option('--execute', 18)));
        await page.evaluate(() => window.AzaharAIPlayer.load());
        if (setups.includes('planner')) {
            const name = option('--planner');
            await page.evaluate(async name => {
                const planner = window.AzaharAIPlanner;
                await planner.refreshStored();
                if (!planner.models().find(model => model.id === name).stored) await planner.download(name);
                document.querySelector('#ai-planner-pause').checked = true;
                document.querySelector('#ai-planner-pause').dispatchEvent(new Event('change'));
            }, name);
            await page.evaluate(() => {
                const notes = document.querySelector('#ai-planner-notes');
                notes.value = 'New Super Mario Bros. 2: reach the goal pole at the right end of the level. Run right; ' +
                    'jump (B or A) over gaps, pipes and enemies; hold Y to dash.';
                notes.dispatchEvent(new Event('input'));
            });
        }
        await (await page.$('#rom-file')).uploadFile(path.resolve(rom));
        await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, {timeout: 60000});
        await page.click('#btn-load');
        await page.waitForFunction(() => window.AzaharUI?.isPlaying?.(), {timeout: 180000});
        for (const setup of setups) {
            const withPlanner = setup === 'planner' || setup === 'search-planner';
            if (withPlanner) await page.evaluate(name => window.AzaharAIPlanner.choose(name), option('--planner'));
            for (let i = 0; i < attempts; i++) {
                const framesDir = process.argv.includes('--save-frames') ? path.join(out, 'frames', `${setup}_${i + 1}`) : null;
                if (framesDir) fs.mkdirSync(framesDir, {recursive: true});
                const result = setup.startsWith('search')
                    ? {...await searchAttempt(page, state, seconds, {horizon: Number(option('--horizon', 90)),
                        commit: Number(option('--commit', 45)), reader: option('--reader', 'scroll'),
                        verify: process.argv.includes('--verify')},
                    path.join(out, `search_end_${i + 1}`), option('--save-state-at') && Number(option('--save-state-at'))), setup}
                    : await attempt(page, state, setup, seconds, framesDir);
                if (result.chosen) {
                    console.log(`  search steps ${result.steps} in ${result.wallSeconds} s of wall time ` +
                        `(${(result.wallSeconds / Math.max(0.1, result.gameSeconds)).toFixed(0)}x slower than real time), ` +
                        `plans chosen ${JSON.stringify(result.chosen)}, ` +
                        `replays at most ${result.replayError.toFixed(3)} from their futures (${result.unaligned} unaligned)`);
                }
                results.push(result);
                console.log(`${setup} #${i + 1}: furthest ${(100 * result.best).toFixed(0)}% of the level, ${result.end} ` +
                    `after ${result.gameSeconds} s of game time (${result.decisions} decisions, ${result.skipped} actions skipped)`);
            }
            if (withPlanner) await page.evaluate(() => window.AzaharAIPlanner.choose('off'));
            const mine = results.filter(result => result.setup === setup);
            console.log(`== ${setup}: furthest ${(100 * Math.max(...mine.map(r => r.best))).toFixed(0)}%, mean ` +
                `${(100 * mine.reduce((sum, r) => sum + r.best, 0) / mine.length).toFixed(0)}%, ` +
                `${mine.filter(r => r.end === 'cleared').length} of ${mine.length} cleared`);
        }
        if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
        fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify({rom: path.basename(rom), results}, null, 1));
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch(error => {
    console.error(`ai_mario_bench failed: ${error.message}`);
    process.exitCode = 1;
});
