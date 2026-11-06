// The emulated ARM CPU interprets code until it runs often, then runs it compiled to
// WebAssembly; the engine switches per block and hands anything compiled code cannot run back
// to the interpreter (see arm_dyncom_jit.h). This watchdog is the page's half of keeping a
// game from halting: it watches a running game and, when the game looks stuck with compiled
// code on, switches the CPU to the interpreter on the spot. If that revives the game, the
// title is remembered so later sessions start on the interpreter; if not, compiled code comes
// back, since it was not the cause.
//
// Two symptoms count as stuck:
//   - no game frames for STALL_MS while emulated time keeps going (a thread spinning forever);
//     not while linked to other consoles over Local Play, where a game draws nothing while
//     it waits for a peer, and switching CPUs would only add a hitch to a timing-sensitive link;
//   - a flood of accesses to unmapped memory (a thread running garbage).
(function (root) {
    'use strict';

    const STALL_MS = 10000;
    const MIN_STALL_SPEED = 50;       // % of full speed: a slow or paused game is not stuck
    const REVIVE_MS = 15000;          // how long the interpreter has to revive the game
    const FLOOD_PER_SECOND = 500;     // unmapped accesses per second; games make a handful
    const FLOOD_SAMPLES = 2;          // in a row

    class CpuJitWatchdog {
        constructor() {
            this.state = 'watching';  // 'watching' (compiled code on), 'trial', 'done'
            this.lastFrameAt = null;
            this.lastSample = null;
            this.floodSamples = 0;
            this.calmSamples = 0;
            this.trial = null;        // {reason, since}
        }

        // `sample`: {now (ms), compiled (compiled code is on), gameFps, speed (%), unmapped
        // (accesses so far), linked (Local Play peers)}. Returns what to do, if anything:
        //   {action: 'interpreter', reason}   switch the CPU to the interpreter now
        //   {action: 'remember', reason}      it revived the game: keep this title on it
        //   {action: 'compiled'}              it did not help: switch compiled code back on
        observe(sample) {
            const previous = this.lastSample;
            this.lastSample = sample;
            if (sample.gameFps > 0 || this.lastFrameAt === null) this.lastFrameAt = sample.now;
            const seconds = previous ? (sample.now - previous.now) / 1000 : 0;
            const floodRate = previous && seconds > 0 ? (sample.unmapped - previous.unmapped) / seconds : 0;
            const flooding = floodRate >= FLOOD_PER_SECOND;
            this.floodSamples = flooding ? this.floodSamples + 1 : 0;
            this.calmSamples = flooding ? 0 : this.calmSamples + 1;

            if (this.state === 'watching') {
                if (!sample.compiled) return null;
                if (this.floodSamples >= FLOOD_SAMPLES) {
                    return this.startTrial('flood', sample.now);
                }
                const stalledFor = sample.now - this.lastFrameAt;
                if (stalledFor >= STALL_MS && sample.speed >= MIN_STALL_SPEED && !sample.linked) {
                    return this.startTrial('stall', sample.now);
                }
                return null;
            }
            if (this.state === 'trial') {
                const revived = this.trial.reason === 'stall' ? sample.gameFps > 0 :
                    this.calmSamples >= FLOOD_SAMPLES;
                if (revived) {
                    this.state = 'done';
                    return {action: 'remember', reason: this.trial.reason};
                }
                if (sample.now - this.trial.since >= REVIVE_MS) {
                    if (this.trial.reason === 'flood') {
                        // Garbage is still running: the state is damaged either way, so stay on
                        // the safer interpreter for this session without blaming compiled code.
                        this.state = 'done';
                        return null;
                    }
                    // Not compiled code's doing; wait for frames before judging again.
                    this.state = 'watching';
                    this.lastFrameAt = Infinity;
                    return {action: 'compiled'};
                }
            }
            return null;
        }

        startTrial(reason, now) {
            this.state = 'trial';
            this.trial = {reason, since: now};
            this.calmSamples = 0;
            return {action: 'interpreter', reason};
        }
    }

    // Titles that ran into trouble with compiled code, by program ID. A newer compiler
    // (JIT_VERSION) gets another chance at them.
    const JIT_VERSION = 1;
    const STORAGE_KEY = 'azahar-cpu-jit-off';

    function readTitles() {
        try {
            const titles = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            return titles && typeof titles === 'object' ? titles : {};
        } catch (_) {
            return {};
        }
    }

    const titles = {
        // The reason a title runs on the interpreter, if it does.
        get(programId) {
            const entry = programId ? readTitles()[programId] : null;
            return entry && entry.version === JIT_VERSION ? entry : null;
        },
        remember(programId, reason) {
            if (!programId) return;
            const all = readTitles();
            all[programId] = {reason, version: JIT_VERSION, at: new Date().toISOString()};
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch (_) {}
        },
        forget(programId) {
            const all = readTitles();
            delete all[programId];
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch (_) {}
        },
    };

    root.AzaharCpuJit = {CpuJitWatchdog, titles, STALL_MS, REVIVE_MS, FLOOD_PER_SECOND};
    if (typeof module !== 'undefined') module.exports = root.AzaharCpuJit;
})(typeof window !== 'undefined' ? window : globalThis);
