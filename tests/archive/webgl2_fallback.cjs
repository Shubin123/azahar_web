// Verify the non-negotiable WebGL2 safety boundary: context loss before a
// title starts must navigate to a fresh software page, never switch renderer
// implementations on the active canvas.

const assert = require('node:assert/strict');
const puppeteer = require(process.env.AZAHAR_PUPPETEER_MODULE || 'puppeteer-core');
const {listen} = require('../web/server.cjs');

async function main() {
    const server = await listen(0);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.CHROME_PATH,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: {width: 1280, height: 900},
    });
    const page = await browser.newPage();
    try {
        await page.goto(`${origin}/index_webgl2.html`, {waitUntil: 'networkidle0', timeout: 120000});
        await page.waitForFunction(
            () => document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000},
        );

        const lost = await page.evaluate(() => {
            const gl = document.querySelector('#canvas')?.getContext('webgl2');
            const loseContext = gl?.getExtension('WEBGL_lose_context');
            if (!loseContext) return false;
            loseContext.loseContext();
            return true;
        });
        assert.ok(lost, 'Chrome did not expose WEBGL_lose_context for the WebGL2 artifact');

        await page.waitForFunction(
            () => location.pathname.endsWith('/index.html') &&
                document.querySelector('#status')?.textContent.includes('Emulator ready'),
            {timeout: 120000},
        );
        assert.match(page.url(), /index\.html\?webgl2-fallback=1/);
        console.log('WebGL2 context-loss fallback reached a fresh software session.');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
