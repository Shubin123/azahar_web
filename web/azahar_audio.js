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
 * The context runs at the emulator's 32728 Hz where the browser allows it.
 * Browsers that reject that rate get their default rate, and the worklet
 * resamples. Browsers only start audio after a user gesture (a click, tap or
 * key press; gamepad input does not count), so the context resumes on the
 * first one.
 *
 * Settings (mute, volume, buffer latency, time stretching) persist per
 * browser and apply to every title.
 */
(function () {
    'use strict';

    const SETTINGS_KEY = 'azahar.audioSettings';
    const DEFAULTS = { muted: false, volume: 0.8, latencyMs: 100, stretching: true };
    const LATENCY_CHOICES = [50, 100, 150, 200];

    const PROCESSOR_SOURCE = `
        class AzaharRingProcessor extends AudioWorkletProcessor {
            constructor(options) {
                super();
                const { buffer, pointer, ratio } = options.processorOptions;
                this.header = new Int32Array(buffer, pointer, 4);
                this.capacity = this.header[2];
                this.samples = new Int16Array(buffer, pointer + 16, this.capacity * 2);
                // Ring frames consumed per output frame (1 when rates match).
                this.ratio = ratio;
                this.phase = 0;
                this.underruns = 0;
                // Silence before the first samples (boot) is not a dropout.
                this.started = false;
                this.reportCountdown = 0;
            }

            process(inputs, outputs) {
                const left = outputs[0][0];
                const right = outputs[0][1] || left;
                const mask = this.capacity - 1;
                const written = Atomics.load(this.header, 0) >>> 0;
                let read = Atomics.load(this.header, 1) >>> 0;
                const available = (written - read) >>> 0;
                const samples = this.samples;
                let produced = 0;
                if (this.ratio === 1) {
                    produced = Math.min(left.length, available);
                    for (let i = 0; i < produced; i++) {
                        const index = ((read + i) & mask) * 2;
                        left[i] = samples[index] / 32768;
                        right[i] = samples[index + 1] / 32768;
                    }
                    read = (read + produced) >>> 0;
                } else {
                    // Linear interpolation needs the next frame too.
                    let phase = this.phase;
                    let consumed = 0;
                    for (; produced < left.length; produced++) {
                        const whole = Math.floor(phase);
                        if (whole + 1 >= available) break;
                        const fraction = phase - whole;
                        const a = ((read + whole) & mask) * 2;
                        const b = ((read + whole + 1) & mask) * 2;
                        left[produced] = (samples[a] + (samples[b] - samples[a]) * fraction) / 32768;
                        right[produced] = (samples[a + 1] + (samples[b + 1] - samples[a + 1]) * fraction) / 32768;
                        phase += this.ratio;
                    }
                    consumed = Math.floor(phase);
                    this.phase = phase - consumed;
                    read = (read + consumed) >>> 0;
                }
                if (produced < left.length) {
                    // Underrun: emit silence rather than stale samples.
                    left.fill(0, produced);
                    if (right !== left) right.fill(0, produced);
                    if (this.started) this.underruns++;
                }
                if (produced > 0) this.started = true;
                Atomics.store(this.header, 1, read | 0);
                if (--this.reportCountdown <= 0) {
                    this.reportCountdown = 100;
                    this.port.postMessage({ underruns: this.underruns });
                }
                return true;
            }
        }
        registerProcessor('azahar-ring', AzaharRingProcessor);
    `;

    let settings = { ...DEFAULTS };
    try {
        // Carry over the mute choice stored by the first audio release.
        if (localStorage.getItem('azahar.audioMuted') === '1') settings.muted = true;
        settings = { ...settings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch (_) { /* storage blocked or corrupt; use defaults */ }

    let module = null;
    let context = null;
    let gain = null;
    let analyser = null;
    let underruns = 0;
    let ringPointer = 0;
    let ringRate = 0;
    const listeners = new Set();

    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* blocked */ }
    }

    // Perceived loudness is roughly logarithmic; squaring the slider gives an
    // even-feeling control without a dB scale.
    function effectiveGain() {
        return settings.muted ? 0 : settings.volume * settings.volume;
    }

    function resume() {
        if (context && context.state !== 'running') {
            void context.resume().catch(() => {}).finally(notify);
        }
    }

    for (const type of ['pointerdown', 'keydown', 'touchend']) {
        window.addEventListener(type, resume, { capture: true, passive: true });
    }

    // Pushes the engine-side settings; safe to call before a title loads.
    function applyEngineSettings() {
        if (!module) return;
        if (module._azahar_set_audio_latency_ms) {
            settings.latencyMs = module._azahar_set_audio_latency_ms(settings.latencyMs);
        }
        module._azahar_set_audio_stretching?.(settings.stretching ? 1 : 0);
    }

    function createContext(sampleRate) {
        // ?audioResample=1 forces the resampling path that browsers which
        // reject the native rate use, so it can be exercised anywhere.
        if (new URLSearchParams(location.search).has('audioResample')) {
            return new AudioContext({ latencyHint: 'interactive' });
        }
        try {
            return new AudioContext({ sampleRate, latencyHint: 'interactive' });
        } catch (error) {
            console.info(`AudioContext rejected ${sampleRate} Hz (${error.message}); resampling instead.`);
            return new AudioContext({ latencyHint: 'interactive' });
        }
    }

    // Engine settings may be applied as soon as the module exists, so the
    // title starts with the chosen stretching mode.
    function bindModule(Module) {
        if (module === Module || !Module) return;
        module = Module;
        applyEngineSettings();
    }

    async function attach(Module) {
        bindModule(Module);
        if (context) return true;
        if (!Module?._azahar_audio_ring) return false;
        if (typeof AudioWorkletNode === 'undefined' || typeof SharedArrayBuffer === 'undefined') {
            console.warn('Audio needs AudioWorklet support and a cross-origin isolated page.');
            return false;
        }
        ringPointer = Module._azahar_audio_ring();
        ringRate = new Uint32Array(Module.HEAPU8.buffer, ringPointer, 4)[3];
        try {
            context = createContext(ringRate);
            const moduleUrl = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'text/javascript' }));
            try {
                await context.audioWorklet.addModule(moduleUrl);
            } finally {
                URL.revokeObjectURL(moduleUrl);
            }
            const node = new AudioWorkletNode(context, 'azahar-ring', {
                numberOfInputs: 0,
                outputChannelCount: [2],
                processorOptions: {
                    buffer: Module.HEAPU8.buffer,
                    pointer: ringPointer,
                    ratio: ringRate / context.sampleRate,
                },
            });
            node.port.onmessage = event => {
                underruns = event.data.underruns;
                notify();
            };
            gain = context.createGain();
            gain.gain.value = effectiveGain();
            node.connect(gain).connect(context.destination);
            // Taps the final signal (after volume and mute) for level readouts.
            analyser = context.createAnalyser();
            analyser.fftSize = 2048;
            gain.connect(analyser);
            context.onstatechange = notify;
            resume();
            notify();
            return true;
        } catch (error) {
            console.warn('Could not start game audio:', error);
            context?.close().catch(() => {});
            context = null;
            gain = null;
            analyser = null;
            return false;
        }
    }

    function update(changes) {
        settings = { ...settings, ...changes };
        saveSettings();
        if (gain) gain.gain.setTargetAtTime(effectiveGain(), context.currentTime, 0.015);
        applyEngineSettings();
        if (!settings.muted) resume();
        notify();
    }

    function bufferedMs() {
        if (!module || !ringPointer) return 0;
        const header = new Uint32Array(module.HEAPU8.buffer, ringPointer, 2);
        return ((header[0] - header[1]) >>> 0) / ringRate * 1000;
    }

    // Peak absolute amplitude (0-1) of the most recent output block.
    function outputPeak() {
        if (!analyser) return 0;
        const block = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(block);
        let peak = 0;
        for (const value of block) peak = Math.max(peak, Math.abs(value));
        return peak;
    }

    function getState() {
        return {
            attached: Boolean(context),
            running: context?.state === 'running',
            contextRate: context?.sampleRate || 0,
            resampling: Boolean(context) && context.sampleRate !== ringRate,
            bufferedMs: bufferedMs(),
            underruns,
            ...settings,
        };
    }

    function notify() {
        const state = getState();
        for (const listener of listeners) listener(state);
    }

    function onChange(listener) {
        listeners.add(listener);
        listener(getState());
        return () => listeners.delete(listener);
    }

    window.AzaharAudio = {
        LATENCY_CHOICES,
        attach,
        bindModule,
        resume,
        getState,
        onChange,
        outputPeak,
        isMuted: () => settings.muted,
        setMuted: muted => update({ muted: Boolean(muted) }),
        setVolume: volume => update({ volume: Math.min(1, Math.max(0, Number(volume) || 0)) }),
        setLatencyMs: ms => update({ latencyMs: Number(ms) || DEFAULTS.latencyMs }),
        setStretching: enabled => update({ stretching: Boolean(enabled) }),
    };
})();
