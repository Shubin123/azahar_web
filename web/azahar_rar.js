// Start the RAR worker before the emulator reserves its WebAssembly thread
// pool. This keeps archive extraction available after emulator startup.
(function () {
    'use strict';

    window.prepareAzaharRar = function () {
        if (!window.AzaharRarReady) {
            window.AzaharRarReady = import('./vendor/rars/index.js').then(async rarModule => {
                const writer = new rarModule.RarWriter({ format: 'rar50', level: 0 });
                try {
                    writer.add('worker-ready.txt', new Uint8Array([0]));
                    await writer.bytes();
                } finally {
                    writer.close();
                }
                return rarModule;
            }).catch(error => {
                console.warn('Browser RAR extraction could not be initialized:', error);
                return null;
            });
        }
        return window.AzaharRarReady;
    };
})();
