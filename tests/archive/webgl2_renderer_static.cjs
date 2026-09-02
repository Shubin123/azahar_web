// Focused source gate for the incremental WebGL2 backend. This is not a
// correctness substitute: compositor/gameplay gates still validate browser
// output. It catches accidental reintroduction of desktop-only APIs before an
// experimental artifact is offered.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(
    path.join(root, 'azahar', 'src', 'video_core', 'renderer_webgl2', 'renderer_webgl2.cpp'),
    'utf8',
);
const rasterizer = fs.readFileSync(
    path.join(root, 'azahar', 'src', 'video_core', 'renderer_webgl2', 'rasterizer_webgl2.cpp'),
    'utf8',
);
const rasterizerHeader = fs.readFileSync(
    path.join(root, 'azahar', 'src', 'video_core', 'renderer_webgl2', 'rasterizer_webgl2.h'),
    'utf8',
);
const sourceCode = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const cmake = fs.readFileSync(path.join(root, 'azahar', 'src', 'citra_sdl', 'CMakeLists.txt'), 'utf8');
const topLevelCmake = fs.readFileSync(path.join(root, 'azahar', 'CMakeLists.txt'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'web', 'index_webgl2.html'), 'utf8');

assert.match(source, /#version 300 es/);
assert.match(source, /glBufferSubData/);
assert.match(source, /glTexSubImage2D/);
assert.match(source, /GL_RGBA8/);
assert.match(source, /glReadPixels[\s\S]*GL_RGBA[\s\S]*GL_UNSIGNED_BYTE/);
assert.match(source, /glBindFramebuffer\(GL_FRAMEBUFFER, 0\)/);
assert.match(source, /glDisable\(GL_SCISSOR_TEST\)/);
assert.match(source, /glColorMask\(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE\)/);
assert.match(rasterizerHeader, /RasterizerSoftware/);
assert.match(rasterizer, /software_rasterizer\.AddTriangle/);
assert.match(rasterizer, /AccelerateDrawBatch/);
assert.match(rasterizer, /return false/);
assert.match(rasterizer, /CpuVertexGpuBridge/);
assert.match(rasterizer, /DecodeTexture/);
assert.match(rasterizer, /EncodeTexture/);
assert.match(rasterizer, /glReadPixels[\s\S]*GL_RGBA[\s\S]*GL_UNSIGNED_BYTE/);
assert.match(rasterizer, /ENABLE_WEBGL2_CPU_VERTEX_SLICE/);
assert.match(rasterizer, /ENABLE_WEBGL2_CPU_VERTEX_EXECUTION/);
assert.match(rasterizer, /CpuVertexStateRejectionMask/);
assert.match(rasterizerHeader, /cpu_vertex_rejection_mask/);
assert.match(rasterizerHeader, /cpu_vertex_rejection_bit_counts/);
assert.match(topLevelCmake, /ENABLE_WEBGL2_CPU_VERTEX_SLICE/);
assert.match(topLevelCmake, /ENABLE_WEBGL2_CPU_VERTEX_EXECUTION/);
assert.match(cmake, /-sMIN_WEBGL_VERSION=2\s+-sMAX_WEBGL_VERSION=2/);
assert.doesNotMatch(cmake, /-sFULL_ES3/);
assert.match(bootstrap, /renderer:\s*'webgl2'/);
assert.match(bootstrap, /id="canvas"/);
// The framebuffer staging is already normalized to top-down rows. Upload row
// zero is texture v=0, so the top of the presentation quad must sample v=0;
// otherwise every LCD is vertically inverted in WebGL2.
assert.match(sourceCode, /\{\{left, top\}, \{0\.0f, 0\.0f\}\}/);
assert.match(sourceCode, /\{\{right, top\}, \{1\.0f, 0\.0f\}\}/);
assert.doesNotMatch(sourceCode, /\{\{left, top\}, \{0\.0f, 1\.0f\}\}/);

for (const desktopOnly of [
    'glBufferStorage', 'glMapBufferRange', 'glCopyImageSubData', 'glTextureView',
    'glGetTexImage', 'glBindImageTexture', 'glMemoryBarrier', 'glProgramBinary',
    'glUseProgramStages', 'glBindProgramPipeline', 'GL_GEOMETRY_SHADER',
]) {
    assert.ok(!sourceCode.includes(desktopOnly),
        `desktop-only API leaked into WebGL2 renderer: ${desktopOnly}`);
}

for (const desktopOnly of ['glBufferStorage', 'glMapBufferRange', 'glCopyImageSubData',
    'glTextureView', 'glGetTexImage', 'glBindImageTexture', 'glMemoryBarrier',
    'glProgramBinary', 'glUseProgramStages', 'glBindProgramPipeline', 'GL_GEOMETRY_SHADER']) {
    assert.ok(!rasterizer.includes(desktopOnly),
        `desktop-only API leaked into WebGL2 PICA bridge: ${desktopOnly}`);
}

console.log('WebGL2 renderer static gate passed.');
