/**
 * Azahar WebAssembly Benchmark Suite (tests/benchmark.cjs)
 *
 * Runs the WASM emulator for a configurable number of frames and records
 * performance metrics. Designed for comparing before/after optimizations.
 *
 * Usage:
 *   node tests/benchmark.cjs [--frames N] [--warmup N] [--rom PATH] [--output PATH]
 *
 * Options:
 *   --frames N    Frames to benchmark (default: 300)
 *   --warmup N    Warmup frames before measuring (default: 10)
 *   --rom PATH    ROM file path (default: first .3dsx/.3ds/.cia in test_games/)
 *   --output PATH JSON output path (default: tests/benchmark_results.json)
 *   --repeat N    Repeat the benchmark N times (default: 3)
 *   --profile     Run fine-grained perf counter sampling during benchmark
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// ── CLI argument parsing ──────────────────────────────────────────
const argv = require('process').argv.slice(2);
function argVal(flag, fallback) {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
function argFlag(flag) {
    return argv.includes(flag);
}
const BENCH_FRAMES = Number(argVal('--frames', '300'));
const WARMUP_FRAMES = Number(argVal('--warmup', '10'));
const ROM_ARG = argVal('--rom', null);
const OUTPUT_PATH = argVal('--output', path.join(__dirname, 'benchmark_results.json'));
const REPEAT = Number(argVal('--repeat', '3'));
const PROFILE = argFlag('--profile');

const root = path.resolve(__dirname, '..');
const testGamesDir = path.join(root, 'test_games');

// ── ROM discovery ─────────────────────────────────────────────────
function findRom() {
    if (ROM_ARG && fs.existsSync(ROM_ARG)) return ROM_ARG;
    if (ROM_ARG) throw new Error(`ROM not found: ${ROM_ARG}`);
    try {
        const entries = fs.readdirSync(testGamesDir);
        for (const ext of ['.3dsx', '.3ds', '.cia', '.elf', '.cci', '.cxi', '.app']) {
            const match = entries.find(e => e.toLowerCase().endsWith(ext));
            if (match) return path.join(testGamesDir, match);
        }
    } catch (_) { /* test_games/ might not exist */ }
    throw new Error('No ROM found. Place a .3ds/.cia/.3dsx file in test_games/ or use --rom');
}

// ── Benchmark harness ─────────────────────────────────────────────
const { E2EHarness } = require('./e2e/harness');

class BenchmarkRunner {
    constructor(harness) {
        // Reuse an existing harness (and its WASM module) for repeated runs.
        // Skip the mock canvas fill per-frame to avoid ~768KB alloc/frame overhead.
        this.harness = harness || new E2EHarness({ noMockCanvas: true });
        this.wasm = null;
    }

    async init() {
        if (!this.harness.wasmModule) {
            this.wasm = await this.harness.loadWasmModule();
        } else {
            this.wasm = this.harness.wasmModule;
        }
        const r = this.wasm._azahar_init();
        if (r !== 0) throw new Error(`azahar_init returned ${r}`);
    }

    async loadRom(romPath) {
        const buf = fs.readFileSync(romPath);
        const ext = path.extname(romPath).toLowerCase();
        const memfsPath = `/benchmark${ext || '.bin'}`;
        this.harness.fs.writeFile(memfsPath, buf);
        const r = this.wasm._azahar_load_rom(memfsPath);
        if (r !== 0) throw new Error(`azahar_load_rom returned ${r} for ${romPath}`);
        return memfsPath;
    }

    /** Run N frames, return per-frame timing data (ms, float64). */
    runFrames(count, label) {
        const perFrame = [];
        const ctx = this.harness.canvas.getContext('2d');
        const presentsBefore = ctx.putImageDataCalls;

        for (let i = 0; i < count; i++) {
            const t0 = performance.now();
            const r = this.wasm._azahar_step_frame();
            const elapsed = performance.now() - t0;
            perFrame.push(elapsed);
            if (r !== 0 && r !== 1) {
                throw new Error(`azahar_step_frame returned ${r} at ${label} frame ${i}`);
            }
            if (r === 1) break; // shutdown
        }

        const presents = ctx.putImageDataCalls - presentsBefore;
        const sorted = perFrame.slice().sort((a, b) => a - b);
        const sum = perFrame.reduce((a, b) => a + b, 0);
        const avg = sum / perFrame.length;
        const p50 = sorted[Math.floor(sorted.length * 0.50)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        const p99 = sorted[Math.floor(sorted.length * 0.99)];
        const p999 = sorted[Math.floor(sorted.length * 0.999)];
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const fps = 1000 / avg;

        // Standard deviation
        const variance = perFrame.reduce((s, v) => s + (v - avg) ** 2, 0) / perFrame.length;
        const stddev = Math.sqrt(variance);

        return { label, count, presents, sum, avg, fps, stddev, min, max, p50, p95, p99, p999,
            perFrame };
    }

    /** Read C++ perf counters via the shared-memory export. */
    readPerfStats() {
        if (!this.wasm._azahar_get_perf_stats) return null;
        const buf = this.wasm._malloc(64);
        let stats = null;
        if (this.wasm._azahar_get_perf_stats(buf, 8) === 0) {
            const view = new Float64Array(this.wasm.HEAPU8.buffer, buf, 8);
            stats = {
                gameFps: view[0],
                systemFps: view[1],
                emulationSpeed: view[2],
                timeGpu: view[3],
                timeSwap: view[4],
                timeVblank: view[5],
                meanFrametime: view[6],
                frameLimitPct: view[7],
            };
        }
        this.wasm._free(buf);
        return stats;
    }

    /** Profile mode: sample perf counters every N frames during a run. */
    profileFrames(count, sampleInterval) {
        const interval = sampleInterval || Math.max(1, Math.floor(count / 60));
        const samples = [];

        for (let i = 0; i < count; i++) {
            const t0 = performance.now();
            const r = this.wasm._azahar_step_frame();
            const elapsed = performance.now() - t0;

            if (r !== 0 && r !== 1) {
                throw new Error(`azahar_step_frame returned ${r} at profile frame ${i}`);
            }
            if (r === 1) break;

            if (i % interval === 0) {
                samples.push({
                    frame: i,
                    elapsedMs: elapsed,
                    perf: this.readPerfStats(),
                });
            }
        }
        return samples;
    }

    shutdown() {
        if (this.wasm && this.wasm._azahar_shutdown) {
            this.wasm._azahar_shutdown();
        }
    }

    reset() {
        this.shutdown();
        this.harness.reset();
        this.wasm = null;
    }

    heapSize() {
        return this.wasm ? this.wasm.HEAPU8.length : 0;
    }
}

// ── Formatting helpers ────────────────────────────────────────────
function fmtMs(v) { return v.toFixed(2) + 'ms'; }
function fmtFps(v) { return v.toFixed(1); }
function fmtPct(v) { return (v * 100).toFixed(0) + '%'; }
function fmtMB(v) { return (v / 1024 / 1024).toFixed(0) + 'MB'; }

// ── Main ──────────────────────────────────────────────────────────
async function main() {
    const romPath = findRom();
    const romName = path.basename(romPath);
    const romSizeMB = (fs.statSync(romPath).size / 1024 / 1024).toFixed(1);

    console.log(`# Azahar Web Benchmark`);
    console.log(`# ROM: ${romName} (${romSizeMB} MB)`);
    console.log(`# Frames: ${BENCH_FRAMES}  Warmup: ${WARMUP_FRAMES}  Repeats: ${REPEAT}`);
    console.log(`# Profile: ${PROFILE ? 'on' : 'off'}  Mock-canvas: off (benchmark mode)`);
    console.log(`# Started: ${new Date().toISOString()}`);
    console.log('');

    const runs = [];
    const harness = new E2EHarness({ noMockCanvas: true });

    for (let rep = 0; rep < REPEAT; rep++) {
        console.log(`## Run ${rep + 1}/${REPEAT}`);

        const runner = new BenchmarkRunner(harness);

        const initStart = performance.now();
        await runner.init();
        const initMs = performance.now() - initStart;
        console.log(`   Init: ${fmtMs(initMs)}  Heap: ${fmtMB(runner.heapSize())}`);

        const loadStart = performance.now();
        const romPath_ = await runner.loadRom(romPath);
        const loadMs = performance.now() - loadStart;
        console.log(`   Load: ${fmtMs(loadMs)}  Heap: ${fmtMB(runner.heapSize())}`);

        // Warmup
        if (WARMUP_FRAMES > 0) {
            const warm = runner.runFrames(WARMUP_FRAMES, 'warmup');
            console.log(`   Warmup: ${warm.presents} presents, avg ${fmtMs(warm.avg)}/frame`);
        }

        // Profile or Benchmark
        let profileSamples = null;
        if (PROFILE) {
            const benchStart = performance.now();
            profileSamples = runner.profileFrames(BENCH_FRAMES);
            const benchMs = performance.now() - benchStart;
            console.log(`   Profile: ${profileSamples.length} samples over ${BENCH_FRAMES} frames, `
                + `${fmtMs(benchMs / BENCH_FRAMES)}/frame avg`);
        }

        const bench = runner.runFrames(BENCH_FRAMES, 'bench');
        const perfStats = runner.readPerfStats();
        const heapAfter = runner.heapSize();

        console.log(`   Bench: ${bench.presents} presents, avg ${fmtMs(bench.avg)}/frame, `
            + `${fmtFps(bench.fps)} FPS`);
        console.log(`   Stats: p50=${fmtMs(bench.p50)} p95=${fmtMs(bench.p95)} `
            + `p99=${fmtMs(bench.p99)} σ=${fmtMs(bench.stddev)} `
            + `min=${fmtMs(bench.min)} max=${fmtMs(bench.max)}`);
        if (perfStats) {
            console.log(`   Native: game_fps=${perfStats.gameFps.toFixed(1)} `
                + `speed=${fmtPct(perfStats.emulationSpeed)} `
                + `gpu=${fmtMs(perfStats.timeGpu * 1000)} `
                + `swap=${fmtMs(perfStats.timeSwap * 1000)} `
                + `vblank=${fmtMs(perfStats.timeVblank * 1000)} `
                + `mean_ft=${fmtMs(perfStats.meanFrametime * 1000)}`);
        }
        console.log(`   Heap: ${fmtMB(heapAfter)}`);

        runs.push({
            run: rep + 1,
            rom: romName,
            romSizeMB: parseFloat(romSizeMB),
            initMs,
            loadMs,
            warmupFrames: WARMUP_FRAMES,
            benchFrames: BENCH_FRAMES,
            bench,
            perfStats,
            profileSamples,
            heapBytes: heapAfter,
        });

        // Shutdown emulator before next run (but keep WASM module loaded)
        runner.shutdown();
        if (global.gc) global.gc();
    }

    // Aggregate across runs
    const avgs = runs.map(r => r.bench.avg);
    const fpsValues = runs.map(r => r.bench.fps);
    const p50s = runs.map(r => r.bench.p50);
    const p95s = runs.map(r => r.bench.p95);
    const stddevs = runs.map(r => r.bench.stddev);
    const avgAvg = avgs.reduce((a, b) => a + b, 0) / avgs.length;
    const aggregate = {
        avgFrameMs: avgAvg,
        minFrameMs: Math.min(...avgs),
        maxFrameMs: Math.max(...avgs),
        avgFps: fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length,
        bestFps: Math.max(...fpsValues),
        worstFps: Math.min(...fpsValues),
        avgP50: p50s.reduce((a, b) => a + b, 0) / p50s.length,
        avgP95: p95s.reduce((a, b) => a + b, 0) / p95s.length,
        avgStddev: stddevs.reduce((a, b) => a + b, 0) / stddevs.length,
    };

    const results = {
        benchmarkVersion: 2,
        timestamp: new Date().toISOString(),
        config: {
            benchFrames: BENCH_FRAMES,
            warmupFrames: WARMUP_FRAMES,
            repeats: REPEAT,
            profileEnabled: PROFILE,
            mockCanvasDisabled: true,
        },
        aggregate,
        runs,
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');

    console.log('');
    console.log(`## Aggregate (${REPEAT} runs):`);
    console.log(`   FPS: ${fmtFps(aggregate.avgFps)} (best ${fmtFps(aggregate.bestFps)}, `
        + `worst ${fmtFps(aggregate.worstFps)})`);
    console.log(`   Frame: ${fmtMs(aggregate.avgFrameMs)} avg `
        + `(p50=${fmtMs(aggregate.avgP50)} p95=${fmtMs(aggregate.avgP95)} `
        + `σ=${fmtMs(aggregate.avgStddev)})`);
    console.log(`   Written to: ${OUTPUT_PATH}`);
}

main().catch(err => {
    console.error('Benchmark failed:', err.message);
    if (err.message.includes('before Wasm module initialization') ||
        err.message.includes('timed out after')) {
        console.error('');
        console.error('This build uses Emscripten pthreads which require a browser environment.');
        console.error('Use the Puppeteer-based runner instead:');
        console.error('  npm install --no-save puppeteer-core');
        console.error('  node tests/benchmark_browser.cjs --frames 300 --warmup 10 --repeat 3');
    }
    if (err.stack && !err.stack.includes('before Wasm')) console.error(err.stack);
    process.exit(1);
});
