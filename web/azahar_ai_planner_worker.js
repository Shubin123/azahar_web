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
 * plan    one look: the screens (RGBA, 400x480: the top screen over the bottom one), the
 *         player's notes and the last plan to the next plan (PLAN_LINES, parsed).
 * ask     the screens and a question to the model's answer (tests).
 * remove  deletes the cached model files.
 */

const TRANSFORMERS_VERSION = '4.3.2';
const TRANSFORMERS_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js`;
const CACHE_NAME = 'transformers-cache';

// The planners the page offers. dtype: per part of the model, as its card recommends for
// WebGPU (4-bit text, float16 vision).
const PLANNERS = {
    'qwen3.5-0.8b': {repo: 'onnx-community/Qwen3.5-0.8B-ONNX', revision: '8fe9dbe3fb39fe902e18df9be84b6a0ac77ae0f6',
        license: 'Apache-2.0', dtype: {embed_tokens: 'q4', vision_encoder: 'fp16', decoder_model_merged: 'q4'}},
    'lfm2.5-vl-450m': {repo: 'onnx-community/LFM2.5-VL-450M-ONNX', revision: '24e63007ff1aaafbde27c89eb01a0513f4f61482',
        license: 'LFM Open License v1.0', dtype: {embed_tokens: 'q4', vision_encoder: 'fp16', decoder_model_merged: 'q4'}},
    'qwen3.5-2b': {repo: 'onnx-community/Qwen3.5-2B-ONNX', revision: '315216e893038beefcc6eba41ac168913dd0d879',
        license: 'Apache-2.0', dtype: {embed_tokens: 'q4', vision_encoder: 'fp16', decoder_model_merged: 'q4'}},
};

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
    const options = {revision: planner.revision, progress_callback};
    const processor = await transformers.AutoProcessor.from_pretrained(planner.repo, options);
    const model = await transformers.AutoModelForImageTextToText.from_pretrained(planner.repo,
        {...options, dtype: planner.dtype, device: 'webgpu'});
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
PRESS: the buttons to press (A, B, X, Y, L, R), or none
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

async function plan({screens, notes, previous}) {
    const prompt = `Notes from the player (quest log, task at hand, manual): ${notes?.trim() || 'none'}\n` +
        `Your last plan: ${describe(previous)}\n${PLAN_LINES}`;
    const answer = await generate(screens, SYSTEM, prompt, 96);
    return {...answer, plan: parsePlan(answer.text)};
}

async function ask({screens, question, maxTokens = 160}) {
    return generate(screens, null, question, maxTokens);
}

// The model's lines (or JSON), checked field by field: anything malformed is dropped, not
// guessed. A plan needs at least a goal and a mode.
function parsePlan(text) {
    const raw = {};
    for (const line of text.split('\n')) {
        const match = /^[\s*#-]*([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
        if (match) raw[match[1].toLowerCase()] = match[2].trim();
    }
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
    const inputs = await processor(text, rgbImage(screens));
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

