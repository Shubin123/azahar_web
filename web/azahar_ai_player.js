/**
 * Azahar Web — AI player (azahar_ai_player.js)
 * The 🤖 AI Player widget: NVIDIA's NitroGen model plays for you. It looks at the top
 * screen and holds the keys a gamepad would (NitroGen predicts gamepad actions from game
 * frames; azahar_input.js's keymap turns them into 3DS keys, as for a real controller).
 * Your own keys and controller keep working alongside it.
 *
 * Nothing is fetched until you ask. "Download model" has azahar_ai_worker.js stream NVIDIA's
 * ng.pt from huggingface.co (a pinned revision), check it, quantize it to 8 bits and keep the
 * result in this browser's Cache Storage; "Delete model" removes it. The first start loads
 * ONNX Runtime Web from cdn.jsdelivr.net, and the model runs on this device (WebGPU, else
 * WebAssembly). See scripts/nitrogen/ for how the graphs are made and checked.
 *
 * Each decision takes the frame just drawn and returns 18 actions, one for each 1/60 s of
 * game time from that frame on. The game runs on while the model decides the next ones
 * (actions that arrive late are skipped); on a device too slow for that, the game can wait
 * for each decision instead, as NVIDIA's own player pauses the game. A frame identical to
 * the last one (a still menu) reuses what the model saw in it.
 */

(function () {
    'use strict';

    const build = new URL(document.currentScript?.src || location.href).searchParams.get('v');
    const stamped = file => build ? `${file}?v=${encodeURIComponent(build)}` : file;
    const MODEL_URL = new URL('vendor/nitrogen/q8/', location.href).href;
    const CACHE_NAME = 'azahar-ai-nitrogen';
    const META_KEY = new URL('ai-model/meta.json', MODEL_URL).href;
    const INPUT_SIZE = 256;
    const HORIZON = 18;
    const ACTION_DIM = 25;
    const FRAME_US = 1e6 / 60;
    const SOURCE_BYTES = 1974723762;
    // nitrogen/shared.py's button order.
    const BUTTONS = ['BACK', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'DPAD_UP', 'EAST', 'GUIDE',
        'LEFT_SHOULDER', 'LEFT_THUMB', 'LEFT_TRIGGER', 'NORTH', 'RIGHT_BOTTOM', 'RIGHT_LEFT',
        'RIGHT_RIGHT', 'RIGHT_SHOULDER', 'RIGHT_THUMB', 'RIGHT_TRIGGER', 'RIGHT_UP', 'SOUTH',
        'START', 'WEST'];
    // NitroGen names an Xbox pad's buttons; these are their standard-gamepad indices
    // (RIGHT_BOTTOM/LEFT/RIGHT/UP have none: NVIDIA's player ignores them too).
    const PAD_BUTTON = {SOUTH: 0, EAST: 1, WEST: 2, NORTH: 3, LEFT_SHOULDER: 4, RIGHT_SHOULDER: 5,
        LEFT_TRIGGER: 6, RIGHT_TRIGGER: 7, BACK: 8, START: 9, LEFT_THUMB: 10, RIGHT_THUMB: 11,
        DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15, GUIDE: 16};
    const BUTTON_THRESHOLD = 0.5;
    const $ = id => document.getElementById(id);

    const els = {};
    let worker = null;
    let requestId = 0;
    const pending = new Map();
    let meta = null;            // the cached model's description, or null
    let busy = '';              // 'download' | 'load' while one runs
    const agent = {
        playing: false,
        loaded: null,           // {backend, ...} once the worker's sessions exist
        waitForModel: false,
        allowMenu: false,
        thinking: null,         // {t0} while a decision is being made
        chunk: null,            // {t0, actions}
        step: -1,
        decisions: 0,
        unchanged: 0,
        lastMs: 0,
        heldMs: 0,
        startedAt: 0,
        codes: [],
    };

    // ── Worker ───────────────────────────────────────────────────

    function ensureWorker() {
        if (worker) return worker;
        worker = new Worker(stamped('azahar_ai_worker.js'), {type: 'module'});
        worker.onmessage = ({data}) => {
            if (data.type === 'progress') {
                showDownloadProgress(data);
                return;
            }
            const request = pending.get(data.id);
            if (!request) return;
            pending.delete(data.id);
            if (data.ok) request.resolve(data.result);
            else request.reject(new Error(data.error));
        };
        worker.onerror = event => {
            const error = new Error(event.message || 'The AI worker failed.');
            for (const request of pending.values()) request.reject(error);
            pending.clear();
        };
        return worker;
    }

    function request(type, payload = {}, transfer = []) {
        const id = ++requestId;
        return new Promise((resolve, reject) => {
            pending.set(id, {resolve, reject});
            ensureWorker().postMessage({id, type, modelUrl: MODEL_URL, ...payload}, transfer);
        });
    }

    function stopWorker() {
        worker?.terminate();
        worker = null;
        for (const request of pending.values()) request.reject(new Error('Stopped.'));
        pending.clear();
        agent.loaded = null;
    }

    // ── Model storage ────────────────────────────────────────────

    async function readMeta() {
        try {
            if (!self.caches || !await caches.has(CACHE_NAME)) return null;
            const response = await (await caches.open(CACHE_NAME)).match(META_KEY);
            return response ? await response.json() : null;
        } catch (_) {
            return null;
        }
    }

    async function download(options = {}) {
        if (busy) return null;
        busy = 'download';
        render();
        try {
            meta = await request('prepare', {sourceUrl: options.sourceUrl});
            setStatus(`Model ready: checked and quantized in ${Math.round(meta.downloadSeconds)} s.`, 'ok');
            return meta;
        } catch (error) {
            setStatus(error.message, 'error');
            throw error;
        } finally {
            busy = '';
            els.progress.hidden = true;
            render();
        }
    }

    function cancelDownload() {
        if (busy === 'download') worker?.postMessage({id: 0, type: 'cancel'});
    }

    async function removeModel() {
        stop();
        cancelDownload();
        stopWorker();
        await caches.delete(CACHE_NAME);
        meta = null;
        setStatus('Model deleted from this browser.', '');
        render();
    }

    // ── Seeing the top screen ────────────────────────────────────

    const taps = new Map();
    // Area averaging: each output pixel is the mean of the source area it covers.
    function areaTaps(src, dst) {
        const key = `${src}:${dst}`;
        if (taps.has(key)) return taps.get(key);
        const scale = src / dst;
        const result = [];
        for (let o = 0; o < dst; o++) {
            const start = o * scale, end = (o + 1) * scale;
            const list = [];
            for (let i = Math.floor(start); i < Math.min(src, Math.ceil(end)); i++) {
                const overlap = Math.min(end, i + 1) - Math.max(start, i);
                if (overlap > 1e-9) list.push(i, overlap / scale);
            }
            result.push(list);
        }
        taps.set(key, result);
        return result;
    }

    function resizeToInput(rgba, width, height) {
        const columns = areaTaps(width, INPUT_SIZE), rows = areaTaps(height, INPUT_SIZE);
        const wide = new Float32Array(height * INPUT_SIZE * 3);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < INPUT_SIZE; x++) {
                const list = columns[x];
                let r = 0, g = 0, b = 0;
                for (let t = 0; t < list.length; t += 2) {
                    const i = (y * width + list[t]) * 4, w = list[t + 1];
                    r += rgba[i] * w; g += rgba[i + 1] * w; b += rgba[i + 2] * w;
                }
                const o = (y * INPUT_SIZE + x) * 3;
                wide[o] = r; wide[o + 1] = g; wide[o + 2] = b;
            }
        }
        const out = new Uint8Array(INPUT_SIZE * INPUT_SIZE * 3);
        for (let y = 0; y < INPUT_SIZE; y++) {
            const list = rows[y];
            for (let x = 0; x < INPUT_SIZE * 3; x++) {
                let value = 0;
                for (let t = 0; t < list.length; t += 2) value += wide[list[t] * INPUT_SIZE * 3 + x] * list[t + 1];
                out[y * INPUT_SIZE * 3 + x] = Math.min(255, Math.max(0, Math.round(value)));
            }
        }
        return out;
    }

    let grabCanvas = null;
    // The top screen as the model's input, read from the canvas the frame was just drawn on.
    function captureInput() {
        const canvas = window.AzaharUI?.getCanvas?.();
        const rect = window.AzaharUI?.getTopScreenRect?.();
        if (!canvas || !rect || rect.w < 1 || rect.h < 1) return null;
        grabCanvas = grabCanvas || document.createElement('canvas');
        if (grabCanvas.width !== rect.w || grabCanvas.height !== rect.h) {
            grabCanvas.width = rect.w;
            grabCanvas.height = rect.h;
        }
        const context = grabCanvas.getContext('2d', {willReadFrequently: true});
        context.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
        const raw = context.getImageData(0, 0, rect.w, rect.h);
        return {input: resizeToInput(raw.data, rect.w, rect.h), raw};
    }

    // ── Acting ───────────────────────────────────────────────────

    // The virtual gamepad for action `step` of a decision.
    function padFor(actions, step) {
        const base = step * ACTION_DIM;
        const buttons = Array.from({length: 17}, () => ({pressed: false, value: 0}));
        BUTTONS.forEach((name, i) => {
            const index = PAD_BUTTON[name];
            if (index === undefined) return;
            // HOME would leave the game; Start and Select only when allowed (NVIDIA's
            // player also keeps the model off its menus by default).
            if (name === 'GUIDE' || ((name === 'START' || name === 'BACK') && !agent.allowMenu)) return;
            const on = actions[base + i] > BUTTON_THRESHOLD;
            buttons[index] = {pressed: on, value: on ? 1 : 0};
        });
        const stick = i => Math.max(-1, Math.min(1, actions[base + i] * 2 - 1));
        return {id: 'NitroGen', connected: true, buttons,
            axes: [stick(21), stick(22), stick(23), stick(24)]};
    }

    function hold(codes) {
        const key = codes.join();
        if (key === agent.codes.join()) return;
        agent.codes = codes;
        window.AzaharInput?.setSourceCodes('ai', codes);
        if (els.keys) {
            const names = codes.map(code => {
                const entry = window.AzaharInput.KEYMAP.find(item => item.code === code);
                return entry ? (entry.group === 'Face buttons' || entry.group === 'Shoulders' || entry.group === 'System'
                    ? entry.control : `${entry.group} ${entry.control}`) : code;
            });
            els.keys.textContent = names.length ? `Holding: ${names.join(', ')}` : 'Holding: nothing';
        }
    }

    function applyStep(now) {
        const chunk = agent.chunk;
        let step = -1;
        if (chunk) {
            step = Math.floor((now - chunk.t0) / FRAME_US);
            if (step >= HORIZON) {
                agent.chunk = null;
                step = -1;
            }
        }
        agent.step = step;
        hold(step >= 0 ? window.AzaharInput.padCodes(padFor(chunk.actions, step)) : []);
    }

    function decide(now) {
        const seen = captureInput();
        if (!seen) return;
        const thinking = {t0: now, startedAt: performance.now()};
        agent.thinking = thinking;
        drawView(seen.input);
        // A decision that never comes back must not leave the game waiting.
        const timeout = new Promise((_, reject) => setTimeout(
            () => reject(new Error('the model took over a minute to answer')), 60000));
        Promise.race([request('act', {pixels: seen.input}, [seen.input.buffer]), timeout]).then(result => {
            if (agent.thinking !== thinking) return;
            agent.thinking = null;
            agent.chunk = {t0: thinking.t0, actions: result.actions};
            agent.decisions++;
            if (result.reused) agent.unchanged++;
            agent.lastMs = performance.now() - thinking.startedAt;
            if (agent.waitForModel) agent.heldMs += agent.lastMs;
            agent.timing = result;
            const time = window.AzaharUI?.getGuestTimeUs?.();
            if (time !== null && time !== undefined) applyStep(time);
            renderPlaying();
        }, error => {
            if (agent.thinking !== thinking) return;
            agent.thinking = null;
            stop();
            setStatus(`The AI stopped: ${error.message}`, 'error');
        });
    }

    // Captures waiting for the next frame (tests): the canvas holds a WebGL frame only
    // until the browser shows it, so it is read here, right after the frame is drawn.
    const frameWaiters = [];

    // Called by azahar_ui.js after every frame the emulator presents.
    function afterFrame() {
        if (frameWaiters.length) {
            const seen = captureInput();
            for (const resolve of frameWaiters.splice(0)) {
                resolve(seen && {input: seen.input.slice(), raw: seen.raw, guestUs: window.AzaharUI.getGuestTimeUs()});
            }
        }
        if (!agent.playing || !agent.loaded) return;
        const now = window.AzaharUI.getGuestTimeUs();
        if (now === null || now === undefined) return;
        applyStep(now);
        // Waiting: decide once the last decision's actions are used up. Real time: keep
        // a decision under way, so new actions arrive as soon as the model can make them.
        if (!agent.thinking && (agent.waitForModel ? !agent.chunk : true)) decide(now);
    }

    function shouldHold() {
        return agent.playing && agent.waitForModel && agent.thinking !== null;
    }

    async function start() {
        if (agent.playing || busy) return;
        meta = meta || await readMeta();
        if (!meta) {
            setStatus('Download the model first.', 'error');
            return;
        }
        if (!agent.loaded) {
            busy = 'load';
            render();
            setStatus('Starting the model: ONNX Runtime Web from cdn.jsdelivr.net, then compiling it for this device…', '');
            try {
                agent.loaded = await request('load', {});
            } catch (error) {
                setStatus(error.message, 'error');
                stopWorker();
                return;
            } finally {
                busy = '';
                render();
            }
        }
        agent.playing = true;
        agent.decisions = 0;
        agent.unchanged = 0;
        agent.heldMs = 0;
        agent.startedAt = performance.now();
        agent.chunk = null;
        agent.thinking = null;
        renderPlaying();
        render();
        if (!window.AzaharUI?.isPlaying?.()) setStatus('The AI plays as soon as a game is running.', '');
    }

    function stop() {
        if (!agent.playing) return;
        agent.playing = false;
        agent.thinking = null;
        agent.chunk = null;
        hold([]);
        render();
        if (meta) setStatus(`The AI stopped after ${agent.decisions} decisions.`, '');
    }

    // ── Widget ───────────────────────────────────────────────────

    function setStatus(text, kind) {
        if (!els.status) return;
        els.status.textContent = text;
        els.status.dataset.kind = kind || '';
    }

    function megabytes(bytes) {
        return `${Math.round(bytes / 1e6)} MB`;
    }

    function showDownloadProgress({phase, received, total, seconds}) {
        els.progress.hidden = false;
        els.progress.value = total ? (received / total) * 100 : 0;
        if (phase === 'verify') {
            setStatus('Checking the quantized model against the reference conversion…', '');
        } else {
            const rate = seconds > 0 ? ` · ${(received / 1e6 / seconds).toFixed(0)} MB/s` : '';
            setStatus(`Downloading ng.pt from huggingface.co and quantizing it: ` +
                `${megabytes(received)} of ${megabytes(total)}${rate}`, '');
        }
    }

    function drawView(input) {
        if (!els.view) return;
        els.view.hidden = false;
        const context = els.view.getContext('2d');
        const image = context.createImageData(INPUT_SIZE, INPUT_SIZE);
        for (let i = 0, o = 0; i < input.length; i += 3, o += 4) {
            image.data[o] = input[i];
            image.data[o + 1] = input[i + 1];
            image.data[o + 2] = input[i + 2];
            image.data[o + 3] = 255;
        }
        context.putImageData(image, 0, 0);
    }

    function renderPlaying() {
        if (!agent.playing) return;
        const backend = agent.loaded?.backend === 'webgpu' ? 'WebGPU' : 'WebAssembly';
        const elapsed = performance.now() - agent.startedAt;
        const unchanged = agent.unchanged ? ` (${agent.unchanged} on an unchanged screen)` : '';
        let mode = '';
        if (agent.waitForModel) {
            if (elapsed > 0) mode = ` · the game waited ${Math.round(100 * agent.heldMs / elapsed)}% of the time`;
        } else if (agent.lastMs > HORIZON * FRAME_US / 1000) {
            // A decision covers 18 frames (0.3 s); slower ones leave the game without input.
            mode = ' · too slow for real time here: tick “Pause the game while the AI thinks”';
        }
        setStatus(agent.decisions
            ? `Playing on ${backend} · ${Math.round(agent.lastMs)} ms per decision · ${agent.decisions} decisions${unchanged}${mode}`
            : `Playing on ${backend} · first decision…`, 'ok');
    }

    function render() {
        if (!els.card) return;
        const cached = Boolean(meta);
        els.download.hidden = cached || busy === 'download';
        els.cancel.hidden = busy !== 'download';
        els.remove.hidden = !cached && busy !== 'download';
        els.remove.disabled = busy === 'download';
        els.play.disabled = !cached || Boolean(busy);
        els.play.textContent = agent.playing ? '✋ Take back control' : '🤖 Let the AI play';
        els.play.classList.toggle('btn-primary', !agent.playing);
        els.play.classList.toggle('btn-secondary', agent.playing);
        els.keys.hidden = !agent.playing;
        if (!agent.playing && els.view) els.view.hidden = true;
        els.stored.textContent = cached
            ? `Downloaded ${new Date(meta.preparedAt).toLocaleDateString()} from revision ` +
              `${meta.source.revision.slice(0, 7)}: ${megabytes(meta.bytes)} kept in this browser.`
            : 'Not downloaded. Nothing is fetched until you press Download.';
    }

    async function init() {
        els.card = $('ai-player-card');
        if (!els.card) return;
        Object.assign(els, {
            play: $('btn-ai-play'), status: $('ai-status'), progress: $('ai-progress'),
            view: $('ai-view'), keys: $('ai-keys'), wait: $('ai-wait'), menu: $('ai-menu'),
            download: $('btn-ai-download'), cancel: $('btn-ai-cancel'), remove: $('btn-ai-delete'),
            stored: $('ai-stored'),
        });
        els.download.textContent = `⬇ Download model (${(SOURCE_BYTES / 1e9).toFixed(2)} GB from huggingface.co)`;
        els.play.addEventListener('click', () => (agent.playing ? stop() : void start()));
        els.download.addEventListener('click', () => void download().catch(() => {}));
        els.cancel.addEventListener('click', cancelDownload);
        els.remove.addEventListener('click', () => void removeModel());
        els.wait.addEventListener('change', () => {
            agent.waitForModel = els.wait.checked;
        });
        els.menu.addEventListener('change', () => {
            agent.allowMenu = els.menu.checked;
        });
        agent.waitForModel = els.wait.checked;
        agent.allowMenu = els.menu.checked;
        setInterval(() => {
            if (agent.playing && !document.hidden) renderPlaying();
        }, 1000);
        render();
        meta = await readMeta();
        render();
    }

    window.AzaharAIPlayer = {
        afterFrame,
        shouldHold,
        start,
        stop,
        download,
        removeModel,
        isPlaying: () => agent.playing,
        // For tests: the input the model would get now, one decision on any input, and
        // the keys an action would hold.
        captureInput,
        nextFrameInput: () => new Promise(resolve => frameWaiters.push(resolve)),
        act: (pixels, noise, noises) => request('act', {pixels, noise, noises}),
        load: preferred => request('load', {preferred}).then(loaded => (agent.loaded = loaded)),
        keysFor: (actions, step) => window.AzaharInput.padCodes(padFor(actions, step)),
        stats: () => ({playing: agent.playing, decisions: agent.decisions, unchanged: agent.unchanged, lastMs: agent.lastMs,
            heldMs: agent.heldMs, step: agent.step, codes: [...agent.codes], loaded: agent.loaded,
            timing: agent.timing || null, cached: Boolean(meta), meta}),
        readMeta,
        MODEL_URL,
        CACHE_NAME,
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else void init();
})();
