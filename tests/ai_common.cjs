'use strict';
// Shared by the AI player's browser test (ai_player.test.cjs) and benchmark (ai_bench.cjs):
// a server for the page plus local model files, saved framebuffers, seeded noise, model
// workers that keep their weights in memory, and the comparison with the float32 model.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {createWebServer} = require('../web/server.cjs');
const cfg = require('./config.cjs');

// The quantized model passes when, against the float32 model on the same frame and noise, it
// holds the same 3DS keys for at least 90% of actions, and changes the keys and sticks
// less than half as much as the float32 model's own sampling does between two noise seeds
// (or by at most 1 point and 0.01, where the model hardly varies between seeds).
const CHECKS = {keysMin: 0.90, vsSeedFactor: 0.5, keysFloor: 0.01, stickFloor: 0.01};

// The page's server, with extra files: `routes` maps a path prefix to a local file (exact
// path) or folder (prefix ending in /). Every path asked for is noted in `served`.
function startServer(routes, served = []) {
    const web = createWebServer(cfg.webDir);
    const handle = web.listeners('request')[0];
    const server = http.createServer((request, response) => {
        served.push(request.url);
        const pathname = request.url.split('?')[0];
        let file = null;
        for (const [prefix, target] of Object.entries(routes)) {
            if (!target) continue;
            if (prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix) {
                file = prefix.endsWith('/') ? path.join(target, path.basename(pathname)) : target;
                break;
            }
        }
        if (file) {
            if (!fs.existsSync(file)) {
                response.writeHead(404).end();
                return;
            }
            response.writeHead(200, {'Content-Type': 'application/octet-stream',
                'Content-Length': fs.statSync(file).size, 'Cross-Origin-Resource-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store'});
            fs.createReadStream(file).pipe(response);
            return;
        }
        handle(request, response);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// tests/ai_frames.cjs's input_*.png under `directory`, as {scene, name, rgb}.
async function framesFromDisk(page, directory, limit = Infinity) {
    const files = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/^input_\d+\.png$/.test(entry.name)) files.push(full);
        }
    };
    walk(directory);
    // Spread a limited set over every scene.
    const step = Math.max(1, Math.floor(files.length / Math.min(limit, files.length)));
    const picked = files.filter((_, i) => i % step === 0).slice(0, limit);
    const frames = [];
    for (const file of picked) {
        const base64 = fs.readFileSync(file).toString('base64');
        const rgb = await page.evaluate(async data => {
            const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
            const bitmap = await createImageBitmap(blob, {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
            const canvas = new OffscreenCanvas(256, 256);
            const context = canvas.getContext('2d');
            context.drawImage(bitmap, 0, 0);
            const rgba = context.getImageData(0, 0, 256, 256).data;
            const out = new Array(256 * 256 * 3);
            for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
                out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2];
            }
            return out;
        }, base64);
        const relative = path.relative(directory, file);
        frames.push({scene: relative.split(path.sep)[0], name: relative, rgb});
    }
    return frames;
}

// Installs window.__noise(seed): seeded Gaussian noise for a decision's 18 x 25 actions,
// the same for every model.
function installNoise(page) {
    return page.evaluate(() => {
        window.__noise = seed => {
            let a = (seed * 2654435761) >>> 0 || 1;
            const uniform = () => {
                a = (a + 0x6D2B79F5) >>> 0;
                let t = Math.imul(a ^ (a >>> 15), 1 | a);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            const out = new Float32Array(450);
            for (let i = 0; i < 450; i += 2) {
                const radius = Math.sqrt(-2 * Math.log(1 - uniform())), angle = 2 * Math.PI * uniform();
                out[i] = radius * Math.cos(angle);
                out[i + 1] = radius * Math.sin(angle);
            }
            return out;
        };
    });
}

// An AI worker in the page named `name` (window.__models[name](type, payload)) for the
// model at `modelPath`, converted from `sourcePath` into its memory only. `expert`: with a
// light expert, which encoder decides ('gate', the default: the mixture; 'light'; 'heavy').
function startModelWorker(page, name, modelPath, sourcePath, preferred, expert) {
    return page.evaluate(async (name, modelUrl, sourceUrl, preferred, expert) => {
        const worker = new Worker('azahar_ai_worker.js', {type: 'module'});
        let id = 0;
        const pending = new Map();
        worker.onmessage = ({data}) => {
            const request = pending.get(data.id);
            if (!request) return;
            pending.delete(data.id);
            if (data.ok) request.resolve(data.result);
            else request.reject(new Error(data.error));
        };
        window.__models = window.__models || {};
        window.__workers = window.__workers || {};
        window.__models[name] = (type, payload = {}) => new Promise((resolve, reject) => {
            pending.set(++id, {resolve, reject});
            worker.postMessage({id, type, modelUrl, ...payload});
        });
        window.__workers[name] = worker;
        const meta = await window.__models[name]('prepare', {sourceUrl, store: false});
        const loaded = await window.__models[name]('load', {preferred, expert});
        return {meta, loaded};
    }, name, new URL(modelPath, page.url()).href, sourcePath, preferred || null, expert || null);
}

// Same 3DS keys (with the page's own key mapping), stick error and largest raw difference
// between two lists of decisions (18 actions of 25 values each).
function compareRuns(page, a, b) {
    return page.evaluate((a, b) => {
        const keysEqual = (x, y) => x.length === y.length && x.every(code => y.includes(code));
        let sameKeys = 0, steps = 0, stickError = 0, sticks = 0, maxAbs = 0;
        for (let run = 0; run < a.length; run++) {
            for (let step = 0; step < 18; step++) {
                steps++;
                if (keysEqual(window.AzaharAIPlayer.keysFor(a[run], step), window.AzaharAIPlayer.keysFor(b[run], step))) sameKeys++;
                for (let i = 21; i < 25; i++) {
                    const clip = v => Math.max(-1, Math.min(1, v * 2 - 1));
                    stickError += Math.abs(clip(a[run][step * 25 + i]) - clip(b[run][step * 25 + i]));
                    sticks++;
                }
            }
            for (let i = 0; i < 450; i++) maxAbs = Math.max(maxAbs, Math.abs(a[run][i] - b[run][i]));
        }
        return {keys: sameKeys / steps, stickMAE: stickError / sticks, rawMaxAbs: maxAbs};
    }, a, b);
}

// CHECKS for the quantized model's metrics against the float32 model, given the float32
// model's own metrics between two seeds: [name, ok, value] each.
function quantizedChecks(metrics, seed) {
    const seedKeys = Math.max(CHECKS.keysFloor, CHECKS.vsSeedFactor * (1 - seed.keys));
    const seedStick = Math.max(CHECKS.stickFloor, CHECKS.vsSeedFactor * seed.stickMAE);
    return [
        [`same 3DS keys as the float32 model >= ${CHECKS.keysMin}`, metrics.keys >= CHECKS.keysMin, metrics.keys.toFixed(4)],
        [`key disagreement <= ${seedKeys.toFixed(4)} (float32 between seeds: ${(1 - seed.keys).toFixed(4)})`,
            1 - metrics.keys <= seedKeys, (1 - metrics.keys).toFixed(4)],
        [`stick error <= ${seedStick.toFixed(4)} (float32 between seeds: ${seed.stickMAE.toFixed(4)})`,
            metrics.stickMAE <= seedStick, metrics.stickMAE.toFixed(4)],
    ];
}

// Decisions of `models` (names in window.__models; the player's own model is 'player') on
// every frame and seed, the reference also from another seed. Returns the runs per model.
async function decide(page, frames, models, seeds, otherSeed, onProgress) {
    const runs = Object.fromEntries([...models, 'otherSeed'].map(name => [name, []]));
    const timings = Object.fromEntries(models.map(name => [name, []]));
    const scenes = [];
    for (let index = 0; index < frames.length; index++) {
        const result = await page.evaluate(async (rgb, models, seeds, otherSeed) => {
            const pixels = Uint8Array.from(rgb);
            const call = (name, noise) => (name === 'player'
                ? window.AzaharAIPlayer.act(pixels.slice(), noise)
                : window.__models[name]('act', {pixels: pixels.slice(), noise}));
            const out = {runs: {otherSeed: []}, ms: {}};
            for (const seed of seeds) {
                for (const name of models) {
                    const decision = await call(name, window.__noise(seed));
                    (out.runs[name] = out.runs[name] || []).push([...decision.actions]);
                    (out.ms[name] = out.ms[name] || []).push(decision.encodeMs + decision.denoiseMs);
                }
                const other = await call(models[models.length - 1], window.__noise(seed + otherSeed));
                out.runs.otherSeed.push([...other.actions]);
            }
            return out;
        }, frames[index].rgb, models, seeds, otherSeed);
        for (const [name, list] of Object.entries(result.runs)) runs[name].push(...list);
        for (const [name, list] of Object.entries(result.ms)) timings[name].push(...list);
        scenes.push(...seeds.map(() => frames[index].scene));
        onProgress?.(index + 1);
    }
    return {runs, timings, scenes};
}

// The policy's action distribution, not single draws: NitroGen samples its actions from
// noise, so a model that samples differently (fewer denoising steps) is judged by how often
// it holds each 3DS key, and where it puts the sticks, at each of the 18 actions of each
// frame, over `count` noise draws, each frame's its own (seeds base + 1000 x frame + i).
// Returns per frame its draws (18 x 25 values each).
async function sampleDistribution(page, frames, model, base, count) {
    const samples = [];
    for (const [index, frame] of frames.entries()) {
        const seeds = Array.from({length: count}, (_, i) => base + 1000 * index + i);
        samples.push(await page.evaluate(async (rgb, model, seeds) => {
            const noises = seeds.map(seed => window.__noise(seed));
            const pixels = Uint8Array.from(rgb);
            // 'player': the page's own model.
            const out = model === 'player' ? await window.AzaharAIPlayer.act(pixels, null, noises)
                : await window.__models[model]('act', {pixels, noises});
            return seeds.map((_, i) => [...out.actions.subarray(i * 450, (i + 1) * 450)]);
        }, frame.rgb, model, seeds));
    }
    return samples;
}

// How two action distributions (per frame, lists of draws) differ: `keys`, the mean over
// frames and actions of the summed difference in each 3DS key's hold frequency, and
// `sticks`, of the mean stick positions' difference.
function distributionDistance(page, a, b) {
    return page.evaluate((a, b) => {
        const clip = v => Math.max(-1, Math.min(1, v * 2 - 1));
        let keys = 0, sticks = 0, cells = 0;
        for (let frame = 0; frame < a.length; frame++) {
            for (let step = 0; step < 18; step++) {
                const frequencies = draws => {
                    const counts = new Map();
                    const mean = [0, 0, 0, 0];
                    for (const draw of draws) {
                        for (const code of window.AzaharAIPlayer.keysFor(draw, step)) counts.set(code, (counts.get(code) || 0) + 1);
                        for (let i = 0; i < 4; i++) mean[i] += clip(draw[step * 25 + 21 + i]) / draws.length;
                    }
                    return {counts, mean, n: draws.length};
                };
                const fa = frequencies(a[frame]), fb = frequencies(b[frame]);
                for (const code of new Set([...fa.counts.keys(), ...fb.counts.keys()])) {
                    keys += Math.abs((fa.counts.get(code) || 0) / fa.n - (fb.counts.get(code) || 0) / fb.n);
                }
                for (let i = 0; i < 4; i++) sticks += Math.abs(fa.mean[i] - fb.mean[i]) / 4;
                cells++;
            }
        }
        return {keys: keys / cells, sticks: sticks / cells};
    }, a, b);
}

// How varied a distribution's draws are (per frame, lists of draws): over every pair of
// draws of a frame, how often they hold different 3DS keys at an action (`keys`), and how
// far apart their sticks are (`sticks`). A sampler that falls back on its average action
// is less varied, and can look close to the original by key frequencies alone.
function variety(page, draws) {
    return page.evaluate(draws => {
        const clip = v => Math.max(-1, Math.min(1, v * 2 - 1));
        let keys = 0, sticks = 0, pairs = 0;
        for (const frame of draws) {
            for (let step = 0; step < 18; step++) {
                const held = frame.map(draw => window.AzaharAIPlayer.keysFor(draw, step).sort().join());
                for (let i = 0; i < frame.length; i++) {
                    for (let j = i + 1; j < frame.length; j++) {
                        if (held[i] !== held[j]) keys++;
                        for (let axis = 21; axis < 25; axis++) {
                            sticks += Math.abs(clip(frame[i][step * 25 + axis]) - clip(frame[j][step * 25 + axis])) / 4;
                        }
                        pairs++;
                    }
                }
            }
        }
        return {keys: keys / pairs, sticks: sticks / pairs};
    }, draws);
}

// The policy check for a model that samples differently from the float32 graphs (fewer
// denoising steps, quantized weights): on `frames`, `count` draws each from the model and
// two independent sets from the float32 model ('reference'). The model passes when it is at
// most DISTRIBUTION.factor times as far from the float32 model's key and stick frequencies
// as the float32 model is from itself with other seeds, and its draws are as varied
// (DISTRIBUTION.variety times as often two draws of a frame hold different keys, and as far
// apart their sticks). Returns [name, ok, value] checks and the measurements.
const DISTRIBUTION = {factor: 1.25, variety: [0.8, 1.25]};

async function distributionChecks(page, frames, model, count) {
    const referenceA = await sampleDistribution(page, frames, 'reference', 1e6, count);
    const referenceB = await sampleDistribution(page, frames, 'reference', 2e6, count);
    const candidate = await sampleDistribution(page, frames, model, 3e6, count);
    const self = await distributionDistance(page, referenceA, referenceB);
    const distance = await distributionDistance(page, referenceA, candidate);
    const referenceVariety = await variety(page, referenceA.map((draws, i) => [...draws, ...referenceB[i]]));
    const modelVariety = await variety(page, candidate);
    const checks = [];
    for (const part of ['keys', 'sticks']) {
        const limit = DISTRIBUTION.factor * self[part];
        checks.push([`${part} distribution ${distance[part].toFixed(4)} from float32 <= ${DISTRIBUTION.factor} x ` +
            `${self[part].toFixed(4)} (float32 with other seeds)`, distance[part] <= limit, distance[part].toFixed(4)]);
    }
    for (const [part, name] of [['keys', 'key variety (draws holding different keys)'], ['sticks', 'stick variety']]) {
        const ratio = modelVariety[part] / referenceVariety[part];
        checks.push([`${name} ${ratio.toFixed(3)} x float32's, within ${DISTRIBUTION.variety.join('-')}`,
            ratio >= DISTRIBUTION.variety[0] && ratio <= DISTRIBUTION.variety[1],
            `${modelVariety[part].toFixed(4)} vs ${referenceVariety[part].toFixed(4)}`]);
    }
    return {checks, self, distance, variety: {reference: referenceVariety, model: modelVariety}};
}

const median = list => [...list].sort((x, y) => x - y)[list.length >> 1];

module.exports = {CHECKS, startServer, framesFromDisk, installNoise, startModelWorker, compareRuns,
    quantizedChecks, decide, sampleDistribution, distributionDistance, variety, distributionChecks, DISTRIBUTION, median};
