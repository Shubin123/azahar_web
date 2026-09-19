#!/usr/bin/env node
/**
 * Display-path throughput fallback (tests/renderer_autofallback.cjs)
 *
 * Drives the production UI exactly as a user does — real file input, real
 * Load & Run button, real run loop — and checks that Auto leaves an
 * accelerated backend that cannot deliver frames.
 *
 * A backend can be far slower than the software renderer without ever
 * failing: it stalls frame production instead of rejecting work. Emulation
 * advances once per browser frame, so that caps guest speed at the frame rate.
 * The existing fallbacks only cover a backend that produces *no* visible
 * frame, which this class of failure passes.
 *
 * The ROM is uploaded through the browser's own file picker (a real path on
 * disk) rather than a File built in the page: a 256 MB in-page copy competes
 * with the emulator heap and fails to read.
 *
 * Usage:
 *   node tests/renderer_autofallback.cjs [--rom PATH] [--timeout-seconds N]
 *
 * Environment:
 *   CHROME_PATH   Path to Chrome/Chromium
 *   AZAHAR_CHROME_ARGS  Extra Chrome arguments (e.g. --use-angle=swiftshader)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const { createWebServer } = require('../web/server.cjs');
const cfg = require('./config.cjs');

const romPath = cfg.argVal('--rom', cfg.romPath);
const timeoutSeconds = Number(cfg.argVal('--timeout-seconds', '240'));
const pinnedMode = cfg.argFlag('--pinned');
const expectFallback = !cfg.argFlag('--expect-none') && !pinnedMode;

if (!romPath || !fs.existsSync(romPath)) {
    console.error('No ROM found. Place one in test_games/ or pass --rom PATH.');
    process.exit(2);
}
if (!cfg.chromePath) {
    console.error('Chrome not found. Set CHROME_PATH.');
    process.exit(2);
}

function log(message) { console.log(`   ${message}`); }

async function main() {
    const server = createWebServer(path.join(cfg.ROOT, 'web'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Pinned mode asserts the opposite guarantee: an explicit choice in the
    // dropdown must survive even on a backend Auto would abandon, so the
    // Windows/D3D11 and Vulkan configurations keep behaving as before.
    const url = pinnedMode ? `${origin}/index.html?renderer=webgl2` : `${origin}/index.html`;
    console.log(`# Renderer auto-fallback test${pinnedMode ? ' (pinned WebGL2)' : ''}`);
    console.log(`# ROM: ${path.basename(romPath)}`);
    console.log(`# URL: ${url}${pinnedMode ? '' : ' (Auto — no renderer query)'}`);

    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.CHROME_PATH || cfg.chromePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage',
            ...(process.env.AZAHAR_CHROME_ARGS || '').split(/\s+/).filter(Boolean)],
        defaultViewport: { width: 1280, height: 900 },
        protocolTimeout: timeoutSeconds * 1000 + 60000,
    });

    let failure = null;
    try {
        const page = await browser.newPage();
        const fallbacks = [];
        page.on('framenavigated', frame => {
            if (frame === page.mainFrame()) fallbacks.push(frame.url());
        });
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        // The page must reach Auto's accelerated artifact before the test means
        // anything; a preflight fallback is a different code path.
        await page.waitForFunction(
            () => /Emulator initialized successfully/.test(
                document.querySelector('#log')?.textContent || ''),
            { timeout: 120000 });
        const startedOn = await page.evaluate(() => window.location.search || '(no query)');
        log(`emulator ready, query: ${startedOn}`);

        await (await page.$('#rom-file')).uploadFile(romPath);
        await page.waitForFunction(
            () => /ROM ready/.test(document.querySelector('#status')?.textContent || ''),
            { timeout: 180000 });
        log('ROM read through the browser file picker');

        await page.click('#btn-load');

        const deadline = Date.now() + timeoutSeconds * 1000;
        let switched = null;
        // The fallback replaces the document, so the reason has to be captured
        // from the live page before it navigates away.
        let reason = '(none)';
        let lastMeter = '';
        while (Date.now() < deadline) {
            const state = await page.evaluate(() => ({
                search: window.location.search,
                fps: document.querySelector('#fps')?.textContent || '',
                log: document.querySelector('#log')?.textContent || '',
            })).catch(() => null);
            if (!state) { await new Promise(r => setTimeout(r, 250)); continue; }
            const match = state.log.match(/WebGL2 fallback: ([^\n]+)/);
            if (match) reason = match[1];
            if (state.fps) lastMeter = state.fps;
            if (/renderer=software/.test(state.search)) { switched = state; break; }
            await new Promise(r => setTimeout(r, 500));
        }

        if (switched && pinnedMode) {
            failure = 'An explicit WebGL2 choice was overridden by the throughput fallback';
        } else if (pinnedMode) {
            log(`stayed on WebGL2 as chosen; meter: ${lastMeter || 'n/a'}`);
        } else if (switched && !expectFallback) {
            const fromUrl = new URLSearchParams(switched.search)
                .get('webgl2-fallback-reason');
            failure = `Fell back although the accelerated path was keeping up: ` +
                `${fromUrl || '(no reason recorded)'} ` +
                `(last accelerated meter: ${lastMeter || 'n/a'})`;
        } else if (switched) {
            // The UI records the reason in the destination query precisely
            // because the navigation is scheduled immediately after logging it,
            // so polling the live log cannot be relied on to observe the line.
            const fromUrl = new URLSearchParams(switched.search)
                .get('webgl2-fallback-reason');
            if (fromUrl) reason = fromUrl;
            log(`switched to software renderer`);
            log(`reason: ${reason}`);
            log(`accelerated meter before switch: ${lastMeter || 'n/a'}`);
            if (!/delivered/.test(reason)) {
                failure = `Fell back for a non-throughput reason: ${reason}`;
            }
        } else if (expectFallback) {
            const state = await page.evaluate(() => ({
                fps: document.querySelector('#fps')?.textContent || '',
                status: document.querySelector('#status')?.textContent || '',
            }));
            failure = `No fallback within ${timeoutSeconds}s (fps meter: ${state.fps || 'n/a'})`;
        }

        if (switched && expectFallback) {
            // The fresh document that the renderer switch requires cannot keep
            // the uploaded ROM, so it has to be supplied again before the
            // destination renderer can be timed at all.
            await page.waitForFunction(
                () => /Emulator initialized successfully/.test(
                    document.querySelector('#log')?.textContent || ''),
                { timeout: 120000 });
            await (await page.$('#rom-file')).uploadFile(romPath);
            await page.waitForFunction(
                () => /ROM ready/.test(document.querySelector('#status')?.textContent || ''),
                { timeout: 180000 });
            await page.click('#btn-load');
            log('ROM re-supplied to the software renderer');

            // The point of switching is speed, so confirm the destination
            // actually runs faster rather than merely loading.
            await page.waitForFunction(
                () => /\d+% speed/.test(document.querySelector('#fps')?.textContent || ''),
                { timeout: 240000 });
            await new Promise(r => setTimeout(r, 10000));
            const after = await page.evaluate(() =>
                document.querySelector('#fps')?.textContent || '');
            log(`software renderer meter: ${after}`);
            const speed = Number((after.match(/(\d+)% speed/) || [])[1] || 0);
            if (speed < 60) {
                failure = `Software renderer reached only ${speed}% speed after fallback`;
            }

            // A repeat visit must act on the stored verdict instead of paying
            // the timed probe and a second ROM upload again. This is what makes
            // the measured result the machine's setting rather than a ritual.
            const startedAt = Date.now();
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(
                () => /renderer=software/.test(window.location.search),
                { timeout: 60000 });
            const revisitSeconds = (Date.now() - startedAt) / 1000;
            const revisitReason = await page.evaluate(() =>
                new URLSearchParams(window.location.search).get('webgl2-fallback-reason') || '');
            log(`repeat visit went straight to software in ${revisitSeconds.toFixed(1)}s`);
            log(`repeat reason: ${revisitReason}`);
            if (!/remembered/.test(revisitReason)) {
                failure = `Repeat visit re-probed instead of using the stored verdict: ${revisitReason}`;
            } else if (revisitSeconds > 30) {
                failure = `Repeat visit took ${revisitSeconds.toFixed(1)}s; expected a redirect, not a probe`;
            }
        }
    } catch (error) {
        failure = error.message;
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }

    if (failure) {
        console.error(`\nFAIL: ${failure}`);
        process.exit(1);
    }
    console.log('\nPASS');
}

main();
