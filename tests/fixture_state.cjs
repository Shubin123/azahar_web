'use strict';
// Restores a captured .cst fixture into a running page. The file name must keep
// the "<programId>.<slot>.cst" form that capture_fixture.cjs writes, because
// the core looks states up by title and slot.
const fs = require('node:fs');
const path = require('node:path');

async function restoreState(page, statePath, { timeout = 180000 } = {}) {
    const name = path.basename(statePath).replace(/\.\d+\.cst$/i, '.01.cst');
    const base64 = fs.readFileSync(statePath).toString('base64');
    await page.evaluate((name, base64) => {
        const module = window.AzaharUI.getModule();
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const directory = '/home/web_user/.local/share/azahar-emu/states';
        module.FS.mkdirTree(directory);
        module.FS.writeFile(`${directory}/${name}`, bytes);
        const request = module._azahar_load_state(1);
        if (request !== 0) throw new Error(`azahar_load_state rejected slot 1: ${request}`);
    }, name, base64);
    // The request is consumed by the emulation loop; wait until it has run.
    await page.waitForFunction(() => window.AzaharUI.getModule()._azahar_get_state_operation() === 0,
        { timeout, polling: 250 });
}

module.exports = { restoreState };
