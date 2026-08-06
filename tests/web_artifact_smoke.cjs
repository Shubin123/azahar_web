// Smoke-test the real generated Emscripten artifacts without requiring a browser.
// This complements tests/e2e, whose DOM/WASM layer is intentionally mocked.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const webDir = path.join(root, 'web');
const buildDir = path.join(root, 'build-web', 'bin', 'Release');
const expectedExports = [
    'azahar_init',
    'azahar_load_rom',
    'azahar_framebuffer_nonblack_pixels',
    'azahar_get_perf_stats',
    'azahar_run_loop',
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
    requireFile(dir, 'azahar.js');
    requireFile(dir, 'azahar.wasm');
}

for (const name of ['azahar.js', 'azahar.wasm']) {
    const buildHash = crypto.createHash('sha256').update(read(path.join(buildDir, name))).digest('hex');
    const webHash = crypto.createHash('sha256').update(read(path.join(webDir, name))).digest('hex');
    assert.equal(webHash, buildHash,
        `served web/${name} is stale; rebuild the azahar_web_assets target`);
}

const html = read(path.join(webDir, 'index.html')).toString('utf8');
const ui = read(path.join(webDir, 'azahar_ui.js')).toString('utf8');
const glue = read(path.join(webDir, 'azahar.js')).toString('utf8');

assert.match(html, /<canvas\s+id=["']canvas["']/i);
assert.match(html, /azahar_ui\.js/);
assert.match(ui, /script\.src\s*=\s*['"]azahar\.js['"]/);
for (const name of expectedExports) {
    assert.match(glue, new RegExp(`_${name}\\b`), `missing ${name} in generated JS`);
}

const wasmBytes = read(path.join(webDir, 'azahar.wasm'));
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

console.log(`Web artifact smoke test passed (${moduleExports.length} WASM exports inspected).`);
