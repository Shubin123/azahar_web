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
    const SOURCE = 'lookahead';
    // Buttons for jump and dash (the planner's names: NitroGen's south and west buttons);
    // B and Y in Nintendo's platformers.
    const JUMP = 'B', DASH = 'Y';

    const state = {
        enabled: false, running: false, cancel: false, steps: 0, startUs: 0, startedAt: 0,
        tried: [], chosen: null, reading: null, reader: 'scroll', lastLookUs: -Infinity, error: '', replayError: 0,
        horizon: HORIZON, commit: COMMIT, verify: false, verifyLog: [],
    };
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
    async function untilGuest(us) {
        while (ui().getGuestTimeUs() < us) {
            if (state.cancel) throw new Error('cancelled');
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
            return;
        }
        watch.blankRun = 0;
        watch.last = screens;
        if (watch.midAt && !watch.mid && now >= watch.midAt) watch.mid = {screens, scroll: watch.total};
        if (now - watch.t0 <= state.commit * FRAME_US + FRAME_US / 2) watch.atCommit = screens;
        const nearCommit = state.verify || Math.abs(now - watch.t0 - state.commit * FRAME_US) <= 3 * FRAME_US;
        if (!watch.scroll && !nearCommit) return;
        const next = band(screens);
        if (watch.scroll) {
            if (watch.previous) watch.total -= shiftBetween(watch.previous, next);
            watch.previous = next;
        }
        if (nearCommit) watch.bands.set(now, next);
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
    function harderPlans() {
        const plan = planner()?.state().plan;
        const steering = plan?.mode === 'play';
        const heading = steering && plan.move !== 'none' ? plan.move : 'right';
        const jump = steering && plan.press.length ? plan.press[0] : JUMP;
        const avoid = steering ? plan.avoid : [];
        return [{move: heading, press: [jump], avoid, hold: 20}, {move: heading, press: [jump], avoid, hold: 8},
            {move: heading, press: [jump], avoid}, {move: OPPOSITE[heading], avoid}];
    }

    // The keys a plan holds itself (a held jump): the Circle Pad its way and its button.
    function heldCodes(plan) {
        const code = (group, control) => window.AzaharInput.KEYMAP.find(e => e.group === group && e.control === control)?.code;
        const pad = {left: 'Left', right: 'Right', up: 'Up', down: 'Down'}[plan.move];
        return [pad && code('Circle Pad', pad), ...plan.press.map(b => code('Face buttons', b))].filter(Boolean);
    }

    const buttonName = b => (b === JUMP ? 'jump' : b === DASH ? 'dash' : b);
    const planName = plan => (plan ? `${plan.move}${plan.press ? ` + ${plan.press.map(buttonName).join(' + ')}` : ''}` +
        (plan.hold ? ` held ${plan.hold}` : '') : 'NitroGen alone');
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
            last: null, atCommit: null, midAt: end - SETTLE * FRAME_US, mid: null};
        const played = [];
        for (const [stop, keys] of planned || []) {
            if (stop > end) break;
            window.AzaharInput.setSourceCodes(SOURCE, keys);
            ui().setGuestStopUs(stop);
            await untilGuest(stop);
            played.push([stop, keys]);
        }
        window.AzaharInput.setSourceCodes(SOURCE, []);
        const recording = player().rollout(plan?.hold && !planned ? {codes: heldCodes(plan), frames: plan.hold} : null);
        try {
            await untilGuest(end);
            const last = reading(watch.last, watch.blankRun);
            const mid = watch.mid ? reading(watch.mid.screens) : last;
            const midScroll = watch.mid?.scroll ?? watch.total;
            const metered = state.reader === 'meter' && here.inLevel;
            // Leaving the level at its end is the best a future can do.
            const goal = metered && !last.inLevel && !last.dark && Math.max(mid.meter ?? 0, here.meter ?? 0) > 0.93;
            const alive = goal || (metered ? last.inLevel : !last.dark);
            const moving = goal || (metered ? mid.meter !== null && last.meter !== null && Math.abs(last.meter - mid.meter) > 0.001
                : Math.abs(watch.total - midScroll) >= 2);
            const progress = goal ? 2 : metered ? last.meter ?? -1 : watch.total;
            return {plan, planned: Boolean(planned), alive, moving, progress, goal, steps: [...played, ...recording.take()],
                bands: watch.bands, atCommit: reading(watch.atCommit)};
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
        for (const [stop, keys] of chosen.steps) {
            window.AzaharInput.setSourceCodes(SOURCE, keys);
            ui().setGuestStopUs(stop);
            await untilGuest(stop);
        }
        window.AzaharInput.setSourceCodes(SOURCE, []);
        freeze();
        planner()?.override(chosen.plan);
        const t0 = ui().getGuestTimeUs();
        watch = {t0, scroll: true, total: 0, previous: null, lastUs: null, bands: new Map(), blankRun: 0,
            last: null, atCommit: null};
        const recording = player().rollout();
        try {
            await untilGuest(t0 + (DEEPER - SETTLE / 2) * FRAME_US);
            const midScroll = watch.total;
            await untilGuest(t0 + DEEPER * FRAME_US);
            const end = reading(watch.last, watch.blankRun);
            return {alive: !end.dark, moving: Math.abs(watch.total - midScroll) >= 2, steps: recording.take()};
        } finally {
            recording.stop();
            watch = null;
            freeze();
        }
    }

    const rank = f => (f.alive ? 2 : 0) + (f.moving ? 1 : 0);
    const better = (a, b) => rank(b) > rank(a) || (rank(b) === rank(a) && b.progress > a.progress);

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
        Object.assign(state, {running: true, cancel: false, steps: 0, tried: [], chosen: null, error: '', replayError: 0, unaligned: 0,
            harder: 0,
            startUs: ui().getGuestTimeUs(), startedAt: performance.now(), lastLookUs: -Infinity});
        ui().setUncapped(true);
        freeze();
        // Where the game is: a frame on (a held game shows no new frame to read).
        let here = await stepAndLook();
        let planned = null;
        try {
            while (!state.cancel) {
                await consultPlanner(here);
                const checkpoint = await ui().captureState();
                const checkpointUs = ui().getGuestTimeUs();
                state.checkpoint = checkpoint;
                freeze();
                const tried = [];
                // As planned: the last choice's own continuation (checked further), then NitroGen on.
                if (planned) {
                    render('trying the plan as it stood…');
                    const result = await future(checkpoint, planned.plan, here, planned.steps);
                    tried.push(result);
                }
                for (const plan of plans()) {
                    render(`trying ${planName(plan)}…`);
                    tried.push(await future(checkpoint, plan, here));
                }
                // The best, if it still lives and moves DEEPER frames on; else the next best that
                // does; and when none does, the harder plans too.
                const pick = async futures => {
                    const ranked = [...futures].sort((a, b) => (better(a, b) ? 1 : better(b, a) ? -1 : 0));
                    for (const candidate of ranked) {
                        if (candidate.goal) return candidate;
                        if (!candidate.alive || !candidate.moving) break;
                        render(`checking ${planName(candidate.plan)} further…`);
                        candidate.deeper = await further(checkpoint, candidate);
                        if (candidate.deeper.alive && candidate.deeper.moving) return candidate;
                    }
                    return null;
                };
                let best = await pick(tried);
                if (!best) {
                    const harder = [];
                    for (const plan of harderPlans()) {
                        render(`thinking harder: ${planName(plan)}…`);
                        harder.push(await future(checkpoint, plan, here));
                    }
                    tried.push(...harder);
                    state.harder++;
                    best = await pick(harder) || tried.reduce((a, b) => (better(a, b) ? b : a));
                }
                planner()?.override(undefined);
                state.tried = tried;
                state.chosen = best;
                await replay(checkpoint, best);
                here = best.atCommit;
                // What the choice played past the commit point, to try again as planned next step.
                const commitUs = (best.steps.find(([stop]) => stop - checkpointUs >= state.commit * FRAME_US) || [Infinity])[0];
                planned = {plan: best.plan, steps: [...best.steps, ...(best.deeper?.steps || [])].filter(([stop]) => stop > commitUs)};
                state.reading = here;
                state.steps++;
                render();
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
        if (!state.running) {
            els.status.textContent = 'On: the AI looks ahead once it plays.';
            return;
        }
        const gameSeconds = (ui().getGuestTimeUs() - state.startUs) / 1e6;
        const wall = (performance.now() - state.startedAt) / 1000;
        const meter = state.reading?.meter;
        const tried = state.tried.map(f => `${futureName(f)} ${!f.alive ? 'dies' : !f.moving ? 'stuck' : 'ok'}`).join(', ');
        els.status.textContent = `Looking ahead${doing ? `: ${doing}` : ''} · ${state.steps} steps` +
            (state.chosen ? ` · last: ${tried} → ${futureName(state.chosen)}` : '') +
            (meter !== null && meter !== undefined ? ` · level ${Math.round(100 * Math.max(0, meter))}%` : '') +
            (gameSeconds > 0.5 ? ` · ${(wall / gameSeconds).toFixed(0)}× slower than real time` : '');
    }

    function init() {
        els.toggle = document.getElementById('ai-lookahead');
        els.status = document.getElementById('ai-lookahead-status');
        if (!els.toggle) return;
        try {
            els.toggle.checked = localStorage.getItem(KEY) === '1';
        } catch (_) {}
        state.enabled = els.toggle.checked;
        els.toggle.addEventListener('change', () => {
            state.enabled = els.toggle.checked;
            try { localStorage.setItem(KEY, state.enabled ? '1' : '0'); } catch (_) {}
            render();
        });
        render();
    }

    window.AzaharAILookahead = {
        enabled: () => state.enabled,
        running: () => state.running,
        run, stop, onFrame,
        // Tests: turn it on without the widget, and its frames and progress reading.
        configure: ({enabled, horizon, commit, reader, verify} = {}) => {
            if (verify !== undefined) state.verify = Boolean(verify);
            if (enabled !== undefined) state.enabled = Boolean(enabled);
            if (horizon) state.horizon = horizon;
            if (commit) state.commit = commit;
            if (reader) state.reader = reader;
            if (els.toggle) els.toggle.checked = state.enabled;
            render();
        },
        stats: () => ({steps: state.steps, running: state.running, error: state.error, replayError: state.replayError,
            unaligned: state.unaligned, harder: state.harder, verifyLog: state.verifyLog.slice(-3).map(entry => ({...entry, pictures: undefined})),
            verifyPictures: state.verifyLog.filter(entry => entry.pictures).map(entry => entry.pictures),
            meter: state.reading?.meter ?? null, dark: state.reading?.dark ?? false,
            gameSeconds: state.running || state.steps ? (ui().getGuestTimeUs() - state.startUs) / 1e6 : 0,
            wallSeconds: state.startedAt ? (performance.now() - state.startedAt) / 1000 : 0,
            tried: state.tried.map(f => ({plan: futureName(f), alive: f.alive, moving: f.moving, progress: f.progress,
                further: f.deeper ? (f.deeper.alive ? (f.deeper.moving ? 'ok' : 'stuck') : 'dies') : null})),
            chosen: state.chosen && futureName(state.chosen), inLevel: state.reading?.inLevel ?? false}),
        nsmb2Meter,
        // Tests: the state the last step started from (a .cst file's bytes), and the screens
        // the last step left (ImageData, 400x480).
        checkpointBytes: () => state.checkpoint?.bytes || null,
        screens: () => state.reading?.screens || null,
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
