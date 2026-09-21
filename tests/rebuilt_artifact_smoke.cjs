#!/usr/bin/env node
/** Validate the locally rebuilt software artifact without comparing it to web/. */
'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const buildDir = path.resolve(process.env.AZAHAR_BUILD_DIR || path.join(root, 'build-web-sw'));
const bin = path.join(buildDir, 'bin', 'Release');
const jsPath = path.join(bin, 'azahar.js');
const wasmPath = path.join(bin, 'azahar.wasm');

for (const file of [jsPath, wasmPath]) {
    assert.ok(fs.existsSync(file), `missing rebuilt artifact: ${file}`);
    assert.ok(fs.statSync(file).size > 1024 * 1024, `rebuilt artifact is unexpectedly small: ${file}`);
}

const wasm = fs.readFileSync(wasmPath);
assert.deepEqual([...wasm.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'invalid WASM magic');

// Node 16 requires an experimental flag to parse Wasm EH tag sections. The
// Emscripten environment already places Binaryen's validator on PATH, and it
// understands the exact feature set used by the linker.
const wasmOpt = process.env.EMSDK ? path.join(process.env.EMSDK, 'upstream', 'bin', 'wasm-opt') :
    'wasm-opt';
execFileSync(wasmOpt, [wasmPath, '--all-features', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null'],
    {stdio: 'pipe'});

const glue = fs.readFileSync(jsPath, 'utf8');
const requiredExports = [
    'azahar_init', 'azahar_load_rom', 'azahar_step_frame', 'azahar_shutdown',
    'azahar_run_loop', 'azahar_framebuffer_nonblack_pixels', 'azahar_get_perf_stats',
    'azahar_set_fast_forward', 'azahar_get_fast_forward', 'azahar_save_state',
    'azahar_load_state', 'azahar_get_state_operation', 'azahar_get_program_id',
    'azahar_set_resolution_scale', 'azahar_get_resolution_scale',
    'azahar_reset_renderer_stats', 'azahar_get_renderer_stats',
];
for (const name of requiredExports) {
    // Release glue only retains the public Module property (`_azahar_*`),
    // whereas assertions builds also keep readable internal identifiers.
    assert.match(glue, new RegExp(`\\b_${name}\\b`), `generated glue does not expose ${name}`);
}
assert.match(glue, /PThread|pthread/i, 'generated glue is not a pthread build');
assert.match(glue, /azahar\.wasm/, 'generated glue does not locate azahar.wasm');

console.log('Rebuilt artifact smoke passed:');
console.log(`  JS:   ${jsPath} (${(fs.statSync(jsPath).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  WASM: ${wasmPath} (${(fs.statSync(wasmPath).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  API:  ${requiredExports.length} required exports present`);
