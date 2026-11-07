// One console of split.html, which runs several consoles on one device. The
// page loads index.html?seat=N in a frame per console and, once this frame
// reports that its emulator is ready, sends the ROM and the shared link:
//   {kind: 'azahar-split', action: 'start', file, name, buffer, seat, nick, muted, restore, holdFrames}
// `restore` ({programId, bytes}, optional) is a checkpoint this console took before the page
// restarted it; the console comes back to it (see restoreGroup in azahar_split.js), with the
// link's frames held (`holdFrames`, see AzaharNetplay) until every console is back.
// Every console runs on the page's main thread, so this frame publishes how
// long its emulation steps take and fills only the share of each refresh the
// page gives it (see tuneFrameBudget in azahar_ui.js).
(function () {
    'use strict';

    if (!document.documentElement.classList.contains('split-seat')) return;

    const SMOOTHING = 0.1;
    let slot = null;
    let started = false;

    function post(message) {
        window.parent.postMessage({kind: 'azahar-split', seat: Number(new URLSearchParams(location.search).get('seat')),
            ...message}, location.origin);
    }

    async function start(message) {
        if (started) return;
        started = true;
        try {
            const netplay = window.AzaharNetplay;
            netplay.name = String(message.nick || 'Player').slice(0, 10);
            netplay.holdFrames = message.holdFrames || null;
            netplay.linkShared(message.buffer, message.seat);
            slot = netplay.shared.slot();
            window.AzaharAudio?.setMuted(Boolean(message.muted));
            await window.AzaharUI.loadRomBytes(message.file, message.name, true);
            if (message.restore) await restore(message.restore);
            post({event: 'running'});
        } catch (error) {
            post({event: 'error', message: error.message || String(error)});
        }
    }

    async function restore(checkpoint) {
        const ui = window.AzaharUI;
        post({event: 'restoring'});
        // A Download Play guest's checkpoint is of the game's child, which runs only after the
        // console restarts into it.
        if (checkpoint.programId !== ui.getProgramId()) {
            ui.setStatus('Starting the Download Play game to restore its checkpoint...');
            await ui.bootDownloadPlayChild();
        }
        ui.setStatus('Restoring the checkpoint...');
        await ui.restoreState(checkpoint.bytes);
        ui.setStatus('Running from the checkpoint.', 'ok');
    }

    window.addEventListener('message', event => {
        if (event.source !== window.parent || event.origin !== location.origin) return;
        const message = event.data;
        if (message?.kind !== 'azahar-split') return;
        if (message.action === 'start') void start(message);
    });

    // The page owns the keyboard: every player has keys of their own on it (see
    // azahar_split.js). Keys typed while this screen has focus go to the page, which hands
    // each console its player's keys; those arrive here untrusted and reach the game.
    for (const type of ['keydown', 'keyup']) {
        window.addEventListener(type, event => {
            if (!event.isTrusted) return;
            event.stopImmediatePropagation();
            if (window.parent.AzaharSplit?.routeKey(type, event)) event.preventDefault();
        }, true);
    }

    function announceReady() {
        if (window.AzaharUI?.isInitialized()) post({event: 'ready'});
        else window.addEventListener('azahar-initialized', () => post({event: 'ready'}), {once: true});
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announceReady);
    else announceReady();

    window.AzaharSplitSeat = {
        // The run loop failed (see handleRunFailure in azahar_ui.js); the page restarts this
        // console. `compiled`: compiled code was on.
        failed(detail, compiled) {
            post({event: 'failed', detail, compiled});
        },
        // Fraction of a refresh this console may spend emulating.
        budgetShare() {
            const share = slot ? slot[window.AzaharSharedLink.SLOT.share] : 0;
            return share > 0 && share <= 1 ? share : 1;
        },
        // Called after every emulation callback with its step time and the frame budget.
        report(stepMs, frameBudget) {
            if (!slot) return;
            const SLOT = window.AzaharSharedLink.SLOT;
            const saturated = stepMs >= frameBudget.appliedMs - 0.5 ? 1 : 0;
            const first = !slot[SLOT.heartbeat];
            const smooth = (index, value) => {
                slot[index] = first ? value : slot[index] + (value - slot[index]) * SMOOTHING;
            };
            smooth(SLOT.stepMs, stepMs);
            smooth(SLOT.saturated, saturated);
            slot[SLOT.frameMs] = Math.max(1, frameBudget.periodMs) * Math.max(1, frameBudget.refreshes);
            slot[SLOT.heartbeat] = window.AzaharSharedLink.wallNow();
        },
    };
})();
