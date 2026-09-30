/**
 * input_ui.test.cjs
 * Verifies the keymap menu lists every 3DS control with the key the native
 * core actually reads, and that the menu opens and closes from the UI.
 */
'use strict';

const puppeteer = require('puppeteer-core');
const { listen } = require('../web/server.cjs');
const cfg = require('./config.cjs');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// SDL scancode names in the engine's default Controls profile, in
// Settings::NativeButton order, mapped to the menu's control labels.
const NATIVE_BUTTON_ORDER = ['Face buttons:A', 'Face buttons:B', 'Face buttons:X', 'Face buttons:Y',
    'D-pad:Up', 'D-pad:Down', 'D-pad:Left', 'D-pad:Right', 'Shoulders:L', 'Shoulders:R',
    'System:Start', 'System:Select', 'System:Debug', 'System:GPIO14', 'Shoulders:ZL', 'Shoulders:ZR',
    'System:Home'];
const ANALOG_ORDER = ['Up', 'Down', 'Left', 'Right', 'Half tilt (hold)'];

function scancodeToDomCode(name) {
    if (/^[A-Z]$/.test(name)) return `Key${name}`;
    if (/^[0-9]$/.test(name)) return `Digit${name}`;
    return `Arrow${name[0]}${name.slice(1).toLowerCase()}`;
}

// When the engine source is checked out next to this repo, make sure the
// documented table still matches its defaults.
function engineDefaults() {
    const configPath = path.join(cfg.ROOT, '..', 'azahar_emscripten', 'src', 'citra_sdl', 'config.cpp');
    if (!fs.existsSync(configPath)) return null;
    const source = fs.readFileSync(configPath, 'utf8');
    const scancodes = block => [...block.matchAll(/SDL_SCANCODE_(\w+)/g)].map(m => m[1]);
    const buttons = scancodes(source.match(/default_buttons = \{([\s\S]*?)\};/)[1]);
    const analogs = scancodes(source.match(/default_analogs\{\{([\s\S]*?)\}\};/)[1]);
    const expected = {};
    NATIVE_BUTTON_ORDER.forEach((control, i) => { expected[control] = scancodeToDomCode(buttons[i]); });
    ['Circle Pad', 'C-Stick'].forEach((group, g) => ANALOG_ORDER.forEach((control, i) => {
        if (group === 'C-Stick' && i === 4) return; // shared modifier, listed once
        expected[`${group}:${control}`] = scancodeToDomCode(analogs[g * 5 + i]);
    }));
    return expected;
}

async function runTests() {
    if (!cfg.chromePath) {
        console.log('SKIP: Chrome not found (set CHROME_PATH).');
        return;
    }
    console.log('--- Starting Input UI Tests ---');
    const port = 8792;
    const server = await listen(port, '127.0.0.1');
    const browser = await puppeteer.launch({
        executablePath: cfg.chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.AzaharInput);

        console.log('Test 1: keymap menu opens from the Controls card...');
        assert.strictEqual(await page.$('#keymap-dialog'), null, 'Menu is built on demand');
        await page.click('#btn-keymap');
        await page.waitForFunction(() => document.getElementById('keymap-dialog')?.open);
        if (process.env.AZAHAR_CAPTURE_DIR) {
            fs.mkdirSync(process.env.AZAHAR_CAPTURE_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.AZAHAR_CAPTURE_DIR, 'keymap.png') });
        }

        console.log('Test 2: every control is listed with its key...');
        const rows = await page.$$eval('#keymap-dialog tbody tr[data-control]', trs => trs.map(tr => ({
            control: tr.dataset.control,
            key: tr.querySelector('kbd').textContent
        })));
        const keymap = await page.evaluate(() => window.AzaharInput.KEYMAP);
        assert.strictEqual(rows.length, keymap.length, 'One menu row per mapped control');
        for (const control of NATIVE_BUTTON_ORDER) {
            assert.ok(rows.some(row => row.control === control), `Menu must list ${control}`);
        }
        for (const group of ['Circle Pad', 'C-Stick']) {
            for (const control of ['Up', 'Down', 'Left', 'Right']) {
                assert.ok(rows.some(row => row.control === `${group}:${control}`), `Menu must list ${group} ${control}`);
            }
        }
        assert.ok(rows.some(row => row.control.startsWith('Touch screen')), 'Menu must explain touch input');
        assert.ok(rows.every(row => row.key.trim()), 'Every control must show a key');

        const expected = engineDefaults();
        if (expected) {
            for (const [control, code] of Object.entries(expected)) {
                const entry = keymap.find(item => `${item.group}:${item.control}` === control);
                assert.strictEqual(entry?.code, code, `${control} must match the engine default (${code})`);
            }
            console.log(`  ✓ ${Object.keys(expected).length} bindings match the engine's config.cpp`);
        } else {
            console.log('  (engine source not found next to this repo; skipped default cross-check)');
        }

        console.log('Test 3: menu keys do not reach the game and Escape closes it...');
        await page.evaluate(() => {
            window.__gameKeys = 0;
            window.addEventListener('keydown', () => window.__gameKeys++);
        });
        await page.keyboard.press('KeyA');
        assert.strictEqual(await page.evaluate(() => window.__gameKeys), 0, 'Keys typed in the menu stay in the menu');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('keymap-dialog').open);

        console.log('Test 4: the close button closes a reopened menu...');
        await page.click('#btn-keymap');
        await page.waitForFunction(() => document.getElementById('keymap-dialog').open);
        await page.click('#keymap-dialog .keymap-close');
        await page.waitForFunction(() => !document.getElementById('keymap-dialog').open);
        assert.strictEqual(await page.$$eval('#keymap-dialog', els => els.length), 1, 'The menu is reused, not duplicated');

        console.log('\n--- ALL INPUT UI TESTS PASSED! ---');
    } finally {
        await browser.close();
        server.close();
    }
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
