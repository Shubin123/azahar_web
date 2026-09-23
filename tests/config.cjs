/**
 * Shared test configuration — auto-detects Chrome, ROM, and save-state paths.
 *
 * Usage:
 *   const cfg = require('./config.cjs');
 *   // cfg.chromePath, cfg.romPath, cfg.statePath, cfg.buildDir, cfg.webDir
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

// --- Chrome auto-detection ---
const CHROME_CANDIDATES = process.platform === 'win32'
  ? [
      process.env.CHROME_PATH,
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
  : process.platform === 'darwin'
  ? [
      process.env.CHROME_PATH,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]
  : [
      process.env.CHROME_PATH,
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];

const chromePath = CHROME_CANDIDATES.filter(Boolean).find(p => {
  try { return fs.statSync(p.trim()).isFile(); } catch { return false; }
});

// --- ROM auto-detection ---
const TEST_GAMES_DIR = path.join(ROOT, 'test_games');
let romPath = null;
try {
  const romFile = fs.readdirSync(TEST_GAMES_DIR)
    .find(f => /\.(3ds|3dsx|cia)$/i.test(f));
  if (romFile) romPath = path.join(TEST_GAMES_DIR, romFile);
} catch {}

// --- Save-state auto-detection (prefer mario-moving for gameplay benchmarks) ---
const STATE_CANDIDATES = [
  path.join(ROOT, 'tmp_test', 'gameplay_state', 'mario-moving'),
  path.join(ROOT, 'tmp_test', 'gameplay_state'),
];
let statePath = null;
for (const dir of STATE_CANDIDATES) {
  try {
    // Walk into timestamped subdirectories to find .cst files
    const findCst = (d) => {
      for (const entry of fs.readdirSync(d)) {
        const full = path.join(d, entry);
        const st = fs.statSync(full);
        if (st.isFile() && entry.endsWith('.cst')) return full;
        if (st.isDirectory()) {
          const found = findCst(full);
          if (found) return found;
        }
      }
      return null;
    };
    const found = findCst(dir);
    if (found) { statePath = found; break; }
  } catch {}
}

// --- Build directory auto-detection ---
// Respect the build used to produce the served artifacts. The accelerated
// OpenGL/WebGL2 directory takes precedence over older experimental builds so
// smoke tests do not compare web/ against an unrelated stale linker output.
const requestedBuildDir = process.env.AZAHAR_BUILD_DIR
  ? path.resolve(ROOT, process.env.AZAHAR_BUILD_DIR)
  : null;
const buildDir = requestedBuildDir || [
  path.join(ROOT, 'build-webgl2-opengl'),
  path.join(ROOT, 'build-web2'),
  path.join(ROOT, 'build-web'),
].find(candidate => fs.existsSync(candidate));

const webDir = path.join(ROOT, 'web');

// --- CLI helper: parse --key value from process.argv ---
function argVal(key, fallback) {
  const idx = process.argv.indexOf(key);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}
function argFlag(key) { return process.argv.includes(key); }

module.exports = {
  ROOT,
  chromePath: chromePath ? chromePath.trim() : null,
  romPath,
  statePath,
  buildDir,
  webDir,
  argVal,
  argFlag,
};
