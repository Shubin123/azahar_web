'use strict';
// A local Windows launch option; it does not change the site's renderer policy
// or the user's normal Chrome profile.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const cfg = require('../tests/config.cjs');

async function main() {
    if (process.platform !== 'win32') throw new Error('This launcher is for Windows.');
    if (!cfg.chromePath) throw new Error('Google Chrome was not found. Set CHROME_PATH to its executable.');
    const port = Number(process.env.PORT || 8765);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
    const url = `http://localhost:${port}/`;
    const ready = async () => {
        try {
            const response = await fetch(url, {signal: AbortSignal.timeout(1000)});
            if (!response.ok || !(await response.text()).includes('AzaharWebConfig')) {
                throw new Error(`Another server is using port ${port}. Choose a different PORT.`);
            }
            return true;
        } catch (error) {
            if (error.message.startsWith('Another server')) throw error;
            return false;
        }
    };
    if (!(await ready())) {
        const server = spawn(process.execPath, [path.join(cfg.ROOT, 'web', 'server.cjs')], {
            cwd: cfg.ROOT, env: {...process.env, PORT: String(port), HOST: '127.0.0.1'},
            detached: true, windowsHide: true, stdio: 'ignore',
        });
        server.unref();
        let started = false;
        for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 250));
            if (await ready()) { started = true; break; }
        }
        if (!started) throw new Error('The local Azahar server could not start.');
    }
    const profile = path.join(process.env.LOCALAPPDATA, 'AzaharWeb', 'ChromeVulkan');
    fs.mkdirSync(profile, {recursive: true});
    const chrome = spawn(cfg.chromePath, [`--user-data-dir=${profile}`, '--use-angle=vulkan', url], {
        detached: true, windowsHide: true, stdio: 'ignore',
    });
    chrome.on('error', error => {console.error(error.message); process.exitCode = 1;});
    chrome.unref();
    console.log(`Azahar: ${url} — Chrome Vulkan, using its own local profile.`);
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
