#!/usr/bin/env node
/**
 * Unified Azahar Web Test Runner
 *
 * Single entry point for all web build tests. Uses save states by default
 * for fast benchmarking (skips the 30-45s boot/menu cycle).
 *
 * Usage:
 *   node tests/run.cjs                      # Run all: smoke + benchmark + regression
 *   node tests/run.cjs --smoke              # WASM artifact integrity only
 *   node tests/run.cjs --bench              # Benchmark only (with save state)
 *   node tests/run.cjs --regression         # Rendering regression only
 *   node tests/run.cjs --transition         # Cold boot, touch title, sustain gameplay
 *   node tests/run.cjs --save-states        # Persistent UI save/load/reload/delete lifecycle
 *   node tests/run.cjs --bench --no-state   # Benchmark from cold boot (slow)
 *   node tests/run.cjs --duration 30        # Custom benchmark duration
 *   node tests/run.cjs --warmup 10          # Custom warmup (short with save state)
 *   node tests/run.cjs --repeat 3           # Multiple benchmark runs
 *   node tests/run.cjs --artifact webgl2    # Test WebGL2 build
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const cfg = require('./config.cjs');

const TESTS_DIR = __dirname;
const argFlag = (k) => process.argv.includes(k);
const argVal = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};

const explicit = argFlag('--smoke') || argFlag('--bench') || argFlag('--regression') ||
  argFlag('--transition') || argFlag('--save-states');
const runSmoke = !explicit || argFlag('--smoke');
const runBench = !explicit || argFlag('--bench');
const runRegression = !explicit || argFlag('--regression');
const runTransition = argFlag('--transition');
const runSaveStates = argFlag('--save-states');
const useState = !argFlag('--no-state');
const artifact = argVal('--artifact', 'software');
const duration = argVal('--duration', useState ? '15' : '15');
const warmup = argVal('--warmup', useState ? '10' : '45');
const repeat = argVal('--repeat', '1');

let passed = 0, failed = 0, skipped = 0;

function header(name) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('='.repeat(60));
}

function run(label, scriptPath, args, opts = {}) {
  header(label);
  const fullArgs = [scriptPath, ...args];
  console.log(`> node ${fullArgs.join(' ')}\n`);
  try {
    const result = spawnSync(process.execPath, fullArgs, {
      cwd: cfg.ROOT,
      stdio: 'inherit',
      timeout: opts.timeout || 180000,
      env: { ...process.env, CHROME_PATH: cfg.chromePath || '', ...(opts.env || {}) },
    });
    if (result.status === 0) {
      console.log(`\n  ✓ ${label} PASSED`);
      passed++;
      return true;
    } else {
      console.log(`\n  ✗ ${label} FAILED (exit ${result.status})`);
      failed++;
      return false;
    }
  } catch (e) {
    console.log(`\n  ✗ ${label} ERROR: ${e.message}`);
    failed++;
    return false;
  }
}

// ── Preflight ───────────────────────────────────────────────────────
console.log('Azahar Web Test Runner');
console.log(`  Chrome:     ${cfg.chromePath || '(not found)'}`);
console.log(`  ROM:        ${cfg.romPath ? path.basename(cfg.romPath) : '(not found)'}`);
console.log(`  Save state: ${cfg.statePath ? path.relative(cfg.ROOT, cfg.statePath) : '(none)'}`);
console.log(`  Build dir:  ${path.relative(cfg.ROOT, cfg.buildDir)}`);
console.log(`  Artifact:   ${artifact}`);
if (useState && cfg.statePath) {
  console.log(`  Mode:       save-state (warmup ${warmup}s, measure ${duration}s)`);
} else {
  console.log(`  Mode:       cold boot (warmup ${warmup}s, measure ${duration}s)`);
}

// ── 1. Smoke test ───────────────────────────────────────────────────
if (runSmoke) {
  run('WASM Artifact Smoke Test',
    path.join(TESTS_DIR, 'web_artifact_smoke.cjs'), ['--artifact', artifact]);
}

// ── 2. Benchmark ────────────────────────────────────────────────────
if (runBench) {
  if (!cfg.chromePath) {
    header('Benchmark'); console.log('  ⊘ Skipped: Chrome not found.'); skipped++;
  } else if (!cfg.romPath) {
    header('Benchmark'); console.log('  ⊘ Skipped: No ROM in test_games/'); skipped++;
  } else {
    const args = [
      '--artifact', artifact,
      '--duration-seconds', duration,
      '--warmup-seconds', warmup,
      '--repeat', repeat,
    ];
    if (useState && cfg.statePath) {
      args.push('--state', cfg.statePath);
    }
    run('Benchmark' + (useState && cfg.statePath ? ' (save-state)' : ' (cold boot)'),
      path.join(TESTS_DIR, 'benchmark_browser.cjs'), args, { timeout: 300000 });
  }
}

// ── 3. Rendering regression ─────────────────────────────────────────
if (runRegression) {
  if (!cfg.chromePath) {
    header('Regression'); console.log('  ⊘ Skipped: Chrome not found.'); skipped++;
  } else if (!cfg.romPath) {
    header('Regression'); console.log('  ⊘ Skipped: No ROM found.'); skipped++;
  } else {
    run('Rendering Regression',
      path.join(TESTS_DIR, 'browser_regression.cjs'), [], {
        timeout: 120000, env: { AZAHAR_RENDERER: artifact },
      });
    run('Static-host Deployment Regression',
      path.join(TESTS_DIR, 'browser_regression.cjs'), [], {
        timeout: 120000,
        env: { AZAHAR_STATIC_HOST: '1', AZAHAR_RENDERER: artifact },
      });
  }
}

// The title transition is intentionally opt-in because it cold boots a game
// and sustains the post-touch scene for 45 seconds. It guards a distinct class
// of cache-lifetime and shader/upload failures that save-state tests bypass.
if (runTransition) {
  if (!cfg.chromePath) {
    header('Title Transition Regression'); console.log('  ⊘ Skipped: Chrome not found.'); skipped++;
  } else if (!cfg.romPath) {
    header('Title Transition Regression'); console.log('  ⊘ Skipped: No ROM found.'); skipped++;
  } else {
    run('Title Transition Regression',
      path.join(TESTS_DIR, 'title_transition_regression.cjs'), [], { timeout: 150000 });
  }
}

if (runSaveStates) {
  if (!cfg.chromePath) {
    header('Save-state UI'); console.log('  Skipped: Chrome not found.'); skipped++;
  } else if (!cfg.romPath || !cfg.statePath) {
    header('Save-state UI'); console.log('  Skipped: ROM or gameplay state not found.'); skipped++;
  } else {
    run('Persistent Save-state UI Lifecycle',
      path.join(TESTS_DIR, 'browser_regression.cjs'), [], {
        timeout: 240000,
        env: { AZAHAR_SAVE_STATE_UI: '1', AZAHAR_RENDERER: artifact },
      });
  }
}

// ── Summary ─────────────────────────────────────────────────────────
header('Summary');
console.log(`  Passed:  ${passed}`);
console.log(`  Failed:  ${failed}`);
console.log(`  Skipped: ${skipped}`);
process.exit(failed > 0 ? 1 : 0);
