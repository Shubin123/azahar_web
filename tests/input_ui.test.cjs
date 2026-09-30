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

        console.log('Test 5: keymap lists gamepad bindings...');
        const padLabels = await page.$$eval('#keymap-dialog tbody tr[data-control]', trs => Object.fromEntries(
            trs.map(tr => [tr.dataset.control, tr.querySelector('.keymap-pad').textContent])));
        assert.match(padLabels['Face buttons:A'], /Right face button/);
        assert.match(padLabels['Circle Pad:Up'], /Left stick/);
        assert.match(padLabels['C-Stick:Right'], /Right stick/);
        assert.match(padLabels['Shoulders:ZR'], /Right trigger/);
        assert.match(await page.$eval('#btn-keymap + .gamepad-status', el => el.textContent), /No gamepad connected/);

        console.log('Test 6: gamepad input reaches the game as key events...');
        await page.evaluate(() => {
            const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
            window.__pad = { id: 'Test Pad (STANDARD GAMEPAD)', connected: true, index: 0, mapping: 'standard',
                buttons, axes: [0, 0, 0, 0] };
            window.__pads = [window.__pad];
            navigator.getGamepads = () => window.__pads;
            window.__keyLog = [];
            const record = event => window.__keyLog.push({ type: event.type, code: event.code, keyCode: event.keyCode });
            window.addEventListener('keydown', record);
            window.addEventListener('keyup', record);
            window.dispatchEvent(new Event('gamepadconnected'));
        });
        await page.waitForFunction(() => document.querySelector('#btn-keymap + .gamepad-status').textContent.includes('Test Pad connected'));
        const pressed = () => page.evaluate(() => window.AzaharInput.getPressedCodes().sort());
        const waitPressed = async (codes, label) => {
            await page.waitForFunction(expected => JSON.stringify(window.AzaharInput.getPressedCodes().sort()) === expected,
                { timeout: 2000 }, JSON.stringify([...codes].sort())).catch(async error => {
                console.error(`${label}: pressed`, await pressed());
                throw error;
            });
        };

        await page.evaluate(() => { window.__pad.buttons[1] = { pressed: true, value: 1 }; });
        await waitPressed(['KeyA'], 'right face button');
        assert.deepStrictEqual(await page.evaluate(() => window.__keyLog.at(-1)),
            { type: 'keydown', code: 'KeyA', keyCode: 65 }, 'The 3DS A key must be sent with SDL\'s keyCode');
        await page.evaluate(() => { window.__pad.buttons[1] = { pressed: false, value: 0 }; });
        await waitPressed([], 'released face button');
        assert.deepStrictEqual(await page.evaluate(() => window.__keyLog.at(-1)),
            { type: 'keyup', code: 'KeyA', keyCode: 65 });

        await page.evaluate(() => { window.__pad.buttons[7] = { pressed: false, value: 0.8 }; });
        await waitPressed(['Digit2'], 'analog trigger');
        await page.evaluate(() => { window.__pad.buttons[7] = { pressed: false, value: 0 }; window.__pad.axes = [1, 0, 0, -1]; });
        await waitPressed(['ArrowRight', 'KeyI'], 'full stick tilt');
        await page.evaluate(() => { window.__pad.axes = [0.5, 0, 0, 0]; });
        await waitPressed(['ArrowRight', 'KeyD'], 'half stick tilt');
        await page.evaluate(() => { window.__pad.axes = [0.1, -0.1, 0.2, 0]; });
        await waitPressed([], 'stick in dead zone');
        await page.evaluate(() => { window.__pad.buttons[12] = { pressed: true, value: 1 }; window.__pad.buttons[9] = { pressed: true, value: 1 }; });
        await waitPressed(['KeyM', 'KeyT'], 'D-pad and Start together');

        console.log('Test 7: disconnecting the pad releases held keys...');
        await page.evaluate(() => {
            window.__pads = [];
            window.dispatchEvent(new Event('gamepaddisconnected'));
        });
        await waitPressed([], 'disconnected pad');
        const lastUps = await page.evaluate(() => window.__keyLog.slice(-2).map(e => `${e.type}:${e.code}`).sort());
        assert.deepStrictEqual(lastUps, ['keyup:KeyM', 'keyup:KeyT'], 'Held keys must be released on disconnect');
        await page.waitForFunction(() => document.querySelector('#btn-keymap + .gamepad-status').textContent.includes('No gamepad'));

        console.log('Test 8: the emulator listens for keys on window...');
        await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('Emulator ready'),
            { timeout: 60000 });
        const session = await page.createCDPSession();
        const { result } = await session.send('Runtime.evaluate', { expression: 'window' });
        const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
        const scripts = new Map();
        session.on('Debugger.scriptParsed', event => scripts.set(event.scriptId, event.url));
        await session.send('Debugger.enable');
        const keyListenerScripts = listeners.filter(l => l.type === 'keydown').map(l => scripts.get(l.scriptId) || '');
        assert.ok(keyListenerScripts.some(url => /azahar(_webgl2)?\.js$/.test(url)),
            `SDL keydown listener must be on window, found: ${JSON.stringify(keyListenerScripts)}`);

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
