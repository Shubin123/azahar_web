'use strict';
// Gameplay performance regression check. Restores each scene in tests/perf_scenes.json
// (saved states in actual play) and measures it with tests/perf_probe.cjs, once per
// build directory, then compares every build with the first.
//
//   node tests/gameplay_perf.cjs [--builds REF_DIR,DIR,...] [--scenes a,b] [--seconds 20]
//        [--repeat 1] [--query "renderer=webgl2"] [--tolerance 3] [--gpu] [--output FILE.json]
//
// Default builds: web/ only (prints a table). With two or more builds, exits 1 when a
// later build is slower than the first by more than --tolerance percentage points of
// emulation speed in any scene, or renders 7% fewer frames per emulated second.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const cfg = require('./config.cjs');

const root = cfg.ROOT;
const builds = cfg.argVal('--builds', 'web').split(',').map(dir => path.resolve(root, dir));
const only = cfg.argVal('--scenes', '');
const seconds = cfg.argVal('--seconds', '20');
const repeat = Number(cfg.argVal('--repeat', '1'));
const query = cfg.argVal('--query', '');
const tolerance = Number(cfg.argVal('--tolerance', '3'));
const gpu = process.argv.includes('--gpu') || process.env.AZAHAR_FIXTURE_GPU === '1';
const output = cfg.argVal('--output', null);

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'perf_scenes.json'), 'utf8'));
const scenes = manifest.scenes.filter(scene => !only || only.split(',').includes(scene.name));

function probe(scene, build) {
    const args = [path.join(__dirname, 'perf_probe.cjs'), '--rom', path.join(root, scene.rom),
        '--state', path.join(root, scene.state), '--seconds', seconds, '--label', scene.name];
    const sceneQuery = [query, scene.query].filter(Boolean).join('&');
    if (sceneQuery) args.push('--query', sceneQuery);
    if (gpu) args.push('--gpu');
    const text = execFileSync(process.execPath, args, { env: { ...process.env, AZAHAR_WEB_DIR: build },
        encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(text.trim().split('\n').filter(line => line.startsWith('{')).pop());
}

const results = [];
let regressions = 0;
for (const scene of scenes) {
    if (![scene.rom, scene.state].every(file => fs.existsSync(path.join(root, file)))) {
        console.log(`skip ${scene.name}: ROM or state missing`);
        continue;
    }
    const perBuild = builds.map(build => {
        const runs = [];
        for (let i = 0; i < repeat; i++) {
            try {
                runs.push(probe(scene, build));
            } catch (error) {
                runs.push({ error: String(error.stderr || error.message).slice(-400) });
            }
        }
        const ok = runs.filter(run => !run.error);
        const mean = key => ok.length ? ok.reduce((sum, run) => sum + key(run), 0) / ok.length : NaN;
        return { build: path.relative(root, build) || '.', runs: ok.length, errors: runs.filter(run => run.error),
            speed: mean(run => run.speedPercent), fps: mean(run => run.gameFps),
            // Frames per emulated second: the game's own frame rate, whatever the speed.
            guestFps: mean(run => run.gameFps / Math.max(1, run.speedPercent) * 100),
            callbackMs: mean(run => run.callbackMs.mean), p95Ms: mean(run => run.callbackMs.p95),
            hitches: mean(run => run.hitches50ms) };
    });
    const reference = perBuild[0];
    for (const entry of perBuild) {
        const delta = entry.speed - reference.speed;
        // Slower emulation, or the game itself dropping frames (a lowered CPU clock can
        // keep the speed while the game loses frames).
        const fewerFrames = entry.guestFps < reference.guestFps * 0.93;
        const slower = entry !== reference && (delta < -tolerance || fewerFrames || !entry.runs);
        if (slower) regressions++;
        console.log(`${scene.name.padEnd(24)} ${entry.build.padEnd(28)} speed ${entry.speed.toFixed(1).padStart(6)}%` +
            ` fps ${entry.fps.toFixed(1).padStart(5)} game-time fps ${entry.guestFps.toFixed(1).padStart(5)}` +
            ` cb ${entry.callbackMs.toFixed(1).padStart(5)}ms` +
            ` p95 ${entry.p95Ms.toFixed(1).padStart(5)}ms hitches ${entry.hitches.toFixed(0).padStart(3)}` +
            (entry === reference ? '' : ` (${delta >= 0 ? '+' : ''}${delta.toFixed(1)})`) +
            (slower ? '  REGRESSION' : '') + (entry.errors.length ? `  ${entry.errors.length} failed run(s)` : ''));
    }
    results.push({ scene: scene.name, builds: perBuild });
}
if (output) fs.writeFileSync(output, JSON.stringify({ seconds, repeat, query, gpu, results }, null, 2));
if (builds.length > 1) {
    console.log(regressions ? `gameplay_perf: ${regressions} regression(s)` : 'gameplay_perf: no regressions');
    process.exitCode = regressions ? 1 : 0;
}
