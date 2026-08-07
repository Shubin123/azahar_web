// Renderer-readiness preflight. This intentionally creates a separate probe
// canvas: it must never claim or change the production software canvas.
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {listen} = require('../web/server.cjs');

const requireWebGL2 = process.argv.includes('--require-webgl2');
const interactive = process.argv.includes('--interactive');

async function main() {
    const server = await listen(0);
    const url = `http://127.0.0.1:${server.address().port}/index.html`;
    const browser = await puppeteer.launch({
        headless: interactive ? false : 'new',
        executablePath: process.env.CHROME_PATH,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: {width: 1280, height: 900},
    });
    const page = await browser.newPage();
    try {
        await page.goto(url, {waitUntil: 'networkidle0', timeout: 120000});
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000});
        const report = await page.evaluate(() => {
            const probe = document.createElement('canvas');
            const gl = probe.getContext('webgl2', {antialias: false, depth: true, stencil: true});
            const extensions = name => Boolean(gl?.getExtension(name));
            const currentCanvas = document.querySelector('#canvas');
            return {
                crossOriginIsolated,
                webgl2: Boolean(gl),
                webgpu: Boolean(navigator.gpu),
                productionCanvasContext: currentCanvas?.getContext('webgl2') ? 'webgl2' :
                    currentCanvas?.getContext('2d') ? '2d' : 'none',
                limits: gl ? {
                    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
                    maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
                    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
                    maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS),
                } : null,
                extensions: gl ? {
                    colorBufferFloat: extensions('EXT_color_buffer_float'),
                    textureFloatLinear: extensions('OES_texture_float_linear'),
                    etc: extensions('WEBGL_compressed_texture_etc'),
                    astc: extensions('WEBGL_compressed_texture_astc'),
                    s3tc: extensions('WEBGL_compressed_texture_s3tc'),
                } : null,
            };
        });
        if (!report.crossOriginIsolated) throw new Error('COOP/COEP isolation is missing');
        if (requireWebGL2 && !report.webgl2) throw new Error('WebGL2 is required but unavailable');
        console.log(JSON.stringify({ok: true, report}, null, 2));
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
