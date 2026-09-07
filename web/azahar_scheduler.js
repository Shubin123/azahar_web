// Keep UI and benchmark scheduling identical. Alternative task sources let CPU
// traces distinguish refresh waits from GPU backpressure. RAF remains the default:
// uninterrupted posted tasks lengthened Mario slices without improving guest speed.
(function () {
    'use strict';
    const requested = new URLSearchParams(location.search).get('scheduler');
    const mode = requested === 'message' || requested === 'timer' ? requested : 'raf';
    const channel = new MessageChannel();
    const pending = new Map();
    let nextHandle = 1;
    channel.port1.onmessage = event => {
        const callback = pending.get(event.data);
        pending.delete(event.data);
        callback?.(performance.now());
    };
    window.AzaharScheduler = {
        mode,
        request(callback) {
            if (mode === 'raf') return requestAnimationFrame(callback);
            if (mode === 'timer') return setTimeout(() => callback(performance.now()), 0);
            const handle = nextHandle++;
            pending.set(handle, callback);
            channel.port2.postMessage(handle);
            return handle;
        },
        cancel(handle) {
            if (mode === 'raf') cancelAnimationFrame(handle);
            else if (mode === 'timer') clearTimeout(handle);
            else pending.delete(handle);
        },
    };
})();
