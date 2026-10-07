'use strict';
// Measures what Local Play clock pacing costs two linked consoles that both run a
// title from a saved state. Two pages in one browser link through a same-browser
// room, so the only difference between runs is pacing and the simulated network.
//
//   node tests/netplay_perf.cjs --rom ROM --state STATE.cst [--state-b STATE.cst]
//        [--seconds 30] [--query "pacing=0"] [--netsim "delay=40,jitter=30"]
//        [--stall-b] [--gpu] [--label NAME] [--output FILE.jsonl]
//
// Prints each console's emulation speed and how long pacing slowed or held it.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config.cjs');
const { createWebServer } = require('../web/server.cjs');
const { restoreState } = require('./fixture_state.cjs');

const rom = path.resolve(cfg.argVal('--rom', ''));
const stateA = path.resolve(cfg.argVal('--state', ''));
const stateB = path.resolve(cfg.argVal('--state-b', stateA));
const seconds = Number(cfg.argVal('--seconds', '30'));
const warmup = Number(cfg.argVal('--warmup', '5'));
const query = cfg.argVal('--query', '');
const netsim = cfg.argVal('--netsim', '');
const label = cfg.argVal('--label', `${path.basename(stateA)} ${query} ${netsim}`.trim());
const gpu = process.argv.includes('--gpu') || process.env.AZAHAR_FIXTURE_GPU === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function openConsole(browser, port, room, nick, state) {
    // A separate window per console: headless Chrome gives a background tab no animation
    // frames, so it would not run at all.
    const session = await browser.target().createCDPSession();
    const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const target = await browser.waitForTarget(candidate => candidate._targetId === targetId ||
        candidate._getTargetInfo?.().targetId === targetId);
    const page = await target.page();
    await page.setViewport({ width: 1100, height: 1400 });
    page.errors = [];
    page.on('pageerror', error => page.errors.push(String(error)));
    const extra = [query, netsim && `netsim=${encodeURIComponent(netsim)}`].filter(Boolean).join('&');
    await page.goto(`http://127.0.0.1:${port}/?speed=1&link=tabs:${room}&nick=${nick}${extra ? `&${extra}` : ''}`,
        { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Emulator ready'),
        { timeout: 120000 });
    await (await page.$('#rom-file')).uploadFile(rom);
    await page.waitForFunction(() => !document.querySelector('#btn-load').disabled);
    await page.click('#btn-load');
    await page.waitForFunction(() => !document.querySelector('#btn-stop').disabled, { timeout: 180000 });
    await restoreState(page, state);
    return page;
}

function startSampling(page) {
    return page.evaluate(() => {
        const module = window.AzaharUI.getModule();
        const netplay = window.AzaharNetplay;
        const probe = window.__netProbe = { speeds: [], scales: [], leads: [], lates: [], start: performance.now(),
            pacing: { ...netplay.pacingStats }, callbacks: 0 };
        const request = AzaharScheduler.request.bind(AzaharScheduler);
        AzaharScheduler.request = callback => request(now => { probe.callbacks++; callback(now); });
        probe.timer = setInterval(() => {
            const buffer = module._malloc(64);
            if (module._azahar_get_perf_stats(buffer, 8) === 0) {
                probe.speeds.push(new Float64Array(module.HEAPU8.buffer, buffer, 8)[2] * 100);
            }
            module._free(buffer);
            probe.scales.push(netplay.speedPermille / 10);
            const peer = [...netplay.peers.values()][0];
            if (peer?.smoothedLead != null) probe.leads.push(Math.round(peer.smoothedLead / 1000));
            if (peer?.clock) probe.lates.push(Math.round(peer.clock.late || 0));
        }, 250);
    });
}

function finishSampling(page) {
    return page.evaluate(() => {
        const probe = window.__netProbe;
        clearInterval(probe.timer);
        const netplay = window.AzaharNetplay;
        const elapsed = (performance.now() - probe.start) / 1000;
        const mean = list => list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
        const after = netplay.pacingStats;
        const state = netplay.status();
        return {
            speedPercent: Number(mean(probe.speeds).toFixed(1)),
            minSpeedPercent: Number(Math.min(...probe.speeds).toFixed(1)),
            pacedScalePercent: Number(mean(probe.scales).toFixed(1)),
            throttledShare: Number(((after.throttledMs - probe.pacing.throttledMs) / (elapsed * 1000)).toFixed(3)),
            holds: after.holds - probe.pacing.holds,
            heldMs: Math.round(after.heldMs - probe.pacing.heldMs),
            rebases: after.gaveUp - probe.pacing.gaveUp,
            callbacksPerSecond: Number((probe.callbacks / elapsed).toFixed(1)),
            leadMs: probe.leads.length ? { mean: Math.round(mean(probe.leads)), min: Math.min(...probe.leads),
                max: Math.max(...probe.leads) } : null,
            lateMs: probe.lates.length ? { mean: Math.round(mean(probe.lates)), max: Math.max(...probe.lates) } : null,
            linked: state.peers.filter(peer => peer.open).length,
            joined: state.joined,
        };
    });
}

async function main() {
    const web = createWebServer(process.env.AZAHAR_WEB_DIR || cfg.webDir);
    await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: cfg.chromePath, headless: true,
        defaultViewport: { width: 1100, height: 1400 }, protocolTimeout: 180000,
        // Two consoles share one browser; keep the background page running at full rate.
        args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
            ...(gpu ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] : [])] });
    try {
        const port = web.address().port;
        const room = `perf${Date.now()}`;
        const pages = [await openConsole(browser, port, room, 'PerfA', stateA),
            await openConsole(browser, port, room, 'PerfB', stateB)];
        await Promise.all(pages.map(page => page.waitForFunction(
            () => window.AzaharNetplay.status().joined && window.AzaharNetplay.status().peers.some(peer => peer.open),
            { timeout: 60000 })));
        await sleep(warmup * 1000);
        // --stall-b stops the second console (a peer on a long load or a background tab):
        // the first must keep running at full speed.
        if (process.argv.includes('--stall-b')) await pages[1].click('#btn-stop');
        // --slow-b 0.8 runs the second console at 80% (a slower device): the first should
        // follow it, keeping their game clocks within the pacing tolerance.
        const slow = Number(cfg.argVal('--slow-b', '0'));
        if (slow) await pages[1].evaluate(permille => window.AzaharUI.getModule()._azahar_set_speed_scale(permille),
            Math.round(slow * 1000));
        await Promise.all(pages.map(startSampling));
        await sleep(seconds * 1000);
        const results = await Promise.all(pages.map(finishSampling));
        const output = { label, query, netsim, gpu, consoles: results,
            errors: pages.flatMap(page => page.errors) };
        console.log(JSON.stringify(output));
        const out = cfg.argVal('--output', null);
        if (out) fs.appendFileSync(out, `${JSON.stringify(output)}\n`);
    } finally {
        await browser.close();
        web.close();
    }
}
main().catch(error => { console.error(error); process.exit(1); });
