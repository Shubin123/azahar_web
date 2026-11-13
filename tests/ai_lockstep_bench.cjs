'use strict';
// The AI player in lockstep (AzaharAIPlayer.setLockstep): the game runs as fast as this
// machine can, waits for each decision, and stops at the end of each action's frame, so the
// model's speed is what limits how fast the game is played, and every action is held for
// exactly its frame of game time (azahar_set_guest_stop_us). Against that, the same model
// waiting for each decision with the game fast-forwarded (4x) instead: the game runs several
// frames between the page's looks at it, so actions are skipped.
//
// The page's model is prepared from --ckpt (a local copy of NVIDIA's ng.pt), as
// tests/ai_player.test.cjs does, and plays --decisions decisions from --state per run.
// Results go to tmp_test/ai_lockstep/latest.json.
//
//   node tests/ai_lockstep_bench.cjs --ckpt ng.pt --rom ROM --state STATE.cst
//        [--decisions 60] [--expert heavy|gate|light] [--backend wasm]
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

async function bootGame(page, rom, state) {
    await (await page.$('#rom-file')).uploadFile(path.resolve(rom));
    await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, {timeout: 60000});
    await page.click('#btn-load');
    await page.waitForFunction(() => window.AzaharUI?.isPlaying?.(), {timeout: 180000});
    await restoreState(page, state);
}

// From the state, `decisions` decisions in `mode`: 'lockstep', or 'fast' (4x fast-forward,
// waiting for each decision). Wall time, game time, the model's time per decision and the
// actions skipped.
async function run(page, state, mode, decisions) {
    await restoreState(page, state);
    await page.evaluate(mode => {
        window.AzaharAIPlayer.setLockstep(mode === 'lockstep');
        window.AzaharUI.getModule()._azahar_set_fast_forward(mode === 'fast' ? 4 : 1);
        const wait = document.querySelector('#ai-wait');
        if (!wait.checked) wait.click();
    }, mode);
    const start = await page.evaluate(() => window.AzaharUI.getGuestTimeUs());
    const started = Date.now();
    await page.click('#btn-ai-play');
    // Progress, and where it stands if the game stops moving for a minute.
    let last = {guest: start, at: Date.now()};
    for (;;) {
        const now = await page.evaluate(() => ({guest: window.AzaharUI.getGuestTimeUs(), stats: window.AzaharAIPlayer.stats(),
            hold: window.AzaharAIPlayer.shouldHold(), playing: window.AzaharUI.isPlaying()}));
        if (now.stats.decisions >= decisions) break;
        if (now.guest !== last.guest) last = {guest: now.guest, at: Date.now()};
        if (Date.now() - last.at > 60000) {
            throw new Error(`${mode}: the game stopped at ${(now.guest / 1e6).toFixed(3)} s of game time after ` +
                `${now.stats.decisions} decisions (step ${now.stats.step}, hold ${now.hold}, running ${now.playing}, ` +
                `skipped ${now.stats.skipped}, last decision ${Math.round(now.stats.lastMs)} ms)`);
        }
        await sleep(200);
    }
    const seconds = (Date.now() - started) / 1000;
    const end = await page.evaluate(() => ({guest: window.AzaharUI.getGuestTimeUs(), stats: window.AzaharAIPlayer.stats()}));
    await page.click('#btn-ai-play');
    await page.evaluate(() => {
        window.AzaharAIPlayer.setLockstep(false);
        window.AzaharUI.getModule()._azahar_set_fast_forward(1);
    });
    const gameSeconds = (end.guest - start) / 1e6;
    return {mode, decisions: end.stats.decisions, wallSeconds: +seconds.toFixed(2), gameSeconds: +gameSeconds.toFixed(2),
        decisionsPerSecond: +(end.stats.decisions / seconds).toFixed(2), gamePace: +(gameSeconds / seconds).toFixed(2),
        modelMs: Math.round(end.stats.lastMs), skipped: end.stats.skipped,
        actions: end.stats.decisions * 18};
}

async function main() {
    const ckpt = option('--ckpt'), rom = option('--rom'), state = option('--state');
    if (!ckpt || !rom || !state) throw new Error('--ckpt, --rom and --state are required');
    const decisions = Number(option('--decisions', 60));
    const server = await common.startServer({[MIRROR_PATH]: ckpt});
    const browser = await puppeteer.launch({executablePath: cfg.chromePath, headless: cfg.headless,
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...cfg.chromeArgs], protocolTimeout: 1800000,
        defaultViewport: {width: 1280, height: 1100}});
    const summary = {rom: path.basename(rom), state: path.basename(path.dirname(state)), expert: option('--expert', 'heavy')};
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        // Ticks as fast as they can follow one another, not one per display refresh.
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html?scheduler=message`, {waitUntil: 'load'});
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000});
        await page.evaluate(source => window.AzaharAIPlayer.download({sourceUrl: source}), MIRROR_PATH);
        await page.select('#ai-expert', summary.expert);
        const loaded = await page.evaluate(backend => window.AzaharAIPlayer.load(backend), option('--backend'));
        summary.backend = loaded.backend;
        await bootGame(page, rom, state);
        await sleep(1000);
        summary.runs = [];
        for (const mode of ['lockstep', 'fast']) {
            const result = await run(page, state, mode, decisions);
            summary.runs.push(result);
            console.log(`${mode}: ${result.decisions} decisions in ${result.wallSeconds} s (${result.decisionsPerSecond}/s, ` +
                `model ${result.modelMs} ms the last); ${result.gameSeconds} s of game time, ${result.gamePace}x real time; ` +
                `${result.skipped} of ${result.actions} actions skipped`);
        }
        const lockstep = summary.runs[0];
        summary.ok = lockstep.skipped === 0 && errors.length === 0;
        console.log(`${summary.ok ? 'PASS' : 'FAIL'} in lockstep every action had its frame (${lockstep.skipped} skipped)` +
            (errors.length ? `; page errors: ${errors.slice(0, 2).join(' | ')}` : ''));
        const out = path.join(ROOT, 'tmp_test', 'ai_lockstep');
        fs.mkdirSync(out, {recursive: true});
        fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(summary, null, 1));
        if (!summary.ok) process.exitCode = 1;
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch(error => {
    console.error(`ai_lockstep_bench failed: ${error.message}`);
    process.exitCode = 1;
});
