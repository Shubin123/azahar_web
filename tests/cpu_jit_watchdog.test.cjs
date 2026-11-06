/**
 * cpu_jit_watchdog.test.cjs
 * The page's CPU watchdog (web/azahar_cpu_jit.js), without a browser: it switches a stuck game
 * from compiled code to the interpreter, remembers a title only when that revived it, switches
 * back when it did not, and leaves slow, loading and paused games alone.
 *
 * Usage: node tests/cpu_jit_watchdog.test.cjs
 */
'use strict';

const assert = require('node:assert');

const store = new Map();
globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
};
const { CpuJitWatchdog, titles, STALL_MS, REVIVE_MS } = require('../web/azahar_cpu_jit.js');

// Feeds samples every 500 ms; `fps` and `unmapped` are per-sample functions of time.
function run(watchdog, { from = 0, to, fps, speed = 100, unmappedPerSecond = () => 0, compiled = () => true,
    linked = false }) {
    const decisions = [];
    let unmapped = run.unmapped || 0;
    for (let now = from; now <= to; now += 500) {
        unmapped += unmappedPerSecond(now) / 2;
        const decision = watchdog.observe({ now, compiled: compiled(now), gameFps: fps(now), speed, unmapped, linked });
        if (decision) decisions.push({ at: now, ...decision });
    }
    run.unmapped = unmapped;
    return decisions;
}

// A loading pause shorter than the stall limit is left alone.
{
    const watchdog = new CpuJitWatchdog();
    const decisions = run(watchdog, { to: 30000, fps: now => (now > 5000 && now < 5000 + STALL_MS - 1000 ? 0 : 30) });
    assert.deepStrictEqual(decisions, [], 'a pause shorter than the stall limit is not a stall');
}

// A slow or paused game that draws nothing is not stuck.
{
    const watchdog = new CpuJitWatchdog();
    assert.deepStrictEqual(run(watchdog, { to: 40000, fps: () => 0, speed: 20 }), [], 'a slow game is not stuck');
}

// A Local Play console waiting for its peer draws nothing: not a stall.
{
    const watchdog = new CpuJitWatchdog();
    assert.deepStrictEqual(run(watchdog, { to: 40000, fps: now => (now < 2000 ? 30 : 0), linked: true }), [],
        'waiting for a Local Play peer is not a stall');
    // A flood still counts while linked.
    run.unmapped = 0;
    const flood = run(new CpuJitWatchdog(), { to: 10000, fps: () => 30, linked: true,
        unmappedPerSecond: now => (now > 4000 ? 10000 : 0) });
    assert.deepStrictEqual(flood.map(d => `${d.action}:${d.reason}`), ['interpreter:flood']);
}

// Nothing happens while the interpreter already runs everything.
{
    const watchdog = new CpuJitWatchdog();
    assert.deepStrictEqual(run(watchdog, { to: 40000, fps: now => (now < 2000 ? 30 : 0), compiled: () => false }), []);
}

// Stuck with compiled code; the interpreter revives it: remembered.
{
    const watchdog = new CpuJitWatchdog();
    const stuckFrom = 3000;
    // Measured from the last sample with frames.
    const switchedAt = stuckFrom - 500 + STALL_MS;
    const decisions = run(watchdog, { to: 40000,
        fps: now => (now < stuckFrom || now >= switchedAt + 2000 ? 30 : 0) });
    assert.deepStrictEqual(decisions.map(d => d.action), ['interpreter', 'remember']);
    assert.strictEqual(decisions[0].reason, 'stall');
    assert.ok(decisions[0].at >= switchedAt && decisions[0].at <= switchedAt + 500, `switched after the stall limit (${decisions[0].at})`);
    assert.strictEqual(watchdog.state, 'done');
}

// Stuck either way: compiled code comes back on, and is not blamed again until the game draws.
{
    const watchdog = new CpuJitWatchdog();
    const decisions = run(watchdog, { to: 60000, fps: now => (now < 1000 ? 30 : 0) });
    assert.deepStrictEqual(decisions.map(d => d.action), ['interpreter', 'compiled']);
    assert.ok(decisions[1].at - decisions[0].at >= REVIVE_MS, 'the interpreter gets its full chance');
    assert.strictEqual(watchdog.state, 'watching');
    // Frames return, then stop again: a new trial.
    const later = run(watchdog, { from: 60500, to: 90000, fps: now => (now < 62000 ? 30 : 0) });
    assert.deepStrictEqual(later.map(d => d.action), ['interpreter', 'compiled']);
}

// Garbage running with compiled code (a flood of unmapped accesses), calm on the interpreter.
{
    run.unmapped = 0;
    const watchdog = new CpuJitWatchdog();
    let switched = Infinity;
    const decisions = [];
    for (let now = 0, unmapped = 0; now <= 20000; now += 500) {
        unmapped += now > 4000 && now < switched + 500 ? 5000 : 1;
        const decision = watchdog.observe({ now, compiled: switched === Infinity, gameFps: 30, speed: 100, unmapped });
        if (decision?.action === 'interpreter') switched = now;
        if (decision) decisions.push(decision);
    }
    assert.deepStrictEqual(decisions.map(d => `${d.action}:${d.reason}`), ['interpreter:flood', 'remember:flood']);
}

// A flood the interpreter does not stop: stay on the interpreter, blame nothing.
{
    const watchdog = new CpuJitWatchdog();
    const decisions = [];
    for (let now = 0, unmapped = 0; now <= 40000; now += 500) {
        unmapped += now > 4000 ? 5000 : 1;
        const decision = watchdog.observe({ now, compiled: decisions.length === 0, gameFps: 30, speed: 100, unmapped });
        if (decision) decisions.push(decision);
    }
    assert.deepStrictEqual(decisions.map(d => d.action), ['interpreter']);
    assert.strictEqual(watchdog.state, 'done');
}

// Remembered titles.
{
    assert.strictEqual(titles.get('0004000000055D00'), null);
    titles.remember('0004000000055D00', 'stall');
    assert.strictEqual(titles.get('0004000000055D00').reason, 'stall');
    titles.forget('0004000000055D00');
    assert.strictEqual(titles.get('0004000000055D00'), null);
    // An entry from an older compiler gets another chance.
    store.set('azahar-cpu-jit-off', JSON.stringify({ '0004000000030600': { reason: 'stall', version: 0 } }));
    assert.strictEqual(titles.get('0004000000030600'), null);
}

console.log('CPU watchdog tests passed');
