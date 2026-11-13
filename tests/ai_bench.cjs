'use strict';
// How fast the AI player's model decides in the browser, and whether it still decides like
// the float32 model: a speed-up only counts if the fidelity checks still pass.
//
// The model (--model, a folder nitrogen_onnx.py built: the page's own by default) is
// converted from --ckpt (a local copy of NVIDIA's ng.pt) into a worker's memory, as the page
// does, and makes --decisions decisions on saved emulator framebuffers (--frames, from
// tests/ai_frames.cjs). Each decision is timed: the encoder (the image), the denoiser (the 18
// actions) and the whole. With --rom the game runs meanwhile, as when the AI plays. Then the
// model and the float32 graphs (--reference) decide on --fidelity-frames framebuffers with
// the same noise, and ai_common.cjs's CHECKS compare them.
//
// --distribution compares the model's action distribution with the float32 graphs' instead
// (for a model that samples differently, such as with fewer denoising steps, where the same
// noise need not give the same draw): on --distribution-frames framebuffers, --samples draws
// each from independent seeds, and ai_common.cjs's distributionChecks compare them.
//
//   node tests/ai_bench.cjs --ckpt ng.pt [--model web/vendor/nitrogen/q8]
//        [--reference tmp_test/ai_reference/f32] [--frames tmp_test/ai_frames/valid]
//        [--decisions 60] [--fidelity-frames 32] [--rom ROM [--state STATE.cst]]
//        [--min-per-second N] [--backend wasm] [--no-fidelity]
//        [--distribution [--distribution-frames 32] [--samples 12]] [--expert gate|light|heavy]
//
// With a light expert in the model's manifest, --expert picks the encoder: gate (the
// mixture, as the page runs it), light or heavy (NitroGen's own) alone.
//
// Results are printed and written to tmp_test/ai_bench/latest.json.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const cfg = require('./config.cjs');
const {restoreState} = require('./fixture_state.cjs');
const common = require('./ai_common.cjs');

const ROOT = path.resolve(__dirname, '..');
const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = name => process.argv.includes(name);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function bootGame(page, rom, state) {
    await (await page.$('#rom-file')).uploadFile(path.resolve(rom));
    await page.waitForFunction(() => !document.querySelector('#btn-load').disabled, {timeout: 60000});
    await page.click('#btn-load');
    await page.waitForFunction(() => window.AzaharUI?.isPlaying?.(), {timeout: 180000});
    if (state) await restoreState(page, state);
    else await sleep(20000);
}

const percentile = (list, p) => [...list].sort((x, y) => x - y)[Math.min(list.length - 1, Math.floor(list.length * p))];

async function main() {
    const ckpt = option('--ckpt');
    if (!ckpt) throw new Error('--ckpt (a local copy of ng.pt) is required');
    const modelDir = path.resolve(option('--model', path.join(cfg.webDir, 'vendor', 'nitrogen', 'q8')));
    const referenceDir = path.resolve(option('--reference', path.join(ROOT, 'tmp_test', 'ai_reference', 'f32')));
    const framesDir = option('--frames', path.join(ROOT, 'tmp_test', 'ai_frames', 'valid'));
    const decisions = Number(option('--decisions', 60));
    const server = await common.startServer({'/__bench/ng.pt': ckpt, '/__bench/model/': modelDir,
        '/__bench/reference/': referenceDir});
    const browser = await puppeteer.launch({executablePath: cfg.chromePath, headless: cfg.headless,
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...cfg.chromeArgs], protocolTimeout: 1800000,
        defaultViewport: {width: 1280, height: 1100}});
    const summary = {model: path.relative(ROOT, modelDir), game: option('--rom') ? path.basename(option('--rom')) : null};
    let ok = true;
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, {waitUntil: 'load'});
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000});
        await common.installNoise(page);
        const frames = await common.framesFromDisk(page, framesDir);
        if (!frames.length) throw new Error(`No input_*.png framebuffers in ${framesDir}`);
        if (option('--rom')) await bootGame(page, option('--rom'), option('--state'));

        const started = Date.now();
        const model = await common.startModelWorker(page, 'model', '/__bench/model/', '/__bench/ng.pt', option('--backend'),
            option('--expert'));
        summary.backend = model.loaded.backend;
        summary.routing = model.loaded.routing;
        summary.prepareSeconds = (Date.now() - started) / 1000;
        const manifest = JSON.parse(fs.readFileSync(path.join(modelDir, 'manifest.json')));
        summary.weightsMB = Math.round((Object.values(manifest.graphs).reduce((sum, graph) => sum + graph.weightsSize, 0) +
            (manifest.light ? manifest.light.weightsSize : 0)) / 1e6);

        // Speed.
        const times = {encodeMs: [], denoiseMs: [], totalMs: []};
        let light = 0;
        const gates = [];
        for (let i = 0; i < decisions + 3; i++) {
            const frame = frames[i % frames.length];
            const timing = await page.evaluate(async (rgb, seed) => {
                const started = performance.now();
                const out = await window.__models.model('act', {pixels: Uint8Array.from(rgb), noise: window.__noise(seed),
                    profile: true});
                return {encodeMs: out.encodeMs, denoiseMs: out.denoiseMs, totalMs: performance.now() - started,
                    expert: out.expert, gate: out.gate, verify: out.verify};
            }, frame.rgb, i);
            if (i < 3) continue;   // warm-up
            if (timing.expert === 'light') light++;
            if (timing.gate !== null && timing.gate !== undefined) gates.push(timing.gate);
            if (timing.verify) summary.verify = timing.verify;
            for (const key of Object.keys(times)) times[key].push(timing[key]);
        }
        for (const [key, list] of Object.entries(times)) {
            summary[key] = {median: +common.median(list).toFixed(1), p90: +percentile(list, 0.9).toFixed(1)};
        }
        summary.decisionsPerSecond = +(1000 / summary.totalMs.median).toFixed(2);
        summary.lightShare = +(light / decisions).toFixed(3);
        // The gate's predicted error per frame (log), against the manifest's threshold.
        if (gates.length) summary.gate = {median: +common.median(gates).toFixed(3), max: +Math.max(...gates).toFixed(3)};
        console.log(`${summary.model} on ${summary.backend}${summary.game ? ` with ${summary.game} running` : ''}: ` +
            `${summary.decisionsPerSecond} decisions/s — median ${summary.totalMs.median} ms ` +
            `(encoder ${summary.encodeMs.median}, denoiser ${summary.denoiseMs.median}), p90 ${summary.totalMs.p90} ms` +
            (model.loaded.light ? `; ${summary.routing}: light expert alone on ${Math.round(100 * summary.lightShare)}% ` +
                `of decisions` + (summary.gate ? ` (gate median ${summary.gate.median}, max ${summary.gate.max})` : '') +
                (summary.verify?.checks ? `; its check against NitroGen: ${summary.verify.heavy ? 'acts unlike it, NitroGen decides'
                    : 'acts alike'} (${summary.verify.disagreement.toFixed(4)} over ${summary.verify.checks} checks)` : '') : ''));
        const minimum = Number(option('--min-per-second', 0));
        if (minimum) {
            const fast = summary.decisionsPerSecond >= minimum;
            ok = ok && fast;
            console.log(`${fast ? 'PASS' : 'FAIL'} at least ${minimum} decisions per second`);
        }

        // Fidelity.
        if (!flag('--no-fidelity')) {
            await common.startModelWorker(page, 'reference', '/__bench/reference/', '/__bench/ng.pt', option('--backend'));
            const subset = await common.framesFromDisk(page, framesDir, Number(option('--fidelity-frames', 32)));
            const {runs} = await common.decide(page, subset, ['model', 'reference'], [0, 1], 1000);
            const fidelity = await common.compareRuns(page, runs.reference, runs.model);
            const seed = await common.compareRuns(page, runs.reference, runs.otherSeed);
            summary.fidelity = {frames: subset.length, ...fidelity, otherSeed: seed};
            for (const [name, pass, value] of common.quantizedChecks(fidelity, seed)) {
                ok = ok && pass;
                console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${value}`);
            }
        }
        if (flag('--distribution')) {
            if (!(await page.evaluate(() => Boolean(window.__models.reference)))) {
                await common.startModelWorker(page, 'reference', '/__bench/reference/', '/__bench/ng.pt', option('--backend'));
            }
            const subset = await common.framesFromDisk(page, framesDir, Number(option('--distribution-frames', 32)));
            const result = await common.distributionChecks(page, subset, 'model', Number(option('--samples', 12)));
            summary.distribution = {frames: subset.length, ...result, checks: undefined};
            for (const [name, pass] of result.checks) {
                ok = ok && pass;
                console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
            }
        }
        if (errors.length) {
            ok = false;
            console.log(`FAIL page errors: ${errors.slice(0, 3).join(' | ')}`);
        }
    } finally {
        await browser.close();
        server.close();
    }
    summary.pass = ok;
    const out = path.join(ROOT, 'tmp_test', 'ai_bench');
    fs.mkdirSync(out, {recursive: true});
    fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(summary, null, 1));
    if (!ok) process.exitCode = 1;
}

main().catch(error => {
    console.error(`ai_bench failed: ${error.stack || error.message}`);
    process.exitCode = 1;
});
