/**
 * Azahar Web — AI look-ahead (azahar_ai_lookahead.js)
 * System 2's slow, deliberate way to play (the widget's Look ahead option). Rather than
 * letting NitroGen (System 1, azahar_ai_player.js) play straight on, the game is saved
 * every COMMIT frames (AzaharUI.captureState) and NitroGen plays the next HORIZON frames
 * from there under each of a few plans: as planned (the last choice's own continuation,
 * then NitroGen on), the heading alone, with jump, with dash and jump (pulled that way as
 * its actions are denoised, as the planner steers it), and unsteered. The best future is
 * played on DEEPER frames more (a death shows only a while after it starts), the next best
 * taking its place if it then dies; when none lives on, harder plans are tried (a held jump,
 * a short hop, backing off). The game goes back to the saved state and the chosen future's
 * stops of game time and keys up to the COMMIT point are replayed: the emulator plays the
 * same stops and keys from the same state the same way.
 *
 * A future is judged by whether it lived, then whether it kept moving, then how far it got,
 * all read off the screen the same way in any game: how far the top screen scrolled the
 * heading's way; stuck when it stopped scrolling near the end; lost when the screen went
 * dark. (Tests can judge by New Super Mario Bros. 2's own progress bar instead, which this
 * file also reads for them: reader 'meter'.)
 *
 * The heading is the planner's when one runs (System 2: it looks at the committed game now
 * and then, works menus itself, and its own choice of button is tried as a future of its
 * own), otherwise to the right. The game waits while it thinks: play goes about 20 times
 * slower than real time.
 */
(() => {
    'use strict';

    const KEY = 'azahar-ai-lookahead';
    const FRAME_US = 1e6 / 60;
    const HORIZON = 90;              // frames each future runs
    const COMMIT = 45;               // frames of the best one kept before looking again
    const SETTLE = 40;               // frames before a future's end where it should still move
    const DEEPER = 60;               // frames the chosen future then plays on, to be sure of it
    const LOOK_EVERY_US = 5e6;       // committed game time between the planner's looks
    const MENU_FRAMES = 90;          // the game runs this long after the planner works a menu
    // Near dangers (the widget's middle choice): NitroGen plays on its own between dangers.
    const FREE_FRAMES = 30;          // frames of free play between checks
    const CHECK_EVERY_US = 1.5e6;    // game time between the saves free play can go back to
    const RING = 8;                  // saves kept to go back to (free play's and careful steps')
    const STALL_FRAMES = 45;         // frames without getting on that mean a failure
    const DARK_US = 1.5e6;           // a dark spell this long is a failure (shorter: a pipe, a door)
    const CAREFUL_STALL_US = 6e6;    // careful play getting no further this long is a dead end
    const CELL = 16;                 // pixels a side of the cells of a level the player has been in
    const PROGRESS = 8;              // pixels further the heading's way that count as getting on
    const REWIND_US = 1e6;           // how long before a failure the save gone back to is
    const GATE_BEFORE = 200;         // pixels before a place it failed at where care begins
    const GATE_AFTER = 48;           // and after it, where care ends
    const CAREFUL_PAST = 96;         // pixels past a failure it plays carefully
    const BACKUPS = 5;               // times it backs up around a place before playing on
    const ENEMY_RANGE = 180;         // pixels ahead in which a known enemy calls for care
    const ENEMY_LIKE = 0.6;          // colour-signature overlap that makes a thing a known enemy
    const SAME_LEVEL = 12;           // how alike two levels' starts look (mean colour difference) to be one
    const LIT_FRAMES = 20;           // frames lit in a row that end a dark spell between levels
    const LEVEL_SHOWN = 60;          // and that begin a level (past the opening iris, to see how it starts)
    const MEMORY_KEY = 'azahar-ai-memory';
    const STAGE_CLEARED = 'Look at the game screen. Did the player just finish the level (the goal flag reached, or a ' +
        'course clear), rather than lose a life? Answer yes or no.';
    const SOURCE = 'lookahead';
    // Buttons for jump and dash (the planner's names: NitroGen's south and west buttons);
    // B and Y in Nintendo's platformers.
    const JUMP = 'B', DASH = 'Y';

    const state = {
        enabled: false, running: false, cancel: false, steps: 0, startUs: 0, startedAt: 0,
        tried: [], chosen: null, reading: null, reader: 'scroll', lastLookUs: -Infinity, error: '', replayError: 0,
        horizon: HORIZON, commit: COMMIT, verify: false, verifyLog: [],
        mode: 'off',                 // 'off', 'dangers' or 'always'
    };
    // What it learned in this game (kept in this browser, per game): enemies, the moving
    // things beside the player when it failed ({hist: colour signature, n}), known in every
    // level; and levels ({sig: how its start looks, gates, cleared}), each with its gates, the
    // places it failed at ({pos: pixels the scene scrolled from the level's start, n}).
    let memory = {enemies: [], levels: []};
    // (A level's places along the way it goes: sideways, or up and down, gatesY.)
    const gates = () => (!state.level ? [] : state.axis === 'y' ? (state.level.gatesY ||= []) : state.level.gates);
    const els = {};
    // The future or replay under way: {t0, scroll: whether to measure it, total: scroll seen,
    // previous: last band, lastUs, bands: Map(game time -> band) around the commit point}.
    let watch = null;

    const ui = () => window.AzaharUI;
    const player = () => window.AzaharAIPlayer;
    const planner = () => window.AzaharAIPlanner;
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const freeze = () => ui().setGuestStopUs(ui().getGuestTimeUs());
    // Saves and loads happen with the game held: the engine does them as a step of their own
    // and keeps a held game where the load put it, so every future and replay starts exactly
    // at the saved state.
    async function restore(checkpoint) {
        freeze();
        await ui().restoreState(checkpoint.bytes);
        freeze();
    }
    async function untilGuest(us, stopIf = null) {
        while (ui().getGuestTimeUs() < us) {
            if (state.cancel) throw new Error('cancelled');
            if (stopIf?.()) return;
            await tick();
        }
    }

    // ── Reading the game ─────────────────────────────────────────

    // New Super Mario Bros. 2: in a level, the bottom screen shows the yellow WORLD banner
    // (rows 5-30) and a progress bar with Mario's red marker (rows 50-80) from x 27.5 (start)
    // to 262 (the goal). {progress: 0-1, or null when the marker is hidden (over the Bowser
    // icon at the end, or while Mario dies)}, or null when no level is shown.
    function nsmb2Meter(screens) {
        const data = screens.data;
        const px = (x, y) => ((240 + y) * 400 + 40 + x) * 4;
        let yellow = 0, sum = 0, count = 0;
        for (let y = 5; y < 30; y++) {
            for (let x = 10; x < 150; x++) {
                const i = px(x, y);
                if (data[i] > 200 && data[i + 1] > 170 && data[i + 2] < 90) yellow++;
            }
        }
        if (yellow <= 300) return null;
        for (let y = 50; y < 80; y++) {
            for (let x = 0; x < 260; x++) {
                const i = px(x, y);
                if (data[i] > 180 && data[i + 1] < 80 && data[i + 2] < 80) {
                    sum += x;
                    count++;
                }
            }
        }
        return {progress: count > 20 ? (sum / count - 27.5) / (262 - 27.5) : null};
    }

    function darkness(screens) {
        let sum = 0, count = 0;
        for (let i = 0; i < 400 * 240 * 4; i += 4 * 53) {
            sum += screens.data[i] + screens.data[i + 1] + screens.data[i + 2];
            count++;
        }
        return sum / count / 3;
    }

    // The top screen's lower band (where the ground is), grey, for measuring scroll.
    const BAND = {from: 120, to: 236, every: 2, shift: 8};
    function band(screens) {
        const rows = Math.ceil((BAND.to - BAND.from) / BAND.every);
        const out = new Float32Array(rows * 400);
        for (let r = 0; r < rows; r++) {
            const y = BAND.from + r * BAND.every;
            for (let x = 0; x < 400; x++) {
                const i = (y * 400 + x) * 4;
                out[r * 400 + x] = screens.data[i] + screens.data[i + 1] + screens.data[i + 2];
            }
        }
        return out;
    }

    // How far the picture moved left to right between two bands (pixels; the scene moves
    // left when the camera goes right).
    function shiftBetween(previous, next) {
        const rows = previous.length / 400, s = BAND.shift;
        let best = 0, bestCost = Infinity;
        for (let d = -s; d <= s; d++) {
            let cost = 0;
            for (let r = 0; r < rows; r++) {
                const base = r * 400;
                for (let x = s; x < 400 - s; x++) cost += Math.abs(next[base + x + d] - previous[base + x]);
            }
            // Flat scenes match any shift: prefer none.
            cost += Math.abs(d) * rows;
            if (cost < bestCost) {
                bestCost = cost;
                best = d;
            }
        }
        return best;
    }

    // The top screen, grey (r+g+b per pixel), for measuring how far the camera went up or down.
    function grey(screens) {
        const out = new Float32Array(400 * 240), d = screens.data;
        for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j] + d[j + 1] + d[j + 2];
        return out;
    }

    // How far the picture moved down between two frames (pixels; the scene moves down when
    // the camera goes up), its move sideways (`dx`) taken out. Rows 32-232: past a heads-up
    // display along the top.
    function vShiftBetween(previous, next, dx) {
        const s = BAND.shift;
        let best = 0, bestCost = Infinity;
        for (let d = -s; d <= s; d++) {
            let cost = 0, n = 0;
            for (let x = 16; x < 384; x += 4) {
                for (let y = 32; y < 232; y += 2) {
                    cost += Math.abs(next[(y + d) * 400 + x + dx] - previous[y * 400 + x]);
                    n++;
                }
            }
            // (Flat scenes match any shift: prefer none.)
            cost += Math.abs(d) * n / 50;
            if (cost < bestCost) {
                bestCost = cost;
                best = d;
            }
        }
        return best;
    }

    // Called by the player after each frame while it looks ahead, at game time `now`. Only
    // frames the game moved on count: one shown while it waits for NitroGen can come back blank.
    function onFrame(now) {
        if (!watch || now === watch.lastUs) return;
        watch.lastUs = now;
        const screens = player().captureScreens();
        if (!screens) return;
        // A step of game time without a new picture leaves the canvas blank to read: not a
        // frame. Many in a row: the game itself went black.
        if (blank(screens)) {
            watch.blankRun++;
            if (watch.blankRun >= BLACK_RUN) watch.wentDark = true;
            if (watch.between && watch.blankRun >= BLACK_RUN) betweenFrame(screens, true);
            else if (watch.free && watch.blankRun >= BLACK_RUN) freeDark(now);
            return;
        }
        watch.blankRun = 0;
        watch.last = screens;
        if (watch.between) {
            betweenFrame(screens, darkness(screens) < 12);
            return;
        }
        if (watch.free) {
            if (darkness(screens) < 12) {
                freeDark(now);
                return;
            }
            if (state.darkSince !== null) freeLit(now);
        }
        // (A future that went dark and came back lit: through a pipe or a door, elsewhere.)
        if (watch.track) {
            if (darkness(screens) < 12) watch.wentDark = true;
            else if (watch.wentDark) watch.cut = true;
        }
        if (watch.midAt && !watch.mid && now >= watch.midAt) watch.mid = {screens, scroll: cameraAlong(watch), at: watch.lastAt};
        if (now - watch.t0 <= state.commit * FRAME_US + FRAME_US / 2) {
            watch.atCommit = screens;
            watch.atCommitScroll = watch.total;
            watch.atCommitScrollY = watch.totalY || 0;
            watch.atCommitPlayer = watch.player;
        }
        const nearCommit = state.verify || Math.abs(now - watch.t0 - state.commit * FRAME_US) <= 3 * FRAME_US;
        if (!watch.scroll && !nearCommit) return;
        const next = band(screens);
        let shift = 0, shiftY = 0;
        if (watch.scroll) {
            const picture = grey(screens);
            if (watch.previous) {
                shift = shiftBetween(watch.previous, next);
                shiftY = vShiftBetween(watch.picture, picture, shift);
            }
            watch.total -= shift;
            watch.totalY = (watch.totalY || 0) - shiftY;
            watch.previous = next;
            watch.picture = picture;
        }
        if (nearCommit) watch.bands.set(now, next);
        if (watch.free) freeFrame(now, screens, shift, shiftY);
        else if (watch.track) trackFrame(screens, shift, shiftY);
    }

    // A frame of a future: where the player goes (every third frame, against that frame).
    function trackFrame(screens, shift, shiftY) {
        watch.trackShift = (watch.trackShift || 0) + shift;
        watch.trackShiftY = (watch.trackShiftY || 0) + shiftY;
        if (++watch.trackFrames % 3) return;
        const cells = cellsOf(screens);
        if (watch.cells) {
            watch.player = playerAmong(movingThings(cells, watch.cells, watch.trackShift), watch.player);
            if (watch.player) {
                const at = alongOf(watch.player.x - watch.scrolled, watch.player.y - watch.scrolledY);
                if (watch.first === undefined) watch.first = at;
                watch.lastAt = at;
            }
        }
        watch.cells = cells;
        watch.scrolled = (watch.scrolled || 0) + watch.trackShift;
        watch.scrolledY = (watch.scrolledY || 0) + watch.trackShiftY;
        watch.trackShift = 0;
        watch.trackShiftY = 0;
    }

    // ── Near dangers: free play, failures, what they teach ───────

    // A frame of free play: where in the level it is, what moves on screen, whether it failed
    // (the screen went dark, or the scene stopped for STALL_FRAMES: stuck, or dying) and
    // whether a danger is near (a place it failed at, a known enemy ahead).
    function freeFrame(now, screens, shift, shiftY) {
        state.pos -= shift;
        state.posY -= shiftY;
        noteCamera(-shift, -shiftY, 1, now);
        const cells = cellsOf(screens);
        if (watch.cells) {
            const things = movingThings(cells, watch.cells, shift);
            state.player = playerAmong(things, state.player);
            visit();
            state.seen.push({us: now, things, player: state.player});
            if (state.seen.length > 120) state.seen.shift();
            if (!watch.danger) watch.danger = dangerNear(things);
        }
        watch.cells = cells;
        // (Getting on: further the heading's way than it has been, by the scene scrolling or the
        // player crossing the screen, as at a level's start before the scene follows. A player
        // dying stops, then hops straight up; its sprite's changes move its centre a little.)
        if ((where() - state.moveMark) * headingSign() >= PROGRESS) {
            state.moveMark = where();
            state.movedUs = now;
            gotOn(now);
        }
        if (now - state.movedUs >= STALL_FRAMES * FRAME_US && !state.ending) {
            watch.failed = {kind: 'stalled', since: state.movedUs, pos: where()};
        }
        // (Half a second after a cut: a scene of this level seen before means it began again,
        // a life lost, rather than a pipe or door to elsewhere.)
        // (Only against the scenes saved before the cut, and only soon after it.)
        if (state.cutCheck && now >= state.cutCheck.at) {
            if (now - state.cutCheck.at < 0.5e6 && seenBefore(screens, state.cutCheck.scenes)) {
                watch.failed ||= {kind: 'began again', since: state.cutCheck.since, pos: where()};
            }
            state.cutCheck = null;
        }
    }

    // Whether a scene looks like one this level showed before (its start, a save's: the first
    // `upTo` of them).
    const seenBefore = (screens, upTo = state.scenes.length) => {
        const sig = signature(screens);
        return state.scenes.slice(0, upTo).some(seen => sigDistance(seen, sig) < SAME_LEVEL);
    };

    // A dark frame in free play: a death, a stage's end, or a pipe or door to another part of
    // the level. Dark for DARK_US (at a stage's end, at once) is a failure; the stall clock
    // waits meanwhile.
    function freeDark(now) {
        state.darkSince ??= now;
        state.movedUs = now;
        if (state.ending || now - state.darkSince >= DARK_US) {
            watch.failed ||= {kind: 'dark', since: state.darkSince, pos: where()};
        }
    }

    // Lit again after a short dark spell: another part of the level. The player is found anew,
    // and nothing is measured across the cut.
    function freeLit(now) {
        state.cutCheck = {at: now + 0.5e6, since: state.darkSince, scenes: state.scenes.length};
        state.darkSince = null;
        Object.assign(watch, {cells: null, previous: null, picture: null});
        state.player = null;
        state.moveMark = where();
        state.movedUs = now;
        gotOn(now);
    }

    // The cells of the level the player has been in (free play, and each careful step's
    // commit point), and how new a place is: how many cells from the nearest of them (up to 8).
    function visit() {
        if (!state.player || !state.visited) return;
        state.visited.add(`${Math.floor((state.pos + state.player.x) / CELL)},${Math.floor((state.posY + state.player.y) / CELL)}`);
    }
    function novelty({x, y}) {
        const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
        for (let d = 0; d < 8; d++) {
            for (let dx = -d; dx <= d; dx++) {
                for (let dy = -d; dy <= d; dy++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) === d && state.visited.has(`${cx + dx},${cy + dy}`)) return d;
                }
            }
        }
        return 8;
    }

    // Getting on, for careful play's stall clock: where it last got further from, and when.
    function gotOn(now) {
        state.gotOn = {at: where(), us: now};
    }

    // Where in the level the player is, along the way the level goes: how far the scene
    // scrolled since the level began, plus where on the screen the player is. Sideways (x),
    // or up and down (y, counted upward).
    const alongOf = (x, y) => (state.axis === 'y' ? -y : x);
    const where = () => alongOf(state.pos + (state.player?.x ?? 180), state.posY + (state.player?.y ?? 170));
    // How far a future's camera went along the level's way.
    const cameraAlong = w => alongOf(w.total, w.totalY || 0);

    // Which way the level goes, from where the camera went of late (camera moves, pixels,
    // over `frames` frames; the net move, so jumps up and back down cancel): up or down once it
    // went that way three times as far as sideways and at least 96 pixels (a climb, a shaft),
    // sideways again the other way round.
    function noteCamera(dx, dy, frames, now) {
        const keep = 0.99 ** frames, c = state.camera;
        c.x = c.x * keep + dx;
        c.y = c.y * keep + dy;
        const x = Math.abs(c.x), y = Math.abs(c.y);
        const axis = y > 3 * x && y > 96 ? 'y' : x > 3 * y && x > 96 ? 'x' : state.axis;
        if (axis === state.axis) return;
        state.axis = axis;
        state.down = c.y > 0;
        // (Places along the old way mean nothing along the new.)
        state.deadEnds = {};
        state.carefulUntil = -Infinity;
        state.moveMark = where();
        state.movedUs = now;
        gotOn(now);
    }

    // The top screen in 4x4-pixel cells (100x60, each its mean colour).
    const GRID = {w: 100, h: 60, cell: 4};
    function cellsOf(screens) {
        const out = new Float32Array(GRID.w * GRID.h * 3), d = screens.data;
        for (let cy = 0; cy < GRID.h; cy++) {
            for (let cx = 0; cx < GRID.w; cx++) {
                let r = 0, g = 0, b = 0;
                for (const [dx, dy] of [[1, 1], [2, 2], [1, 2], [2, 1]]) {
                    const i = ((cy * 4 + dy) * 400 + cx * 4 + dx) * 4;
                    r += d[i];
                    g += d[i + 1];
                    b += d[i + 2];
                }
                const o = (cy * GRID.w + cx) * 3;
                out[o] = r / 4;
                out[o + 1] = g / 4;
                out[o + 2] = b / 4;
            }
        }
        return out;
    }

    // The things that moved against the scrolling scene since the last frame: compact groups
    // of cells that changed, each {x, y (its centre, top-screen pixels), n (cells), hist (its
    // colours, 4 levels a channel)}. Long thin changes (a scrolling backdrop's edges) are not
    // things.
    function movingThings(cells, previous, shift) {
        const {w, h} = GRID, s = Math.round(shift / GRID.cell);
        const moved = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const from = x - s;
                if (from < 0 || from >= w) continue;
                const a = (y * w + x) * 3, b = (y * w + from) * 3;
                if (Math.abs(cells[a] - previous[b]) + Math.abs(cells[a + 1] - previous[b + 1]) +
                    Math.abs(cells[a + 2] - previous[b + 2]) > 80) moved[y * w + x] = 1;
            }
        }
        const things = [];
        const queue = new Int32Array(w * h);
        for (let start = 0; start < w * h; start++) {
            if (moved[start] !== 1) continue;
            let head = 0, tail = 0, n = 0, sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
            const hist = new Float32Array(64);
            queue[tail++] = start;
            moved[start] = 2;
            while (head < tail) {
                const at = queue[head++], x = at % w, y = (at - x) / w;
                n++;
                sx += x;
                sy += y;
                x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
                const o = at * 3;
                hist[(cells[o] >> 6) * 16 + (cells[o + 1] >> 6) * 4 + (cells[o + 2] >> 6)]++;
                for (const next of [at - 1, at + 1, at - w, at + w]) {
                    if (next < 0 || next >= w * h || moved[next] !== 1) continue;
                    if (Math.abs((next % w) - x) > 1) continue;
                    moved[next] = 2;
                    queue[tail++] = next;
                }
            }
            const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
            if (n < 3 || bw > 12 || bh > 12 || n / (bw * bh) < 0.3) continue;
            for (let i = 0; i < 64; i++) hist[i] /= n;
            things.push({x: (sx / n) * GRID.cell + 2, y: (sy / n) * GRID.cell + 2, n, hist});
        }
        return things;
    }

    // The player: the moving thing that carries on from where the player was (at first, the
    // one nearest the middle of the screen's lower half); where it was when nothing moves.
    function playerAmong(things, was) {
        const from = was || {x: 180, y: 170};
        let best = null, bestDistance = was ? 40 : Infinity;
        for (const thing of things) {
            const distance = Math.hypot(thing.x - from.x, thing.y - from.y);
            if (distance < bestDistance) {
                best = thing;
                bestDistance = distance;
            }
        }
        return best ? {x: best.x, y: best.y, thing: best} : was;
    }

    const likeness = (a, b) => {
        let sum = 0;
        for (let i = 0; i < 64; i++) sum += Math.min(a[i], b[i]);
        return sum;
    };

    function headingSign() {
        const plan = planner()?.state().plan;
        const move = plan?.mode === 'play' ? plan.move : null;
        if (state.axis === 'y') return move === 'down' || (move !== 'up' && state.down) ? -1 : 1;
        return move === 'left' ? -1 : 1;
    }

    // A reason to play carefully now: a place it failed at just ahead, or a known enemy ahead.
    function dangerNear(things) {
        const x = where();
        const gate = gates().find(g => x >= g.pos - runUp(g) && x <= g.pos + GATE_AFTER);
        if (gate) return `where it failed before (${gate.n}x)`;
        const player = state.player;
        if (!player || !memory.enemies.length) return null;
        const sign = headingSign();
        for (const thing of things) {
            if (thing === player.thing) continue;
            const ahead = (alongOf(thing.x, thing.y) - alongOf(player.x, player.y)) * sign;
            const aside = state.axis === 'y' ? Math.abs(thing.x - player.x) : Math.abs(thing.y - player.y);
            if (ahead < -24 || ahead > ENEMY_RANGE || aside > 100) continue;
            if (memory.enemies.some(enemy => likeness(enemy.hist, thing.hist) >= ENEMY_LIKE)) return 'a known enemy ahead';
        }
        return null;
    }

    // A failure teaches: the place (a gate) and, when something moving was beside the player
    // as it stopped, that thing's look (an enemy).
    function learn(failure) {
        const gate = gates().find(g => Math.abs(g.pos - failure.pos) < 64);
        if (gate) gate.n++;
        else gates().push({pos: Math.round(failure.pos), n: 1});
        let killer = null, nearest = 64;
        for (const seen of state.seen) {
            if (seen.us > failure.since || seen.us < failure.since - 20 * FRAME_US || !seen.player) continue;
            for (const thing of seen.things) {
                if (thing === seen.player.thing) continue;
                const distance = Math.hypot(thing.x - seen.player.x, thing.y - seen.player.y);
                if (distance < nearest) {
                    killer = thing;
                    nearest = distance;
                }
            }
        }
        if (killer) {
            const known = memory.enemies.find(enemy => likeness(enemy.hist, killer.hist) >= 0.8);
            if (known) known.n++;
            else memory.enemies.push({hist: [...killer.hist], n: 1});
        }
        state.learned.push({kind: failure.kind, pos: Math.round(failure.pos), enemy: Boolean(killer)});
        saveMemory();
    }

    const gameKey = () => `${MEMORY_KEY}:${ui()?.getRomName?.() || 'game'}`;
    function loadMemory() {
        try {
            memory = JSON.parse(localStorage.getItem(gameKey())) || {};
        } catch (_) {
            memory = {};
        }
        // (Places kept before levels were told apart belong to no level now.)
        memory = {enemies: memory.enemies || [], levels: memory.levels || []};
    }
    function saveMemory() {
        try { localStorage.setItem(gameKey(), JSON.stringify(memory)); } catch (_) {}
    }

    // NitroGen plays FREE_FRAMES frames on its own (as the planner steers it, if one runs),
    // from a save made now and then; on a failure the game goes back to a save from before
    // it, and what it taught is kept.
    async function freeStep() {
        state.planned = null;
        if (!state.ring.length || ui().getGuestTimeUs() - state.ring.at(-1).us >= CHECK_EVERY_US) {
            keep(await ui().captureState(), ui().getGuestTimeUs());
        }
        planner()?.override(undefined);
        const t0 = ui().getGuestTimeUs();
        watch = {t0, scroll: true, free: true, total: 0, previous: null, cells: null, lastUs: null, bands: new Map(),
            blankRun: 0, last: null, atCommit: null, failed: null, danger: null};
        const recording = player().rollout();
        let seen;
        try {
            render('playing');
            await untilGuest(t0 + FREE_FRAMES * FRAME_US, () => watch.failed || watch.danger);
        } finally {
            recording.stop();
            seen = watch;
            watch = null;
            freeze();
        }
        state.freeUs += ui().getGuestTimeUs() - t0;
        state.freeSteps++;
        state.here = reading(seen.last, seen.blankRun);
        if (seen.failed?.kind === 'dark' && state.ending) {
            levelOver();
        } else if (seen.failed) {
            learn(seen.failed);
            await goBack(seen.failed);
        } else if (seen.danger) {
            state.why = seen.danger;
            state.carefulLeft = Math.max(state.carefulLeft, 2);
        }
    }

    // A save to go back to: the game, when and where.
    function keep(checkpoint, us) {
        state.checkpoint = checkpoint;
        if (state.ring.at(-1)?.us === us) return;
        if (state.here?.screens && !state.here.dark) {
            state.scenes.push(signature(state.here.screens));
            if (state.scenes.length > 200) state.scenes.splice(1, 1);
        }
        state.ring.push({checkpoint, us, pos: state.pos, posY: state.posY, player: state.player});
        if (state.ring.length > RING) state.ring.shift();
    }

    // Back to the latest save from REWIND_US or more before the failure, to play carefully
    // until past it; failing at the same place again backs up further (backUp).
    async function goBack(failure) {
        if ((state.deadEnds[Math.round(failure.pos / 64)] || 0) > 0) {
            await backUp(failure.pos, failure.kind);
            return;
        }
        state.deadEnds[Math.round(failure.pos / 64)] = 1;
        let i = state.ring.length - 1;
        while (i > 0 && state.ring[i].us > failure.since - REWIND_US) i--;
        await backTo(i, failure.pos);
    }

    // Backtracking: stuck at `pos` again (a failure where it failed already, or no future
    // that lives on), it goes back 2, 4, then 8 saves, and plays carefully from there, with
    // fresh futures, until past it.
    async function backUp(pos, why, atLeast = 0) {
        const place = Math.round(pos / 64);
        state.deadEnds[place] = (state.deadEnds[place] || 0) + 1;
        const steps = Math.min(state.ring.length - 1, Math.max(atLeast, 2 ** Math.min(3, state.deadEnds[place] - 1)));
        state.backtracks++;
        const gate = gates().find(g => Math.abs(g.pos - pos) < 64);
        if (gate) gate.n++;
        else gates().push({pos: Math.round(pos), n: 1});
        saveMemory();
        state.learned.push({kind: why, pos: Math.round(pos), enemy: false, back: steps});
        await backTo(Math.max(0, state.ring.length - 1 - steps), pos);
    }

    async function backTo(i, failedAt) {
        const save = state.ring[i];
        state.ring.length = i + 1;
        await restore(save.checkpoint);
        state.pos = save.pos;
        state.posY = save.posY;
        state.player = save.player;
        state.moveMark = where();
        state.movedUs = ui().getGuestTimeUs();
        state.darkSince = null;
        state.cutCheck = null;
        gotOn(state.movedUs);
        state.seen = [];
        state.carefulUntil = Math.max(state.carefulUntil, failedAt + CAREFUL_PAST);
        state.why = 'it failed here';
        state.rewinds++;
        state.planned = null;
        state.here = await stepAndLook();
    }

    // ── Levels ───────────────────────────────────────────────────

    // How a level's start looks: the top screen in 16x10 blocks, each its mean colour.
    function signature(screens) {
        const out = [];
        for (let by = 0; by < 10; by++) {
            for (let bx = 0; bx < 16; bx++) {
                let r = 0, g = 0, b = 0, n = 0;
                for (let y = by * 24 + 2; y < by * 24 + 24; y += 4) {
                    for (let x = bx * 25 + 2; x < bx * 25 + 25; x += 4) {
                        const i = (y * 400 + x) * 4;
                        r += screens.data[i];
                        g += screens.data[i + 1];
                        b += screens.data[i + 2];
                        n++;
                    }
                }
                out.push(Math.round(r / n), Math.round(g / n), Math.round(b / n));
            }
        }
        return out;
    }

    const sigDistance = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;

    // A level begins (the run starts, or the screen comes back after going dark between
    // levels): a level it knows by how its start looks, with the places it failed at there,
    // or a new one. Where it is counts from here.
    function startLevel(screens) {
        const sig = screens ? signature(screens) : null;
        let level = sig && memory.levels.find(known => sigDistance(known.sig, sig) < SAME_LEVEL);
        if (!level) {
            level = {sig: sig || [], gates: [], cleared: 0};
            memory.levels.push(level);
            saveMemory();
        }
        Object.assign(state, {level, between: null, checkpoint: null, pos: 0, posY: 0, axis: 'x', down: false,
            camera: {x: 0, y: 0}, player: null, seen: [], ring: [], deadEnds: {}, visited: new Set(),
            scenes: sig ? [sig] : [], cutCheck: null,
            carefulLeft: 0, carefulUntil: -Infinity, ending: false, ownWay: {steps: 0, walked: 0, free: 0}, planned: null,
            moveMark: 0, movedUs: ui().getGuestTimeUs(), darkSince: null, levelsEntered: state.levelsEntered + 1});
        state.moveMark = where();
        gotOn(state.movedUs);
    }

    // The stage was cleared and the screen went dark: the level is over. Its saves are of no
    // use from here.
    function levelOver() {
        if (state.level) state.level.cleared = (state.level.cleared || 0) + 1;
        saveMemory();
        Object.assign(state, {between: {phase: 'leaving', lit: 0}, levelsCleared: state.levelsCleared + 1, ring: [],
            deadEnds: {}, carefulLeft: 0, carefulUntil: -Infinity, ending: false, planned: null, why: 'between levels'});
    }

    // Between levels (a map, a menu, a level's intro card): NitroGen plays on (the planner
    // working menus), with no saves and nothing taken for a failure. The screen comes back
    // from the level's end; when it next goes dark and comes back, the next level begins.
    async function betweenStep() {
        await consultPlanner(state.here);
        const t0 = ui().getGuestTimeUs();
        watch = {t0, scroll: false, between: true, lastUs: null, bands: new Map(), blankRun: 0, last: null, atCommit: null};
        const recording = player().rollout();
        let seen;
        try {
            render('between levels');
            await untilGuest(t0 + FREE_FRAMES * FRAME_US, () => state.between.phase === 'started');
        } finally {
            recording.stop();
            seen = watch;
            watch = null;
            freeze();
        }
        state.freeUs += ui().getGuestTimeUs() - t0;
        state.freeSteps++;
        state.here = reading(seen.last, seen.blankRun);
        if (state.between.phase === 'started') startLevel(seen.last);
    }

    // A frame between levels: dark spells and the lit stretches after them.
    function betweenFrame(screens, dark) {
        const between = state.between;
        if (dark) {
            between.lit = 0;
            if (between.phase === 'map') between.phase = 'entering';
            return;
        }
        between.lit++;
        if (between.phase === 'leaving' && between.lit >= LIT_FRAMES) between.phase = 'map';
        else if (between.phase === 'entering' && between.lit >= LEVEL_SHOWN) between.phase = 'started';
    }

    // How far before a place it failed at care begins: further the more often it failed there.
    const runUp = gate => GATE_BEFORE * Math.min(4, gate.n);

    // Whether to play carefully (look ahead) now, and why.
    function careful() {
        if (state.mode === 'always') return 'always';
        if (state.carefulLeft > 0) return state.why;
        const x = where();
        if (x < state.carefulUntil) return 'it failed here';
        const gate = gates().find(g => x >= g.pos - runUp(g) && x <= g.pos + GATE_AFTER);
        return gate ? `where it failed before (${gate.n}x)` : null;
    }

    function blank(screens) {
        for (let i = 0; i < screens.data.length; i += 4 * 61) {
            if (screens.data[i] || screens.data[i + 1] || screens.data[i + 2]) return false;
        }
        return true;
    }

    const BLACK_RUN = 10;            // blank reads in a row that mean the game went black

    // What a frame shows: {screens, inLevel and meter (New Super Mario Bros. 2's bar: 0-1 or
    // null), dark}.
    function reading(screens, blankRun = 0) {
        const bar = screens ? nsmb2Meter(screens) : null;
        return {screens, inLevel: Boolean(bar), meter: bar?.progress ?? null,
            dark: blankRun >= BLACK_RUN || !screens || darkness(screens) < 12};
    }

    // How far apart two bands are (mean per pixel and colour, 0-255).
    function bandDifference(a, b) {
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
        return sum / a.length / 3;
    }

    // The game a frame on, read (`steps` frames at most, while reads come back blank).
    async function stepAndLook(steps = BLACK_RUN) {
        for (let i = 0; i < steps; i++) {
            const shot = player().nextFrameScreens(true);
            ui().setGuestStopUs(ui().getGuestTimeUs() + FRAME_US);
            const screens = await shot;
            freeze();
            if (screens && !blank(screens)) return reading(screens);
        }
        return reading(null, BLACK_RUN);
    }

    // ── Searching ────────────────────────────────────────────────

    // The futures to try: the heading alone, with jump, with dash and jump, NitroGen
    // unsteered, and the planner's own choice when it names another button (a game whose
    // jump is elsewhere); none presses a button the planner wants avoided.
    function plans() {
        const plan = planner()?.state().plan;
        const steering = plan?.mode === 'play';
        const heading = steering && plan.move !== 'none' ? plan.move : 'right';
        const avoid = steering ? plan.avoid : [];
        const list = [{move: heading, avoid}, {move: heading, press: [JUMP], avoid}, {move: heading, press: [DASH, JUMP], avoid},
            null].filter(p => !p?.press?.some(b => avoid.includes(b)));
        if (steering && plan.press.length && !list.some(p => p?.press?.join() === plan.press.join())) {
            list.unshift({move: heading, press: plan.press, avoid});
        }
        return list;
    }

    // When none of those lives on: a held jump (the heading and jump held for a moment, then
    // NitroGen on), a short hop, run and jump once more (NitroGen draws anew each time), and
    // backing off.
    const OPPOSITE = {left: 'right', right: 'left', up: 'down', down: 'up'};
    // Stuck at a place (it backed up there twice or more), long jumps too: running (and
    // dashing) its way, jumping after 0-40 frames, held for 25, and running on through the
    // air (a long jump at the right moment, which NitroGen's own draws may never find); and
    // running and dashing all the way (keeping the speed it has, in the air too).
    function harderPlans(stuck = false) {
        const plan = planner()?.state().plan;
        const steering = plan?.mode === 'play';
        const heading = steering && plan.move !== 'none' ? plan.move : 'right';
        const jump = steering && plan.press.length ? plan.press[0] : JUMP;
        const avoid = steering ? plan.avoid : [];
        const plans = [{move: heading, press: [jump], avoid, hold: 20}, {move: heading, press: [jump], avoid, hold: 8},
            {move: heading, press: [jump], avoid}, {move: OPPOSITE[heading], avoid}];
        if (stuck) {
            for (const after of [0, 8, 16, 24, 32, 40]) {
                plans.push({move: heading, press: [DASH, jump], avoid, run: after, hold: 25, then: HORIZON});
            }
            plans.push({move: heading, press: [DASH], avoid, hold: HORIZON});
            // (Down, or up, held a while: into a pipe, through a door, the way on elsewhere; and
            // the same after a hop the heading's way, onto the pipe first.)
            const hop = {move: heading, press: [jump]};
            plans.push({move: 'down', press: [], avoid, hold: 30, enter: true}, {move: 'up', press: [], avoid, hold: 30, enter: true},
                {move: 'down', press: [], avoid, hold: 40, enter: true, hop}, {move: 'up', press: [], avoid, hold: 40, enter: true, hop});
        }
        return plans;
    }

    // How often it backed up within 128 pixels of `x`.
    function backupsNear(x) {
        const place = Math.round(x / 64);
        return Math.max(0, ...[-2, -1, 0, 1, 2].map(d => state.deadEnds?.[place + d] || 0));
    }

    // Whether it backed up twice or more at a place up to 400 pixels ahead (backing up starts
    // it again in the run-up to it) or just behind.
    function stuckHere() {
        const x = where(), sign = headingSign();
        return Object.entries(state.deadEnds || {}).some(([at, n]) => n >= 2 && (at * 64 - x) * sign <= 400 &&
            (at * 64 - x) * sign >= -64);
    }

    // The keys a plan holds itself, part after part: running first (`run` frames, with dash),
    // then its buttons too (`hold` frames), then running on (`then` frames, with dash).
    function heldParts(plan) {
        if (!plan?.hold) return null;
        const running = {codes: heldCodes({move: plan.move, press: plan.press.filter(b => b === DASH)})};
        const parts = [];
        if (plan.run) parts.push({...running, frames: plan.run});
        if (plan.hop) parts.push({codes: heldCodes(plan.hop), frames: 24});
        parts.push({codes: heldCodes(plan), frames: plan.hold});
        if (plan.then) parts.push({...running, frames: plan.then});
        return parts;
    }

    // The keys a plan holds itself (a held jump): the Circle Pad its way and its button.
    function heldCodes(plan) {
        const code = (group, control) => window.AzaharInput.KEYMAP.find(e => e.group === group && e.control === control)?.code;
        const pad = {left: 'Left', right: 'Right', up: 'Up', down: 'Down'}[plan.move];
        return [pad && code('Circle Pad', pad), ...plan.press.map(b => code('Face buttons', b))].filter(Boolean);
    }

    const buttonName = b => (b === JUMP ? 'jump' : b === DASH ? 'dash' : b);
    const planName = plan => (plan ? `${plan.move}${plan.press?.length ? ` + ${plan.press.map(buttonName).join(' + ')}` : ''}` +
        (plan.run !== undefined ? ` after ${plan.run}` : '') + (plan.hop ? ' after a hop' : '') + (plan.hold ? ` held ${plan.hold}` : '') +
        (plan.then ? ' running on' : '') : 'NitroGen alone');
    const futureName = f => (f.planned ? `as planned (${planName(f.plan)})` : planName(f.plan));

    // One future from the saved state under `plan`: what NitroGen held on each frame and how it went.
    // One future from the saved state under `plan`: its stops and keys, and how it went.
    // `planned`: stops and keys to play first, exactly (the last choice's own continuation).
    async function future(checkpoint, plan, here, planned = null) {
        await restore(checkpoint);
        planner()?.override(plan);
        const t0 = ui().getGuestTimeUs();
        const end = t0 + state.horizon * FRAME_US;
        watch = {t0, scroll: true, total: 0, previous: null, lastUs: null, bands: new Map(), blankRun: 0,
            last: null, atCommit: null, midAt: end - SETTLE * FRAME_US, mid: null,
            track: state.mode === 'dangers', trackFrames: 0, scrolled: 0, cells: null, player: state.player};
        const played = [];
        for (const [stop, keys] of planned || []) {
            if (stop > end) break;
            window.AzaharInput.setSourceCodes(SOURCE, keys);
            ui().setGuestStopUs(stop);
            await untilGuest(stop);
            played.push([stop, keys]);
        }
        window.AzaharInput.setSourceCodes(SOURCE, []);
        const recording = player().rollout(planned ? null : heldParts(plan));
        try {
            await untilGuest(end);
            const last = reading(watch.last, watch.blankRun);
            const mid = watch.mid ? reading(watch.mid.screens) : last;
            const midScroll = watch.mid?.scroll ?? cameraAlong(watch);
            const metered = state.reader === 'meter' && here.inLevel;
            // Leaving the level at its end is the best a future can do.
            const goal = metered && !last.inLevel && !last.dark && Math.max(mid.meter ?? 0, here.meter ?? 0) > 0.93;
            // (Cut back to a scene of this level seen before: it began again, a life lost.)
            const alive = goal || (metered ? last.inLevel : !last.dark && !(watch.cut && last.screens && seenBefore(last.screens)));
            // (Moving: the camera going on, or the player going on the heading's way while the
            // camera stands, as at a level's end.)
            const moving = goal || (metered ? mid.meter !== null && last.meter !== null && Math.abs(last.meter - mid.meter) > 0.001
                : Math.abs(cameraAlong(watch) - midScroll) >= 2 || playerGoesOn(watch.mid?.at));
            const progress = goal ? 2 : metered ? last.meter ?? -1 : cameraAlong(watch) * headingSign();
            // (How far the player went the heading's way in the level, against the scene.)
            const walked = watch.first === undefined ? 0 : (watch.lastAt - watch.first) * headingSign();
            // (Where the player ends up in the level, and how far that is from anywhere it has been.)
            const endsAt = watch.player && {x: state.pos + watch.total + watch.player.x, y: state.posY + (watch.totalY || 0) + watch.player.y};
            return {plan, planned: Boolean(planned), alive, moving, progress, goal, steps: [...played, ...recording.take()],
                bands: watch.bands, atCommit: reading(watch.atCommit), commitScroll: watch.atCommitScroll,
                commitScrollY: watch.atCommitScrollY, playerAtCommit: watch.atCommitPlayer, walked,
                cut: Boolean(watch.cut), novelty: endsAt ? novelty(endsAt) : 0};
        } finally {
            recording.stop();
            watch = null;
            freeze();
        }
    }

    // A future played on DEEPER frames: its own frames replayed, then NitroGen on under the
    // same plan (a death shows only a while after it starts: the scene stops, much later the
    // screen goes black). Whether it still lives and moves at the end.
    async function further(checkpoint, chosen) {
        await restore(checkpoint);
        // (Watched from the save on, to follow the player through the replayed part too.)
        watch = {t0: ui().getGuestTimeUs(), scroll: true, total: 0, previous: null, lastUs: null, bands: new Map(), blankRun: 0,
            last: null, atCommit: null, track: state.mode === 'dangers', trackFrames: 0, scrolled: 0, cells: null,
            player: state.player};
        let recording = null;
        try {
            for (const [stop, keys] of chosen.steps) {
                window.AzaharInput.setSourceCodes(SOURCE, keys);
                ui().setGuestStopUs(stop);
                await untilGuest(stop);
            }
            window.AzaharInput.setSourceCodes(SOURCE, []);
            freeze();
            planner()?.override(chosen.plan);
            const t0 = ui().getGuestTimeUs();
            recording = player().rollout();
            await untilGuest(t0 + (DEEPER - SETTLE / 2) * FRAME_US);
            const midScroll = cameraAlong(watch), midAt = watch.lastAt;
            await untilGuest(t0 + DEEPER * FRAME_US);
            const end = reading(watch.last, watch.blankRun);
            return {alive: !end.dark, moving: Math.abs(cameraAlong(watch) - midScroll) >= 2 || playerGoesOn(midAt),
                steps: recording.take()};
        } finally {
            recording?.stop();
            watch = null;
            freeze();
        }
    }

    // Whether the player (followed in a future) went 8 pixels or more the heading's way since
    // it was at `from`.
    const playerGoesOn = from => from !== undefined && watch.lastAt !== undefined &&
        (watch.lastAt - from) * headingSign() >= PROGRESS;

    const rank = f => (f.alive ? 2 : 0) + (f.moving ? 1 : 0);
    const better = (a, b) => rank(b) > rank(a) || (rank(b) === rank(a) && b.progress > a.progress);
    // Stuck at a place, it explores: what lives on and gets elsewhere (a cut: a pipe, a door),
    // else what lives on and ends up where the player has not been, the newer the better.
    const exploreRank = f => (f.alive ? 4 : 0) + (f.alive && f.cut ? 2 : 0);
    const explores = (a, b) => exploreRank(b) > exploreRank(a) || (exploreRank(b) === exploreRank(a) &&
        (b.novelty > a.novelty || (b.novelty === a.novelty && b.progress > a.progress)));

    // The best future's first COMMIT frames from the saved state, exactly as it played them:
    // the same stops of game time with the same keys. How far the game is then from what that
    // future showed at the same moments: `replayError` (and `unaligned` when no frame of the
    // two fell at the same moment). The game is then as that future showed it at the commit
    // point (its reading there stands for the replay's).
    async function replay(checkpoint, {steps, bands}) {
        await restore(checkpoint);
        const t0 = ui().getGuestTimeUs();
        watch = {t0, scroll: false, lastUs: null, bands: new Map(), blankRun: 0, last: null, atCommit: null};
        try {
            // (The stops as NitroGen set them, to the last bit: the core compares game time with them.)
            for (const [stop, keys] of steps) {
                const last = stop - t0 >= state.commit * FRAME_US;
                window.AzaharInput.setSourceCodes(SOURCE, keys);
                ui().setGuestStopUs(stop);
                await untilGuest(stop);
                if (last) break;
            }
            let worst = null;
            for (const [time, seenBand] of watch.bands) {
                if (bands.has(time)) worst = Math.max(worst ?? 0, bandDifference(bands.get(time), seenBand));
            }
            if (state.verify) {
                // (Debugging: where the replay first parts from the future, in ms of game time.)
                const parts = [...watch.bands].filter(([time]) => bands.has(time))
                    .find(([time, seenBand]) => bandDifference(bands.get(time), seenBand) > 1);
                const picture = data => {
                    const canvas = new OffscreenCanvas(400, data.length / 400);
                    const image = new ImageData(400, data.length / 400);
                    data.forEach((value, i) => image.data.set([value / 3, value / 3, value / 3, 255], 4 * i));
                    canvas.getContext('2d').putImageData(image, 0, 0);
                    return canvas.convertToBlob({type: 'image/png'})
                        .then(blob => blob.arrayBuffer()).then(buffer => [...new Uint8Array(buffer)]);
                };
                state.verifyLog.push({compared: [...watch.bands.keys()].filter(time => bands.has(time)).length,
                    partsAtMs: parts ? Math.round((parts[0] - t0) / 1000) : null, worst,
                    pictures: parts && state.verifyLog.length < 2
                        ? {future: await picture(bands.get(parts[0])), replay: await picture(parts[1])} : null});
            }
            if (worst === null) state.unaligned++;
            else state.replayError = Math.max(state.replayError, worst);
        } finally {
            watch = null;
            window.AzaharInput.setSourceCodes(SOURCE, []);
            freeze();
        }
    }

    // The planner, if one runs, looks at the committed game now and then (it works menus
    // itself: the game then runs on a moment with nothing else held).
    async function consultPlanner(seen) {
        const p = planner();
        if (!p?.state().loaded || !seen.screens) return;
        const now = ui().getGuestTimeUs();
        if (now - state.lastLookUs < LOOK_EVERY_US && now >= state.lastLookUs) return;
        state.lastLookUs = now;
        render('the planner looks…');
        const plan = await p.look(seen.screens, now);
        if (plan?.mode !== 'menu') return;
        p.operate(plan, now);
        ui().setGuestStopUs(now + MENU_FRAMES * FRAME_US);
        await untilGuest(now + MENU_FRAMES * FRAME_US);
        freeze();
    }

    async function run() {
        if (state.running) return;
        loadMemory();
        Object.assign(state, {running: true, cancel: false, steps: 0, tried: [], chosen: null, error: '', replayError: 0, unaligned: 0,
            harder: 0, freeSteps: 0, startUs: ui().getGuestTimeUs(), startedAt: performance.now(), lastLookUs: -Infinity,
            pos: 0, moveMark: 0, movedUs: ui().getGuestTimeUs(), player: null, seen: [], ring: [], rewinds: 0, freeUs: 0,
            carefulUs: 0, carefulLeft: 0, carefulUntil: -Infinity, why: '', learned: [], planned: null,
            deadEnds: {}, backtracks: 0, ending: false, ownWay: {steps: 0, walked: 0, free: 0},
            between: null, level: null, levelsEntered: 0, levelsCleared: 0});
        ui().setUncapped(true);
        freeze();
        // Where the game is: a frame on (a held game shows no new frame to read).
        state.here = await stepAndLook();
        // (It starts in a level.)
        startLevel(state.here.screens);
        try {
            while (!state.cancel) {
                if (state.mode === 'dangers' && state.ending && state.here.dark) levelOver();
                if (state.mode === 'dangers' && state.between) {
                    await betweenStep();
                    continue;
                }
                const why = careful();
                if (!why) {
                    await consultPlanner(state.here);
                    await freeStep();
                    continue;
                }
                state.why = why;
                const startedUs = ui().getGuestTimeUs();
                await carefulStep();
                state.carefulUs += ui().getGuestTimeUs() - startedUs;
                state.carefulLeft = Math.max(0, state.carefulLeft - 1);
                // (Careful play moved on: the stall clock starts again.)
                state.moveMark = where();
                state.movedUs = ui().getGuestTimeUs();
                state.seen = [];
                for (const place of Object.keys(state.deadEnds)) {
                    if ((where() - place * 64) * headingSign() > 2 * CAREFUL_PAST) delete state.deadEnds[place];
                }
            }
        } catch (error) {
            if (error.message !== 'cancelled') state.error = `Look-ahead stopped: ${error.message}`;
        } finally {
            planner()?.override(undefined);
            window.AzaharInput.setSourceCodes(SOURCE, []);
            ui().setGuestStopUs(0);
            ui().setUncapped(false);
            state.running = false;
            render();
        }
    }

    // One careful step: futures from a save, the best checked further, its first COMMIT
    // frames replayed.
    async function carefulStep() {
        let here = state.here, planned = state.planned;
        await consultPlanner(here);
        const checkpoint = await ui().captureState();
        const checkpointUs = ui().getGuestTimeUs();
        state.checkpoint = checkpoint;
        keep(checkpoint, checkpointUs);
        freeze();
        const tried = [];
        // As planned: the last choice's own continuation (checked further), then NitroGen on.
        if (planned) {
            render('trying the plan as it stood…');
            const result = await future(checkpoint, planned.plan, here, planned.steps);
            tried.push(result);
        }
        // (Stuck here: the timed jumps from the first.)
        const first = stuckHere() ? [...plans(), ...harderPlans(true).filter(plan => plan.run !== undefined || plan.enter)]
            : plans();
        for (const plan of first) {
            render(`trying ${planName(plan)}…`);
            tried.push(await future(checkpoint, plan, here));
        }
        // The best, if it still lives and moves DEEPER frames on; else the next best that
        // does; and when none does, the harder plans too.
        const exploring = state.mode === 'dangers' && stuckHere();
        const order = exploring ? explores : better;
        const pick = async futures => {
            const ranked = [...futures].sort((a, b) => (order(a, b) ? 1 : order(b, a) ? -1 : 0));
            for (const candidate of ranked) {
                if (candidate.goal) return candidate;
                // (Exploring, a future that lives and gets somewhere new will do.)
                const somewhere = exploring && candidate.alive && (candidate.cut || candidate.novelty > 0);
                if (!candidate.alive || !(candidate.moving || somewhere)) break;
                render(`checking ${planName(candidate.plan)} further…`);
                candidate.deeper = await further(checkpoint, candidate);
                if (candidate.deeper.alive && (candidate.deeper.moving || somewhere)) return candidate;
            }
            return null;
        };
        let best = await pick(tried);
        if (!best) {
            const harder = [];
            for (const plan of harderPlans(stuckHere()).filter(plan => !first.some(tried => planName(tried) === planName(plan)))) {
                render(`thinking harder: ${planName(plan)}…`);
                harder.push(await future(checkpoint, plan, here));
            }
            tried.push(...harder);
            state.harder++;
            best = await pick(harder) || tried.reduce((a, b) => (order(a, b) ? b : a));
        }
        planner()?.override(undefined);
        state.tried = tried;
        state.chosen = best;
        // No future lives on and gets on, even the harder ones: a dead end. Back up further,
        // up to BACKUPS times around here; then take the best and play on (a level's end or a
        // scene the game plays itself looks the same, and backing up cannot change it).
        // When every future shows the same game whatever it pressed, the game plays itself: a
        // stage's end (play on, and no backing up until the player has a say again for three
        // steps) or a death (back up past it all). The planner, when one runs, is asked
        // whether the stage was just cleared (its fine-tuned model says yes only when the
        // screen shows it, as a "course clear"); without one, the player walking on by itself
        // over two such steps is a stage's end (one may begin with a slide down a pole). (Not
        // with one: what it follows as the player can be a shell sliding on as the player dies.)
        const ownWay = tried.length > 1 && tried.every(f => f.atCommit?.screens && tried[0].atCommit?.screens &&
            bandDifference(band(f.atCommit.screens), band(tried[0].atCommit.screens)) < 1);
        const asking = Boolean(planner()?.state().loaded);
        if (ownWay) {
            state.ownWay.steps++;
            state.ownWay.walked += Math.max(0, best.walked || 0);
            state.ownWay.free = 0;
            if (asking && !state.ending && best.atCommit?.screens) {
                render('asking the planner whether the stage was cleared…');
                if (await planner().askYesNo(best.atCommit.screens, STAGE_CLEARED) === true) state.ending = true;
            } else if (!asking && state.ownWay.walked >= 24) {
                state.ending = true;
            }
        } else {
            state.ownWay.steps = 0;
            state.ownWay.walked = 0;
            if (++state.ownWay.free >= 3) state.ending = false;
        }
        const somewhere = exploring && best.alive && (best.cut || best.novelty > 0);
        if (somewhere) gotOn(checkpointUs);
        const stalled = !state.ending && checkpointUs - state.gotOn.us > CAREFUL_STALL_US;
        const deadEnd = ownWay ? state.ownWay.steps >= (asking ? 4 : 2) && !state.ending
            : !best.goal && (!(best.alive && (best.moving || somewhere)) || stalled);
        if (state.mode === 'dangers' && deadEnd && !state.ending && backupsNear(where()) < BACKUPS) {
            await backUp(where(), ownWay ? 'the player stopped and the game plays itself'
                : stalled ? 'no further for a while' : 'dead end', ownWay ? state.ownWay.steps + 1 : 0);
            state.ownWay.steps = 0;
            state.ownWay.walked = 0;
            return;
        }
        // (Backed up here as often as it does and the game still plays itself: take it for the
        // stage's end. A death taken for one costs a life, and the level comes again.)
        if (state.mode === 'dangers' && deadEnd && ownWay && !state.ending) state.ending = true;
        if (ownWay) state.why = state.ending ? 'the stage ends by itself' : 'the game plays itself';
        await replay(checkpoint, best);
        here = best.atCommit;
        // What the choice played past the commit point, to try again as planned next step.
        const commitUs = (best.steps.find(([stop]) => stop - checkpointUs >= state.commit * FRAME_US) || [Infinity])[0];
        planned = {plan: best.plan, steps: [...best.steps, ...(best.deeper?.steps || [])].filter(([stop]) => stop > commitUs)};
        state.pos += best.commitScroll ?? 0;
        state.posY += best.commitScrollY ?? 0;
        // (Where the player is then, as that future followed it.)
        if (best.playerAtCommit) state.player = best.playerAtCommit;
        visit();
        if ((where() - state.gotOn.at) * headingSign() >= PROGRESS) gotOn(ui().getGuestTimeUs());
        noteCamera(best.commitScroll ?? 0, best.commitScrollY ?? 0, state.commit, ui().getGuestTimeUs());
        state.reading = here;
        state.steps++;
        render();
        state.here = here;
        state.planned = planned;
    }

    function stop() {
        state.cancel = true;
    }

    // ── Widget ───────────────────────────────────────────────────

    function render(doing = '') {
        if (!els.status) return;
        if (state.error) {
            els.status.textContent = state.error;
            return;
        }
        if (!state.enabled) {
            els.status.textContent = '';
            return;
        }
        const places = memory.levels.reduce((sum, level) => sum + level.gates.length, 0);
        const learned = places || memory.enemies.length
            ? ` Learned in this game: ${places} place${places === 1 ? '' : 's'} it failed at in ` +
              `${memory.levels.length} level${memory.levels.length === 1 ? '' : 's'}, ` +
              `${memory.enemies.length} enem${memory.enemies.length === 1 ? 'y' : 'ies'}.` : '';
        if (els.forget) els.forget.hidden = !learned;
        if (!state.running) {
            els.status.textContent = (state.mode === 'always' ? 'On: the AI looks ahead once it plays.'
                : 'On: the AI plays on its own and looks ahead near dangers once it plays.') + learned;
            return;
        }
        const gameSeconds = (ui().getGuestTimeUs() - state.startUs) / 1e6;
        const wall = (performance.now() - state.startedAt) / 1000;
        const meter = state.reading?.meter;
        const pace = gameSeconds > 0.5 ? ` · ${(wall / gameSeconds).toFixed(0)}× slower than real time` : '';
        if (state.mode === 'dangers' && doing === 'playing') {
            els.status.textContent = `Playing on its own (careful ${Math.round(100 * state.carefulUs /
                Math.max(1, state.carefulUs + state.freeUs))}% of the time, ${state.rewinds} failures gone back from)` +
                pace + '.' + learned;
            return;
        }
        const tried = state.tried.map(f => `${futureName(f)} ${!f.alive ? 'dies' : !f.moving ? 'stuck' : 'ok'}`).join(', ');
        els.status.textContent = `Looking ahead${state.mode === 'dangers' && state.why ? ` (${state.why})` : ''}` +
            `${doing ? `: ${doing}` : ''} · ${state.steps} steps` +
            (state.chosen ? ` · last: ${tried} → ${futureName(state.chosen)}` : '') +
            (meter !== null && meter !== undefined ? ` · level ${Math.round(100 * Math.max(0, meter))}%` : '') + pace;
    }

    function setMode(mode) {
        state.mode = ['off', 'dangers', 'always'].includes(mode) ? mode : 'off';
        state.enabled = state.mode !== 'off';
        if (els.toggle) els.toggle.value = state.mode;
        render();
    }

    // Forgets what it learned in the game running now.
    function forget() {
        memory = {enemies: [], levels: []};
        // (Playing a level now: it is a new one to it.)
        if (state.running && state.level) {
            state.level = {sig: state.level.sig, gates: [], cleared: 0};
            memory.levels.push(state.level);
        }
        try { localStorage.removeItem(gameKey()); } catch (_) {}
        render();
    }

    function init() {
        els.toggle = document.getElementById('ai-lookahead');
        els.status = document.getElementById('ai-lookahead-status');
        els.forget = document.getElementById('btn-ai-forget');
        if (!els.toggle) return;
        let saved = 'off';
        try {
            saved = localStorage.getItem(KEY) || 'off';
        } catch (_) {}
        setMode(saved === '1' ? 'always' : saved);
        els.toggle.addEventListener('change', () => {
            setMode(els.toggle.value);
            try { localStorage.setItem(KEY, state.mode); } catch (_) {}
        });
        els.forget?.addEventListener('click', forget);
    }

    window.AzaharAILookahead = {
        enabled: () => state.enabled,
        running: () => state.running,
        run, stop, onFrame,
        // Tests: turn it on without the widget, and its frames and progress reading.
        configure: ({enabled, mode, horizon, commit, reader, verify} = {}) => {
            if (verify !== undefined) state.verify = Boolean(verify);
            if (mode !== undefined) setMode(mode);
            else if (enabled !== undefined) setMode(enabled ? 'always' : 'off');
            if (horizon) state.horizon = horizon;
            if (commit) state.commit = commit;
            if (reader) state.reader = reader;
        },
        stats: () => ({steps: state.steps, ticks: state.steps + (state.freeSteps ?? 0), running: state.running, error: state.error, replayError: state.replayError,
            unaligned: state.unaligned, harder: state.harder, verifyLog: state.verifyLog.slice(-3).map(entry => ({...entry, pictures: undefined})),
            verifyPictures: state.verifyLog.filter(entry => entry.pictures).map(entry => entry.pictures),
            meter: (state.mode === 'dangers' ? state.here : state.reading)?.meter ?? null,
            dark: state.reading?.dark ?? false, mode: state.mode, pos: Math.round(state.pos ?? 0), axis: state.axis ?? 'x',
            where: state.level ? Math.round(where()) : 0,
            rewinds: state.rewinds ?? 0, backtracks: state.backtracks ?? 0, why: state.why ?? '', learned: state.learned ?? [],
            freeSeconds: (state.freeUs ?? 0) / 1e6, carefulSeconds: (state.carefulUs ?? 0) / 1e6,
            memory: {gates: memory.levels.reduce((sum, level) => sum + level.gates.length, 0), enemies: memory.enemies.length,
                levels: memory.levels.length},
            between: state.between?.phase || null, levelsEntered: state.levelsEntered ?? 0, levelsCleared: state.levelsCleared ?? 0,
            level: state.level ? memory.levels.indexOf(state.level) : null,
            gameSeconds: state.running || state.steps ? (ui().getGuestTimeUs() - state.startUs) / 1e6 : 0,
            wallSeconds: state.startedAt ? (performance.now() - state.startedAt) / 1000 : 0,
            tried: state.tried.map(f => ({plan: futureName(f), alive: f.alive, moving: f.moving, progress: f.progress,
                further: f.deeper ? (f.deeper.alive ? (f.deeper.moving ? 'ok' : 'stuck') : 'dies') : null})),
            chosen: state.chosen && futureName(state.chosen),
            inLevel: (state.mode === 'dangers' ? state.here : state.reading)?.inLevel ?? false}),
        nsmb2Meter,
        // Tests: the latest save (a .cst file's bytes: the state the last step started from), and the screens
        // the last step left (ImageData, 400x480).
        checkpointBytes: () => state.checkpoint?.bytes || null,
        screens: () => (state.mode === 'dangers' ? state.here : state.reading)?.screens || null,
        // Tests: what it learned in this game, and forgetting it.
        memory: () => JSON.parse(JSON.stringify(memory)),
        forget,
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
