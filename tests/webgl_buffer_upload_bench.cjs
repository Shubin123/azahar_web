#!/usr/bin/env node
/**
 * WebGL2 streamed-upload microbenchmark (no ROM needed).
 *
 * The WebGL2 renderer streams vertex, index and uniform data through
 * OGLStreamBuffer. It either writes each chunk into a large ring with
 * bufferSubData ("ring") or replaces the buffer's data store with bufferData
 * on every upload ("orphan"). The engine picks per ANGLE backend
 * (gl_driver.cpp, azahar_webgl_prefers_buffer_orphaning): orphan everywhere
 * except Direct3D, which keeps the ring until it is measured. `?glStream=`
 * overrides that in the real page.
 *
 * This runs the renderer's upload pattern (one vertex and one uniform upload
 * per small draw) against the local backend and prints ms per frame for the
 * engine's ring sizes, a small ring, and orphaning. Frames are paced by
 * requestAnimationFrame, so ~16.7 ms means the strategy kept up with vsync.
 *
 * Measured 2026-10-04, 400 draws/frame:
 *   ANGLE Metal (Apple M1):      ring 16/8 MiB 837 ms, ring 128/32 KiB 17 ms, orphan 17 ms
 *   ANGLE Vulkan (SwiftShader):  ring 16/8 MiB 196 ms, ring 128/32 KiB 187 ms, orphan 123 ms
 *
 * Usage:
 *   node tests/webgl_buffer_upload_bench.cjs [--draws N]
 *   AZAHAR_CHROME_ARGS="--use-angle=d3d11" node tests/webgl_buffer_upload_bench.cjs
 *   AZAHAR_CHROME_ARGS="--use-angle=vulkan --enable-features=Vulkan" node tests/webgl_buffer_upload_bench.cjs
 */
'use strict';
const cfg = require('./config.cjs');

const argVal = (k, d) => {
    const i = process.argv.indexOf(k);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};
const DRAWS = Number(argVal('--draws', '400'));
const EXTRA_ARGS = (process.env.AZAHAR_CHROME_ARGS || '').split(/\s+/).filter(Boolean);

async function main() {
    const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH || cfg.chromePath,
        headless: 'new',
        args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', ...EXTRA_ARGS],
    });
    try {
        const page = await browser.newPage();
        await page.setContent('<canvas id="c" width="400" height="480"></canvas>');
        const result = await page.evaluate(async (draws) => {
            const gl = document.getElementById('c').getContext('webgl2', {antialias: false});
            if (!gl) throw new Error('WebGL2 is unavailable');
            const info = gl.getExtension('WEBGL_debug_renderer_info');
            const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
            const compile = (type, source) => {
                const shader = gl.createShader(type);
                gl.shaderSource(shader, source);
                gl.compileShader(shader);
                return shader;
            };
            const program = gl.createProgram();
            gl.attachShader(program, compile(gl.VERTEX_SHADER, `#version 300 es
layout(location = 0) in vec4 position;
uniform Block { vec4 offset; };
void main() { gl_Position = position + offset; }`));
            gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
out vec4 color;
void main() { color = vec4(1.0); }`));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('link failed');
            gl.useProgram(program);
            gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program, 'Block'), 0);
            gl.bindVertexArray(gl.createVertexArray());
            gl.enableVertexAttribArray(0);

            const VERTICES = 300;
            const FRAMES = 30;
            const vertexData = new Float32Array(VERTICES * 4).map(
                (_, i) => (i % 4 === 3 ? 1 : Math.sin(i) * 0.5));
            const uniformData = new Float32Array(64);
            const nextFrame = () => new Promise(requestAnimationFrame);

            const measure = async (vertexRing, uniformRing) => {
                const orphan = vertexRing === 0;
                const vertexBuffer = gl.createBuffer();
                const uniformBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, Math.max(vertexRing, 16), gl.STREAM_DRAW);
                gl.bindBuffer(gl.UNIFORM_BUFFER, uniformBuffer);
                gl.bufferData(gl.UNIFORM_BUFFER, Math.max(uniformRing, 256), gl.STREAM_DRAW);
                let vertexPos = 0;
                let uniformPos = 0;
                const frame = () => {
                    for (let draw = 0; draw < draws; ++draw) {
                        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
                        if (orphan) {
                            gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STREAM_DRAW);
                            vertexPos = 0;
                        } else {
                            if (vertexPos + vertexData.byteLength > vertexRing) vertexPos = 0;
                            gl.bufferSubData(gl.ARRAY_BUFFER, vertexPos, vertexData);
                        }
                        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, vertexPos);
                        gl.bindBuffer(gl.UNIFORM_BUFFER, uniformBuffer);
                        if (orphan) {
                            gl.bufferData(gl.UNIFORM_BUFFER, uniformData, gl.STREAM_DRAW);
                            uniformPos = 0;
                        } else {
                            if (uniformPos + 256 > uniformRing) uniformPos = 0;
                            gl.bufferSubData(gl.UNIFORM_BUFFER, uniformPos, uniformData);
                        }
                        gl.bindBufferRange(gl.UNIFORM_BUFFER, 0, uniformBuffer, uniformPos, 256);
                        gl.drawArrays(gl.TRIANGLES, 0, VERTICES);
                        vertexPos += vertexData.byteLength;
                        uniformPos += 256;
                    }
                };
                for (let i = 0; i < 5; ++i) { frame(); await nextFrame(); }
                const start = performance.now();
                for (let i = 0; i < FRAMES; ++i) { frame(); await nextFrame(); }
                const ms = (performance.now() - start) / FRAMES;
                gl.deleteBuffer(vertexBuffer);
                gl.deleteBuffer(uniformBuffer);
                return ms;
            };
            return {
                renderer,
                engineRing: await measure(16 << 20, 8 << 20),
                smallRing: await measure(128 << 10, 32 << 10),
                orphan: await measure(0, 0),
            };
        }, DRAWS);

        console.log(`Renderer: ${result.renderer}`);
        console.log(`Draws per frame: ${DRAWS}`);
        console.log(`  ring 16 MiB / 8 MiB (engine sizes):  ${result.engineRing.toFixed(1)} ms/frame`);
        console.log(`  ring 128 KiB / 32 KiB:               ${result.smallRing.toFixed(1)} ms/frame`);
        console.log(`  orphan per upload:                   ${result.orphan.toFixed(1)} ms/frame`);
        const d3d = /direct3d|d3d/i.test(result.renderer);
        const engineChoice = d3d ? 'ring' : 'orphan';
        const faster = result.orphan <= result.engineRing ? 'orphan' : 'ring';
        console.log(`Engine default for this backend: ${engineChoice}; faster here: ${faster}`);
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
