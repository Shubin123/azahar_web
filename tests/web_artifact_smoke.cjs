// Smoke-test the real generated Emscripten artifacts without requiring a browser.
// This complements tests/e2e, whose DOM/WASM layer is intentionally mocked.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config.cjs');

const root = path.resolve(__dirname, '..');
const webDir = path.join(root, 'web');
const buildDir = path.join(cfg.buildDir, 'bin', 'Release');
const artifactArgument = process.argv.indexOf('--artifact');
const artifactKind = artifactArgument >= 0 ? process.argv[artifactArgument + 1] : 'software';
if (!['software', 'webgl2'].includes(artifactKind)) {
    throw new Error('Usage: node tests/web_artifact_smoke.cjs [--artifact software|webgl2]');
}
const artifactName = artifactKind === 'webgl2' ? 'azahar_webgl2' : 'azahar';
const pageName = 'index.html';
const expectedExports = [
    'azahar_init',
    'azahar_load_state',
    'azahar_get_state_operation',
    'azahar_get_program_id',
    'azahar_set_fast_forward',
    'azahar_get_fast_forward',
    'azahar_set_resolution_scale',
    'azahar_get_resolution_scale',
    'azahar_load_rom',
    'azahar_framebuffer_nonblack_pixels',
    'azahar_reset_renderer_stats',
    'azahar_get_perf_stats',
    'azahar_get_renderer_stats',
    'azahar_run_loop',
    'azahar_save_state',
    'azahar_shutdown',
    'azahar_step_frame',
];

function read(file) {
    return fs.readFileSync(file);
}

function requireFile(dir, name) {
    const file = path.join(dir, name);
    assert.ok(fs.existsSync(file), `missing ${path.relative(root, file)}`);
    assert.ok(fs.statSync(file).size > 0, `empty ${path.relative(root, file)}`);
    return file;
}

for (const dir of [webDir, buildDir]) {
    requireFile(dir, `${artifactName}.js`);
    requireFile(dir, `${artifactName}.wasm`);
}

for (const extension of ['js', 'wasm']) {
    const name = `${artifactName}.${extension}`;
    const buildHash = crypto.createHash('sha256').update(read(path.join(buildDir, name))).digest('hex');
    const webHash = crypto.createHash('sha256').update(read(path.join(webDir, name))).digest('hex');
    assert.equal(webHash, buildHash,
        `served web/${name} is stale; rebuild the azahar_web_assets target`);
}

const html = read(path.join(webDir, pageName)).toString('utf8');
const ui = read(path.join(webDir, 'azahar_ui.js')).toString('utf8');
const glue = read(path.join(webDir, `${artifactName}.js`)).toString('utf8');

assert.match(html, /<canvas\s+id=["']canvas["']/i);
assert.match(html, /azahar_ui\.js/);
assert.match(html, /azahar_savestates\.js/);
requireFile(webDir, 'azahar_savestates.js');
assert.match(html, /id=["']renderer-mode["']/i);
assert.match(ui, /script\.src\s*=\s*`\$\{artifactName\}\.js`/);
if (artifactKind === 'webgl2') {
    assert.match(html, /renderer:\s*['"]webgl2['"]/);
    assert.match(ui, /#version 300 es/);
}
for (const name of expectedExports) {
    assert.match(glue, new RegExp(`_${name}\\b`), `missing ${name} in generated JS`);
}

const wasmBytes = read(path.join(webDir, `${artifactName}.wasm`));
const wasmModule = new WebAssembly.Module(wasmBytes);
const moduleExports = WebAssembly.Module.exports(wasmModule);
const moduleImports = WebAssembly.Module.imports(wasmModule);
assert.ok(
    moduleExports.some(({kind}) => kind === 'memory') ||
        moduleImports.some(({kind}) => kind === 'memory'),
    'WASM has no memory import or export',
);
assert.ok(moduleExports.filter(({kind}) => kind === 'function').length > 100,
    'WASM export table is unexpectedly small');

console.log(`${artifactKind} web artifact smoke test passed (${moduleExports.length} WASM exports inspected).`);
