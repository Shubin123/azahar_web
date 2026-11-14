'use strict';
// The AI player widget (web/azahar_ai_player.js) in headless Chrome, all of it on the
// browser's own GPU (WebGPU):
//
//  1. Opening the page fetches nothing of the model: no huggingface.co, no ONNX Runtime
//     from cdn.jsdelivr.net, no vendor/nitrogen file, no worker, and no cached model.
//  2. huggingface.co serves the pinned ng.pt to this cross-origin-isolated page
//     (a 30-byte range request; skipped with --offline).
//  3. Download prepares the 8-bit model in the browser (from --ckpt, a local copy of that
//     ng.pt, so the test does not fetch 2 GB) and its weights match the reference conversion
//     (scripts/nitrogen/nitrogen_onnx.py) byte for byte.
//  4. The page's model (8 bits, a float16 encoder, 4 denoising steps) makes at least
//     --min-per-second decisions per second, and acts like NVIDIA's model on emulator
//     framebuffers: --saved-frames of the saved ones in --frames (tests/ai_frames.cjs) and ones
//     taken from the running game. NVIDIA's model there is the float32 graphs with its 16
//     steps (nitrogen_onnx.py --variants f32, in --reference-model; they reproduce NVIDIA's
//     code), converted from ng.pt by a second worker into its memory only. The two are
//     compared as policies, over many noise draws per frame (ai_common.cjs's
//     distributionChecks).
//     With a light expert in the manifest (scripts/nitrogen/nitrogen_light_expert.py), its
//     weights come with the download, the page decides with the mixture (the light encoder,
//     NitroGen's when its gate is unsure), and the widget's encoder choice takes effect.
//  5. With --planner-checks (not on Pokémon: the planner is judged on other games), the
//     planner (System 2, azahar_ai_planner.js) steers NitroGen: with a plan to head left,
//     favour A and avoid B, the chunks played head left and press A more often than
//     NitroGen's own, and never press B; and its touch reaches the bottom screen (--tap).
//  6. With a game running (--rom, optionally --state), "Let the AI play" holds keys that
//     change the game, in real time (the game not held, a new decision at least every 18
//     frames) and waiting for each decision (one per 18 frames of game time); taking back
//     control releases them. A planner's touch reaches the bottom screen.
//     Looking ahead (System 2's Look ahead, azahar_ai_lookahead.js), each step tries 4
//     futures from a saved state and replays the best one exactly (the game then matches what
//     that future showed), and taking back control lets the game run on.
//  7. Delete model empties the browser's model storage.
//
//   node tests/ai_player.test.cjs --ckpt ng.pt [--frames tmp_test/ai_frames/valid]
//        [--reference-model tmp_test/ai_reference/f32] [--rom ROM [--state STATE.cst]]
//        [--live-frames 16] [--saved-frames 32] [--samples 12] [--min-per-second 5] [--offline]
//        [--keep-model] [--backend wasm] [--software] [--planner-checks [--tap X,Y]]
//
// --tap X,Y: with --planner-checks, where the planner's touch check touches, in its 400x480
// view of both screens (a button on the game's bottom screen at --state).
//
// --backend wasm runs the model on WebAssembly instead of WebGPU; --software runs the
// emulator's compatibility renderer.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const cfg = require('./config.cjs');
const {restoreState} = require('./fixture_state.cjs');
const common = require('./ai_common.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = name => process.argv.includes(name);
const ROOT = path.resolve(__dirname, '..');
const MODEL_DIR = path.join(cfg.webDir, 'vendor', 'nitrogen', 'q8');
const MIRROR_PATH = '/__test/ng.pt';
const REFERENCE_PATH = '/__test/reference/';
const results = [];

function check(name, ok, detail = '') {
    results.push({name, ok: Boolean(ok), detail});
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// The planner steering NitroGen on the frames: for each, the same noises, played as NitroGen
// alone would (the first draw, unguided) and as the planner steers with a fixed plan (the
// draws pulled its way as they are denoised, the best one picked). Counted over each
// chunk's first 8 actions (what plays before the next decision).
async function steeringChecks(page, frames) {
    const counts = await page.evaluate(async (frames, seeds) => {
        const player = window.AzaharAIPlayer, planner = window.AzaharAIPlanner;
        const code = (group, control) => window.AzaharInput.KEYMAP.find(e => e.group === group && e.control === control).code;
        const left = [code('D-pad', 'Left'), code('Circle Pad', 'Left')], a = code('Face buttons', 'A');
        const b = code('Face buttons', 'B');
        const plan = {move: 'left', press: ['A'], avoid: ['B']};
        const tally = {alone: {left: 0, a: 0, b: 0}, steered: {left: 0, a: 0, b: 0}, steps: 0};
        const count = (into, chunk) => {
            for (let step = 0; step < 8; step++) {
                const keys = player.keysFor(chunk, step);
                if (keys.some(k => left.includes(k))) into.left++;
                if (keys.includes(a)) into.a++;
                if (keys.includes(b)) into.b++;
            }
        };
        for (const [index, frame] of frames.entries()) {
            const noises = Array.from({length: planner.STEER_DRAWS}, (_, i) => window.__noise(seeds + 100 * index + i));
            planner.steer(null);
            const alone = await player.act(Uint8Array.from(frame.rgb), null, noises);
            count(tally.alone, alone.actions.subarray(0, 450));
            planner.steer(plan);
            const out = await player.act(Uint8Array.from(frame.rgb), null, noises, planner.guidance(player.BUTTONS));
            const chosen = planner.pick(out.actions, noises.length, player.BUTTONS);
            count(tally.steered, out.actions.subarray(chosen * 450, (chosen + 1) * 450));
            tally.steps += 8;
        }
        planner.steer(null);
        return tally;
    }, frames.map(frame => ({rgb: frame.rgb})), 5e6);
    const share = (who, key) => counts[who][key] / counts.steps;
    console.log(`  steering on ${frames.length} framebuffers: left ${share('alone', 'left').toFixed(3)} -> ` +
        `${share('steered', 'left').toFixed(3)}, A ${share('alone', 'a').toFixed(3)} -> ${share('steered', 'a').toFixed(3)}, ` +
        `B ${share('alone', 'b').toFixed(3)} -> ${share('steered', 'b').toFixed(3)}`);
    check('the planner steers NitroGen left (left held at least 1.5 x as often, and more than 0.1 more)',
        share('steered', 'left') >= 1.5 * share('alone', 'left') && share('steered', 'left') - share('alone', 'left') > 0.1,
        `${share('alone', 'left').toFixed(3)} -> ${share('steered', 'left').toFixed(3)}`);
    check('the planner makes NitroGen favour A', share('steered', 'a') > share('alone', 'a'),
        `${share('alone', 'a').toFixed(3)} -> ${share('steered', 'a').toFixed(3)}`);
    check('a button the planner avoids is never pressed', counts.steered.b === 0,
        `B on ${counts.steered.b} of ${counts.steps} actions (NitroGen alone: ${counts.alone.b})`);
}

// The page's model against the float32 one (the 'reference' worker): its speed, and its
// action distribution on the frames (ai_common.cjs's distributionChecks).
async function validateOnFramebuffers(page, frames) {
    const times = [];
    let verify = null, light = 0;
    for (let i = 0; i < 24; i++) {
        const out = await page.evaluate(async (rgb, seed) => {
            const out = await window.AzaharAIPlayer.act(Uint8Array.from(rgb), window.__noise(seed));
            return {ms: out.encodeMs + out.denoiseMs, verify: out.verify, expert: out.expert};
        }, frames[i % frames.length].rgb, i);
        times.push(out.ms);
        verify = out.verify || verify;
        if (i >= 4 && out.expert === 'light') light++;
    }
    const perSecond = 1000 / common.median(times.slice(4));
    const minimum = Number(option('--min-per-second', 5));
    check(`the quantized model makes at least ${minimum} decisions per second`, perSecond >= minimum,
        `${perSecond.toFixed(2)} per second (${common.median(times.slice(4)).toFixed(0)} ms each)`);
    if (verify?.checks) {
        console.log(`  the mixture decided ${light} of 20 with the light expert alone; its check against NitroGen: ` +
            `${verify.heavy ? 'acts unlike it here, NitroGen decides' : 'acts alike'} ` +
            `(${verify.disagreement.toFixed(4)} over ${verify.checks} checks)`);
    }
    const started = Date.now();
    const result = await common.distributionChecks(page, frames, 'player', Number(option('--samples', 12)));
    console.log(`  ${frames.length} framebuffers x ${option('--samples', 12)} draws per model, ` +
        `${((Date.now() - started) / 1000).toFixed(0)} s`);
    for (const [name, ok, value] of result.checks) check(`on ${frames.length} framebuffers: ${name}`, ok, value);
}

// Model inputs taken from the running game, as the AI player takes them.
async function liveFrames(page, count) {
    const frames = [];
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyS', 'KeyT', 'KeyG', 'KeyF', 'KeyH'];
    for (let index = 0; index < count; index++) {
        await page.evaluate(code => window.AzaharInput.setSourceCodes('test', [code]), keys[index % keys.length]);
        await sleep(700);
        await page.evaluate(() => window.AzaharInput.setSourceCodes('test', []));
        const seen = await page.evaluate(async () => [...(await window.AzaharAIPlayer.nextFrameInput()).input]);
        frames.push({scene: 'live', name: `live_${index}`, rgb: seen});
    }
    return frames;
}

async function bootGame(page, rom, state) {
    await (await page.$('#rom-file')).uploadFile(path.resolve(rom));
    await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, {timeout: 60000});
    await page.click('#btn-load');
    await page.waitForFunction(() => window.AzaharUI?.isPlaying?.(), {timeout: 180000});
    if (state) await restoreState(page, state);
    else await sleep(20000);
}

// Mean absolute difference between two model inputs, 0-255.
function difference(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
}

const frameNow = page => page.evaluate(async () => {
    const seen = await window.AzaharAIPlayer.nextFrameInput();
    return {input: [...seen.input], guestUs: seen.guestUs};
});

async function waitGuest(page, fromUs, seconds) {
    await page.waitForFunction((start, us) => window.AzaharUI.getGuestTimeUs() - start >= us,
        {timeout: 300000, polling: 50}, fromUs, seconds * 1e6);
}

async function savePng(page, input, file) {
    const base64 = await page.evaluate(async rgb => {
        const rgba = new Uint8ClampedArray(256 * 256 * 4);
        for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
            rgba[o] = rgb[i]; rgba[o + 1] = rgb[i + 1]; rgba[o + 2] = rgb[i + 2]; rgba[o + 3] = 255;
        }
        const canvas = new OffscreenCanvas(256, 256);
        canvas.getContext('2d').putImageData(new ImageData(rgba, 256, 256), 0, 0);
        const bytes = new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(text);
    }, input);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
}

const RUN_SECONDS = 10;
const SETTLE_SECONDS = 1;

// From the state (or where the game is), `seconds` of game time with or without the AI;
// `wait`: the AI's "Pause the game while the AI thinks" option. Returns the first and last
// frames, the wall-clock seconds it took, and, with the AI, its decisions and held keys.
async function run(page, state, ai, wait = false) {
    if (state) await restoreState(page, state);
    await waitGuest(page, (await frameNow(page)).guestUs, SETTLE_SECONDS);
    if (ai) {
        await page.select('#ai-timing', wait ? 'wait' : 'realtime');
    }
    const start = await frameNow(page);
    const started = Date.now();
    if (ai) await page.click('#btn-ai-play');
    const held = new Set();
    let first = null;
    const deadline = Date.now() + 240000;
    for (;;) {
        const now = await page.evaluate(() => ({guest: window.AzaharUI.getGuestTimeUs(),
            playing: window.AzaharUI.isPlaying(), ai: window.AzaharAIPlayer.stats()}));
        now.ai.codes.forEach(code => held.add(code));
        if (first === null && now.ai.decisions > 0) first = {guest: now.guest, decisions: now.ai.decisions};
        if (now.guest - start.guestUs >= RUN_SECONDS * 1e6) break;
        if (Date.now() > deadline) {
            const pageState = await page.evaluate(() => ({fps: document.querySelector('#fps').textContent,
                hold: window.AzaharAIPlayer.shouldHold(), netHold: Boolean(window.AzaharNetplay?.shouldHold?.()),
                log: window.AzaharUI.getLog().split('\n').filter(line => !/SetProbeResponseParam|BeginHostingNetwork/.test(line)).slice(-8)}));
            throw new Error(`Game time stalled at ${((now.guest - start.guestUs) / 1e6).toFixed(2)} s ` +
                `(running ${now.playing}, AI ${JSON.stringify({...now.ai, meta: undefined})}, ${JSON.stringify(pageState)})`);
        }
        await sleep(50);
    }
    const end = await frameNow(page);
    const seconds = (Date.now() - started) / 1000;
    let stats = null;
    if (ai) {
        stats = await page.evaluate(() => window.AzaharAIPlayer.stats());
        await page.click('#btn-ai-play');
    }
    return {start, end, seconds, held, first, stats};
}

// The bottom screen (40,240 to 360,480 of the planner's 400x480 view) of both screens, as
// numbers 0-255, and how much it changed between two such views.
const bottomNow = page => page.evaluate(async () => {
    const screens = await window.AzaharAIPlayer.nextFrameScreens();
    const out = [];
    for (let y = 240; y < 480; y++) {
        for (let x = 40; x < 360; x++) {
            const i = (y * 400 + x) * 4;
            out.push(screens.data[i], screens.data[i + 1], screens.data[i + 2]);
        }
    }
    return out;
});

// A planner's touch at `point` of its view, from the state: the bottom screen's change over
// 1.5 s, with and without it.
async function tapEffect(page, state, point) {
    const changes = {};
    for (const touch of [false, true]) {
        if (state) await restoreState(page, state);
        await waitGuest(page, (await frameNow(page)).guestUs, SETTLE_SECONDS);
        const before = await bottomNow(page);
        if (touch) await page.evaluate(point => window.AzaharAIPlanner.tap(point), point);
        await waitGuest(page, (await frameNow(page)).guestUs, 1.5);
        changes[touch ? 'touched' : 'alone'] = difference(before, await bottomNow(page));
    }
    return changes;
}

// System 2's Look ahead from the state: two steps (each tries 4 futures from a saved state and
// replays the best one), then taking back control.
async function lookAhead(page, state) {
    if (state) await restoreState(page, state);
    const toggle = on => page.select('#ai-lookahead', on ? 'always' : 'off');
    await toggle(true);
    await page.click('#btn-ai-play');
    await page.waitForFunction(() => window.AzaharAILookahead.stats().steps >= 2 || window.AzaharAILookahead.stats().error,
        {timeout: 600000, polling: 500});
    const stats = await page.evaluate(() => window.AzaharAILookahead.stats());
    await page.click('#btn-ai-play');
    await page.waitForFunction(() => !window.AzaharAILookahead.running(), {timeout: 120000});
    await toggle(false);
    const before = await page.evaluate(() => window.AzaharUI.getGuestTimeUs());
    await sleep(1000);
    const after = await page.evaluate(before => ({guestMoved: window.AzaharUI.getGuestTimeUs() > before,
        playing: window.AzaharAIPlayer.isPlaying(), pressed: window.AzaharInput.getPressedCodes()}), before);
    // Near dangers: NitroGen plays on its own (from saves), for 4 s of game time.
    if (state) await restoreState(page, state);
    await page.evaluate(() => window.AzaharAILookahead.forget());
    await page.select('#ai-lookahead', 'dangers');
    await page.click('#btn-ai-play');
    await page.waitForFunction(() => window.AzaharAILookahead.stats().gameSeconds >= 4 || window.AzaharAILookahead.stats().error,
        {timeout: 600000, polling: 500});
    const dangers = await page.evaluate(() => window.AzaharAILookahead.stats());
    await page.click('#btn-ai-play');
    await page.waitForFunction(() => !window.AzaharAILookahead.running(), {timeout: 120000});
    await page.select('#ai-lookahead', 'off');
    const afterDangers = await page.evaluate(() => ({playing: window.AzaharAIPlayer.isPlaying(),
        pressed: window.AzaharInput.getPressedCodes()}));
    return {stats, after, dangers, afterDangers};
}

async function playthrough(page, state) {
    console.log(`  game running; runs of ${RUN_SECONDS} s of game time from the same state`);
    const out = path.join(ROOT, 'tmp_test', 'ai_player');
    fs.mkdirSync(out, {recursive: true});
    // Two runs without input show how much the game changes by itself.
    const idle = [await run(page, state, false), await run(page, state, false)];
    const realTime = await run(page, state, true);
    const waiting = await run(page, state, true, true);
    const after = await page.evaluate(() => ({playing: window.AzaharAIPlayer.isPlaying(),
        codes: window.AzaharAIPlayer.stats().codes, pressed: window.AzaharInput.getPressedCodes()}));
    for (const [name, frames] of [['idle1', idle[0]], ['idle2', idle[1]], ['ai', realTime], ['ai_wait', waiting]]) {
        await savePng(page, frames.start.input, path.join(out, `${name}_start.png`));
        await savePng(page, frames.end.input, path.join(out, `${name}_end.png`));
    }
    const noise = difference(idle[0].end.input, idle[1].end.input);
    const effect = run => Math.min(difference(run.end.input, idle[0].end.input), difference(run.end.input, idle[1].end.input));
    const decisions = run => run.stats.decisions - run.first.decisions;
    const perDecisionMs = run => (run.end.guestUs - run.first.guest) / 1000 / Math.max(1, decisions(run));
    // Game seconds per wall-clock second, against the runs without the AI.
    const pace = run => RUN_SECONDS / run.seconds;
    const idlePace = Math.min(pace(idle[0]), pace(idle[1]));

    for (const [name, run] of [['real time', realTime], ['waiting', waiting]]) {
        console.log(`  ${name}: ${run.stats.decisions} decisions on ${run.stats.loaded.backend}, ${Math.round(run.stats.lastMs)} ms ` +
            `the last; ${perDecisionMs(run).toFixed(0)} ms of game time per decision; game pace ${pace(run).toFixed(2)} ` +
            `(without the AI ${idlePace.toFixed(2)}); keys held: ${[...run.held].join(' ') || 'none'}; ` +
            `end frame vs no input ${effect(run).toFixed(2)} (no input vs no input ${noise.toFixed(2)})`);
    }
    check('in real time the AI held 3DS keys and its keys changed the game',
        realTime.held.size > 0 && effect(realTime) > Math.max(2.0, 2 * noise),
        `${[...realTime.held].join(' ')}; ${effect(realTime).toFixed(2)} vs ${noise.toFixed(2)}`);
    check('in real time the game is not held for the AI (at least 90% of its pace without it)',
        pace(realTime) >= 0.9 * idlePace, `${pace(realTime).toFixed(2)} vs ${idlePace.toFixed(2)}`);
    check('in real time a new decision comes every 300 ms of game time or sooner',
        decisions(realTime) > 0 && perDecisionMs(realTime) <= 300, `${perDecisionMs(realTime).toFixed(0)} ms`);
    check('waiting for the AI, each decision covers its 18 actions of game time (300 ms)',
        decisions(waiting) > 0 && perDecisionMs(waiting) >= 290 && perDecisionMs(waiting) <= 420,
        `${perDecisionMs(waiting).toFixed(0)} ms over ${decisions(waiting)}`);
    check('waiting for the AI, its keys changed the game',
        waiting.held.size > 0 && effect(waiting) > Math.max(2.0, 2 * noise), `${effect(waiting).toFixed(2)} vs ${noise.toFixed(2)}`);
    check('taking back control stops the AI and releases its keys',
        !after.playing && after.codes.length === 0, JSON.stringify(after));
    const ahead = await lookAhead(page, state);
    console.log(`  look ahead: ${ahead.stats.steps} steps, last ${ahead.stats.tried.map(f => `${f.plan} ` +
        `${!f.alive ? 'dies' : !f.moving ? 'stuck' : 'ok'}`).join(', ')} -> ${ahead.stats.chosen}`);
    check('looking ahead, each step tries 4 futures and replays the best one exactly',
        !ahead.stats.error && ahead.stats.steps >= 2 && ahead.stats.tried.length >= 4 && ahead.stats.replayError < 10,
        `${ahead.stats.error || ''} replay ${ahead.stats.replayError.toFixed(3)} apart`);
    check('taking back control from the look-ahead lets the game run on with no keys held',
        !ahead.after.playing && ahead.after.guestMoved && ahead.after.pressed.length === 0, JSON.stringify(ahead.after));
    console.log(`  near dangers: ${ahead.dangers.freeSeconds.toFixed(1)} s of free play, ${ahead.dangers.carefulSeconds.toFixed(1)} s ` +
        `careful, ${ahead.dangers.rewinds} failures gone back from`);
    check('looking ahead near dangers, NitroGen plays on its own between them, and stopping releases its keys',
        !ahead.dangers.error && ahead.dangers.freeSeconds > 0 && !ahead.afterDangers.playing &&
        ahead.afterDangers.pressed.length === 0, JSON.stringify({error: ahead.dangers.error, ...ahead.afterDangers}));
    if (!flag('--planner-checks') || !option('--tap')) return;
    const point = option('--tap').split(',').map(Number);
    const touched = await tapEffect(page, state, point);
    check(`a planner's touch at ${point.join(',')} reaches the bottom screen`,
        touched.touched > Math.max(2.0, 2 * touched.alone),
        `bottom screen change ${touched.touched.toFixed(2)} touched, ${touched.alone.toFixed(2)} without`);
}

async function main() {
    const ckpt = option('--ckpt');
    const manifest = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'manifest.json'), 'utf8'));
    const referenceDir = path.resolve(option('--reference-model', path.join(ROOT, 'tmp_test', 'ai_reference', 'f32')));
    const framesDir = option('--frames', path.join(ROOT, 'tmp_test', 'ai_frames', 'valid'));
    const served = [];
    const server = await common.startServer({[MIRROR_PATH]: ckpt, [REFERENCE_PATH]: referenceDir}, served);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await puppeteer.launch({executablePath: cfg.chromePath, headless: cfg.headless,
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...cfg.chromeArgs], protocolTimeout: 600000,
        defaultViewport: {width: 1280, height: 1100}});
    const requests = [];
    const errors = [];
    try {
        const page = await browser.newPage();
        page.on('request', request => requests.push(request.url()));
        // A worker's own requests (the AI worker's downloads) are not page requests.
        page.on('workercreated', worker => {
            worker.client.on('Network.requestWillBeSent', event => requests.push(event.request.url));
            worker.client.send('Network.enable').catch(() => {});
        });
        page.on('pageerror', error => errors.push(String(error)));
        page.on('console', message => {
            if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(`${origin}/index.html${flag('--software') ? '?renderer=software' : ''}`, {waitUntil: 'load'});
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000});
        await sleep(3000);

        // 1. Nothing is fetched or stored before the player asks.
        const early = [...requests, ...served].filter(url =>
            /huggingface\.co|jsdelivr|vendor\/nitrogen|azahar_ai_worker|azahar_ai_planner_worker|__test/.test(url));
        check('opening the page fetches nothing of the model', early.length === 0, early.join(', '));
        const before = await page.evaluate(async () => ({
            stored: await caches.has(window.AzaharAIPlayer.CACHE_NAME),
            play: document.querySelector('#btn-ai-play').disabled,
            download: !document.querySelector('#btn-ai-download').hidden,
            text: document.querySelector('#ai-stored').textContent,
        }));
        check('no model is stored, Download is offered and play waits for it',
            !before.stored && before.play && before.download, JSON.stringify(before));
        const origins = await page.$eval('#ai-model', element => element.textContent);
        check('the widget names the model, its origin, license and runtime',
            ['NitroGen', 'NVIDIA', 'huggingface.co/nvidia/NitroGen', 'NVIDIA License', 'non-commercial', 'cdn.jsdelivr.net']
                .every(text => origins.includes(text)));
        if (manifest.light) {
            check('the widget names the light expert, its origin and license',
                ['Light expert', 'SigLIP-base', 'Apache 2.0', 'Laya-Vision', 'nitrogen_light_expert.py']
                    .every(text => origins.includes(text)));
        }
        const planner = await page.evaluate(() => ({
            text: document.querySelector('#ai-player-card').textContent,
            choice: document.querySelector('#ai-planner-model').value,
            options: [...document.querySelectorAll('#ai-planner-model option')].map(option => option.value),
        }));
        check('the planner is off until chosen, and the widget names its models, origin, license and runtime',
            planner.choice === 'off' && planner.options.length > 1 &&
            ['System 2', 'Planner', 'huggingface.co', 'Transformers.js', 'cdn.jsdelivr.net', 'Apache 2.0']
                .every(text => planner.text.includes(text)), planner.options.join(', '));

        // 2. The real origin works from this page.
        if (!flag('--offline')) {
            const probe = await page.evaluate(async url => {
                const response = await fetch(url, {headers: {Range: 'bytes=0-29'}, cache: 'no-store'});
                return {status: response.status, head: [...new Uint8Array(await response.arrayBuffer())].slice(0, 4)};
            }, manifest.source.url);
            check('huggingface.co serves the pinned ng.pt to this page (CORS, range)',
                probe.status === 206 && probe.head.join() === '80,75,3,4', JSON.stringify(probe));
        }

        // 3. Prepare the model.
        if (!ckpt) throw new Error('--ckpt (a local copy of ng.pt) is required');
        const started = Date.now();
        const meta = await page.evaluate(source => window.AzaharAIPlayer.download({sourceUrl: source}), MIRROR_PATH);
        console.log(`  prepared in ${((Date.now() - started) / 1000).toFixed(0)} s: ${(meta.bytes / 1e6).toFixed(0)} MB`);
        for (const [graph, description] of Object.entries(manifest.graphs)) {
            check(`browser-converted ${graph} weights match the reference conversion`,
                meta.weightsSha256[graph] === description.weightsSha256, meta.weightsSha256[graph]);
        }
        check('the download streamed ng.pt from its source', served.includes(MIRROR_PATH));
        if (manifest.light) {
            const cached = await page.evaluate(async files => {
                const cache = await caches.open(window.AzaharAIPlayer.CACHE_NAME);
                const keys = (await cache.keys()).map(request => request.url);
                return files.map(file => keys.some(url => url.endsWith(`/ai-model/${file}`)));
            }, manifest.light.weights.map(entry => entry.file));
            check('the light expert\'s weights came with the download, as the manifest describes them, and are kept',
                meta.weightsSha256.light === manifest.light.weights.map(entry => entry.sha256).join(',') && cached.every(Boolean),
                manifest.light.weights.map(entry => `${entry.file} ${Math.round(entry.size / 1e6)} MB`).join(', '));
        }
        const stored = await page.evaluate(async () => ({
            stored: await caches.has(window.AzaharAIPlayer.CACHE_NAME),
            remove: !document.querySelector('#btn-ai-delete').hidden,
            text: document.querySelector('#ai-stored').textContent,
        }));
        check('the model is kept in Cache Storage and can be deleted', stored.stored && stored.remove, stored.text);

        // 4. Inference on framebuffers.
        const loaded = await page.evaluate(backend => window.AzaharAIPlayer.load(backend), option('--backend'));
        if (option('--backend')) check(`the model runs on ${option('--backend')}`, loaded.backend === option('--backend'), loaded.backend);
        console.log(`  model loaded on ${loaded.backend} in ${loaded.loadSeconds?.toFixed(1)} s (warm-up ${Math.round(loaded.warmupMs)} ms)`);
        check('ONNX Runtime Web is fetched only once the AI starts', requests.some(url => url.includes('jsdelivr')));
        if (manifest.light) {
            check('the page decides with NitroGen\'s own encoder unless the player chooses the light expert',
                loaded.light && loaded.routing === 'heavy', JSON.stringify({light: loaded.light, routing: loaded.routing}));
            const used = {};
            for (const expert of ['light', 'gate', 'heavy']) {
                await page.select('#ai-expert', expert);
                used[expert] = await page.evaluate(async () => {
                    const pixels = new Uint8Array(256 * 256 * 3).map((_, i) => (i * 7) % 251);
                    return (await window.AzaharAIPlayer.act(pixels, window.__noise ? window.__noise(1) : null)).expert;
                });
            }
            check('the widget\'s encoder choice decides which encoder runs', used.heavy === 'heavy' && used.light === 'light',
                JSON.stringify(used));
        }
        await common.installNoise(page);
        const frames = fs.existsSync(framesDir)
            ? await common.framesFromDisk(page, framesDir, Number(option('--saved-frames', 32))) : [];
        if (option('--rom')) {
            await bootGame(page, option('--rom'), option('--state'));
            frames.push(...await liveFrames(page, Number(option('--live-frames', 16))));
            // The models have the GPU to themselves while they are compared.
            await page.click('#btn-stop');
        }
        if (frames.length) {
            const referenceManifest = JSON.parse(fs.readFileSync(path.join(referenceDir, 'manifest.json'), 'utf8'));
            const reference = await common.startModelWorker(page, 'reference', REFERENCE_PATH, MIRROR_PATH);
            for (const [graph, description] of Object.entries(referenceManifest.graphs)) {
                check(`browser-converted float32 ${graph} weights match the reference conversion`,
                    reference.meta.weightsSha256[graph] === description.weightsSha256);
            }
            console.log(`  float32 model on ${reference.loaded.backend}; comparing on ${frames.length} framebuffers ` +
                `(${[...new Set(frames.map(frame => frame.scene))].join(', ')})`);
            await validateOnFramebuffers(page, frames);
            await page.evaluate(() => window.__workers.reference.terminate());
            if (flag('--planner-checks')) await steeringChecks(page, frames);
        }

        // 5. Play.
        if (option('--rom')) {
            await page.click('#btn-run');
            await playthrough(page, option('--state'));
        }

        // 6. Delete.
        if (!flag('--keep-model')) {
            await page.select('#ai-models', 'nitrogen');
            await page.click('#btn-ai-delete');
            await page.waitForFunction(() => !document.querySelector('#btn-ai-download').hidden, {timeout: 30000});
            const gone = await page.evaluate(async () => ({
                stored: await caches.has(window.AzaharAIPlayer.CACHE_NAME),
                meta: await window.AzaharAIPlayer.readMeta(),
                play: document.querySelector('#btn-ai-play').disabled,
            }));
            check('Delete model removes it from the browser', !gone.stored && !gone.meta && gone.play, JSON.stringify(gone));
        }
        const pageErrors = errors.filter(text => !/favicon/.test(text));
        check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    } finally {
        await browser.close();
        server.close();
    }
    const failed = results.filter(result => !result.ok);
    console.log(`--- AI PLAYER: ${results.length - failed.length}/${results.length} checks passed ---`);
    if (failed.length) process.exitCode = 1;
}

main().catch(error => {
    console.error(`ai_player test failed: ${error.stack || error.message}`);
    process.exitCode = 1;
});
