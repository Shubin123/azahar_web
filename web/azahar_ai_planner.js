/**
 * Azahar Web — AI planner (azahar_ai_planner.js)
 * System 2 of the AI player. While NitroGen (System 1, azahar_ai_player.js) plays, a small
 * vision-language model (azahar_ai_planner_worker.js) looks at both screens every few
 * seconds, with the player's notes (quest log, task at hand, manual pages), and decides the
 * bigger picture. It steers NitroGen rather than replacing it:
 *
 *   play   NitroGen's actions are pulled the planner's way as they are denoised (its
 *          heading on the Circle Pad, the buttons it favours), NitroGen makes several such
 *          chunks per decision (one batched run) and the one that goes the planner's way
 *          the most is played; buttons the planner wants avoided are never pressed.
 *   menu   NitroGen waits while the planner works a menu, a dialogue or the bottom screen
 *          itself: one button press or one touch per look, looking again soon after.
 *
 * Nothing is fetched until a planner model is chosen in the widget.
 */
(() => {
    'use strict';

    // This deploy's stamp (see azahar_ui.js) on the worker too.
    const build = new URL(document.currentScript?.src || location.href).searchParams.get('v');
    const WORKER_URL = build ? `azahar_ai_planner_worker.js?v=${encodeURIComponent(build)}` : 'azahar_ai_planner_worker.js';
    const NOTES_KEY = 'azahar-ai-planner-notes';
    const PLAY_EVERY_US = 5e6;       // game time between looks while NitroGen plays
    const MENU_EVERY_US = 1.5e6;     // and while the planner works a menu itself
    const PRESS_MS = 120;
    const STEER_DRAWS = 4;           // NitroGen's candidate chunks per decision while steered
    const STEER_STEPS = 8;           // the actions of a chunk that play before the next decision
    // How hard the denoising flow is pulled (azahar_ai_worker.js's guide): the heading fully
    // (the stick goes that way), favoured buttons halfway (NitroGen still decides when).
    const PULL = {heading: 1, press: 0.5};
    // NitroGen's stick values (0-1, 0.5 at rest; y grows downwards) for each heading.
    const STICK = {up: [22, 0], down: [22, 1], left: [21, 0], right: [21, 1]};
    const SCREENS = {width: 400, height: 480, bottom: {x: 40, y: 240, w: 320, h: 240}};
    // The planner's buttons as NitroGen names them (azahar_input.js's pad mapping) and as
    // azahar_input.js's KEYMAP does.
    const NITROGEN = {A: 'EAST', B: 'SOUTH', X: 'NORTH', Y: 'WEST', L: 'LEFT_SHOULDER', R: 'RIGHT_SHOULDER'};
    const KEYS = {A: ['Face buttons', 'A'], B: ['Face buttons', 'B'], X: ['Face buttons', 'X'], Y: ['Face buttons', 'Y'],
        L: ['Shoulders', 'L'], R: ['Shoulders', 'R'], up: ['D-pad', 'Up'], down: ['D-pad', 'Down'],
        left: ['D-pad', 'Left'], right: ['D-pad', 'Right']};
    const HEADING = {up: [0, -1, 'DPAD_UP'], down: [0, 1, 'DPAD_DOWN'], left: [-1, 0, 'DPAD_LEFT'], right: [1, 0, 'DPAD_RIGHT']};
    const OPPOSITE = {up: 'down', down: 'up', left: 'right', right: 'left'};

    const state = {
        // fixed: a plan set by steer() (tests) rather than by a model's looks.
        name: 'off', loaded: false, fixed: false, busy: false, thinking: false, plan: null, lastUs: -Infinity,
        drivingUntil: -Infinity, looks: 0, unparsed: 0, lastMs: 0, error: '',
    };
    const els = {};
    let worker = null;
    let nextId = 0;
    const pending = new Map();

    // ── Worker ───────────────────────────────────────────────────

    function ensureWorker() {
        if (worker) return worker;
        worker = new Worker(WORKER_URL, {type: 'module'});
        worker.onmessage = ({data}) => {
            if (data.type === 'progress') {
                showProgress(data);
                return;
            }
            const request = pending.get(data.id);
            if (!request) return;
            pending.delete(data.id);
            if (data.ok) request.resolve(data.result);
            else request.reject(new Error(data.error));
        };
        return worker;
    }

    function request(type, payload = {}, transfer = []) {
        return new Promise((resolve, reject) => {
            pending.set(++nextId, {resolve, reject});
            ensureWorker().postMessage({id: nextId, type, ...payload}, transfer);
        });
    }

    function stopWorker() {
        worker?.terminate();
        worker = null;
        for (const request of pending.values()) request.reject(new Error('The planner stopped.'));
        pending.clear();
        Object.assign(state, {loaded: false, thinking: false, plan: null});
    }

    // ── Choosing, loading, deleting ──────────────────────────────

    async function choose(name) {
        state.name = name;
        state.error = '';
        stopWorker();
        render();
        if (name === 'off') return;
        state.busy = true;
        render();
        try {
            await request('load', {name});
            state.loaded = true;
        } catch (error) {
            state.error = `The planner could not start: ${error.message}`;
        } finally {
            state.busy = false;
            if (els.progress) els.progress.hidden = true;
            render();
        }
    }

    async function removeModel() {
        await request('remove').catch(() => {});
        stopWorker();
        if (els.model) els.model.value = 'off';
        await choose('off');
        state.error = 'Planner models deleted from this browser.';
        render();
    }

    // ── Looking ──────────────────────────────────────────────────

    // Called by the player after every frame while the AI plays, with the game's time.
    function afterFrame(now) {
        if (!state.loaded || state.thinking) return;
        const every = state.plan?.mode === 'menu' ? MENU_EVERY_US : PLAY_EVERY_US;
        if (now - state.lastUs < every) return;
        const screens = window.AzaharAIPlayer.captureScreens();
        if (!screens) return;
        state.thinking = true;
        state.lastUs = now;
        const started = performance.now();
        request('plan', {screens: {data: screens.data, width: screens.width, height: screens.height},
            notes: els.notes?.value || '', previous: state.plan}, [screens.data.buffer]).then(result => {
            state.thinking = false;
            state.looks++;
            state.lastMs = performance.now() - started;
            if (!result.plan) {
                state.unparsed++;
            } else {
                state.plan = result.plan;
                if (state.plan.mode === 'menu') operate(state.plan, window.AzaharUI.getGuestTimeUs());
            }
            render();
        }, error => {
            state.thinking = false;
            state.error = `The planner stopped: ${error.message}`;
            render();
        });
    }

    // Menu mode: NitroGen waits until the next look; the planner presses or touches once.
    function operate(plan, now) {
        state.drivingUntil = now + MENU_EVERY_US;
        if (plan.tap && tap(plan.tap)) return;
        const codes = [...plan.press.slice(0, 1), ...(plan.move !== 'none' ? [plan.move] : [])].map(codeFor).filter(Boolean);
        if (!codes.length) return;
        window.AzaharInput.setSourceCodes('planner', codes);
        setTimeout(() => window.AzaharInput.setSourceCodes('planner', []), PRESS_MS);
    }

    function codeFor(name) {
        const [group, control] = KEYS[name] || [];
        return window.AzaharInput.KEYMAP.find(entry => entry.group === group && entry.control === control)?.code;
    }

    // A touch at (x, y) of the planner's view (400x480, the bottom screen at 40,240): the
    // mouse events the emulator reads as the touch screen, on the canvas where that point
    // is drawn. False when the point is not on the bottom screen.
    function tap([x, y]) {
        const {bottom} = SCREENS;
        const localX = x - bottom.x, localY = y - bottom.y;
        if (localX < 0 || localY < 0 || localX >= bottom.w || localY >= bottom.h) return false;
        const canvas = window.AzaharUI.getCanvas();
        const rect = window.AzaharUI.getBottomScreenRect();
        const box = canvas.getBoundingClientRect();
        const clientX = box.left + (rect.x + (localX + 0.5) / bottom.w * rect.w) * box.width / canvas.width;
        const clientY = box.top + (rect.y + (localY + 0.5) / bottom.h * rect.h) * box.height / canvas.height;
        const init = {clientX, clientY, screenX: clientX, screenY: clientY, button: 0, bubbles: true, cancelable: true,
            view: window};
        // SDL takes the touch's position from the last mouse movement, not from the press.
        canvas.dispatchEvent(new MouseEvent('mousemove', {...init, buttons: 0}));
        canvas.dispatchEvent(new MouseEvent('mousedown', {...init, buttons: 1}));
        setTimeout(() => canvas.dispatchEvent(new MouseEvent('mouseup', {...init, buttons: 0})), PRESS_MS);
        return true;
    }

    // ── Steering NitroGen ────────────────────────────────────────

    const active = () => state.loaded || state.fixed;

    function steering() {
        const plan = state.plan;
        return Boolean(active() && plan && plan.mode === 'play' && (plan.move !== 'none' || plan.press.length));
    }

    // How many chunks NitroGen should make for its next decision.
    function draws() {
        return steering() ? STEER_DRAWS : 1;
    }

    // The pull on NitroGen's actions for the plan: target values (18 x 25) and weights (25),
    // `buttons` naming its 21 button outputs; null when not steering.
    function guidance(buttons) {
        if (!steering()) return null;
        const plan = state.plan;
        const guide = new Float32Array(18 * 25), weight = new Float32Array(25);
        const set = (index, value, pull) => {
            weight[index] = pull;
            for (let step = 0; step < 18; step++) guide[step * 25 + index] = value;
        };
        if (STICK[plan.move]) set(STICK[plan.move][0], STICK[plan.move][1], PULL.heading);
        for (const name of plan.press) set(buttons.indexOf(NITROGEN[name]), 1, PULL.press);
        return {guide, weight};
    }

    // Of `count` chunks (18 actions of 25 values each, `buttons` naming the 21 button
    // outputs), the one whose first actions go the planner's way the most.
    function pick(actions, count, buttons) {
        if (count < 2 || !steering()) return 0;
        const plan = state.plan;
        const index = name => buttons.indexOf(name);
        const pressed = (base, name) => actions[base + index(name)] > 0.5;
        let best = 0, bestScore = -Infinity;
        for (let k = 0; k < count; k++) {
            let score = 0;
            for (let step = 0; step < STEER_STEPS; step++) {
                const base = (k * 18 + step) * 25;
                const heading = HEADING[plan.move];
                if (heading) {
                    const [dx, dy, dpad] = heading;
                    score += (actions[base + 21] * 2 - 1) * dx + (actions[base + 22] * 2 - 1) * dy;
                    if (pressed(base, dpad)) score += 1;
                    if (pressed(base, HEADING[OPPOSITE[plan.move]][2])) score -= 1;
                }
                for (const name of plan.press) if (pressed(base, NITROGEN[name])) score += 1;
            }
            if (score > bestScore) {
                best = k;
                bestScore = score;
            }
        }
        return best;
    }

    // Whether NitroGen's button `name` is one the planner wants avoided.
    function avoids(name) {
        return Boolean(active() && state.plan?.avoid.some(button => NITROGEN[button] === name));
    }

    // Whether the planner is working a menu itself (NitroGen waits).
    function driving(now) {
        return active() && now < state.drivingUntil;
    }

    // Tests: a fixed plan, as if the planner had looked (null: none).
    function steer(plan) {
        state.fixed = Boolean(plan);
        state.plan = plan ? {screens: '', goal: '', mode: 'play', move: 'none', press: [], avoid: [], tap: null, ...plan} : null;
        render();
    }

    function reset() {
        if (state.fixed) return;
        state.plan = null;
        state.lastUs = -Infinity;
        state.drivingUntil = -Infinity;
        window.AzaharInput?.setSourceCodes('planner', []);
        render();
    }

    // ── Widget ───────────────────────────────────────────────────

    function showProgress({received, total}) {
        if (!els.progress) return;
        els.progress.hidden = false;
        els.progress.value = total ? (received / total) * 100 : 0;
        els.status.textContent = `Downloading the planner model from huggingface.co: ${Math.round(received / 1e6)} of ` +
            `${Math.round(total / 1e6)} MB…`;
    }

    function render() {
        if (!els.status) return;
        els.remove.hidden = state.name === 'off' && !state.loaded;
        els.model.disabled = state.busy;
        if (state.busy) return;
        const plan = state.plan;
        let text = state.error;
        if (!text) {
            if (state.name === 'off') text = 'Off: NitroGen plays on its own.';
            else if (!state.loaded) text = 'Not loaded.';
            else if (!plan) text = 'Ready: it looks once the AI plays.';
            else {
                const steer = plan.mode === 'menu'
                    ? (plan.tap ? `touching ${plan.tap.join(',')}` : `pressing ${[...plan.press.slice(0, 1), plan.move]
                        .filter(item => item && item !== 'none').join(' + ') || 'nothing'}`)
                    : [plan.move !== 'none' ? `heading ${plan.move}` : '', plan.press.length ? `favouring ${plan.press.join(' ')}` : '',
                        plan.avoid.length ? `avoiding ${plan.avoid.join(' ')}` : ''].filter(Boolean).join(', ') || 'not steering';
                text = `Goal: ${plan.goal || '—'} · ${plan.mode === 'menu' ? 'working the menu' : 'NitroGen plays'}, ${steer}` +
                    ` · ${(state.lastMs / 1000).toFixed(1)} s per look, ${state.looks} looks` +
                    (state.unparsed ? ` (${state.unparsed} unreadable)` : '');
            }
        }
        els.status.textContent = text;
    }

    function init() {
        Object.assign(els, {
            model: document.getElementById('ai-planner-model'), notes: document.getElementById('ai-planner-notes'),
            status: document.getElementById('ai-planner-status'), progress: document.getElementById('ai-planner-progress'),
            remove: document.getElementById('btn-ai-planner-delete'),
        });
        if (!els.model) return;
        try {
            els.notes.value = localStorage.getItem(NOTES_KEY) || '';
        } catch (_) {}
        els.notes.addEventListener('input', () => {
            try { localStorage.setItem(NOTES_KEY, els.notes.value); } catch (_) {}
        });
        els.model.addEventListener('change', () => void choose(els.model.value));
        els.remove.addEventListener('click', () => void removeModel());
        // Nothing loads with the page: a planner starts (from this browser's cache, once
        // downloaded) when it is chosen.
        els.model.value = 'off';
        render();
    }

    window.AzaharAIPlanner = {
        afterFrame, draws, guidance, pick, avoids, driving, reset, choose, tap, steer,
        state: () => ({...state, plan: state.plan && {...state.plan}}),
        STEER_DRAWS,
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
