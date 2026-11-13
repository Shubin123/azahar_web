/**
 * Azahar Web — AI planner worker (azahar_ai_planner_worker.js, a module worker)
 * System 2 of the AI player: a small vision-language model that looks at both screens every
 * few seconds, with the player's notes (quest log, task at hand, manual pages), and decides
 * the bigger picture: what to do next, which way NitroGen (System 1, azahar_ai_worker.js)
 * should go and which buttons it should favour or avoid, and in menus and on the bottom
 * screen, what to press or touch itself.
 *
 * load    Transformers.js (from cdn.jsdelivr.net) and the chosen model (from huggingface.co,
 *         at a pinned revision), on WebGPU. Transformers.js keeps the files in Cache Storage
 *         (transformers-cache); nothing is fetched before the player asks.
 * plan    one look: the screens (RGBA, 400x480: the top screen over the bottom one) and the
 *         player's notes to the next plan, from a few multiple-choice questions (QUESTIONS:
 *         is a menu waiting, which way to go, which button), with `withGoal` the goal too,
 *         and where to touch when a menu waits.
 * ask     the screens and a question to the model's answer (tests).
 * remove  deletes the cached model files.
 */

const TRANSFORMERS_VERSION = '4.3.2';
const TRANSFORMERS_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js`;
const CACHE_NAME = 'transformers-cache';

// The planners the page offers. dtype: per part of the model, as its card recommends for
// WebGPU (4-bit text, float16 vision); imageFirst: its processor takes the image before the
// text.
const PLANNERS = {
    'qwen3.5-0.8b': {repo: 'onnx-community/Qwen3.5-0.8B-ONNX', revision: '8fe9dbe3fb39fe902e18df9be84b6a0ac77ae0f6',
        license: 'Apache-2.0', dtype: {embed_tokens: 'q4', vision_encoder: 'fp16', decoder_model_merged: 'q4'}},
    // (LFM: the views go in at 384x480, the 32-pixel grid Liquid AI's own processor sizes them
    // to, unstretched: Transformers.js's would first squash them to 512x512.)
    'lfm2.5-vl-450m': {repo: 'onnx-community/LFM2.5-VL-450M-ONNX', revision: '24e63007ff1aaafbde27c89eb01a0513f4f61482',
        license: 'LFM Open License v1.0', imageFirst: true, size: [384, 480],
        dtype: {embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'q4f16'}},
    'qwen3.5-2b': {repo: 'onnx-community/Qwen3.5-2B-ONNX', revision: '315216e893038beefcc6eba41ac168913dd0d879',
        license: 'Apache-2.0', dtype: {embed_tokens: 'q4', vision_encoder: 'fp16', decoder_model_merged: 'q4'}},
};
// LFM2.5-VL-450M fine-tuned for game instructions (scripts/nitrogen/system2_finetune.py): the
// same files, but its decoder's graph from this site, which adds each fine-tuned layer's LoRA
// branch beside it (its 4-bit weights are the original's), kept under a key of its own.
PLANNERS['lfm2.5-vl-450m-games'] = {...PLANNERS['lfm2.5-vl-450m'],
    graph: {url: 'vendor/system2/lfm2.5-vl-450m-games.onnx', sha256: '4786eb29edafa6e25992538fd4826afdf904a2b898a579e59d7dfc25161f199b'}};

let transformers = null;
let loaded = null;   // {name, processor, model}

function post(message) {
    self.postMessage(message);
}

self.onmessage = async ({data}) => {
    const {id, type} = data;
    try {
        let result;
        if (type === 'load') result = await load(data);
        else if (type === 'plan') result = await plan(data);
        else if (type === 'ask') result = await ask(data);
        else if (type === 'remove') result = await remove();
        else throw new Error(`Unknown request ${type}`);
        post({id, ok: true, result});
    } catch (error) {
        post({id, ok: false, error: String(error?.message || error)});
    }
};

async function load({name}) {
    const planner = PLANNERS[name];
    if (!planner) throw new Error(`Unknown planner ${name}`);
    if (loaded?.name === name) return {name, repo: planner.repo};
    if (loaded) await loaded.model.dispose?.();
    loaded = null;
    const started = performance.now();
    transformers = transformers || await import(TRANSFORMERS_URL);
    transformers.env.allowLocalModels = false;
    const files = new Map();
    // Per file: bytes so far and in all (the model's parts arrive one after another).
    const progress_callback = info => {
        if (info.status !== 'progress' || !info.file) return;
        files.set(info.file, {loaded: info.loaded, total: info.total});
        let received = 0, total = 0;
        for (const file of files.values()) {
            received += file.loaded || 0;
            total += file.total || 0;
        }
        post({type: 'progress', received, total});
    };
    const cache = await caches.open(CACHE_NAME);
    transformers.env.useCustomCache = false;
    if (planner.graph) {
        // Transformers.js asks its cache for the decoder's graph by its huggingface.co URL: it
        // gets this site's instead (the weights it names are the original's, fetched as usual).
        const decoder = `${HUB}/${planner.repo}/resolve/${planner.revision}/${DECODER_GRAPH}`;
        const patched = graphKey(name, planner);
        if (!await cache.match(patched)) await prepareGraph(planner, patched, cache, progress_callback);
        const url = request => (typeof request === 'string' ? request : request.url);
        transformers.env.useCustomCache = true;
        transformers.env.customCache = {
            match: request => cache.match(url(request) === decoder ? patched : request),
            put: (request, response) => cache.put(request, response),
        };
    }
    const options = {revision: planner.revision, progress_callback};
    const processor = await transformers.AutoProcessor.from_pretrained(planner.repo, options);
    const model = await transformers.AutoModelForImageTextToText.from_pretrained(planner.repo,
        {...options, dtype: planner.dtype, device: 'webgpu'});
    if (planner.size) processor.image_processor.do_resize = false;
    loaded = {name, processor, model};
    return {name, repo: planner.repo, revision: planner.revision, license: planner.license,
            loadSeconds: (performance.now() - started) / 1000};
}

// RGBA to the RGB image the processor takes.
function rgbImage({data, width, height}) {
    const rgb = new Uint8ClampedArray(width * height * 3);
    for (let i = 0, o = 0; i < data.length; i += 4, o += 3) {
        rgb[o] = data[i]; rgb[o + 1] = data[i + 1]; rgb[o + 2] = data[i + 2];
    }
    return new transformers.RawImage(rgb, width, height, 3);
}

const SYSTEM = 'You plan for an AI playing a Nintendo 3DS game. The image shows the top screen (400x240) above ' +
    'the bottom touch screen (320x240, centred below it). A fast reflex model presses the buttons moment to ' +
    'moment; every few seconds you look and set its course.';

// Small models keep to labelled lines better than to JSON.
const PLAN_LINES = `Answer in exactly these 7 lines:
SCREENS: what the two screens show, in under 15 words
GOAL: the next thing to achieve, in under 8 words
MODE: menu if a menu, a dialogue or the bottom screen needs input, else play
MOVE: up, down, left, right or none
PRESS: the one button to press next (A, B, X, Y, L or R), or none
AVOID: the buttons to avoid, or none
TAP: x,y of the point to touch on the bottom screen, in this image's pixels, or none`;

const ACT_LINES = `Answer in exactly these 5 short lines:
MODE: menu if a menu, a dialogue or the bottom screen needs input, else play
MOVE: up, down, left, right or none
PRESS: the one button to press next (A, B, X, Y, L or R), or none
AVOID: the buttons to avoid, or none
TAP: x,y of the point to touch on the bottom screen, in this image's pixels, or none`;

const BUTTONS = ['A', 'B', 'X', 'Y', 'L', 'R'];
const MOVES = ['up', 'down', 'left', 'right', 'none'];

function describe(previous) {
    if (!previous) return 'none';
    return `goal "${previous.goal}", ${previous.mode}, move ${previous.move}` +
        (previous.press.length ? `, press ${previous.press.join(' ')}` : '') +
        (previous.tap ? `, tapped ${previous.tap.join(',')}` : '');
}

// Small models answer short multiple-choice questions far more reliably than they fill in a
// form: a look is a numbered list of them (one model call), and a touch point is asked for
// only when a menu waits.
const QUESTIONS = [
    ['menu', 'Is a menu, a dialogue box or a button on the bottom screen waiting for the player? (yes or no)', ['yes', 'no']],
    ['move', 'Which way should the player move now to make progress? (left, right, up, down or none)', MOVES],
    ['press', 'Which one button should the player press now? (A, B, X, Y or none)', [...BUTTONS.slice(0, 4), 'none']],
];
const GOAL_QUESTION = 'In five words or fewer, what should the player do next?';
const TAP_QUESTION = 'Where on the bottom screen should the player touch? Answer x,y in this image\'s pixels, or none.';

// The one allowed word an answer gives; several (an echoed list of choices) or none: null.
function choice(answer, allowed) {
    const words = String(answer || '').toLowerCase().match(/[a-z]+/g) || [];
    const found = [...new Set(words.filter(word => allowed.some(item => item.toLowerCase() === word)))];
    return found.length === 1 ? allowed.find(item => item.toLowerCase() === found[0]) : null;
}

async function plan({screens, notes, previous, withGoal = true}) {
    const questions = [...QUESTIONS.map(([, text]) => text), ...(withGoal ? [GOAL_QUESTION] : [])];
    const prompt = `Notes from the player (quest log, task at hand, manual): ${notes?.trim() || 'none'}\n` +
        `Answer each question in a word or two, as a numbered list.\n` +
        questions.map((text, i) => `${i + 1}. ${text}`).join('\n');
    const answer = await generate(screens, SYSTEM, prompt, withGoal ? 40 : 24);
    const answers = {};
    for (const line of answer.text.split('\n')) {
        const match = /^\s*(\d+)\s*[.):-]\s*(.*)$/.exec(line);
        if (match) answers[Number(match[1])] = match[2].trim();
    }
    const value = index => answers[index + 1];
    const menu = choice(value(0), ['yes', 'no']) === 'yes';
    const move = choice(value(1), MOVES) || 'none';
    const press = choice(value(2), BUTTONS);
    let tap = null, ms = answer.ms;
    if (menu) {
        const where = await generate(screens, SYSTEM, TAP_QUESTION, 12);
        const point = where.text.match(/-?\d+(\.\d+)?/g);
        if (point && point.length === 2) tap = point.map(Number);
        ms += where.ms;
    }
    const goal = withGoal && value(3) ? value(3).replace(/[.]+$/, '') : previous?.goal || '';
    const parsed = Object.keys(answers).length >= 2;
    return {...answer, ms, plan: parsed ? {screens: previous?.screens || '', goal, mode: menu ? 'menu' : 'play', move,
        press: press ? [press] : [], avoid: [], tap} : null};
}

async function ask({screens, question, maxTokens = 160}) {
    return generate(screens, null, question, maxTokens);
}

// The model's lines (or JSON), checked field by field: anything malformed is dropped, not
// guessed. A plan needs at least a mode, and a goal (or the last plan's).
function parsePlan(text, previous) {
    const raw = {};
    for (const line of text.split('\n')) {
        const match = /^[\s*#-]*([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
        if (match) raw[match[1].toLowerCase()] = match[2].trim();
    }
    if (!raw.goal && previous?.goal) raw.goal = previous.goal;
    if (!raw.screens && previous?.screens) raw.screens = previous.screens;
    if (!raw.goal || !raw.mode) {
        const start = text.indexOf('{'), end = text.lastIndexOf('}');
        try {
            Object.assign(raw, JSON.parse(text.slice(start, end + 1)));
        } catch (_) {
            return null;
        }
    }
    const words = value => (Array.isArray(value) ? value.join(' ') : String(value ?? '')).toUpperCase();
    const list = value => [...new Set(words(value).match(/\b[ABXYLR]\b/g) || [])].filter(item => BUTTONS.includes(item));
    const move = String(raw.move || 'none').toLowerCase().match(/up|down|left|right|none/)?.[0] || 'none';
    const point = Array.isArray(raw.tap) ? raw.tap : String(raw.tap ?? '').match(/-?\d+(\.\d+)?/g);
    const tap = point && point.length === 2 && point.every(value => Number.isFinite(Number(value))) ? point.map(Number) : null;
    return {
        screens: typeof raw.screens === 'string' ? raw.screens : '',
        goal: typeof raw.goal === 'string' ? raw.goal : '',
        mode: /menu/i.test(String(raw.mode)) ? 'menu' : 'play',
        move: MOVES.includes(move) ? move : 'none',
        press: list(raw.press || []),
        avoid: list(raw.avoid || []),
        tap,
    };
}

async function generate(screens, system, prompt, maxTokens) {
    if (!loaded) throw new Error('The planner is not loaded.');
    const {processor, model} = loaded;
    const started = performance.now();
    const conversation = [
        ...(system ? [{role: 'system', content: [{type: 'text', text: system}]}] : []),
        {role: 'user', content: [{type: 'image'}, {type: 'text', text: prompt}]},
    ];
    const text = processor.apply_chat_template(conversation, {add_generation_prompt: true});
    const planner = PLANNERS[loaded.name];
    const image = planner.size ? await rgbImage(screens).resize(...planner.size) : rgbImage(screens);
    const inputs = planner.imageFirst
        ? await processor(image, text, {add_special_tokens: false})
        : await processor(text, image);
    const promptTokens = inputs.input_ids.dims.at(-1);
    const outputs = await model.generate({...inputs, max_new_tokens: maxTokens, do_sample: false});
    const answer = processor.batch_decode(outputs.slice(null, [promptTokens, null]), {skip_special_tokens: true})[0];
    return {text: answer.trim(), ms: performance.now() - started, promptTokens,
            newTokens: outputs.dims.at(-1) - promptTokens};
}

async function remove() {
    if (loaded) await loaded.model.dispose?.();
    loaded = null;
    return {deleted: await caches.delete(CACHE_NAME)};
}

// ── Fine-tuned planners ──────────────────────────────────────────

const HUB = 'https://huggingface.co';
const DECODER_GRAPH = 'onnx/decoder_model_merged_q4f16.onnx';

// Where a fine-tuned planner's decoder graph is kept: beside the original's, in a folder named
// after the planner and its graph (a new one makes a new folder).
function graphKey(name, planner) {
    return `${HUB}/${planner.repo}/resolve/${planner.revision}/onnx/azahar-${name}-${planner.graph.sha256.slice(0, 12)}/` +
        DECODER_GRAPH.slice('onnx/'.length);
}

// Fetches a file with progress (reported as `file` to `progress_callback`).
async function fetchBytes(url, file, progress_callback) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const parts = [];
    let loaded = 0;
    for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        parts.push(value);
        loaded += value.byteLength;
        progress_callback({status: 'progress', file, loaded, total: total || loaded});
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }
    return bytes;
}

// The fine-tuned decoder graph from this site, checked and kept.
async function prepareGraph(planner, key, cache, progress_callback) {
    const graph = await fetchBytes(new URL(planner.graph.url, self.location.href).href, 'game fine-tune', progress_callback);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', graph))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== planner.graph.sha256) throw new Error('The game fine-tune is not the one this page expects.');
    await cache.put(key, new Response(graph, {headers: {'content-type': 'application/octet-stream',
        'content-length': String(graph.byteLength)}}));
}
