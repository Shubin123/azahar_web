'use strict';
// Measures gameplay smoothness from a saved state: emulation speed, display
// callbacks per second, and hitches (callbacks that block the page for long).
//
//   node tests/perf_probe.cjs --rom ROM --state STATE.cst [--seconds 20]
//        [--warmup 5] [--query "hwShader=1"] [--uncapped | --vsync-hz 144] [--gpu]
//        [--label NAME] [--output FILE.jsonl]
//
// --uncapped removes Chrome's vsync cap. --vsync-hz N instead starts every
// callback on the next N Hz refresh, like a real high-refresh display: a
// callback that overruns a refresh waits for the following one.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config.cjs');
const { createWebServer } = require('../web/server.cjs');
const { restoreState } = require('./fixture_state.cjs');

const rom = path.resolve(cfg.argVal('--rom', ''));
const stateArg = cfg.argVal('--state', '');
const state = stateArg ? path.resolve(stateArg) : null; // none: measure from a cold boot
const seconds = Number(cfg.argVal('--seconds', '20'));
const warmup = Number(cfg.argVal('--warmup', '5'));
const query = cfg.argVal('--query', '');
const label = cfg.argVal('--label', state ? path.basename(state) : 'cold-boot');
const uncapped = process.argv.includes('--uncapped');
const vsyncHz = Number(cfg.argVal('--vsync-hz', '0'));
const gpu = process.argv.includes('--gpu') || process.env.AZAHAR_FIXTURE_GPU === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const web = createWebServer(process.env.AZAHAR_WEB_DIR || cfg.webDir);
    await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: cfg.chromePath, headless: true,
        defaultViewport: { width: 1100, height: 1400 }, protocolTimeout: 180000,
        args: ['--no-sandbox',
            ...(gpu ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] : []),
            ...(uncapped || vsyncHz > 0 ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])] });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`http://127.0.0.1:${web.address().port}/?speed=1${query ? `&${query}` : ''}`,
            { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Emulator ready'),
            { timeout: 120000 });
        await (await page.$('#rom-file')).uploadFile(rom);
        await page.waitForFunction(() => !document.querySelector('#btn-load').disabled);
        await page.click('#btn-load');
        await page.waitForFunction(() => !document.querySelector('#btn-stop').disabled, { timeout: 180000 });
        if (state) {
            await restoreState(page, state);
            await sleep(warmup * 1000);
        }
        await page.evaluate(vsyncHz => {
            const probe = window.__perfProbe = { durations: [], speeds: [], fps: [], start: performance.now() };
            const request = AzaharScheduler.request.bind(AzaharScheduler);
            const measured = callback => now => {
                const began = performance.now();
                callback(now);
                probe.durations.push(performance.now() - began);
            };
            if (vsyncHz > 0) {
                // Chrome runs uncapped here; skip animation frames until the next refresh
                // boundary, so presentation still follows each callback as it would.
                const period = 1000 / vsyncHz;
                const origin = performance.now();
                AzaharScheduler.request = callback => {
                    const run = measured(callback);
                    const at = origin + (Math.floor((performance.now() - origin) / period) + 1) * period;
                    const poll = () => {
                        const now = performance.now();
                        if (now < at) return request(poll);
                        run(origin + Math.floor((now - origin) / period) * period);
                    };
                    return request(poll);
                };
            } else {
                AzaharScheduler.request = callback => request(measured(callback));
            }
            const module = window.AzaharUI.getModule();
            probe.timer = setInterval(() => {
                const buffer = module._malloc(64);
                if (module._azahar_get_perf_stats(buffer, 8) === 0) {
                    const stats = new Float64Array(module.HEAPU8.buffer, buffer, 8);
                    probe.fps.push(stats[0]);
                    probe.speeds.push(stats[2] * 100);
                }
                module._free(buffer);
            }, 500);
        }, vsyncHz);
        const profilePath = cfg.argVal('--profile', null);
        let session = null;
        if (profilePath) {
            session = await page.target().createCDPSession();
            await session.send('Profiler.enable');
            await session.send('Profiler.setSamplingInterval', { interval: 200 });
            await session.send('Profiler.start');
        }
        const tracePath = cfg.argVal('--trace', null);
        if (tracePath) {
            await page.tracing.start({ path: tracePath, categories: ['devtools.timeline', 'blink', 'gpu',
                'cc', 'viz', 'toplevel', 'disabled-by-default-devtools.timeline', 'v8.execute'] });
        }
        await sleep(seconds * 1000);
        if (tracePath) await page.tracing.stop();
        if (session) {
            const { profile } = await session.send('Profiler.stop');
            fs.writeFileSync(profilePath, JSON.stringify(profile));
            const self = new Map();
            const byId = new Map(profile.nodes.map(node => [node.id, node]));
            const dt = profile.timeDeltas;
            profile.samples.forEach((id, index) => {
                const frame = byId.get(id).callFrame;
                const key = `${frame.functionName || '(anon)'} ${frame.url.split('/').pop()}`;
                self.set(key, (self.get(key) || 0) + (dt[index] || 0));
            });
            const total = [...self.values()].reduce((a, b) => a + b, 0);
            console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 25)
                .map(([key, us]) => `${(100 * us / total).toFixed(1).padStart(5)}% ${key}`).join('\n'));
        }
        const shotPath = cfg.argVal('--shot', null);
        if (shotPath) await (await page.$('#canvas')).screenshot({ path: shotPath });
        const grepLog = cfg.argVal('--grep-log', null);
        if (grepLog) {
            const lines = await page.evaluate(pattern => window.AzaharUI.getLog?.()
                .split('\n').filter(line => line.includes(pattern)).slice(-40), grepLog);
            console.log((lines || []).join('\n'));
        }
        const result = await page.evaluate(() => {
            const probe = window.__perfProbe;
            clearInterval(probe.timer);
            const elapsed = (performance.now() - probe.start) / 1000;
            const sorted = [...probe.durations].sort((a, b) => a - b);
            const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] || 0;
            const mean = list => list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
            return {
                callbacksPerSecond: probe.durations.length / elapsed,
                callbackMs: { mean: mean(probe.durations), p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) || 0 },
                hitches50ms: probe.durations.filter(d => d > 50).length,
                hitches100ms: probe.durations.filter(d => d > 100).length,
                speedPercent: mean(probe.speeds),
                gameFps: mean(probe.fps),
                frameBudget: window.AzaharUI.getFrameBudget?.(),
                adapter: (() => {
                    const gl = document.querySelector('#canvas').getContext('webgl2');
                    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
                    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'software';
                })(),
            };
        });
        const round = value => typeof value === 'number' ? Number(value.toFixed(1)) : value;
        const output = { label, query, uncapped, vsyncHz, gpu, ...result,
            callbackMs: Object.fromEntries(Object.entries(result.callbackMs).map(([k, v]) => [k, round(v)])),
            callbacksPerSecond: round(result.callbacksPerSecond), speedPercent: round(result.speedPercent),
            gameFps: round(result.gameFps), errors };
        console.log(JSON.stringify(output));
        const out = cfg.argVal('--output', null);
        if (out) fs.appendFileSync(out, `${JSON.stringify(output)}\n`);
    } finally {
        await browser.close();
        web.close();
    }
}
main().catch(error => { console.error(error); process.exit(1); });
