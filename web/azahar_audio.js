/**
 * Game audio (web/azahar_audio.js).
 *
 * The emulator's WebAudio sink pumps interleaved stereo s16 samples into a
 * ring buffer in shared WebAssembly memory once per browser frame (see
 * azahar_audio_ring in the engine). An AudioWorklet on the browser's audio
 * thread drains it. Ring header, as u32 words: frames written, frames read
 * (both free-running), capacity in frames (a power of two), sample rate;
 * samples follow at byte offset 16.
 *
 * Browsers only start audio after a user gesture, so the context is resumed
 * on the first click or key press.
 *
 * Usage: AzaharAudio.attach(Module); AzaharAudio.setMuted(true|false);
 */
(function () {
    'use strict';

    const MUTED_KEY = 'azahar.audioMuted';

    const PROCESSOR_SOURCE = `
        class AzaharRingProcessor extends AudioWorkletProcessor {
            constructor(options) {
                super();
                const { buffer, pointer } = options.processorOptions;
                this.header = new Int32Array(buffer, pointer, 4);
                this.capacity = this.header[2];
                this.samples = new Int16Array(buffer, pointer + 16, this.capacity * 2);
            }

            process(inputs, outputs) {
                const left = outputs[0][0];
                const right = outputs[0][1] || left;
                const mask = this.capacity - 1;
                const written = Atomics.load(this.header, 0) >>> 0;
                const read = Atomics.load(this.header, 1) >>> 0;
                const available = (written - read) >>> 0;
                const count = Math.min(left.length, available);
                for (let i = 0; i < count; i++) {
                    const index = ((read + i) & mask) * 2;
                    left[i] = this.samples[index] / 32768;
                    right[i] = this.samples[index + 1] / 32768;
                }
                // Underrun: emit silence rather than stale samples.
                left.fill(0, count);
                if (right !== left) right.fill(0, count);
                Atomics.store(this.header, 1, (read + count) | 0);
                return true;
            }
        }
        registerProcessor('azahar-ring', AzaharRingProcessor);
    `;

    let context = null;
    let gain = null;
    let muted = false;
    try { muted = localStorage.getItem(MUTED_KEY) === '1'; } catch (_) { /* storage blocked */ }
    const listeners = new Set();

    function resume() {
        if (context && context.state !== 'running') void context.resume().catch(() => {});
    }

    // Resume on the first gestures; autoplay policy keeps the context
    // suspended until the page has been interacted with.
    for (const type of ['pointerdown', 'keydown', 'touchend']) {
        window.addEventListener(type, resume, { capture: true, passive: true });
    }

    async function attach(Module) {
        if (context || !Module?._azahar_audio_ring) return false;
        if (typeof AudioWorkletNode === 'undefined' || typeof SharedArrayBuffer === 'undefined') {
            console.warn('Audio needs AudioWorklet support and a cross-origin isolated page.');
            return false;
        }
        const pointer = Module._azahar_audio_ring();
        const header = new Uint32Array(Module.HEAPU8.buffer, pointer, 4);
        const sampleRate = header[3];
        try {
            // Run the context at the emulator's native rate; the browser
            // resamples to the output device.
            context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
            const moduleUrl = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'text/javascript' }));
            try {
                await context.audioWorklet.addModule(moduleUrl);
            } finally {
                URL.revokeObjectURL(moduleUrl);
            }
            const node = new AudioWorkletNode(context, 'azahar-ring', {
                numberOfInputs: 0,
                outputChannelCount: [2],
                processorOptions: { buffer: Module.HEAPU8.buffer, pointer },
            });
            gain = context.createGain();
            gain.gain.value = muted ? 0 : 1;
            node.connect(gain).connect(context.destination);
            resume();
            notify();
            return true;
        } catch (error) {
            console.warn('Could not start game audio:', error);
            context?.close().catch(() => {});
            context = null;
            gain = null;
            return false;
        }
    }

    function setMuted(value) {
        muted = Boolean(value);
        try { localStorage.setItem(MUTED_KEY, muted ? '1' : '0'); } catch (_) { /* storage blocked */ }
        if (gain) gain.gain.value = muted ? 0 : 1;
        if (!muted) resume();
        notify();
    }

    function notify() {
        for (const listener of listeners) listener(getState());
    }

    function getState() {
        return { attached: Boolean(context), muted, running: context?.state === 'running' };
    }

    function onChange(listener) {
        listeners.add(listener);
        listener(getState());
    }

    window.AzaharAudio = { attach, setMuted, isMuted: () => muted, getState, onChange, resume };
})();
