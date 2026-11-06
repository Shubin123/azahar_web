/**
 * guest_time.cjs
 * Waits measured in a console's own game time. Scripted steps for a game's menus
 * (multiplayer_games.json) were written against consoles at full speed; a console
 * that runs slower (two browsers sharing one machine, several consoles sharing one
 * page) would otherwise finish its steps before the game reached the screens they
 * were meant for.
 */
'use strict';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Waits until the console in `target` (a page or frame) has run `ms` of game time.
// A console that stops advancing (paused, or held by Local Play pacing) gives up
// after 30 times as long in real time, or 30 s.
async function guestSleep(target, ms) {
    const now = () => target.evaluate(() => window.AzaharNetplay.guestTimeUs());
    const until = await now() + ms * 1000;
    const started = Date.now();
    while (Date.now() - started < Math.max(ms * 30, 30000)) {
        await sleep(Math.min(250, ms));
        if (await now() >= until) return;
    }
    throw new Error(`the console did not advance ${ms} ms of game time`);
}

module.exports = { guestSleep };
