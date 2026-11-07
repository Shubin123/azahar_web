/**
 * game_roms.cjs
 * Finds the ROM for a build in multiplayer_games.json: the build's `rom` path under the
 * repository, or else a file whose name matches the build's `match` pattern in a folder of
 * games given with --roms DIR or AZAHAR_ROMS (searched one level deep, so a folder per game
 * works too).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config.cjs');

const ROM_FILE = /\.(3ds|cci|cxi|cia|3dsx)$/i;

function romFolders() {
    return [cfg.argVal('--roms', null), process.env.AZAHAR_ROMS].filter(Boolean).map(dir => path.resolve(dir));
}

function findIn(directory, pattern, depth = 1) {
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isFile() && ROM_FILE.test(entry.name) && !entry.name.startsWith('._') && pattern.test(entry.name)) {
            return full;
        }
    }
    if (depth > 0) {
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const found = findIn(path.join(directory, entry.name), pattern, depth - 1);
                if (found) return found;
            }
        }
    }
    return null;
}

// The ROM for `build`, or null.
function findBuildRom(build) {
    if (!build) return null;
    const listed = path.join(cfg.ROOT, build.rom);
    if (fs.existsSync(listed)) return listed;
    if (!build.match) return null;
    const pattern = new RegExp(build.match, 'i');
    for (const folder of romFolders()) {
        const found = findIn(folder, pattern);
        if (found) return found;
    }
    return null;
}

module.exports = { findBuildRom, romFolders };
