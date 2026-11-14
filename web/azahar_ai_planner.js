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
 * Planner models are downloaded only from the widget's model list (Download), into the
 * browser's Cache Storage (Transformers.js's transformers-cache), and can be deleted one by
 * one; the planner itself only starts models already there. With the widget's option on, the
 * game pauses while the planner looks.
 */
(() => {
    'use strict';

    // This deploy's stamp (see azahar_ui.js) on the worker too.
    const build = new URL(document.currentScript?.src || location.href).searchParams.get('v');
    const WORKER_URL = build ? `azahar_ai_planner_worker.js?v=${encodeURIComponent(build)}` : 'azahar_ai_planner_worker.js';
    const NOTES_KEY = 'azahar-ai-planner-notes';
    const PAUSE_KEY = 'azahar-ai-planner-pause';
    const CACHE_NAME = 'transformers-cache';
    // The planner models the widget offers (azahar_ai_planner_worker.js runs them, from the same
    // repositories and revisions); sizes are what a download fetches and keeps.
    const MODELS = [
        {id: 'qwen3.5-0.8b', label: 'Qwen3.5-0.8B', by: 'Qwen (Alibaba)', repo: 'onnx-community/Qwen3.5-0.8B-ONNX',
            revision: '8fe9dbe3fb39fe902e18df9be84b6a0ac77ae0f6', license: 'Apache 2.0', megabytes: 850},
        {id: 'lfm2.5-vl-450m', label: 'LFM2.5-VL-450M', by: 'Liquid AI', repo: 'onnx-community/LFM2.5-VL-450M-ONNX',
            revision: '24e63007ff1aaafbde27c89eb01a0513f4f61482', license: 'LFM Open License v1.0', megabytes: 545},
        // The same model fine-tuned here for game instructions: its decoder's graph comes from
        // this site (`patch` MB: the original's with each fine-tuned layer's LoRA branch); it
        // shares every other file, the decoder's 4-bit weights too, with the original.
        {id: 'lfm2.5-vl-450m-games', label: 'LFM2.5-VL-450M · games', by: 'Liquid AI, fine-tuned in this project',
            repo: 'onnx-community/LFM2.5-VL-450M-ONNX', revision: '24e63007ff1aaafbde27c89eb01a0513f4f61482',
            license: 'LFM Open License v1.0', megabytes: 557, patch: 12, patchId: '4786eb29edaf'},
    ];
    // A fine-tuned model's own graph (azahar_ai_planner_worker.js's graphKey), and the
    // original's decoder graph.
    const patchedPath = model => `/onnx/azahar-${model.id}-${model.patchId}/`;
    const decoderGraph = model => new RegExp(`/${model.repo}/resolve/${model.revision}/onnx/decoder_model_merged[^/]*\\.onnx$`);
    const PLAY_EVERY_US = 5e6;       // game time between looks while NitroGen plays
    const MENU_EVERY_US = 1.5e6;     // and while the planner works a menu itself
    const PRESS_MS = 120;
    const GOAL_EVERY = 6;            // looks between rethinking the goal
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
    const stored = new Set();         // planner models in this browser's cache
    let downloading = null;           // {id, worker} while one downloads
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
            if (data.type === 'status') {
                if (els.status) els.status.textContent = data.text;
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

    // Which planner models this browser keeps: Transformers.js caches each file under its
    // huggingface.co URL, which names the repository and revision.
    async function refreshStored() {
        stored.clear();
        try {
            if (self.caches && await caches.has(CACHE_NAME)) {
                const urls = (await (await caches.open(CACHE_NAME)).keys()).map(request => request.url);
                for (const model of MODELS) {
                    const own = model.patch ? url => url.includes(patchedPath(model)) : url => decoderGraph(model).test(url);
                    if (urls.some(own)) stored.add(model.id);
                }
            }
        } catch (_) {}
        changed();
    }

    // The widget's model list (azahar_ai_player.js) shows these and acts on them.
    function changed() {
        renderChoices();
        render();
        window.dispatchEvent(new Event('azahar-ai-models'));
    }

    function models() {
        return MODELS.map(model => ({id: model.id, label: model.label, role: 'System 2',
            stored: stored.has(model.id), busy: downloading?.id === model.id,
            status: downloading?.id === model.id ? downloading.status || '' : '',
            from: model.patch ? `huggingface.co and this site: ${model.megabytes - model.patch} + ${model.patch} MB` : 'huggingface.co',
            size: `${model.megabytes} MB ${stored.has(model.id) ? 'kept' : 'download'}`}));
    }

    function info(id) {
        const model = MODELS.find(item => item.id === id);
        if (model.patch) {
            return `<b>${model.label}</b>: Liquid AI's LFM2.5-VL-450M, fine-tuned in this project for game instructions ` +
                '(which way to head, which button to press, whether a menu waits, from the screens and your notes; ' +
                'learned from human play in NVIDIA\'s NitroGen dataset, CC BY-NC 4.0). Download fetches the model from ' +
                `<a href="https://huggingface.co/${model.repo}" target="_blank" rel="noopener">huggingface.co/${model.repo}` +
                `</a> (revision ${model.revision.slice(0, 7)}) and this site's ${model.patch} MB fine-tune (the decoder's ` +
                'graph with a small branch beside each fine-tuned layer) and keeps them: about ' +
                `${model.megabytes} MB, all but the fine-tune shared with the original model. Under the ${model.license}; ` +
                'it runs on this device with ' +
                'Transformers.js from cdn.jsdelivr.net, as the planner (System 2).';
        }
        return `<b>${model.label}</b> by ${model.by}, a vision-language model, from <a href="https://huggingface.co/` +
            `${model.repo}" target="_blank" rel="noopener">huggingface.co/${model.repo}</a> (revision ` +
            `${model.revision.slice(0, 7)}), under the ${model.license}. About ${model.megabytes} MB, fetched straight ` +
            'from huggingface.co and kept in this browser until you delete it; it runs on this device with ' +
            'Transformers.js from cdn.jsdelivr.net, as the planner (System 2).';
    }

    // Fetches a model into the cache with a worker of its own, which then ends.
    async function download(id) {
        if (downloading) return;
        const own = new Worker(WORKER_URL, {type: 'module'});
        downloading = {id, worker: own};
        changed();
        const progress = document.getElementById('ai-model-progress');
        try {
            await new Promise((resolve, reject) => {
                own.onmessage = ({data}) => {
                    if (data.type === 'status') {
                        downloading.status = data.text;
                        changed();
                        return;
                    }
                    if (data.type === 'progress') {
                        if (progress) {
                            progress.hidden = false;
                            progress.value = data.total ? (data.received / data.total) * 100 : 0;
                        }
                        return;
                    }
                    if (data.ok) resolve(data.result);
                    else reject(new Error(data.error));
                };
                own.onerror = event => reject(new Error(event.message || 'The download stopped.'));
                own.postMessage({id: 1, type: 'load', name: id});
            });
        } finally {
            own.terminate();
            downloading = null;
            if (progress) progress.hidden = true;
            await refreshStored();
        }
    }

    function cancelDownload() {
        if (!downloading) return;
        downloading.worker.terminate();
        downloading = null;
        void refreshStored();
    }

    // Deletes one model's files from the cache (and stops the planner if it is the one running).
    async function remove(id) {
        const model = MODELS.find(item => item.id === id);
        if (state.name === id) {
            if (els.model) els.model.value = 'off';
            await choose('off');
        }
        try {
            const cache = await caches.open(CACHE_NAME);
            // Its own decoder graph goes; the files it shares with another model of the same
            // repository (all the others) go only when no such model is kept.
            const own = url => (model.patch ? url.includes(`/onnx/azahar-${model.id}-`) : decoderGraph(model).test(url));
            const decoder = url => decoderGraph(model).test(url) || url.includes('/onnx/azahar-');
            const sharing = MODELS.some(other => other !== model && other.repo === model.repo && stored.has(other.id));
            for (const request of await cache.keys()) {
                const url = request.url;
                if (!url.includes(`/${model.repo}/resolve/${model.revision}/`)) continue;
                if (own(url) || (!sharing && !decoder(url))) await cache.delete(request);
            }
        } catch (_) {}
        await refreshStored();
    }

    // The game waits while the planner looks (the widget's option).
    function holds() {
        return Boolean(state.pauseGame && state.thinking);
    }

    // ── Looking ──────────────────────────────────────────────────

    // Called by the player after every frame while the AI plays, with the game's time.
    function afterFrame(now) {
        if (!state.loaded || state.thinking) return;
        const every = state.plan?.mode === 'menu' ? MENU_EVERY_US : PLAY_EVERY_US;
        if (now - state.lastUs < every) return;
        const screens = window.AzaharAIPlayer.captureScreens();
        if (!screens) return;
        void look(screens, now).then(plan => {
            if (plan?.mode === 'menu') operate(plan, window.AzaharUI.getGuestTimeUs());
        });
    }

    // The player's notes, after the game's name (from the ROM's file name, without its
    // regions and languages) unless they name it already.
    function notesNow() {
        const notes = (els.notes?.value || '').trim();
        const game = (window.AzaharUI?.getRomName?.() || '').replace(/\.[^.]+$/, '').replace(/\s*[([][^)\]]*[)\]]/g, '').trim();
        return game && !notes.toLowerCase().includes(game.toLowerCase()) ? `Game: ${game}. ${notes}`.trim() : notes;
    }

    // One look at both screens (ImageData, 400x480) at game time `now`: the new plan, or
    // null when the answer could not be read or the planner failed.
    function look(screens, now) {
        state.thinking = true;
        state.lastUs = now;
        const started = performance.now();
        // The goal (and what the screens show) every few looks; what to do now every look.
        const withGoal = !state.plan || state.looks % GOAL_EVERY === 0;
        const data = screens.data.slice();
        return request('plan', {screens: {data, width: screens.width, height: screens.height},
            notes: notesNow(), previous: state.plan, withGoal}, [data.buffer]).then(result => {
            state.thinking = false;
            state.looks++;
            state.lastMs = performance.now() - started;
            if (!result.plan) state.unparsed++;
            else state.plan = result.plan;
            render();
            return result.plan || null;
        }, error => {
            state.thinking = false;
            state.error = `The planner stopped: ${error.message}`;
            render();
            return null;
        });
    }

    // A yes-or-no question about both screens (ImageData, 400x480): true, false, or null when
    // no planner runs or the answer is neither.
    async function askYesNo(screens, question) {
        if (!state.loaded) return null;
        const data = screens.data.slice();
        try {
            const result = await request('ask', {screens: {data, width: screens.width, height: screens.height}, question,
                maxTokens: 4}, [data.buffer]);
            return /\byes\b/i.test(result.text) ? true : /\bno\b/i.test(result.text) ? false : null;
        } catch (_) {
            return null;
        }
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

    // The plan NitroGen is steered by: the look-ahead's for the future it is trying (null:
    // unsteered), else the planner's.
    const current = () => (state.override !== undefined ? state.override : state.plan);
    const active = () => state.loaded || state.fixed || state.override !== undefined;

    function steering() {
        const plan = current();
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
        const plan = current();
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
        const plan = current();
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
        return Boolean(active() && current()?.avoid.some(button => NITROGEN[button] === name));
    }

    // Whether the planner is working a menu itself (NitroGen waits).
    function driving(now) {
        return active() && state.override === undefined && now < state.drivingUntil;
    }

    const asPlan = plan => ({screens: '', goal: '', mode: 'play', move: 'none', press: [], avoid: [], tap: null, ...plan});

    // Tests: a fixed plan, as if the planner had looked (null: none).
    function steer(plan) {
        state.fixed = Boolean(plan);
        state.plan = plan ? asPlan(plan) : null;
        render();
    }

    // The look-ahead: steer NitroGen by `plan` (null: unsteered) for the future it tries,
    // whatever the planner's own plan; undefined hands back to the planner.
    function override(plan) {
        state.override = plan === undefined ? undefined : plan && asPlan(plan);
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

    // The planner's choice: off, or a model this browser keeps (the others, greyed out, are
    // downloaded in the widget's model list).
    function renderChoices() {
        if (!els.model) return;
        const chosen = state.name;
        els.model.replaceChildren(new Option('Off — NitroGen plays on its own', 'off'), ...MODELS.map(model => {
            const option = new Option(stored.has(model.id) ? `${model.label} — downloaded`
                : `${model.label} — download it under Models below (${model.megabytes} MB)`, model.id);
            option.disabled = !stored.has(model.id);
            return option;
        }));
        els.model.value = chosen === 'off' || stored.has(chosen) ? chosen : 'off';
    }

    function render() {
        if (!els.status) return;
        els.model.disabled = state.busy;
        if (state.busy) return;
        const plan = state.plan;
        let text = state.error;
        if (!text) {
            if (state.name === 'off') text = stored.size ? 'Off: NitroGen plays on its own.'
                : 'Off: download a planner model under Models below to use one.';
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
            pause: document.getElementById('ai-planner-pause'),
        });
        if (!els.model) return;
        try {
            els.notes.value = localStorage.getItem(NOTES_KEY) || '';
            const pause = localStorage.getItem(PAUSE_KEY);
            if (pause !== null) els.pause.checked = pause === '1';
        } catch (_) {}
        els.notes.addEventListener('input', () => {
            try { localStorage.setItem(NOTES_KEY, els.notes.value); } catch (_) {}
        });
        state.pauseGame = els.pause.checked;
        els.pause.addEventListener('change', () => {
            state.pauseGame = els.pause.checked;
            try { localStorage.setItem(PAUSE_KEY, els.pause.checked ? '1' : '0'); } catch (_) {}
        });
        els.model.addEventListener('change', () => void choose(els.model.value));
        // Nothing loads with the page: a planner starts (from this browser's cache) when chosen.
        renderChoices();
        render();
        void refreshStored();
    }

    window.AzaharAIPlanner = {
        afterFrame, look, askYesNo, operate, draws, guidance, pick, avoids, driving, reset, choose, tap, steer, override, holds,
        models, info, download, cancelDownload, remove, refreshStored,
        state: () => ({...state, plan: state.plan && {...state.plan}}),
        STEER_DRAWS,
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
