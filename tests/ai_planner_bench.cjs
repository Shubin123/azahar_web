'use strict';
// The AI player's planner (System 2, web/azahar_ai_planner_worker.js) in headless Chrome on
// WebGPU: for each candidate model (--models), how long it takes to load and to answer, and
// what it makes of both screens. On --per-scene frames of each scene in --frames
// (tests/ai_frames.cjs --screens: screens_NNNN.png) it is asked to read the screens and to
// plan (the page's own prompt and parsing). Every answer is written to
// tmp_test/ai_planner_bench/<model>.json for review, with the timings and how many plans
// parsed.
//
//   node tests/ai_planner_bench.cjs [--models qwen3.5-0.8b,lfm2.5-vl-450m]
//        [--frames tmp_test/ai_planner_frames] [--per-scene 4] [--notes "..."] [--scenes REGEX]
//
// Scenes are the subfolders of --frames; Pokémon scenes are left out (the planner is not
// judged on Pokémon) unless --scenes picks them.
//
// The models come from huggingface.co and Transformers.js from cdn.jsdelivr.net; the
// browser profile (and so its model cache) is kept in tmp_test/ai_planner_bench/profile.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const cfg = require('./config.cjs');
const common = require('./ai_common.cjs');

const ROOT = path.resolve(__dirname, '..');
const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
};

const READ = 'Read both screens. What does the top screen show, and what does the bottom screen show? ' +
    'Quote any text you can read and list any menu options or on-screen buttons.';

function scenes(directory, perScene, pattern) {
    const picked = [];
    for (const scene of fs.readdirSync(directory).sort()) {
        if (pattern ? !pattern.test(scene) : /pokemon/i.test(scene)) continue;
        const folder = path.join(directory, scene);
        if (!fs.statSync(folder).isDirectory()) continue;
        const files = fs.readdirSync(folder).filter(name => /^screens_\d+\.png$/.test(name)).sort();
        const step = Math.max(1, Math.floor(files.length / perScene));
        for (const name of files.filter((_, i) => i % step === 0).slice(0, perScene)) {
            picked.push({scene, name, file: path.join(folder, name)});
        }
    }
    return picked;
}

async function main() {
    const models = option('--models', 'qwen3.5-0.8b,lfm2.5-vl-450m').split(',');
    const frames = scenes(path.resolve(option('--frames', path.join(ROOT, 'tmp_test', 'ai_planner_frames'))),
        Number(option('--per-scene', 4)), option('--scenes') ? new RegExp(option('--scenes'), 'i') : null);
    if (!frames.length) throw new Error('No screens_*.png frames (tests/ai_frames.cjs --screens)');
    const out = path.join(ROOT, 'tmp_test', 'ai_planner_bench');
    fs.mkdirSync(out, {recursive: true});
    const server = await common.startServer({});
    const browser = await puppeteer.launch({executablePath: cfg.chromePath, headless: cfg.headless,
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...cfg.chromeArgs], protocolTimeout: 3600000,
        userDataDir: path.join(out, 'profile'), defaultViewport: {width: 1280, height: 1100}});
    try {
        const page = await browser.newPage();
        page.on('pageerror', error => console.log(`page error: ${error}`));
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, {waitUntil: 'load'});
        await page.evaluate(() => {
            const worker = new Worker('azahar_ai_planner_worker.js', {type: 'module'});
            let id = 0;
            const pending = new Map();
            worker.onmessage = ({data}) => {
                if (data.type === 'progress') {
                    window.__plannerProgress = data;
                    return;
                }
                const request = pending.get(data.id);
                pending.delete(data.id);
                if (data.ok) request.resolve(data.result);
                else request.reject(new Error(data.error));
            };
            window.__planner = (type, payload = {}) => new Promise((resolve, reject) => {
                pending.set(++id, {resolve, reject});
                worker.postMessage({id, type, ...payload});
            });
        });
        for (const name of models) {
            console.log(`== ${name}`);
            const loaded = await page.evaluate(name => window.__planner('load', {name}), name);
            console.log(`  loaded ${loaded.repo}@${loaded.revision.slice(0, 7)} in ${loaded.loadSeconds.toFixed(1)} s`);
            const results = [];
            let previous = null;
            for (const frame of frames) {
                const png = fs.readFileSync(frame.file).toString('base64');
                const answer = await page.evaluate(async (png, read, notes, previous) => {
                    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
                    const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
                    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                    const context = canvas.getContext('2d');
                    context.drawImage(bitmap, 0, 0);
                    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
                    const screens = {data: image.data, width: image.width, height: image.height};
                    return {
                        read: await window.__planner('ask', {screens, question: read}),
                        plan: await window.__planner('plan', {screens, notes, previous}),
                    };
                }, png, READ, option('--notes', ''), previous);
                previous = answer.plan.plan;
                results.push({...frame, file: path.relative(ROOT, frame.file), ...answer});
                console.log(`  ${frame.scene}/${frame.name}: read ${Math.round(answer.read.ms)} ms ` +
                    `(${answer.read.newTokens} tokens), plan ${Math.round(answer.plan.ms)} ms ` +
                    `${answer.plan.plan ? JSON.stringify(answer.plan.plan) : `UNPARSED ${JSON.stringify(answer.plan.text)}`}`);
            }
            const plans = results.map(result => result.plan);
            const summary = {
                model: name, repo: loaded.repo, revision: loaded.revision, loadSeconds: loaded.loadSeconds,
                frames: results.length, parsed: plans.filter(plan => plan.plan).length,
                planMs: common.median(plans.map(plan => plan.ms)),
                readMs: common.median(results.map(result => result.read.ms)),
                tokensPerSecond: common.median(results.map(result => result.read.newTokens / (result.read.ms / 1000))),
            };
            console.log(`  ${name}: ${summary.parsed}/${summary.frames} plans parsed, plan median ${Math.round(summary.planMs)} ms, ` +
                `read median ${Math.round(summary.readMs)} ms (~${summary.tokensPerSecond.toFixed(1)} tokens/s incl. the image)`);
            fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({summary, results}, null, 1));
        }
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch(error => {
    console.error(`ai_planner_bench failed: ${error.message}`);
    process.exitCode = 1;
});
