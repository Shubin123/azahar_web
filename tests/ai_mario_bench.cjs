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
//        [--notes "..."]   (the planner's notes, in place of the level's)
// Setups: nitrogen; steer (right, favour B and Y); right (right only); planner; learn (look ahead
// near dangers: NitroGen plays on its own, goes back from failures to look ahead there, and
// remembers them from one attempt to the next, starting from nothing); learn-planner (the same
// with --planner steering, and judging whether a stage was cleared); search-planner
// (search with --planner choosing the heading and a button of its own); search: the
// widget's Look ahead (azahar_ai_lookahead.js), which every --commit frames saves the game, lets
// NitroGen play --horizon frames from there under each of a few steering plans, scores those
// futures by how far the screen scrolled (--reader meter: by the progress bar instead), and
// replays the best one's keys from the saved state.
//
// campaign: Look ahead near dangers from the level's start on through the levels after it,
// the AI playing the map between them itself (--levels, --hours; --planner judges stage ends
// and works menus).
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
// The planner's notes (--notes replaces them).
const NOTES = 'New Super Mario Bros. 2: reach the goal pole at the right end of the level. Run right; ' +
    'jump (B or A) over gaps, pipes and enemies; hold Y to dash.';

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
// The screens the look-ahead last read, as a PNG.
async function saveScreens(page, file) {
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
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, Buffer.from(shot, 'base64'));
    }
}

async function searchAttempt(page, state, seconds, options, endDir, saveAt = null) {
    const stepsDir = endDir.replace('search_end_', 'search_steps_');
    fs.rmSync(stepsDir, {recursive: true, force: true});
    await restoreState(page, state);
    await sleep(300);
    await page.evaluate(options => window.AzaharAILookahead.configure({mode: 'always', ...options}), options);
    await page.click('#btn-ai-play');
    let best = 0, sawLevel = false, steps = -1, careful = -1, end = 'time', stats = null, stepAt = Date.now();
    const log = [];
    for (;;) {
        await sleep(250);
        stats = await page.evaluate(() => window.AzaharAILookahead.stats());
        if (stats.error) throw new Error(stats.error);
        if (stats.ticks === steps) {
            if (Date.now() - stepAt > 300000) throw new Error(`the look-ahead made no step for 5 minutes (${steps} steps)`);
            continue;
        }
        steps = stats.ticks;
        stepAt = Date.now();
        if (!steps) continue;
        // (Near dangers: a line per careful step, and per failure gone back from.)
        const freePlay = stats.mode === 'dangers' && stats.steps === careful;
        careful = stats.steps;
        if (freePlay && stats.learned.length === (log.learned || 0)) {
            if (stats.inLevel && stats.meter !== null) best = Math.max(best, stats.meter);
            if (stats.gameSeconds >= seconds) break;
            // (A screen a second of free play, to see what it did: free_NNNN.png.)
            if (stats.gameSeconds >= (log.nextShot || 0)) {
                log.nextShot = Math.floor(stats.gameSeconds) + 1;
                await saveScreens(page, path.join(stepsDir, `free_${String(Math.floor(stats.gameSeconds)).padStart(4, '0')}.png`));
            }
            if (!stats.inLevel && sawLevel) {
                end = 'left the level';
                break;
            }
            continue;
        }
        if (stats.learned.length !== (log.learned || 0)) {
            log.learned = stats.learned.length;
            const last = stats.learned.at(-1);
            console.log(`  failed (${last.kind}) at ${last.pos} px` +
                `${last.enemy ? ', a moving thing beside the player' : ''}: ` +
                `${last.back ? `backed up ${last.back} save${last.back === 1 ? '' : 's'}` : 'gone back'} to look ahead; ` +
                `learned so far ${stats.memory.gates} places, ${stats.memory.enemies} enemies`);
        }
        log.push(`${stats.tried.map(f => `${f.plan} ${!f.alive ? 'dies' : !f.moving ? 'stuck' : 'ok'} ` +
            `${f.progress.toFixed(0)}${f.further ? ` (further: ${f.further})` : ''}`).join(', ')} -> ${stats.chosen}, level ${stats.meter === null ? '-' : (100 * stats.meter).toFixed(1)}%` +
            (stats.mode === 'dangers' ? ` [careful: ${stats.why}; at ${stats.pos} px]` : ''));
        // The screens each step left, to see what happened (tmp_test/ai_mario_bench/search_steps_N).
        await saveScreens(page, path.join(stepsDir, `${String(steps).padStart(3, '0')}.png`));
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
    // turned red (it stays dark after a life lost); read on the end frames saved above.
    if (end === 'left the level') {
        let red = 0;
        for (let i = 4; i <= 8; i++) {
            const file = path.join(endDir, `${i}s.png`);
            if (!fs.existsSync(file)) continue;
            red = Math.max(red, await page.evaluate(async url => {
                const image = new Image();
                image.src = url;
                await image.decode();
                const canvas = new OffscreenCanvas(image.width, image.height);
                const context = canvas.getContext('2d');
                context.drawImage(image, 0, 0);
                const data = context.getImageData(0, 0, image.width, image.height).data;
                let count = 0;
                for (let y = 140; y < 158; y++) {
                    for (let x = 278; x < 304; x++) {
                        const k = (y * image.width + x) * 4;
                        if (data[k] > 170 && data[k + 1] < 90 && data[k + 2] < 90) count++;
                    }
                }
                return count;
            }, `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`));
        }
        end = red > 40 ? 'cleared' : 'lost a life';
    }
    await page.evaluate(() => window.AzaharAILookahead.configure({enabled: false}));
    const tally = {};
    for (const line of log) {
        const chosen = line.split(' -> ')[1].split(',')[0];
        tally[chosen] = (tally[chosen] || 0) + 1;
    }
    return {setup: 'search', best: Math.min(1, best), end, gameSeconds: +stats.gameSeconds.toFixed(1), steps: stats.steps,
        rewinds: stats.rewinds, freeSeconds: +stats.freeSeconds.toFixed(1), carefulSeconds: +stats.carefulSeconds.toFixed(1),
        memory: stats.memory,
        wallSeconds: Math.round(stats.wallSeconds),
        chosen: tally, log, replayError: stats.replayError, unaligned: stats.unaligned, decisions: 0, skipped: 0};
}

// What the look-ahead waits on: its status line, the planner's, and whether game time moves.
const stuckAt = page => page.evaluate(async () => {
    const before = window.AzaharUI.getGuestTimeUs();
    await new Promise(resolve => setTimeout(resolve, 2000));
    const planner = window.AzaharAIPlanner.state();
    return {status: document.querySelector('#ai-lookahead-status')?.textContent,
        guest: {us: window.AzaharUI.getGuestTimeUs(), moved: window.AzaharUI.getGuestTimeUs() - before},
        planner: {loaded: planner.loaded, thinking: planner.thinking, error: planner.error, looks: planner.looks},
        player: window.AzaharAIPlayer.stats()};
});

// Setup 'campaign': the widget's Look ahead near dangers from the state (a level's start)
// on through the levels after it, from nothing learned: a stage cleared, it plays between
// levels itself (NitroGen on the map, the planner working menus) into the next one,
// remembering each level's places and every enemy. Until --levels levels are cleared, or
// --seconds of game time or --hours of wall time pass. A line per level begun, cleared, and
// per failure gone back from; the screens as each level begins and every 5 s of game time
// in tmp_test/ai_mario_bench/campaign (to see which level, and what it did between).
async function campaign(page, state, {levels, seconds, hours}) {
    const dir = path.join(ROOT, 'tmp_test', 'ai_mario_bench', 'campaign');
    fs.rmSync(dir, {recursive: true, force: true});
    await restoreState(page, state);
    await sleep(300);
    await page.evaluate(() => window.AzaharAILookahead.configure({mode: 'dangers'}));
    await page.click('#btn-ai-play');
    const startedAt = Date.now();
    const wall = () => Math.round((Date.now() - startedAt) / 1000);
    let entered = 0, cleared = 0, learned = 0, between = null, nextShot = 0, ticks = -1, tickAt = Date.now(), stats = null;
    let best = 0, levelStart = {game: 0, wall: 0, failures: 0}, axis = 'x', lastLevel = null, held = 0;
    const done = [], log = {};
    for (;;) {
        await sleep(500);
        stats = await page.evaluate(() => window.AzaharAILookahead.stats());
        if (stats.error) throw new Error(stats.error);
        if (stats.ticks !== ticks) {
            ticks = stats.ticks;
            tickAt = Date.now();
        } else if (Date.now() - tickAt > 300000) {
            throw new Error(`the look-ahead made no step for 5 minutes (${ticks} steps): ${JSON.stringify(await stuckAt(page))}`);
        }
        const game = stats.gameSeconds.toFixed(1);
        if (stats.learned.length !== learned) {
            for (const last of stats.learned.slice(learned)) {
                console.log(`  failed (${last.kind}) at ${last.pos} px${last.enemy ? ', a moving thing beside the player' : ''}: ` +
                    `${last.back ? `backed up ${last.back} save${last.back === 1 ? '' : 's'}` : 'gone back'}`);
            }
            learned = stats.learned.length;
        }
        if (stats.inLevel && stats.meter !== null && !stats.between) best = Math.max(best, stats.meter);
        if (stats.levelsCleared !== cleared) {
            cleared = stats.levelsCleared;
            const entry = {level: entered, known: levelStart.known, bar: +best.toFixed(3), gameSeconds: +(stats.gameSeconds - levelStart.game).toFixed(1),
                wallSeconds: wall() - levelStart.wall, failures: stats.rewinds - levelStart.failures};
            done.push(entry);
            console.log(`level ${entered} cleared (its own judgement; furthest on the bar ${(100 * best).toFixed(0)}%) after ` +
                `${entry.gameSeconds} s of game time, ${entry.wallSeconds} s of wall time, ${entry.failures} failures gone back from`);
            await saveScreens(page, path.join(dir, `level${entered}_cleared.png`));
        }
        // (Going into a pipe or through a door: a choice of down or up.)
        if (stats.chosen && /^(as planned \()?(down|up)\b/.test(stats.chosen) && stats.steps !== log.enterStep) {
            log.enterStep = stats.steps;
            console.log(`  chose ${stats.chosen} (${game} s, at ${stats.where} px)`);
        }
        if (stats.axis !== axis && !stats.between) {
            axis = stats.axis;
            console.log(`  the level goes ${axis === 'y' ? 'up or down' : 'sideways'} from here (${game} s, at ${stats.where} px)`);
        }
        if (stats.between !== between) {
            between = stats.between;
            if (between) console.log(`  between levels: ${between} (${game} s)`);
        }
        if (stats.levelsEntered !== entered) {
            // (Whether the last clear holds: a level it has not played just before follows a
            // clear; the same level again follows a life lost.)
            if (done.length && entered === done.at(-1).level) {
                done.at(-1).held = stats.level !== lastLevel;
                held += done.at(-1).held ? 1 : 0;
                console.log(`  ${done.at(-1).held ? 'the clear holds: another level follows' : 'that was no clear: the same level again'}`);
            }
            lastLevel = stats.level;
            entered = stats.levelsEntered;
            best = 0;
            levelStart = {game: stats.gameSeconds, wall: wall(), failures: stats.rewinds, known: entered > 1 && stats.level < stats.memory.levels - 1};
            console.log(`level ${entered} begins at ${game} s of game time, ${wall()} s of wall time: ` +
                `level #${stats.level + 1} of the ${stats.memory.levels} it has seen; it knows ${stats.memory.enemies} enemies, ` +
                `${stats.memory.gates} places`);
            await saveScreens(page, path.join(dir, `level${entered}_begins.png`));
            // (A state to start from here: the look-ahead's first save in the level.)
            await page.waitForFunction(() => window.AzaharAILookahead.checkpointBytes() || window.AzaharAILookahead.stats().error,
                {timeout: 600000, polling: 500}).catch(() => {});
            const bytes = await page.evaluate(() => {
                const data = window.AzaharAILookahead.checkpointBytes();
                if (!data) return null;
                let text = '';
                for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
                return btoa(text);
            });
            // (Named as the core looks states up: <programId>.<slot>.cst, as the state started from.)
            if (bytes) {
                const file = path.join(dir, `level${entered}`, path.basename(state));
                fs.mkdirSync(path.dirname(file), {recursive: true});
                fs.writeFileSync(file, Buffer.from(bytes, 'base64'));
            }
        }
        if (stats.gameSeconds >= nextShot) {
            nextShot = Math.floor(stats.gameSeconds / 5) * 5 + 5;
            await saveScreens(page, path.join(dir, `t${String(Math.floor(stats.gameSeconds)).padStart(5, '0')}.png`));
        }
        if (cleared >= levels || stats.gameSeconds >= seconds || wall() >= hours * 3600) break;
    }
    await page.click('#btn-ai-play');
    await page.waitForFunction(() => !window.AzaharAILookahead.running(), {timeout: 120000});
    await page.evaluate(() => window.AzaharAILookahead.configure({enabled: false}));
    console.log(`== campaign: ${cleared} levels cleared by its own judgement (${held} of them held: another level ` +
        `followed), ${entered} begun, in ${stats.gameSeconds.toFixed(0)} s of game time and ` +
        `${wall()} s of wall time (${(wall() / Math.max(1, stats.gameSeconds)).toFixed(0)}x slower); ${stats.rewinds} failures ` +
        `gone back from; it knows ${stats.memory.levels} levels, ${stats.memory.gates} places, ${stats.memory.enemies} enemies`);
    return {setup: 'campaign', cleared, held, entered, levels: done, gameSeconds: +stats.gameSeconds.toFixed(1), wallSeconds: wall(),
        rewinds: stats.rewinds, memory: stats.memory};
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
        if (setups.includes('planner') || setups.includes('campaign') && option('--planner')) {
            const name = option('--planner');
            await page.evaluate(async name => {
                const planner = window.AzaharAIPlanner;
                await planner.refreshStored();
                if (!planner.models().find(model => model.id === name).stored) await planner.download(name);
                document.querySelector('#ai-planner-pause').checked = true;
                document.querySelector('#ai-planner-pause').dispatchEvent(new Event('change'));
            }, name);
            await page.evaluate(text => {
                const notes = document.querySelector('#ai-planner-notes');
                notes.value = text;
                notes.dispatchEvent(new Event('input'));
            }, option('--notes', NOTES));
        }
        await (await page.$('#rom-file')).uploadFile(path.resolve(rom));
        await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, {timeout: 60000});
        await page.click('#btn-load');
        await page.waitForFunction(() => window.AzaharUI?.isPlaying?.(), {timeout: 180000});
        if (setups.includes('campaign')) {
            await page.evaluate(() => window.AzaharAILookahead.forget());
            if (option('--planner')) await page.evaluate(name => window.AzaharAIPlanner.choose(name), option('--planner'));
            results.push(await campaign(page, state, {levels: Number(option('--levels', 99)), seconds,
                hours: Number(option('--hours', 6))}));
        }
        for (const setup of setups.filter(name => name !== 'campaign')) {
            const withPlanner = setup === 'planner' || setup === 'search-planner' || setup === 'learn-planner';
            const learning = setup === 'learn' || setup === 'learn-planner';
            // Learning near dangers: from nothing at the first attempt, and on from there.
            if (learning) await page.evaluate(() => window.AzaharAILookahead.forget());
            if (withPlanner) await page.evaluate(name => window.AzaharAIPlanner.choose(name), option('--planner'));
            for (let i = 0; i < attempts; i++) {
                const framesDir = process.argv.includes('--save-frames') ? path.join(out, 'frames', `${setup}_${i + 1}`) : null;
                if (framesDir) fs.mkdirSync(framesDir, {recursive: true});
                const result = setup.startsWith('search') || learning
                    ? {...await searchAttempt(page, state, seconds, {mode: learning ? 'dangers' : 'always',
                        horizon: Number(option('--horizon', 90)),
                        commit: Number(option('--commit', 45)), reader: option('--reader', 'scroll'),
                        verify: process.argv.includes('--verify')},
                    path.join(out, `search_end_${i + 1}`), option('--save-state-at') && Number(option('--save-state-at'))), setup}
                    : await attempt(page, state, setup, seconds, framesDir);
                if (result.memory && learning) {
                    console.log(`  free play ${result.freeSeconds} s, careful ${result.carefulSeconds} s of game time; ` +
                        `${result.rewinds} failures gone back from; it knows ${result.memory.gates} places and ` +
                        `${result.memory.enemies} enemies`);
                }
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
