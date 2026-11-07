/**
 * multiplayer_suite.cjs
 * The multiplayer games on one device (split.html, tests/split_screen.test.cjs), one after
 * another, so a change to Local Play is checked against both ways games add players:
 *   - mario-kart-7: every player has the game; Player 2 joins Player 1's room from the
 *     game's Local Multiplayer menu, then both race and their screens are compared.
 *   - mario-party-island-tour: further players join only through Download Play; each other
 *     screen joins with 📥, the host starts, every guest runs the game's Download Play child in
 *     the host's room, and Player 2 is made to stop and comes back from its checkpoint.
 * The checks that need no game run once, first, and are never retried. A game whose ROM is not found
 * is skipped with the reason. A game that fails is played again up to --retries times
 * (default 1), and the summary says so: Mario Kart 7 sometimes breaks off with a communication
 * error between its lobby and the race, on the code before this suite too (1 of 5 runs there,
 * 2026-11-07). With --two-browsers, tests/multiplayer.test.cjs also links two browsers through
 * invite codes for each game.
 *
 * Usage:
 *   node tests/multiplayer_suite.cjs --roms DIR [--gpu] [--renderer webgl2|software]
 *       [--timeout SECONDS] [--games mario-kart-7,mario-party-island-tour] [--retries N]
 *       [--two-browsers]
 *   ROMs come from each build's `rom` in multiplayer_games.json, or are found by name in DIR
 *   (or AZAHAR_ROMS); see game_roms.cjs.
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const cfg = require('./config.cjs');
const { findBuildRom } = require('./game_roms.cjs');

const GAMES = JSON.parse(fs.readFileSync(path.join(__dirname, 'multiplayer_games.json'), 'utf8'));
const DEFAULT_GAMES = ['mario-kart-7', 'mario-party-island-tour'];
const PASSED_ON = ['--roms', '--renderer', '--timeout', '--web', '--query'];

function run(script, args) {
    return new Promise(resolve => {
        const started = Date.now();
        console.log(`\n$ node ${path.relative(cfg.ROOT, script)} ${args.join(' ')}`);
        const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        const lines = [];
        const relay = (stream, out) => stream.on('data', chunk => {
            out.write(chunk);
            lines.push(...String(chunk).split('\n'));
        });
        relay(child.stdout, process.stdout);
        relay(child.stderr, process.stderr);
        child.on('close', code => resolve({ code, lines, seconds: Math.round((Date.now() - started) / 1000) }));
    });
}

async function main() {
    const games = (cfg.argVal('--games', '') || DEFAULT_GAMES.join(',')).split(',').filter(Boolean);
    const shared = PASSED_ON.flatMap(flag => (cfg.argVal(flag, null) !== null ? [flag, cfg.argVal(flag)] : []));
    if (cfg.argFlag('--gpu')) shared.push('--gpu');
    const results = [];
    // The checks that need no game, once, and never retried.
    const linkChecks = await run(path.join(__dirname, 'split_screen.test.cjs'), shared);
    results.push({ key: 'one device, no game', outcome: linkChecks.code === 0 ? 'PASS' : 'FAIL',
        seconds: linkChecks.seconds, detail: linkChecks.code === 0 ?
            `${linkChecks.lines.filter(line => line.startsWith('PASS')).length} checks` :
            linkChecks.lines.filter(line => /Error|assert|FAIL/.test(line)).slice(0, 2).join(' | ') });
    for (const key of games) {
        const game = GAMES[key];
        if (!game) {
            results.push({ key, outcome: 'FAIL', detail: 'not in multiplayer_games.json' });
            continue;
        }
        const rom = findBuildRom(game.builds.full);
        if (!rom) {
            results.push({ key, outcome: 'SKIP', detail: 'no ROM found (pass --roms DIR)' });
            continue;
        }
        const retries = Number(cfg.argVal('--retries', 1));
        const failures = [];
        let result;
        for (let attempt = 0; attempt <= retries; attempt++) {
            result = await run(path.join(__dirname, 'split_screen.test.cjs'),
                ['--rom', rom, '--game', key, '--game-only', ...shared]);
            if (result.code === 0) break;
            failures.push(result.lines.filter(line => /Error|assert|FAIL/.test(line)).slice(0, 2).join(' | '));
        }
        const passes = result.lines.filter(line => line.startsWith('PASS'));
        const earlier = failures.length && result.code === 0 ?
            `; passed on try ${failures.length + 1} after: ${failures.join(' / ')}` : '';
        results.push({ key, outcome: result.code === 0 ? 'PASS' : 'FAIL', seconds: result.seconds,
            detail: result.code === 0 ? `${passes.length} checks${earlier}` : failures.join(' / ') });
        if (cfg.argFlag('--two-browsers')) {
            const two = await run(path.join(__dirname, 'multiplayer.test.cjs'), ['--game', key, ...shared]);
            const outcome = two.code !== 0 ? 'FAIL' : two.lines.some(line => line.startsWith('PASS')) ? 'PASS' : 'SKIP';
            results.push({ key: `${key} (two browsers)`, outcome, seconds: two.seconds,
                detail: two.lines.filter(line => /^(PASS|FAIL|SKIP)/.test(line)).join(' | ') });
        }
    }
    console.log('\nMultiplayer suite:');
    for (const result of results) {
        console.log(`  ${result.outcome.padEnd(4)} ${result.key}${result.seconds ? ` (${result.seconds} s)` : ''}: ${result.detail}`);
    }
    if (results.some(result => result.outcome === 'FAIL')) process.exit(1);
    if (!results.some(result => result.outcome === 'PASS')) {
        console.log('No game was played; pass --roms DIR with the games in it.');
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
