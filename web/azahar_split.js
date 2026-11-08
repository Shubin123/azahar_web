// split.html: several consoles on one device. Each console is index.html in
// its own frame (?seat=N, see azahar_split_seat.js), so each has its own
// emulator, MAC address and console ID, and they play the game's local
// wireless modes through one SharedArrayBuffer (azahar_shared_link.js).
//
// Every frame of this page runs on one main thread, which emulates each
// console in turn during a display refresh. The page divides each refresh
// between them from the timings they publish: a console that finished its
// step early (the game waited for its next frame) needs only what it used,
// and the rest goes to the consoles that used their whole share.
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const query = new URLSearchParams(location.search);
    // The deploy's commit, stamped on this script's URL (see .github/workflows/pages.yml): each
    // console's page is asked for with it, so none comes from the browser's cache of an earlier
    // deploy (the old page's scripts would not drive this page's join panel).
    const build = new URL(document.currentScript?.src || location.href).searchParams.get('v');
    const REBALANCE_MS = 250;
    const STATUS_MS = 500;
    // A console that has not stepped for this long is paused or loading.
    const IDLE_AFTER_MS = 1000;
    // Never squeeze a console below this share; it must be able to show it needs more.
    const MIN_SHARE = 0.15;
    // Headroom given to a console on top of what it used while finishing early.
    const SHARE_HEADROOM = 1.25;
    // Checkpoints (see scheduleCheckpoint): the first once everyone has been in one room this
    // long, and never two closer than CHECKPOINT_GAP_MS on the page, since each pauses every
    // console for a moment (about 0.6 s for Mario Party on an Apple M4).
    const FIRST_CHECKPOINT_MS = 10000;
    const CHECKPOINT_GAP_MS = 5000;
    // A console that keeps stopping is left stopped after this many restarts in a row.
    const MAX_AUTO_RESTARTS = 3;
    // How long a console reloading into the checkpoint may take (booting, the Download Play
    // child, loading) before the others play on without it.
    const RESTORE_TIMEOUT_MS = 120000;
    // A console saves only between the game's operations (AzaharUI.stateReady); a checkpoint
    // starts when every console can save at its next frame, so the link is held for one refresh,
    // and is tried again a moment later otherwise (in a Mario Kart 7 race some operation is
    // always under way, so none is taken). The hold never lasts longer than CAPTURE_HOLD_MS.
    const CAPTURE_HOLD_MS = 1500;
    const CHECKPOINT_NOT_READY_MS = 1000;
    const CHECKPOINT_RETRY_MS = 20000;
    // A console in no room joins a Download Play lobby another console opened after this long
    // (its screen counts down, with Not now) once its player has left it alone (no key, button
    // or touch) for AUTO_JOIN_IDLE_MS (?joinIdle=SECONDS), and gives up joining that lobby on its
    // own after AUTO_JOIN_TRIES joins that did not start.
    const AUTO_JOIN_MS = 5000;
    const AUTO_JOIN_IDLE_MS = (Number(query.get('joinIdle')) || 30) * 1000;
    const AUTO_JOIN_TRIES = 3;
    const DOWNLOAD_PLAY_COMM_ID = 0x2810;
    // Keyboard layouts that let two players share one keyboard. Each maps a physical key
    // (KeyboardEvent.code) to the key of the console's own default layout that drives that
    // control (see KEYMAP in azahar_input.js): A KeyA, B KeyS, X KeyZ, Y KeyX, L KeyQ,
    // R KeyW, ZL Digit1, ZR Digit2, Start KeyM, Select KeyN, D-pad T/G/F/H, Circle Pad arrows.
    const KEY_LAYOUTS = {
        left: {
            label: 'Keys: left side',
            legend: 'WASD move · G A · F B · T X · R Y · Q/E L/R · Z X C V ◀▼▲▶ · 1 Start · 2 Select',
            keys: {
                KeyW: 'ArrowUp', KeyA: 'ArrowLeft', KeyS: 'ArrowDown', KeyD: 'ArrowRight',
                KeyG: 'KeyA', KeyF: 'KeyS', KeyT: 'KeyZ', KeyR: 'KeyX', KeyQ: 'KeyQ', KeyE: 'KeyW',
                KeyZ: 'KeyF', KeyX: 'KeyG', KeyC: 'KeyT', KeyV: 'KeyH',
                Digit1: 'KeyM', Digit2: 'KeyN', Digit3: 'Digit1', Digit4: 'Digit2',
            },
        },
        right: {
            label: 'Keys: right side',
            legend: 'Arrows move · L A · K B · O X · I Y · U/P L/R · M , . / ◀▼▲▶ · Enter Start · Right Shift Select',
            keys: {
                ArrowUp: 'ArrowUp', ArrowLeft: 'ArrowLeft', ArrowDown: 'ArrowDown', ArrowRight: 'ArrowRight',
                KeyL: 'KeyA', KeyK: 'KeyS', KeyO: 'KeyZ', KeyI: 'KeyX', KeyU: 'KeyQ', KeyP: 'KeyW',
                KeyM: 'KeyF', Comma: 'KeyG', Period: 'KeyT', Slash: 'KeyH',
                Enter: 'KeyM', ShiftRight: 'KeyN', Digit9: 'Digit1', Digit0: 'Digit2',
            },
        },
        // The console's own layout (the emulator page's keymap), for one player at a time.
        all: {label: 'Keys: whole keyboard', legend: 'The emulator\'s keymap: A S Z X, arrows, T F G H, Q W, M N', keys: null},
        none: {label: 'Keys: none', legend: '', keys: {}},
    };
    // Players 1 and 2 split the keyboard; more players use controllers.
    const DEFAULT_KEYS = ['left', 'right', 'none', 'none'];

    // How each player's console lays out its two screens (see azahar_split_seat.js), kept in
    // this browser per player.
    const SCREENS = {
        top: 'Screens: big top',
        stretch: 'Screens: stretched',
        native: 'Screens: 3DS',
    };
    const SCREENS_KEY = 'azahar-split-screens';
    const screenChoices = (() => {
        try {
            const stored = JSON.parse(localStorage.getItem(SCREENS_KEY) || '[]');
            return Array.isArray(stored) ? stored.map(value => (Object.hasOwn(SCREENS, value) ? value : 'top')) : [];
        } catch (_) {
            return [];
        }
    })();
    const screensFor = index => screenChoices[index] || 'top';

    // Query options handed through to every console.
    const PASS_THROUGH = ['logFilter', 'netsim', 'pacing', 'frameBudget', 'scheduler', 'cpuClock',
        'adaptiveClock', 'hwShader', 'resolution', 'crossVersion', 'cores', 'cpuJit'];

    const statusEl = $('status');
    const seatsEl = $('seats');
    const startButton = $('btn-start');
    const stopButton = $('btn-stop');
    const storedSelect = $('stored-games');
    let rom = null;          // {file, name}
    let session = null;      // {buffer, slots, seats: [{frame, element, ...}], timer}

    function say(text, kind = '') {
        statusEl.textContent = text;
        statusEl.dataset.kind = kind;
    }

    // Shared memory needs a cross-origin isolated page. Static hosts get the
    // headers from the service worker after one reload, as on index.html.
    async function ensureIsolation() {
        if (window.crossOriginIsolated) {
            try { sessionStorage.removeItem('azahar-coi-reload'); } catch (_) {}
            return true;
        }
        let reloaded = false;
        try { reloaded = sessionStorage.getItem('azahar-coi-reload') === '1'; } catch (_) {}
        if (!('serviceWorker' in navigator) || reloaded) {
            say('This page needs cross-origin isolation (COOP/COEP headers) for shared memory. ' +
                'Serve web/ with web/server.cjs or over HTTPS.', 'error');
            return false;
        }
        try { sessionStorage.setItem('azahar-coi-reload', '1'); } catch (_) {}
        say('Enabling shared memory; reloading once…');
        await navigator.serviceWorker.register('coi-serviceworker.js', {scope: './'});
        await navigator.serviceWorker.ready;
        location.reload();
        return new Promise(() => {});
    }

    // ── Choosing the game ────────────────────────────────────────
    // Games played or downloaded on index.html are kept in browser storage
    // under the SHA-256 of their source (see azahar_library.js).
    async function storeKey(url) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }

    function store() {
        const store = window.AzaharRomFS?.store;
        return store?.available() ? store : null;
    }

    async function readStored(url) {
        const entry = store() && await store().read(await storeKey(url));
        return entry ? {file: entry.file, name: entry.meta.name || entry.meta.title || 'game.3ds'} : null;
    }

    function chooseRom(file, name) {
        rom = {file, name};
        $('rom-label').textContent = `📄 ${name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
        startButton.disabled = Boolean(session);
        if (!session) say(`Ready: ${name}. Press Start.`, 'ok');
    }

    async function listStored() {
        try {
            const entries = store() ? await store().list() : [];
            for (const entry of entries.sort((a, b) => String(a.title).localeCompare(String(b.title)))) {
                const option = document.createElement('option');
                option.value = entry.url;
                option.textContent = `${entry.title || entry.name} (${(entry.size / 1024 / 1024).toFixed(0)} MB)`;
                storedSelect.append(option);
            }
        } catch (error) {
            console.warn('Could not list stored games:', error);
        }
        storedSelect.disabled = storedSelect.options.length < 2;
    }

    $('rom-file').addEventListener('change', event => {
        const file = event.target.files[0];
        if (file) chooseRom(file, file.name);
    });
    storedSelect.addEventListener('change', async () => {
        if (!storedSelect.value) return;
        const entry = await readStored(storedSelect.value);
        if (entry) chooseRom(entry.file, entry.name);
        else say('That game is no longer in browser storage; choose the file instead.', 'error');
    });

    // ── Consoles ─────────────────────────────────────────────────
    // `interpreter`: the console restarts with compiled ARM code off, after it stopped with it on.
    function seatUrl(index, count, interpreter = false) {
        const url = new URL('index.html', location.href);
        url.searchParams.set('seat', String(index));
        url.searchParams.set('seats', String(count));
        // Halving the main thread is expected here, not a slow renderer to leave.
        url.searchParams.set('autoFallback', '0');
        if (build) url.searchParams.set('v', build);
        url.searchParams.set('screens', screensFor(index));
        if ($('renderer').value === 'software') url.searchParams.set('renderer', 'software');
        for (const name of PASS_THROUGH) {
            if (query.has(name)) url.searchParams.set(name, query.get(name));
        }
        if (interpreter) url.searchParams.set('cpuJit', '0');
        return url.toString();
    }

    function createSeat(index, count) {
        const element = $('seat-template').content.firstElementChild.cloneNode(true);
        const seat = {
            index, element,
            frame: element.querySelector('iframe'),
            state: element.querySelector('.seat-state'),
            fps: element.querySelector('.seat-fps'),
            pad: element.querySelector('.seat-pad'),
            keys: element.querySelector('.seat-keys'),
            screens: element.querySelector('.seat-screens'),
            legend: element.querySelector('.seat-legend'),
            room: element.querySelector('.seat-room'),
            mute: element.querySelector('.seat-mute'),
            join: element.querySelector('.seat-join'),
            joinText: element.querySelector('.seat-join-text'),
            dlp: element.querySelector('.seat-dlp'),
            joinLater: element.querySelector('.seat-join-later'),
            joinMode: null,      // what its join panel shows (see renderSeatButtons)
            joinOffer: null,     // {lobby, at}: the lobby it joins on its own at `at`
            joinDeclined: null,  // the lobby its player said not now to (or left)
            joinAfterRestart: null, // the lobby it joins as soon as it runs again
            autoJoins: {lobby: null, count: 0},
            inLobby: false,      // waiting in a lobby: its buttons do nothing
            lastInput: -Infinity, // when its player last pressed a key or button or touched it
            joins: [],           // each Download Play join it started: {how: 'auto' | 'button' | 'restart', host}
            reset: element.querySelector('.seat-reset'),
            mac: null,           // the console's address, kept for after it restarts
            checkpoint: null,    // {programId, bytes, at}: its part of the last checkpoint
            restore: null,       // the checkpoint it is restarting into
            holdFrames: null,    // the link's frames are held while it restarts (restoreGroup)
            whenRunning: null,   // resolves once it runs again after a restart
            interpreter: false,  // restarted with compiled code off
            failures: 0,         // restarts in a row after it stopped on its own
            events: [],          // what happened to it: {kind: 'stopped' | 'restarted' | 'restored', ...}
            // Only the first console is heard at first; two copies of one soundtrack clash.
            muted: index > 0,
            started: false,
            padCodes: '',
        };
        element.querySelector('.seat-name').textContent = `Player ${index + 1}`;
        seat.frame.title = `Player ${index + 1}'s screen`;
        const renderMute = () => {
            seat.mute.textContent = seat.muted ? '🔇' : '🔊';
            seat.mute.title = seat.muted ? 'Unmute this console' : 'Mute this console';
        };
        renderMute();
        seat.mute.addEventListener('click', event => {
            event.stopPropagation();
            seat.muted = !seat.muted;
            renderMute();
            seat.frame.contentWindow?.AzaharAudio?.setMuted(seat.muted);
        });
        seat.pad.addEventListener('click', event => event.stopPropagation());
        seat.reset.addEventListener('click', event => {
            event.stopPropagation();
            void restartSeat(seat, {reason: 'restarted'});
        });
        seat.join.addEventListener('click', event => event.stopPropagation());
        seat.dlp.addEventListener('click', () => {
            if (seat.joinMode === 'hosting') {
                seat.joinAfterRestart = seat.joinLobby;
                void restartSeat(seat, {reason: `leaves its own lobby to join Player ${session.downloadPlayHost + 1}'s`});
            } else {
                joinDownloadPlay(seat, 'button');
            }
            session.lastStatus = 0;
        });
        seat.joinLater.addEventListener('click', () => {
            if (seat.joinMode === 'lobby') seat.frame.contentWindow?.AzaharNetplay?.cancelDownloadPlay();
            seat.joinDeclined = seat.joinLobby;
            session.lastStatus = 0;
        });
        for (const [value, layout] of Object.entries(KEY_LAYOUTS)) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = layout.label;
            seat.keys.append(option);
        }
        seat.keys.value = DEFAULT_KEYS[index] || 'none';
        seat.keys.addEventListener('click', event => event.stopPropagation());
        seat.keys.addEventListener('change', () => {
            releaseKeys();
            renderKeys();
        });
        for (const [value, label] of Object.entries(SCREENS)) seat.screens.append(new Option(label, value));
        seat.screens.value = screensFor(index);
        seat.screens.addEventListener('click', event => event.stopPropagation());
        seat.screens.addEventListener('change', () => {
            screenChoices[index] = seat.screens.value;
            try {
                localStorage.setItem(SCREENS_KEY, JSON.stringify(screenChoices));
            } catch (_) { /* this session only */ }
            seat.frame.contentWindow?.AzaharSplitSeat?.setScreens(seat.screens.value);
        });
        element.querySelector('.seat-bar').addEventListener('click', () => focusSeat(seat));
        // Touches land in the console's own frame (keys and controllers come through this page).
        seat.frame.addEventListener('load', () => seat.frame.contentWindow?.addEventListener('pointerdown', () => {
            seat.lastInput = performance.now();
        }, true));
        seat.frame.src = seatUrl(index, count);
        return seat;
    }

    // The join panel goes over the lower part of the console's top screen, wherever its Screens
    // setting put it (`top`, in CSS pixels of its frame, `frame` its size; see .seat-join in
    // split.html). The frame spans its seat and ends at its bottom.
    function placeJoinPanel(seat, top, frame) {
        const style = seat.element.style;
        style.setProperty('--top-center', `${Math.round(top.x + top.w / 2)}px`);
        style.setProperty('--top-gap', `${Math.round(frame.h - top.y - top.h)}px`);
        style.setProperty('--top-width', `${Math.round(top.w)}px`);
    }

    // Restarts one console, the others playing on: its frame reloads and gets the game and the
    // link again, as at the start. Booting afresh, it leaves the game: every other console drops
    // it from the room it hosts, so it can join again under the same address (⤺ still brings
    // everyone, it too, back to the last checkpoint). With `restore` (see restoreGroup) it comes
    // back to its checkpoint instead. Resolves once it runs again: true, or false if it failed.
    function restartSeat(seat, {interpreter = false, reason = '', restore = null, holdFrames = null} = {}) {
        if (!restore) {
            for (const other of session.seats) {
                if (other !== seat) other.frame.contentWindow?.AzaharNetplay?.forgetConsole(seat.mac);
            }
            say(`Player ${seat.index + 1} ${reason}; restarting it${interpreter || seat.interpreter ?
                ' with compiled code off' : ''}. The others play on.`);
        }
        seat.started = false;
        seat.error = null;
        seat.restore = restore;
        seat.holdFrames = holdFrames;
        seat.interpreter ||= interpreter;
        seat.keyCodes = undefined;
        seat.padCodes = '';
        seat.state.textContent = restore ? 'Restarting from the checkpoint…' : 'Restarting…';
        seat.events.push({kind: 'restarted', detail: reason, checkpoint: Boolean(restore),
            interpreter: seat.interpreter});
        seat.frame.src = seatUrl(seat.index, session.seats.length, seat.interpreter);
        return new Promise(resolve => { seat.whenRunning = resolve; });
    }

    // Whether every console has a checkpoint from the same moment to go back to.
    function canRestore() {
        const at = session.checkpointAt;
        return Boolean(at) && !session.restoring && session.seats.every(seat => seat.checkpoint?.at === at);
    }

    // Every console back to the last checkpoint, which they all took at one moment (see
    // captureGroup), so their games and the link between them agree again: one console going
    // back alone (the host, say) leaves the others' games ahead of it, and they report a
    // communication error. `failed`: a console that stopped, which reloads, on the interpreter
    // when `interpreter`; so does one running another title than its checkpoint (restarted
    // afresh, it runs the game, not the Download Play child it had joined with). The others
    // load their checkpoint in place, still running (a console loads between the game's
    // operations). Frames sent meanwhile come from the abandoned timeline and are dropped; then
    // each console measures its clock against the others again. Resolves to whether every
    // console is back.
    async function restoreGroup(reason, failed = null, interpreter = false) {
        if (!canRestore()) return false;
        session.restoring = true;
        const ago = Math.round((performance.now() - session.checkpointAt) / 1000);
        say(`${reason}: every console goes back to the checkpoint of ${ago} s ago…`, 'ok');
        const reloads = seat => seat === failed ||
            seat.frame.contentWindow?.AzaharUI?.getProgramId?.() !== seat.checkpoint.programId;
        let restored = true;
        try {
            const inPlace = session.seats.filter(seat => !reloads(seat));
            for (const seat of inPlace) seat.frame.contentWindow.AzaharNetplay.holdFrames = 'drop';
            const loads = [
                ...inPlace.map(seat => seat.frame.contentWindow.AzaharUI.restoreState(seat.checkpoint.bytes)
                    .then(() => { seat.events.push({kind: 'restored'}); return true; })),
                ...session.seats.filter(reloads).map(seat => restartSeat(seat, {
                    interpreter: seat === failed && interpreter, reason, restore: seat.checkpoint,
                    holdFrames: 'drop'})),
            ];
            // A console that never comes back must not hold the others.
            const timeout = new Promise(resolve => setTimeout(() => resolve(false), RESTORE_TIMEOUT_MS));
            restored = (await Promise.all(loads.map(load => Promise.race([load, timeout])))).every(Boolean);
        } catch (error) {
            restored = false;
            console.warn('Going back to the checkpoint failed:', error);
        } finally {
            for (const seat of session.seats) {
                const netplay = seat.frame.contentWindow?.AzaharNetplay;
                if (!netplay) continue;
                netplay.pump();
                netplay.holdFrames = null;
                netplay.rebaseClocks();
            }
            session.restoring = false;
        }
        say(restored ? `Every console is back at the checkpoint of ${ago} s ago.` :
            'Going back to the checkpoint failed.', restored ? 'ok' : 'error');
        session.restores.push({reason, restored});
        return restored;
    }

    // A console stopped on its own (see AzaharSplitSeat.failed): every console goes back to the
    // last checkpoint, this one reloading; without a checkpoint it restarts afresh. Either way on
    // the interpreter when compiled code was on.
    function seatFailed(seat, detail, compiled) {
        seat.failures++;
        seat.events.push({kind: 'stopped', detail, compiled});
        if (seat.failures > MAX_AUTO_RESTARTS) {
            seat.error = `Stopped: ${detail}. It stopped ${seat.failures} times in a row; press ↺ to try again.`;
            return;
        }
        if (!canRestore()) {
            void restartSeat(seat, {interpreter: compiled, reason: `stopped (${detail})`});
            return;
        }
        void restoreGroup(`Player ${seat.index + 1} stopped (${detail})`, seat, compiled).then(restored => {
            if (!restored) {
                void restartSeat(seat, {interpreter: compiled, reason: 'could not go back to the checkpoint'});
            }
        });
    }

    // `how`: 'auto' (on its own), 'button' (📥) or 'restart' (after ↺ Restart and join). Returns
    // whether the join started.
    function joinDownloadPlay(seat, how) {
        const host = session.seats[session.downloadPlayHost];
        if (!host) return false;
        seat.joinOffer = null;
        seat.joinAfterRestart = null;
        const error = seat.frame.contentWindow?.AzaharNetplay?.joinDownloadPlay(host.mac);
        if (error) {
            // Not again on its own for this lobby; 📥 still tries.
            seat.joinDeclined = seat.joinLobby;
            say(`Player ${seat.index + 1} cannot join Download Play: ${error}.`, 'error');
            return false;
        }
        seat.joins.push({how, host: session.downloadPlayHost});
        return true;
    }

    // While everyone is in one room, all consoles take a checkpoint together now and then. Not
    // while a console is in a Download Play room: that service's state is not saved, so such a
    // checkpoint would not restore; the game's own room after it starts is fine.
    function scheduleCheckpoint(now, netplay) {
        const interval = Number($('checkpoints').value) * 1000;
        // The room everyone is in; a new one (a Download Play lobby giving way to the game's own
        // room, say) starts the wait for the first checkpoint again.
        const room = session.together >= 0 ? netplay[session.together]?.gameRoom : null;
        const roomKey = room ? `${room.host}/${room.wlanCommId}/${room.networkId}` : null;
        if (roomKey !== session.togetherRoom) {
            // Checkpoints belong to the room they were taken in. Losing it for a while (a console
            // restarting) keeps them; everyone in another room drops them.
            if (roomKey && session.lastRoom && roomKey !== session.lastRoom) {
                for (const seat of session.seats) seat.checkpoint = null;
                session.checkpointAt = null;
            }
            session.togetherRoom = roomKey;
            session.togetherSince = roomKey ? now : null;
            if (roomKey) session.lastRoom = roomKey;
        }
        if (!interval || session.capturing || session.restoring || !roomKey) return;
        if (now < Math.max(session.togetherSince + FIRST_CHECKPOINT_MS, (session.checkpointAt || 0) + interval,
            session.checkpointRetryAt || 0)) return;
        const ready = session.seats.every((seat, index) => {
            const state = netplay[index];
            const seatWindow = seat.frame.contentWindow;
            return seat.started && !seat.restore && seatWindow?.AzaharUI?.isRunning() && state?.joined &&
                !seatWindow.AzaharNetplay.isDownloadPlayRoom(state.gameRoom) &&
                (!state.downloadPlay || state.downloadPlay.stage === 'idle');
        });
        if (ready) void captureGroup();
    }

    // A checkpoint of every console at one moment, the consoles playing on: once each can save at
    // its next frame, each takes in what is still on its way to it, then the link holds frames
    // while every console saves, so no frame is between the consoles in their checkpoints (one a
    // console sends after its save waits until all have saved). A Mario Party console's
    // checkpoint is about 10 MB and takes about 0.6 s on an Apple M4, a pause on every screen
    // since they share one thread.
    async function captureGroup() {
        const seatWindows = session.seats.map(seat => seat.frame.contentWindow);
        if (!seatWindows.every(seatWindow => seatWindow.AzaharUI.stateReady())) {
            session.checkpointStats.notReady++;
            session.checkpointRetryAt = performance.now() + CHECKPOINT_NOT_READY_MS;
            return;
        }
        session.checkpointStats.tried++;
        session.capturing = true;
        let saves = [];
        try {
            for (const seatWindow of seatWindows) seatWindow.AzaharNetplay.pump();
            for (const seatWindow of seatWindows) seatWindow.AzaharNetplay.holdFrames = 'keep';
            saves = seatWindows.map(seatWindow => seatWindow.AzaharUI.captureState());
            const timeout = new Promise(resolve => setTimeout(() => resolve(null), CAPTURE_HOLD_MS));
            const states = await Promise.race([Promise.all(saves), timeout]);
            for (const seatWindow of seatWindows) seatWindow.AzaharNetplay.holdFrames = null;
            if (!states) {
                session.checkpointStats.failed++;
                session.checkpointRetryAt = performance.now() + CHECKPOINT_RETRY_MS;
                return;
            }
            const at = performance.now();
            session.seats.forEach((seat, index) => {
                // Copied into this page, which outlives the consoles' frames.
                seat.checkpoint = {programId: states[index].programId, bytes: new Uint8Array(states[index].bytes), at};
                // Running long enough to take a checkpoint resets the count of restarts in a row.
                seat.failures = 0;
            });
            session.checkpointAt = at;
            session.checkpointStats.taken++;
        } catch (error) {
            session.checkpointStats.failed++;
            console.warn('The checkpoint failed:', error);
            session.checkpointRetryAt = performance.now() + CHECKPOINT_RETRY_MS;
        } finally {
            for (const seatWindow of seatWindows) {
                if (seatWindow?.AzaharNetplay) seatWindow.AzaharNetplay.holdFrames = null;
            }
            // Saves still under way finish before the next request.
            await Promise.allSettled(saves);
            session.capturing = false;
        }
    }

    function focusSeat(seat) {
        seat.frame.focus();
        seat.frame.contentWindow?.focus();
    }

    // ── Keyboard ─────────────────────────────────────────────────
    // The page owns the keyboard (consoles' frames pass their keys here) and hands every
    // console the keys of its player's layout, so players share one keyboard at once.
    const heldKeys = new Set();

    // Physical key -> {seat, code}. A key two layouts share goes to the earlier player.
    function keyOwners() {
        const owners = new Map();
        for (const seat of session.seats) {
            const layout = KEY_LAYOUTS[seat.keys.value] || KEY_LAYOUTS.none;
            const keys = layout.keys || Object.fromEntries((seat.frame.contentWindow?.AzaharInput?.KEYMAP || [])
                .filter(entry => entry.code).map(entry => [entry.code, entry.code]));
            for (const [physical, code] of Object.entries(keys)) {
                if (!owners.has(physical)) owners.set(physical, {seat, code});
            }
        }
        return owners;
    }

    function syncKeys() {
        const owners = keyOwners();
        for (const seat of session.seats) {
            const codes = seat.inLobby ? [] : [...heldKeys].map(key => owners.get(key))
                .filter(owner => owner?.seat === seat).map(owner => owner.code);
            const signature = codes.join();
            if (signature === seat.keyCodes) continue;
            const input = seat.frame.contentWindow?.AzaharInput;
            if (!input) continue;
            seat.keyCodes = signature;
            input.setSourceCodes('keyboard', codes);
        }
    }

    function releaseKeys() {
        heldKeys.clear();
        if (session) syncKeys();
    }

    function renderKeys() {
        for (const seat of session.seats) {
            const layout = KEY_LAYOUTS[seat.keys.value] || KEY_LAYOUTS.none;
            seat.legend.textContent = layout.legend;
            seat.legend.hidden = !layout.legend;
            seat.element.classList.toggle('has-keyboard', seat.keys.value !== 'none');
        }
    }

    // Ctrl+1..9 gives that player the whole keyboard; Ctrl+0 gives everyone their own keys again.
    function assignKeys(index) {
        session.seats.forEach((seat, i) => {
            seat.keys.value = index < 0 ? (DEFAULT_KEYS[i] || 'none') : i === index ? 'all' : 'none';
        });
        releaseKeys();
        renderKeys();
    }

    // Called for every real key press on this page or a console's frame. Returns whether the
    // key belongs to a player (and the browser should not act on it).
    function routeKey(type, event) {
        if (!session) return false;
        if (event.ctrlKey && /^Digit[0-9]$/.test(event.code)) {
            const index = Number(event.code.slice(5)) - 1;
            if (type === 'keydown' && index < session.seats.length) assignKeys(index);
            return true;
        }
        const owner = keyOwners().get(event.code);
        if (event.ctrlKey || event.metaKey || event.altKey || !owner) return false;
        if (type === 'keydown') owner.seat.lastInput = performance.now();
        if (type === 'keydown') heldKeys.add(event.code);
        else heldKeys.delete(event.code);
        syncKeys();
        return true;
    }

    for (const type of ['keydown', 'keyup']) {
        window.addEventListener(type, event => {
            if (routeKey(type, event)) event.preventDefault();
        });
    }
    // Leaving the page releases every key (moving focus into a console's frame does not).
    window.addEventListener('blur', () => setTimeout(() => {
        if (!document.hasFocus()) releaseKeys();
    }));

    function start() {
        if (!rom || session) return;
        const count = Number($('player-count').value) || 2;
        const buffer = window.AzaharSharedLink.create(count);
        const seats = Array.from({length: count}, (_, index) => createSeat(index, count));
        session = {buffer, slots: window.AzaharSharedLink.slots(buffer), seats, rom, lastRebalance: 0, lastStatus: 0,
            restores: [], checkpointStats: {notReady: 0, tried: 0, taken: 0, failed: 0}};
        seatsEl.className = `seats seats-${count}`;
        // Two columns up to four players (one on portrait screens for two), then a square-ish grid.
        if (count > 4) seatsEl.style.setProperty('--columns', String(Math.ceil(Math.sqrt(count))));
        else seatsEl.style.removeProperty('--columns');
        seatsEl.replaceChildren(...seats.map(seat => seat.element));
        renderKeys();
        startButton.disabled = true;
        stopButton.disabled = false;
        $('player-count').disabled = true;
        $('renderer').disabled = true;
        say(`Starting ${count} consoles with ${rom.name}…`);
        session.frameHandle = requestAnimationFrame(frame);
    }

    function stop() {
        if (!session) return;
        cancelAnimationFrame(session.frameHandle);
        heldKeys.clear();
        // Removing the frames ends their emulators and frees their memory.
        seatsEl.replaceChildren();
        session = null;
        startButton.disabled = !rom;
        stopButton.disabled = true;
        $('player-count').disabled = false;
        $('renderer').disabled = false;
        $('link-stats').textContent = '';
        say(rom ? `Stopped. Press Start to play ${rom.name} again.` : 'Stopped.');
    }

    startButton.addEventListener('click', start);
    // The ? button: how players join a game room. A click outside the dialog closes it.
    const helpDialog = $('help-dialog');
    $('btn-help').addEventListener('click', () => helpDialog.showModal());
    helpDialog.addEventListener('click', event => {
        const box = helpDialog.getBoundingClientRect();
        const outside = event.clientX < box.left || event.clientX > box.right ||
            event.clientY < box.top || event.clientY > box.bottom;
        if (event.target === helpDialog && outside) helpDialog.close();
    });
    $('btn-checkpoint-restore').addEventListener('click', () => {
        if (session) void restoreGroup('Back to the checkpoint');
    });
    stopButton.addEventListener('click', stop);

    window.addEventListener('message', event => {
        const message = event.data;
        if (event.origin !== location.origin || message?.kind !== 'azahar-split' || !session) return;
        const seat = session.seats.find(candidate => candidate.frame.contentWindow === event.source);
        if (!seat) return;
        if (message.event === 'ready' && !seat.started) {
            seat.started = true;
            seat.frame.contentWindow.postMessage({
                kind: 'azahar-split', action: 'start',
                file: session.rom.file, name: session.rom.name,
                buffer: session.buffer, seat: seat.index,
                nick: `Player ${seat.index + 1}`, muted: seat.muted,
                restore: seat.restore, holdFrames: seat.holdFrames,
            }, location.origin);
        } else if (message.event === 'running') {
            if (seat.restore) seat.events.push({kind: 'restored'});
            seat.restore = null;
            seat.whenRunning?.(true);
            seat.whenRunning = null;
        } else if (message.event === 'screens') {
            placeJoinPanel(seat, message.top, message.frame);
        } else if (message.event === 'failed') {
            seatFailed(seat, message.detail, message.compiled);
        } else if (message.event === 'error') {
            seat.error = message.message;
            seat.restore = null;
            seat.whenRunning?.(false);
            seat.whenRunning = null;
        }
    });

    // ── Sharing the main thread ──────────────────────────────────
    function rebalance(now) {
        const SLOT = window.AzaharSharedLink.SLOT;
        const wall = window.AzaharSharedLink.wallNow();
        const slots = session.slots;
        const active = slots.filter(slot => slot[SLOT.heartbeat] && wall - slot[SLOT.heartbeat] < IDLE_AFTER_MS);
        if (!active.length) return;
        const fair = 1 / active.length;
        let spare = 0;
        const busy = [];
        for (const slot of active) {
            if (slot[SLOT.saturated] < 0.5) {
                // Finished early: its own use plus headroom, never more than a fair share.
                const used = slot[SLOT.stepMs] / Math.max(1, slot[SLOT.frameMs]);
                const share = Math.min(fair, Math.max(MIN_SHARE, used * SHARE_HEADROOM + 0.02));
                slot[SLOT.share] = share;
                spare += fair - share;
            } else {
                busy.push(slot);
            }
        }
        for (const slot of busy) slot[SLOT.share] = fair + spare / busy.length;
        // Paused and loading consoles keep a fair share for when they resume.
        for (const slot of slots) if (!active.includes(slot)) slot[SLOT.share] = fair;
        session.lastRebalance = now;
    }

    // ── Controllers ──────────────────────────────────────────────
    // The page reads every controller and hands each console only its own,
    // in the order they connected unless a console picks one.
    function pollPads() {
        const pads = [...(navigator.getGamepads?.() || [])].filter(pad => pad && pad.connected);
        const taken = new Set(session.seats.map(seat => seat.pad.value).filter(value => /^\d+$/.test(value)).map(Number));
        const free = pads.filter(pad => !taken.has(pad.index));
        let next = 0;
        for (const seat of session.seats) {
            const input = seat.frame.contentWindow?.AzaharInput;
            if (!input) continue;
            let pad = null;
            if (seat.pad.value === 'auto') pad = free[next++] || null;
            else if (seat.pad.value !== 'none') pad = pads.find(candidate => candidate.index === Number(seat.pad.value)) || null;
            const codes = pad && !seat.inLobby ? input.padCodes(pad) : [];
            if (codes.length) seat.lastInput = performance.now();
            const key = codes.join();
            if (key !== seat.padCodes || codes.length) {
                seat.padCodes = key;
                input.setSourceCodes('gamepad', codes);
            }
        }
        return pads;
    }

    function updatePadChoices(pads) {
        const signature = pads.map(pad => `${pad.index}:${pad.id}`).join('|');
        if (signature === session.padSignature) return;
        session.padSignature = signature;
        for (const seat of session.seats) {
            const value = seat.pad.value;
            for (const option of [...seat.pad.options]) if (/^\d+$/.test(option.value)) option.remove();
            for (const pad of pads) {
                const option = document.createElement('option');
                option.value = String(pad.index);
                option.textContent = `Controller: ${pad.id.replace(/\s*\(.*$/, '') || 'Gamepad'} #${pad.index + 1}`;
                seat.pad.append(option);
            }
            seat.pad.value = [...seat.pad.options].some(option => option.value === value) ? value : 'auto';
        }
    }

    // ── Status ───────────────────────────────────────────────────
    function updateStatus(now, pads) {
        session.lastStatus = now;
        updatePadChoices(pads);
        const SLOT = window.AzaharSharedLink.SLOT;
        let running = 0;
        for (const seat of session.seats) {
            const doc = seat.frame.contentDocument;
            const text = seat.error || doc?.getElementById('status')?.textContent || 'Loading…';
            seat.state.textContent = text;
            seat.state.dataset.kind = seat.error || /error|failed|stopped/i.test(text) ? 'error' : '';
            seat.fps.textContent = doc?.getElementById('fps')?.textContent || '';
            if (seat.frame.contentWindow?.AzaharUI?.isRunning()) running++;
        }
        const netplay = session.seats.map(seat => seat.frame.contentWindow?.AzaharNetplay?.status?.());
        session.seats.forEach((seat, index) => {
            if (netplay[index]?.mac) seat.mac = netplay[index].mac;
        });
        renderRooms(netplay);
        renderSeatButtons(now, netplay);
        scheduleCheckpoint(now, netplay);
        const linked = netplay.filter(state => state?.joined).length;
        const shares = session.slots.map(slot => `${Math.round(slot[SLOT.share] * 100)}%`).join(' / ');
        const frames = netplay.reduce((sum, state) => sum + (state?.stats.sent || 0), 0);
        $('link-stats').textContent = `${running} of ${session.seats.length} consoles running, ` +
            `${linked} linked · ${frames} frames sent · main-thread shares ${shares}`;
        const dlpHost = session.downloadPlayHost;
        if (session.restoring || session.capturing || session.seats.some(seat => seat.restore || !seat.started)) {
            // restartSeat, restoreGroup or captureGroup said what is happening.
        } else if (session.together >= 0 && dlpHost === session.together) {
            say(`All ${session.seats.length} players are in Player ${dlpHost + 1}'s Download Play lobby: ` +
                `Player ${dlpHost + 1} starts the game from it (Mario Party: End; Mario Kart 7: Start).`, 'ok');
        } else if (session.together >= 0) {
            say(`All ${session.seats.length} players are in one game room, hosted by Player ${session.together + 1}.`, 'ok');
        } else if (session.hosts?.length > 1) {
            // Every console here has the whole game, so each can host; then nobody joins anyone.
            const names = session.hosts.map(index => index + 1);
            say(`Players ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are each hosting a room, so ` +
                'nobody can join. Back out on all but one screen; the others join that room from the ' +
                'game\'s multiplayer menu (Local Play), or, for a Download Play lobby, with ↺ Restart and ' +
                'join on their screen.', 'error');
        } else if (dlpHost >= 0) {
            say(`Player ${dlpHost + 1} opened a Download Play lobby: the other screens join it on their own in a ` +
                'few seconds (each with the Download Play part of its own copy of the game; 📥 joins one now), ' +
                'except a screen whose game has its wireless menu open, which can join from that menu. ' +
                `When everyone is listed, Player ${dlpHost + 1} starts the game.`, 'ok');
        } else if (running === session.seats.length) {
            say(`Playing ${session.rom.name} on ${running} consoles. Host a room on one screen and ` +
                'join it from the others in the game\'s local wireless menu.', 'ok');
        }
    }

    // Which game room (local wireless network) each console is in, by the player hosting it.
    function renderRooms(netplay) {
        const hostOf = room => session.seats.findIndex((seat, i) =>
            netplay[i]?.mac && netplay[i].mac.toLowerCase() === String(room.host).toLowerCase());
        const rooms = netplay.map(state => state?.gameRoom);
        const isDownloadPlay = room => room?.wlanCommId === DOWNLOAD_PLAY_COMM_ID;
        // A console gathering Download Play players (only one at a time is offered to the others).
        session.downloadPlayHost = rooms.findIndex(room => room?.status === 'host' && isDownloadPlay(room));
        for (const [index, seat] of session.seats.entries()) {
            const room = rooms[index];
            const join = netplay[index]?.downloadPlay;
            let text = '';
            // The badges stay short: a bar that wraps shrinks the console's screen mid-game.
            if (room?.status === 'host') {
                text = `🏠 Hosting a room · ${room.nodes.length} player${room.nodes.length === 1 ? '' : 's'}`;
            } else if (room?.status === 'client') {
                const host = hostOf(room);
                text = `🚪 In ${host >= 0 ? `Player ${host + 1}'s` : 'another console\'s'} room`;
            } else if (join?.stage === 'starting') {
                text = '📥 Starting…';
            } else if (join && join.stage !== 'idle') {
                text = '📥 Joining…';
            } else if (room?.status === 'connecting') {
                text = 'Joining a room…';
            }
            // A spectator only looks at a room (games list rooms that way while scanning).
            if (seat.room.textContent !== text) seat.room.textContent = text;
        }
        // Everyone in one room: one console hosts, every other one is a client of that console,
        // and the host's room lists it. (A guest that joined through Download Play does not
        // know the network's ids, so the host's address and the node list decide.)
        const hosts = rooms.map((room, index) => room?.status === 'host' ? index : -1).filter(index => index >= 0);
        const members = hosts.length === 1 ? new Set(rooms[hosts[0]].nodes.map(node => node.id)) : null;
        const together = hosts.length === 1 && rooms.every((room, index) => index === hosts[0] ||
            (room?.status === 'client' && hostOf(room) === hosts[0] && members.has(room.node)));
        session.together = together ? hosts[0] : -1;
        session.hosts = hosts;
    }

    // ⤺ (everyone back to the last checkpoint), and each console's join panel. While another
    // console gathers players in a Download Play lobby, a console in no room that its player
    // left alone joins it on its own after AUTO_JOIN_MS (its screen counts down, with Not now);
    // one in use is invited to (one click). A console whose game has its local wireless open is
    // only offered 📥: its player may be joining from the game's own menu (Mario Kart 7 players
    // do, with the full game). Waiting in the lobby, its buttons do nothing until the host
    // starts: they could take its game into a wireless menu of its own, which ends the join. A
    // console that opened a lobby too (nobody can join either) is offered a restart, after which
    // it joins at once.
    function renderSeatButtons(now, netplay) {
        const back = $('btn-checkpoint-restore');
        back.disabled = !canRestore();
        back.title = session.checkpointAt ? 'Every console back to the checkpoint of ' +
            `${Math.round((now - session.checkpointAt) / 1000)} s ago` : 'No checkpoint yet (see Checkpoints)';
        const host = session.downloadPlayHost;
        const hostRoom = host >= 0 ? netplay[host]?.gameRoom : null;
        const lobby = hostRoom ? `${hostRoom.host}/${hostRoom.networkId}` : null;
        const hostName = `Player ${host + 1}`;
        const playerAt = mac => {
            const index = session.seats.findIndex(seat => seat.mac && seat.mac.toLowerCase() === String(mac).toLowerCase());
            return index >= 0 ? `Player ${index + 1}` : host >= 0 ? hostName : 'the host';
        };
        for (const [index, seat] of session.seats.entries()) {
            const state = netplay[index];
            const room = state?.gameRoom;
            const join = state?.downloadPlay;
            const seatWindow = seat.frame.contentWindow;
            const ready = seat.started && !seat.restore && state?.joined && seatWindow?.AzaharUI?.isRunning() &&
                !/^00040001/.test(seatWindow.AzaharUI.getProgramId?.() || '');
            const other = host >= 0 && host !== index && ready;
            let mode = null;
            let text = '';
            let main = '';
            let later = '';
            if (join && join.stage !== 'idle') {
                mode = 'lobby';
                const name = playerAt(join.host);
                text = join.stage === 'starting' ? `${name} started the game: loading its Download Play version…` :
                    join.stage === 'joined' ? `✔ In ${name}'s lobby. ${name} starts the game once everyone is listed.` :
                    `📥 Joining ${name}'s lobby…`;
                later = join.stage === 'starting' ? '' : 'Leave';
            } else if (other && room?.status === 'host' && room.wlanCommId === DOWNLOAD_PLAY_COMM_ID) {
                if (seat.joinDeclined !== lobby) {
                    mode = 'hosting';
                    text = `${hostName} opened a lobby too, so nobody can join either. Restart this console ` +
                        `and it joins ${hostName}'s.`;
                    main = `↺ Restart and join ${hostName}`;
                    later = 'Not now';
                }
            } else if (other && (!room || room.status === 'none')) {
                if (seat.autoJoins.lobby !== lobby) seat.autoJoins = {lobby, count: 0};
                const auto = !room?.initialized && seat.joinDeclined !== lobby && seat.autoJoins.count < AUTO_JOIN_TRIES;
                const idle = seat.joinAfterRestart === lobby || now - seat.lastInput >= AUTO_JOIN_IDLE_MS;
                if (auto && idle && seat.joinOffer?.lobby !== lobby) seat.joinOffer = {lobby, at: now + AUTO_JOIN_MS};
                const due = auto && idle && (seat.joinAfterRestart === lobby || now >= seat.joinOffer.at);
                if (due) {
                    seat.joinLobby = lobby;
                    seat.autoJoins.count++;
                }
                if (due && joinDownloadPlay(seat, seat.joinAfterRestart === lobby ? 'restart' : 'auto')) {
                    mode = 'lobby';
                    text = `📥 Joining ${hostName}'s lobby…`;
                    later = 'Leave';
                } else if (due) {
                    mode = 'offer';
                    main = `📥 Join ${hostName}'s Download Play`;
                } else if (auto && idle) {
                    mode = 'countdown';
                    text = `${hostName} opened a Download Play lobby. Player ${index + 1} joins it in ` +
                        `${Math.max(1, Math.ceil((seat.joinOffer.at - now - 1) / 1000))} s.`;
                    main = '📥 Join now';
                    later = 'Not now';
                } else if (auto) {
                    mode = 'invite';
                    text = `${hostName} opened a Download Play lobby.`;
                    main = `📥 Join ${hostName}'s lobby`;
                    later = 'Not now';
                } else {
                    mode = 'offer';
                    main = `📥 Join ${hostName}'s Download Play`;
                }
            }
            if (mode !== 'countdown') seat.joinOffer = null;
            // What the buttons act on (a lobby gone by the click is no longer joined on its own).
            if (mode !== 'lobby') seat.joinLobby = lobby;
            seat.joinMode = mode;
            seat.join.hidden = !mode;
            if (mode) {
                seat.join.dataset.mode = mode;
                if (seat.joinText.textContent !== text) seat.joinText.textContent = text;
                seat.dlp.textContent = main;
                seat.dlp.hidden = !main;
                seat.joinLater.textContent = later;
                seat.joinLater.hidden = !later;
            }
            if ((mode === 'lobby') !== seat.inLobby) {
                seat.inLobby = mode === 'lobby';
                if (seat.inLobby) seatWindow?.AzaharInput?.setSourceCodes('gamepad', []);
                syncKeys();
            }
        }
    }

    function frame(now) {
        if (!session) return;
        const pads = pollPads();
        if (now - session.lastRebalance >= REBALANCE_MS) rebalance(now);
        if (now - session.lastStatus >= STATUS_MS) updateStatus(now, pads);
        session.frameHandle = requestAnimationFrame(frame);
    }


    // ── Start-up ─────────────────────────────────────────────────
    (async () => {
        if (!(await ensureIsolation())) return;
        if (query.get('renderer') === 'software') $('renderer').value = 'software';
        // ?checkpoints=0|120|300 picks the checkpoint interval in seconds (0: none).
        if ([...$('checkpoints').options].some(option => option.value === query.get('checkpoints'))) {
            $('checkpoints').value = query.get('checkpoints');
        }
        // ?players=N takes up to the link's limit; the menu offers what most games allow (8).
        const players = Number(query.get('players'));
        if (players >= 2 && players <= window.AzaharSharedLink.MAX_SEATS) {
            if (![...$('player-count').options].some(option => Number(option.value) === players)) {
                $('player-count').append(new Option(`${players} players`, String(players)));
            }
            $('player-count').value = String(players);
        }
        await listStored();
        // index.html hands over the game it was playing.
        const play = query.get('play');
        if (play) {
            const entry = await readStored(play);
            if (entry) {
                chooseRom(entry.file, entry.name);
                if (query.get('autostart') !== '0') start();
            } else {
                say('The game from the emulator page is not in browser storage; choose the file.', 'error');
            }
        }
    })();

    window.AzaharSplit = {
        start,
        stop,
        chooseRom,
        routeKey,
        // Index of the player hosting a room every console is in, or -1.
        together: () => session?.together ?? -1,
        keyLayouts: () => session?.seats.map(seat => seat.keys.value) || [],
        // The physical key that presses `code` (a key of the console's own keymap) on that
        // player's console, or null.
        keyFor(index, code) {
            const seat = session?.seats[index];
            if (!seat) return null;
            for (const [physical, owner] of keyOwners()) {
                if (owner.seat === seat && owner.code === code) return physical;
            }
            return null;
        },
        seats: () => session?.seats.map(seat => seat.frame) || [],
        restartSeat: (index, options) => restartSeat(session.seats[index], options),
        restoreGroup: reason => restoreGroup(reason || 'Back to the checkpoint'),
        // Checkpoints: tries put off (a console was busy), tried, taken, failed.
        checkpointStats: () => ({...session?.checkpointStats}),
        // Each time every console went back to the checkpoint: {reason, restored}.
        restores: () => session?.restores.slice() || [],
        // What happened to each console: stopped, restarted, restored (from a checkpoint).
        events: () => session?.seats.map(seat => seat.events.slice()) || [],
        // When each console's part of the last checkpoint was taken (performance.now()), or null.
        checkpoints: () => session?.seats.map(seat => seat.checkpoint?.at ?? null) || [],
        // Index of the player gathering Download Play players, or -1.
        downloadPlayHost: () => session?.downloadPlayHost ?? -1,
        // How long ago each console's player last pressed a key or button or touched it (ms).
        idleFor: () => session?.seats.map(seat => performance.now() - seat.lastInput) || [],
        // Each console's Download Play joins: {how: 'auto' | 'button' | 'restart', host}.
        joins: () => session?.seats.map(seat => seat.joins.slice()) || [],
        shares: () => session?.slots.map(slot => slot[window.AzaharSharedLink.SLOT.share]) || [],
    };
})();
