/**
 * Azahar Web — AI player worker (azahar_ai_worker.js, a module worker)
 * Prepares and runs NVIDIA's NitroGen for azahar_ai_player.js, away from the page's thread.
 *
 * prepare  streams NVIDIA's ng.pt from huggingface.co (the revision vendor/nitrogen pins),
 *          checks each tensor it uses against the CRC32 the manifest records, quantizes it
 *          and lays it out as the manifest says (scripts/nitrogen/nitrogen_onnx.py does the
 *          same, and the result must match its SHA-256), then keeps the two weights files in
 *          Cache Storage. ng.pt itself is never stored: it is read once and dropped.
 *          With a light expert in the manifest (scripts/nitrogen/nitrogen_light_expert.py), its
 *          own weights come from this site (checked against the manifest's SHA-256s) and are
 *          kept with the rest.
 * load     ONNX Runtime Web (from cdn.jsdelivr.net) with WebGPU, else WebAssembly.
 * act      one decision: the 256x256 input to 18 actions of 25 values (an encoder, then
 *          the denoiser's flow-matching steps in one run; an unchanged image skips the
 *          encoder). With a light expert, a mixture of two encoders: the light one (SigLIP-
 *          base and an adapter into NitroGen's image features) runs on every image, and
 *          NitroGen's own (SigLIP2-large) only on those whose actions its gate predicts the
 *          light one gets wrong; most decisions never use the heavy encoder's weights. The
 *          mixture also checks itself (VERIFY): now and then both encoders see the same
 *          image and the actions they lead to from the same noise are compared; in a game
 *          where the light expert does not act like NitroGen, NitroGen's encoder decides.
 * remove   deletes the cached model.
 *
 * With `store: false` (the tests' float32 reference and model variants, see
 * tests/ai_common.cjs) prepare keeps the weights in this worker's memory instead, and load
 * uses them.
 */

// The deploy's stamp (?v=, see azahar_ui.js) goes on the model files too, so a page never
// pairs one deploy's description of the model with another's graphs.
const build = new URL(self.location.href).searchParams.get('v');
const ORT_VERSION = '1.31.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const CACHE_NAME = 'azahar-ai-nitrogen';

let manifest = null;
let modelUrl = null;
let downloadAbort = null;
let ort = null;
let sessions = null;
let backend = null;
let memoryWeights = null;
// Which encoder decides: 'gate' (the mixture), 'light' or 'heavy' (NitroGen's own) alone.
let routing = 'gate';
// The mixture's check of itself, in the game being played (reset when the AI starts):
// images seen, the last checks' disagreements, and whether NitroGen's encoder decides.
let verify = {images: 0, recent: [], heavy: false};
// The last image the encoder saw and what it made of it: an identical next image (a still
// menu, a dialogue box) skips the encoder.
let lastImage = null;

const cacheKey = name => new URL(`ai-model/${name}`, modelUrl).href;

function modelFile(name) {
    const url = new URL(name, modelUrl);
    if (build) url.searchParams.set('v', build);
    return url;
}

function post(message, transfer) {
    self.postMessage(message, transfer || []);
}

self.onmessage = async ({data}) => {
    const {id, type} = data;
    try {
        let result;
        if (type === 'prepare') result = await prepare(data);
        else if (type === 'cancel') result = cancel();
        else if (type === 'load') result = await load(data);
        else if (type === 'act') result = await act(data);
        else if (type === 'route') result = route(data);
        else if (type === 'reset') result = resetVerify();
        else if (type === 'remove') result = await remove();
        else throw new Error(`Unknown request ${type}`);
        const transfer = result?.actions ? [result.actions.buffer] : [];
        post({id, ok: true, result}, transfer);
    } catch (error) {
        post({id, ok: false, error: error?.name === 'AbortError' ? 'Download cancelled.' : String(error?.message || error)});
    }
};

async function fetchManifest(url) {
    modelUrl = url;
    if (!manifest) {
        const response = await fetch(modelFile('manifest.json'));
        if (!response.ok) throw new Error(`Model description missing (${response.status})`);
        manifest = await response.json();
    }
    return manifest;
}

// ── Checking ng.pt ───────────────────────────────────────────────

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function sha256(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// ── Quantization (scripts/nitrogen/nitrogen_onnx.py quantize_blocks) ─

function roundHalfEven(x) {
    const floor = Math.floor(x);
    const rest = x - floor;
    if (rest > 0.5) return floor + 1;
    if (rest < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
}

// Writes `spec`'s bytes, made from the float32 tensor `src`, into `out`.
function convertTensor(spec, src, out, smooth) {
    const outF32 = (placed) => new Float32Array(out.buffer, out.byteOffset + placed.offset, placed.length / 4);
    if (spec.op === 'f32') {
        const count = spec.data.length / 4;
        outF32(spec.data).set(src.subarray(0, count));
        return;
    }
    if (spec.op === 'f32T') {
        const [k, n] = spec.shape;
        const dst = outF32(spec.data);
        for (let row = 0; row < n; row++) {
            for (let col = 0; col < k; col++) dst[col * n + row] = src[row * k + col];
        }
        return;
    }
    const {k, n, bits, block} = spec;
    const qmax = 2 ** (bits - 1) - 1;
    const zero = 2 ** (bits - 1);
    const blocks = k / block;
    const blob = block * bits / 8;
    const scales = outF32(spec.scales);
    const data = new Uint8Array(out.buffer, out.byteOffset + spec.data.offset, spec.data.length);
    const values = new Float32Array(block);
    const scaleIn = spec.smooth ? new Float32Array(smooth.buffer, smooth.byteOffset + spec.smooth.offset, k) : null;
    for (let row = 0; row < n; row++) {
        for (let b = 0; b < blocks; b++) {
            let amax = 0;
            for (let i = 0; i < block; i++) {
                const col = b * block + i;
                let w = spec.transpose ? src[col * n + row] : src[row * k + col];
                if (scaleIn) w = Math.fround(w * scaleIn[col]);
                values[i] = w;
                const a = Math.abs(w);
                if (a > amax) amax = a;
            }
            const scale = Math.fround(amax / qmax);
            const divisor = scale === 0 ? 1 : scale;
            scales[row * blocks + b] = scale;
            const base = (row * blocks + b) * blob;
            for (let i = 0; i < block; i++) {
                let q = roundHalfEven(Math.fround(values[i] / divisor));
                q = Math.min(qmax, Math.max(-qmax - 1, q)) + zero;
                if (bits === 8) data[base + i] = q;
                else if (i & 1) data[base + (i >> 1)] |= q << 4;
                else data[base + (i >> 1)] = q;
            }
        }
    }
}

// ── prepare ──────────────────────────────────────────────────────

async function prepare({modelUrl: url, sourceUrl, store = true}) {
    const model = await fetchManifest(url);
    const source = sourceUrl || model.source.url;
    const graphs = Object.entries(model.graphs);
    const out = Object.fromEntries(graphs.map(([name, graph]) => [name, new Uint8Array(graph.weightsSize)]));
    let smooth = null;
    if (model.smooth) {
        const response = await fetch(modelFile(model.smooth.file));
        if (!response.ok) throw new Error(`Activation scales missing (${response.status})`);
        smooth = new Float32Array(await response.arrayBuffer());
    }
    const entries = Object.entries(model.entries)
        .map(([name, entry]) => ({name, ...entry}))
        .sort((a, b) => a.offset - b.offset);
    const work = new Map(entries.map(entry => [entry.name, []]));
    for (const [graph, description] of graphs) {
        for (const spec of description.tensors) work.get(spec.entry).push({graph, spec});
    }

    downloadAbort = new AbortController();
    const started = performance.now();
    // no-store: the browser's HTTP cache would otherwise keep a second, undeletable copy.
    const response = await fetch(source, {signal: downloadAbort.signal, cache: 'no-store'});
    if (!response.ok) throw new Error(`Hugging Face answered ${response.status} for ng.pt`);
    const total = Number(response.headers.get('content-length')) || model.source.size;
    if (total !== model.source.size) {
        throw new Error(`ng.pt is ${total} bytes, not the ${model.source.size} of the pinned revision`);
    }
    const reader = response.body.getReader();
    let position = 0;
    let current = 0;
    let entryBytes = null;
    let lastProgress = 0;
    for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        const chunkStart = position;
        position += value.length;
        while (current < entries.length) {
            const entry = entries[current];
            const end = entry.offset + entry.length;
            if (entry.offset >= position) break;
            if (!entryBytes) entryBytes = new Uint8Array(entry.length);
            const from = Math.max(entry.offset, chunkStart);
            const to = Math.min(end, position);
            entryBytes.set(value.subarray(from - chunkStart, to - chunkStart), from - entry.offset);
            if (to < end) break;
            if (crc32(entryBytes) !== entry.crc32) {
                throw new Error(`ng.pt does not match the pinned revision (${entry.name})`);
            }
            const floats = new Float32Array(entryBytes.buffer);
            for (const {graph, spec} of work.get(entry.name)) {
                const count = spec.srcShape.reduce((a, b) => a * b, 1);
                convertTensor(spec, floats.subarray(spec.srcOffset, spec.srcOffset + count), out[graph], smooth);
            }
            entryBytes = null;
            current++;
        }
        const now = performance.now();
        if (now - lastProgress > 250) {
            lastProgress = now;
            post({type: 'progress', phase: 'download', received: position, total,
                  seconds: (now - started) / 1000});
        }
    }
    downloadAbort = null;
    if (current < entries.length || position !== total) {
        throw new Error(`The download ended early (${position} of ${total} bytes)`);
    }
    post({type: 'progress', phase: 'verify', received: total, total});
    const digests = {};
    for (const [name, graph] of graphs) {
        digests[name] = await sha256(out[name]);
        if (graph.weightsSha256 && digests[name] !== graph.weightsSha256) {
            throw new Error(`The converted ${name} weights differ from the reference conversion`);
        }
    }
    const light = model.light ? await fetchLightExpert(model.light) : null;
    if (light) digests.light = model.light.weights.map(file => file.sha256).join(',');
    const meta = {
        variant: model.variant,
        weightsSha256: digests,
        bytes: graphs.reduce((sum, [, graph]) => sum + graph.weightsSize, 0) + (light ? model.light.weightsSize : 0),
        source: {repo: model.source.repo, revision: model.source.revision, url: source},
        preparedAt: new Date().toISOString(),
        downloadSeconds: (performance.now() - started) / 1000,
    };
    if (!store) {
        memoryWeights = Object.fromEntries(graphs.map(([name, graph]) => [graph.weights, out[name]]));
        if (light) Object.assign(memoryWeights, light);
        return meta;
    }
    const cache = await caches.open(CACHE_NAME);
    for (const [name, graph] of graphs) {
        await cache.put(cacheKey(graph.weights), new Response(out[name],
            {headers: {'content-type': 'application/octet-stream'}}));
    }
    if (light) await storeLightExpert(cache, light);
    // Written last: a model is cached once its description is.
    await cache.put(cacheKey('meta.json'), new Response(JSON.stringify(meta),
        {headers: {'content-type': 'application/json'}}));
    return meta;
}

// The light expert's own weights, from this site (they are trained here, not NVIDIA's), by
// file name.
async function fetchLightExpert(description) {
    post({type: 'progress', phase: 'light', received: 0, total: description.weightsSize});
    const files = {};
    for (const {file, sha256: digest} of description.weights) {
        const response = await fetch(modelFile(file));
        if (!response.ok) throw new Error(`The light expert's weights are missing (${response.status})`);
        files[file] = new Uint8Array(await response.arrayBuffer());
        if (await sha256(files[file]) !== digest) throw new Error('The light expert\'s weights are damaged');
    }
    return files;
}

async function storeLightExpert(cache, files) {
    for (const [file, bytes] of Object.entries(files)) {
        await cache.put(cacheKey(file), new Response(bytes, {headers: {'content-type': 'application/octet-stream'}}));
    }
}

function cancel() {
    downloadAbort?.abort();
    return {};
}

// ── load / act ───────────────────────────────────────────────────

async function readCached(cache, name) {
    if (memoryWeights) return memoryWeights[name];
    const response = await cache.match(cacheKey(name));
    if (!response) throw new Error('The model is not downloaded.');
    return new Uint8Array(await response.arrayBuffer());
}

async function load({modelUrl: url, preferred, expert}) {
    const model = await fetchManifest(url);
    if (expert) routing = expert;
    if (sessions) return {backend, light: Boolean(sessions.light), routing: sessions.light ? routing : 'heavy'};
    const cache = memoryWeights ? null : await caches.open(CACHE_NAME);
    if (cache) {
        const metaResponse = await cache.match(cacheKey('meta.json'));
        const meta = metaResponse ? await metaResponse.json() : null;
        if (!meta) throw new Error('The model is not downloaded.');
        for (const [name, graph] of Object.entries(model.graphs)) {
            if (graph.weightsSha256 && meta.weightsSha256[name] !== graph.weightsSha256) {
                throw new Error('The downloaded model is for an older version of this page; delete it and download it again.');
            }
        }
    }
    const started = performance.now();
    ort = ort || await import(`${ORT_BASE}ort.webgpu.min.mjs`);
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.logLevel = 'error';
    let useGpu = preferred !== 'wasm' && Boolean(self.navigator.gpu);
    if (useGpu) {
        try {
            useGpu = Boolean(await self.navigator.gpu.requestAdapter());
        } catch (_) {
            useGpu = false;
        }
    }
    // The emulator's own threads need the processor; the GPU does the work when it can.
    ort.env.wasm.numThreads = useGpu ? 1 : Math.max(1, Math.min(4, (self.navigator.hardwareConcurrency || 4) / 2));
    const weightFiles = {};
    const weightsOf = async name => (weightFiles[name] = weightFiles[name] || await readCached(cache, name));
    const create = async (graph, files, extra) => {
        const response = await fetch(modelFile(graph.onnx));
        if (!response.ok) throw new Error(`Model graph missing (${response.status})`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const externalData = [];
        for (const file of files) externalData.push({path: file, data: await weightsOf(file)});
        return ort.InferenceSession.create(bytes, {
            executionProviders: [useGpu ? 'webgpu' : 'wasm'],
            externalData,
            graphOptimizationLevel: 'all',
            ...extra,
        });
    };
    const kv = model.model.crossBlocks.flatMap(block => [`k${block}`, `v${block}`]);
    // The encoders' keys and values stay on the GPU for the denoiser.
    const onGpu = useGpu ? {preferredOutputLocation: Object.fromEntries(kv.map(name => [name, 'gpu-buffer']))} : {};
    if (model.light && cache) {
        const stored = await Promise.all(model.light.weights.map(({file}) => cache.match(cacheKey(file))));
        // Downloaded before this page had the light expert: fetch its weights now.
        if (stored.some(response => !response)) await storeLightExpert(cache, await fetchLightExpert(model.light));
    }
    sessions = {
        encoder: await create(model.graphs.encoder, [model.graphs.encoder.weights], onGpu),
        // The light expert reads NitroGen's VL blocks from the encoder's weights file.
        light: model.light
            ? await create(model.light, [model.light.shares, ...model.light.weights.map(({file}) => file)], onGpu) : null,
        denoise: await create(model.graphs.denoise, [model.graphs.denoise.weights], {}),
        kv,
    };
    backend = useGpu ? 'webgpu' : 'wasm';
    const loadSeconds = (performance.now() - started) / 1000;
    // The first run compiles the GPU's programs; do it before the game waits on one.
    const warm = await act({pixels: new Uint8Array(256 * 256 * 3), expert: 'heavy'});
    if (sessions.light) {
        forgetImage();
        await act({pixels: new Uint8Array(256 * 256 * 3), expert: 'light'});
    }
    return {backend, loadSeconds, warmupMs: warm.encodeMs + warm.denoiseMs, light: Boolean(sessions.light),
            routing: sessions.light ? routing : 'heavy'};
}

// The player's choice of encoder, from the next decision on.
function route({expert}) {
    routing = expert;
    return {routing: sessions?.light ? routing : 'heavy'};
}

// A new game (or the same one again): the mixture checks itself from scratch.
function resetVerify() {
    verify = {images: 0, recent: [], heavy: false};
    forgetImage();
    return {};
}

// Whether this image is one the mixture checks itself on (manifest.light.verify).
function checking() {
    if (!manifest.light.verify) return false;
    const {first, every, everyLater, laterFrom} = manifest.light.verify;
    const n = verify.images;
    return n <= first || n % (n < laterFrom ? every : everyLater) === 0;
}

// Mean absolute difference between the actions two encodings lead to from the same noises.
async function disagreement(light, heavy, count, actionHorizon, actionDim) {
    const {draws} = manifest.light.verify;
    const noise = new Float32Array(draws * count);
    for (let i = 0; i < draws; i++) noise.set(gaussianNoise(count), i * count);
    const actionsFor = async encoded => {
        const feeds = {noise: new ort.Tensor('float32', noise, [draws, actionHorizon, actionDim])};
        for (const name of sessions.kv) feeds[name] = encoded[name];
        if (sessions.denoise.inputNames.includes('guide')) {
            feeds.guide = new ort.Tensor('float32', new Float32Array(draws * count), [draws, actionHorizon, actionDim]);
            feeds.guide_weight = new ort.Tensor('float32', new Float32Array(draws * actionDim), [draws, 1, actionDim]);
        }
        const result = await sessions.denoise.run(feeds);
        const data = new Float32Array(result.actions.data);
        result.actions.dispose?.();
        return data;
    };
    const a = await actionsFor(light), b = await actionsFor(heavy);
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
}

// RGB / 127.5 - 1 in float32, as nitrogen_validate.py's pixel_values.
const PIXEL_VALUES = Float32Array.from({length: 256}, (_, i) => Math.fround(Math.fround(i / 127.5) - 1));

function gaussianNoise(count) {
    const values = new Float32Array(count);
    const uniform = new Uint32Array(count + (count & 1));
    crypto.getRandomValues(uniform);
    for (let i = 0; i < count; i += 2) {
        const u1 = (uniform[i] + 1) / 4294967297;
        const u2 = uniform[i + 1] / 4294967296;
        const radius = Math.sqrt(-2 * Math.log(u1));
        values[i] = radius * Math.cos(2 * Math.PI * u2);
        if (i + 1 < count) values[i + 1] = radius * Math.sin(2 * Math.PI * u2);
    }
    return values;
}

// `draws`: several action chunks for the image from independent noises (the planner picks
// among them), or `noises` (tests) given. The encoder runs once, the denoiser once on the
// whole batch. `guide` (18 x 25 values) and `guideWeight` (25): the planner's pull on the
// actions as they are denoised (none by default). `expert` (tests): which encoder, instead
// of the player's choice.
async function act({pixels, noise, noises, draws = 1, guide, guideWeight, profile, expert = routing}) {
    if (!sessions) throw new Error('The model is not loaded.');
    const {imageSize, actionHorizon, actionDim} = manifest.model;
    // The page sends 256x256; a model made for smaller images gets them area-averaged.
    const side = Math.round(Math.sqrt(pixels.length / 3));
    if (side !== imageSize) pixels = shrink(pixels, side, imageSize);
    const plane = imageSize * imageSize;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
        input[i] = PIXEL_VALUES[pixels[i * 3]];
        input[plane + i] = PIXEL_VALUES[pixels[i * 3 + 1]];
        input[2 * plane + i] = PIXEL_VALUES[pixels[i * 3 + 2]];
    }
    const started = performance.now();
    const reused = Boolean(lastImage) && lastImage.requested === expert && sameBytes(lastImage.pixels, pixels);
    if (!reused) {
        forgetImage();
        const feeds = {pixel_values: new ort.Tensor('float32', input, [1, 3, imageSize, imageSize])};
        let encoded = null, gate = null, used = 'heavy', checked = null;
        const mixture = expert === 'gate' && sessions.light;
        if (mixture) verify.images++;
        const check = mixture && checking();
        if (sessions.light && expert !== 'heavy' && !(mixture && verify.heavy && !check)) {
            const out = await sessions.light.run(feeds, [...sessions.kv, 'gate']);
            // The gate's predicted error of the light expert's actions (log, in units of
            // a random other frame's): above the threshold, NitroGen's encoder decides.
            gate = out.gate.data[0];
            if (check) {
                // Both encoders on this image: how differently they would act.
                encoded = await sessions.encoder.run(feeds, sessions.kv);
                checked = await disagreement(out, encoded, actionHorizon * actionDim, actionHorizon, actionDim);
                const {window: size, threshold} = manifest.light.verify;
                verify.recent = [...verify.recent, checked].slice(-size);
                verify.heavy = verify.recent.reduce((a, b) => a + b, 0) / verify.recent.length > threshold;
                for (const name of sessions.kv) out[name].dispose?.();
            } else if (expert === 'light' || gate <= manifest.light.gate.threshold) {
                encoded = out;
                used = 'light';
            } else {
                for (const name of sessions.kv) out[name].dispose?.();
            }
        }
        if (!encoded) encoded = await sessions.encoder.run(feeds, sessions.kv);
        lastImage = {pixels: new Uint8Array(pixels), encoded, requested: expert, expert: used, gate, checked};
    }
    const {encoded} = lastImage;
    // The GPU may still be working on the encoder; profiling waits for it (a 1 MB download).
    if (profile && !reused) await encoded[sessions.kv[0]].getData();
    const encodeMs = performance.now() - started;
    const count = actionHorizon * actionDim;
    const starts = noises || (noise ? [noise] : Array.from({length: draws}, () => gaussianNoise(count)));
    const batch = new Float32Array(starts.length * count);
    starts.forEach((start, index) => batch.set(start, index * count));
    // The denoiser takes all the Euler steps from each noise to its actions.
    const feeds = {noise: new ort.Tensor('float32', batch, [starts.length, actionHorizon, actionDim])};
    for (const name of sessions.kv) feeds[name] = encoded[name];
    if (sessions.denoise.inputNames.includes('guide')) {
        const guides = new Float32Array(starts.length * count), weights = new Float32Array(starts.length * actionDim);
        for (let index = 0; index < starts.length; index++) {
            if (guide) guides.set(guide, index * count);
            if (guideWeight) weights.set(guideWeight, index * actionDim);
        }
        feeds.guide = new ort.Tensor('float32', guides, [starts.length, actionHorizon, actionDim]);
        feeds.guide_weight = new ort.Tensor('float32', weights, [starts.length, 1, actionDim]);
    }
    const result = await sessions.denoise.run(feeds);
    const actions = new Float32Array(result.actions.data);
    result.actions.dispose?.();
    return {actions, encodeMs, denoiseMs: performance.now() - started - encodeMs, reused, backend,
            expert: lastImage.expert, gate: lastImage.gate, checked: lastImage.checked,
            verify: sessions.light ? {heavy: verify.heavy, checks: verify.recent.length,
                disagreement: verify.recent.length ? verify.recent.reduce((a, b) => a + b, 0) / verify.recent.length : null} : null};
}

function shrink(rgb, from, to) {
    const out = new Uint8Array(to * to * 3);
    const scale = from / to;
    const taps = Array.from({length: to}, (_, o) => {
        const start = o * scale, end = (o + 1) * scale, list = [];
        for (let i = Math.floor(start); i < Math.min(from, Math.ceil(end)); i++) {
            const overlap = Math.min(end, i + 1) - Math.max(start, i);
            if (overlap > 1e-9) list.push(i, overlap / scale);
        }
        return list;
    });
    for (let y = 0; y < to; y++) {
        for (let x = 0; x < to; x++) {
            for (let c = 0; c < 3; c++) {
                let value = 0;
                for (let ty = 0; ty < taps[y].length; ty += 2) {
                    for (let tx = 0; tx < taps[x].length; tx += 2) {
                        value += rgb[(taps[y][ty] * from + taps[x][tx]) * 3 + c] * taps[y][ty + 1] * taps[x][tx + 1];
                    }
                }
                out[(y * to + x) * 3 + c] = Math.min(255, Math.max(0, Math.round(value)));
            }
        }
    }
    return out;
}

function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    const words = a.length >> 2;
    const wa = new Uint32Array(a.buffer, a.byteOffset, words), wb = new Uint32Array(b.buffer, b.byteOffset, words);
    for (let i = 0; i < words; i++) if (wa[i] !== wb[i]) return false;
    for (let i = words << 2; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function forgetImage() {
    for (const tensor of Object.values(lastImage?.encoded || {})) tensor.dispose?.();
    lastImage = null;
}

async function releaseSessions() {
    forgetImage();
    for (const session of [sessions?.encoder, sessions?.light, sessions?.denoise]) await session?.release?.();
    sessions = null;
}

async function remove() {
    downloadAbort?.abort();
    await releaseSessions();
    return {deleted: await caches.delete(CACHE_NAME)};
}
