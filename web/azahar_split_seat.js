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

    // How the two screens fill this frame, the player's Screens menu on the page (?screens=):
    //   'top': each keeps its shape, the top screen as large as the frame allows and the touch
    //          screen 50-75% of its size, below it or beside it, whichever leaves the top larger;
    //   'stretch': the same touch screen, and the top screen stretched over all the rest;
    //   'native': both at one size, stacked as on a 3DS.
    const SCREENS = ['top', 'stretch', 'native'];
    const BIG_TOP = {arrangement: 'auto', bottomMin: 50, bottomMax: 75};
    // The engine's drawable is at least the native 400x480 frame (it keeps that minimum
    // window size), on each axis on its own: the browser fits it to the canvas, so a short
    // frame need not cost a wide drawable. Every console shares this device's processor, on
    // which the software renderer scales the screens and copies them to the page every frame:
    // it otherwise draws only as many pixels as the native frame, and the browser enlarges them.
    const NATIVE_W = 400, NATIVE_H = 480;
    const software = window.AzaharWebConfig?.renderer !== 'webgl2';
    const canvas = document.getElementById('canvas');
    const requested = new URLSearchParams(location.search).get('screens');
    let screens = SCREENS.includes(requested) ? requested : 'top';
    let layout = null;  // {screens, width, height, top, bottom}: CSS pixels of the canvas
    let pendingLayout = 0;

    // The top screen takes the room the touch screen leaves, in the arrangement Big top chose.
    function stretchTop({kind, bottom}, width, height) {
        if (kind === 'side') {
            return {kind, top: {x: 0, y: 0, w: width - bottom.w, h: height},
                bottom: {...bottom, x: width - bottom.w, y: (height - bottom.h) / 2}};
        }
        return {kind, top: {x: 0, y: 0, w: width, h: height - bottom.h},
            bottom: {...bottom, x: (width - bottom.w) / 2, y: height - bottom.h}};
    }

    function applyScreens() {
        pendingLayout = 0;
        const module = window.AzaharUI?.getModule?.();
        if (!window.AzaharUI?.isInitialized() || !module?._azahar_set_screen_layout) return;
        const fill = screens !== 'native';
        // Filling the frame, the canvas is the frame's shape (see html.split-seat-fill).
        document.documentElement.classList.toggle('split-seat-fill', fill);
        const width = canvas.clientWidth, height = canvas.clientHeight;
        if (width < 1 || height < 1) return;
        let next;
        if (fill) {
            next = window.AzaharFullscreen.computeLayout(width, height, BIG_TOP);
            if (screens === 'stretch') next = stretchTop(next, width, height);
            let scale = window.devicePixelRatio || 1;
            if (software) scale = Math.min(scale, Math.sqrt(NATIVE_W * NATIVE_H / (width * height)));
            const result = window.AzaharFullscreen.drawLayout(next, width, height,
                [Math.max(scale, NATIVE_W / width), Math.max(scale, NATIVE_H / height)]);
            if (result) window.AzaharUI.log(`Screen layout rejected (code ${result}).`);
        } else {
            module._azahar_set_screen_layout(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
            next = {top: {x: 0, y: 0, w: width, h: height / 2},
                bottom: {x: width / 10, y: height / 2, w: width * 0.8, h: height / 2}};
        }
        layout = {screens, width, height, top: next.top, bottom: next.bottom};
        // The page puts its join panel over the top screen (see placeJoinPanel in azahar_split.js).
        const box = canvas.getBoundingClientRect();
        post({event: 'screens', top: {x: box.left + next.top.x, y: box.top + next.top.y,
            w: next.top.w, h: next.top.h}, frame: {w: window.innerWidth, h: window.innerHeight}});
    }

    function scheduleScreens() {
        if (!pendingLayout) pendingLayout = requestAnimationFrame(applyScreens);
    }
    window.addEventListener('resize', scheduleScreens);

    function announceReady() {
        const ready = () => {
            applyScreens();
            post({event: 'ready'});
        };
        if (window.AzaharUI?.isInitialized()) ready();
        else window.addEventListener('azahar-initialized', ready, {once: true});
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announceReady);
    else announceReady();

    window.AzaharSplitSeat = {
        // The player picked another Screens setting on the page.
        setScreens(value) {
            if (!SCREENS.includes(value) || value === screens) return;
            screens = value;
            applyScreens();
        },
        // Where the screens are: {screens, width, height, top, bottom} in CSS pixels of the
        // canvas (null until the emulator is ready).
        screens: () => layout && {...layout, top: {...layout.top}, bottom: {...layout.bottom}},
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
