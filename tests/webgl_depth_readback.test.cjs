'use strict';

// Exercise the production shaders against known depth/stencil values. No ROM
// is needed. Set AZAHAR_ENGINE_DIR if the engine is not in the sibling checkout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const cfg = require('./config.cjs');

async function main() {
    const engine = process.env.AZAHAR_ENGINE_DIR || path.resolve(cfg.ROOT, '../azahar_emscripten');
    const shaders = {};
    for (const [name, file] of Object.entries({
        vertex: 'full_screen_triangle.vert',
        depth: 'format_reinterpreter/d24s8_to_rgba8_webgl.frag',
        stencil: 'format_reinterpreter/stencil_bit.frag',
    })) {
        shaders[name] = '#version 300 es\n#define NO_BINDING_LAYOUT\n' +
            fs.readFileSync(path.join(engine, 'src/video_core/host_shaders', file), 'utf8');
    }
    const browser = await puppeteer.launch({
        executablePath: cfg.chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage',
            ...(process.env.AZAHAR_CHROME_ARGS || '').split(/\s+/).filter(Boolean)],
    });
    try {
        const page = await browser.newPage();
        const result = await page.evaluate(sources => {
            const gl = document.createElement('canvas').getContext('webgl2');
            if (!gl) throw new Error('WebGL2 unavailable');
            function program(fragment) {
                const p = gl.createProgram();
                for (const [type, source] of [[gl.VERTEX_SHADER, sources.vertex],
                    [gl.FRAGMENT_SHADER, fragment]]) {
                    const s = gl.createShader(type);
                    gl.shaderSource(s, source);
                    gl.compileShader(s);
                    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                        throw new Error(gl.getShaderInfoLog(s));
                    }
                    gl.attachShader(p, s);
                }
                gl.linkProgram(p);
                if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
                return p;
            }
            const depthProgram = program(sources.depth);
            const stencilProgram = program(sources.stencil);
            gl.bindVertexArray(gl.createVertexArray());
            let checked = 0;
            for (const format of ['D16', 'D24', 'D24S8']) {
                const maximum = format === 'D16' ? 65535 : 16777215;
                // Include texels beyond mediump's exact integer range and a mip
                // with a different size, plus nonzero subrectangle coordinates.
                for (const level of [0, 1]) {
                    const width = level === 0 ? 2056 : 24;
                    const height = 2;
                    const depthTexture = gl.createTexture();
                    gl.bindTexture(gl.TEXTURE_2D, depthTexture);
                    gl.texStorage2D(gl.TEXTURE_2D, level + 1,
                        format === 'D16' ? gl.DEPTH_COMPONENT16 :
                            format === 'D24' ? gl.DEPTH_COMPONENT24 : gl.DEPTH24_STENCIL8,
                        width << level, height << level);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    const fbo = gl.createFramebuffer();
                    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                    const attachment = format === 'D24S8' ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, depthTexture, level);
                    gl.drawBuffers([gl.NONE]);
                    gl.readBuffer(gl.NONE);
                    const values = [0, 1, 2, 255, 256, maximum >> 1, maximum - 2, maximum - 1, maximum];
                    gl.enable(gl.SCISSOR_TEST);
                    gl.depthMask(true);
                    gl.stencilMask(255);
                    for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
                        const i = y * width + x;
                        gl.scissor(x, y, 1, 1);
                        const depth = values[i % values.length] / maximum;
                        if (format === 'D24S8') gl.clearBufferfi(gl.DEPTH_STENCIL, 0, depth, i & 255);
                        else gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([depth]));
                    }
                    gl.disable(gl.SCISSOR_TEST);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, null, level);
                    const color = gl.createTexture();
                    gl.bindTexture(gl.TEXTURE_2D, color);
                    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
                    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                    gl.readBuffer(gl.COLOR_ATTACHMENT0);
                    for (const rect of [[0, 0, width, height], [width - 7, 1, 7, 1]]) {
                        const [left, bottom, w, h] = rect;
                        gl.viewport(left, bottom, w, h);
                        gl.disable(gl.STENCIL_TEST);
                        gl.disable(gl.BLEND);
                        gl.colorMask(true, true, true, true);
                        gl.bindTexture(gl.TEXTURE_2D, depthTexture);
                        gl.useProgram(depthProgram);
                        gl.uniform1i(gl.getUniformLocation(depthProgram, 'depth_level'), level);
                        gl.uniform2f(gl.getUniformLocation(depthProgram, 'tex_scale'), w / width, h / height);
                        gl.uniform2f(gl.getUniformLocation(depthProgram, 'tex_offset'), left / width, bottom / height);
                        gl.drawArrays(gl.TRIANGLES, 0, 3);
                        gl.bindTexture(gl.TEXTURE_2D, null);
                        if (format === 'D24S8') {
                            gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, depthTexture, level);
                            gl.useProgram(stencilProgram);
                            gl.colorMask(true, false, false, false);
                            gl.enable(gl.STENCIL_TEST);
                            gl.stencilMask(0);
                            gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
                            gl.enable(gl.BLEND);
                            gl.blendFunc(gl.ONE, gl.ONE);
                            for (let bit = 0; bit < 8; ++bit) {
                                gl.stencilFunc(gl.EQUAL, 255, 1 << bit);
                                gl.uniform1f(gl.getUniformLocation(stencilProgram, 'bit_value'), (1 << bit) / 255);
                                gl.drawArrays(gl.TRIANGLES, 0, 3);
                            }
                            gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, null, level);
                        }
                        const bytes = new Uint8Array(w * h * 4);
                        gl.readPixels(left, bottom, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
                        if (gl.getError() !== gl.NO_ERROR) throw new Error(`${format}: GL error`);
                        for (let y = 0; y < h; ++y) for (let x = 0; x < w; ++x) {
                            const i = (bottom + y) * width + left + x;
                            const offset = (y * w + x) * 4;
                            const depth24 = bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
                            const actual = format === 'D16' ? Math.round(depth24 * 65535 / 16777215) : depth24;
                            const expected = values[i % values.length];
                            if (actual !== expected || bytes[offset] !== (format === 'D24S8' ? i & 255 : 0)) {
                                throw new Error(`${format} mip ${level} texel ${i}: depth ${actual}/${expected}, stencil ${bytes[offset]}`);
                            }
                            checked++;
                        }
                    }
                    gl.deleteFramebuffer(fbo);
                    gl.deleteTexture(depthTexture);
                    gl.deleteTexture(color);
                }
            }
            return {checked};
        }, shaders);
        assert.ok(result.checked > 12000);
        console.log(`WebGL depth/stencil readback passed (${result.checked} exact texel checks).`);
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
