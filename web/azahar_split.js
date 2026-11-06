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
    const REBALANCE_MS = 250;
    const STATUS_MS = 500;
    // A console that has not stepped for this long is paused or loading.
    const IDLE_AFTER_MS = 1000;
    // Never squeeze a console below this share; it must be able to show it needs more.
    const MIN_SHARE = 0.15;
    // Headroom given to a console on top of what it used while finishing early.
    const SHARE_HEADROOM = 1.25;
    // Query options handed through to every console.
    const PASS_THROUGH = ['logFilter', 'netsim', 'pacing', 'frameBudget', 'scheduler', 'cpuClock',
        'adaptiveClock', 'hwShader', 'resolution', 'crossVersion', 'cores'];

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
    function seatUrl(index, count) {
        const url = new URL('index.html', location.href);
        url.searchParams.set('seat', String(index));
        url.searchParams.set('seats', String(count));
        // Halving the main thread is expected here, not a slow renderer to leave.
        url.searchParams.set('autoFallback', '0');
        if ($('renderer').value === 'software') url.searchParams.set('renderer', 'software');
        for (const name of PASS_THROUGH) {
            if (query.has(name)) url.searchParams.set(name, query.get(name));
        }
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
            mute: element.querySelector('.seat-mute'),
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
        element.querySelector('.seat-bar').addEventListener('click', () => focusSeat(seat));
        seat.frame.src = seatUrl(index, count);
        return seat;
    }

    function focusSeat(seat) {
        seat.frame.focus();
        seat.frame.contentWindow?.focus();
    }

    function start() {
        if (!rom || session) return;
        const count = Number($('player-count').value) || 2;
        const buffer = window.AzaharSharedLink.create(count);
        const seats = Array.from({length: count}, (_, index) => createSeat(index, count));
        session = {buffer, slots: window.AzaharSharedLink.slots(buffer), seats, rom, lastRebalance: 0, lastStatus: 0};
        seatsEl.className = `seats seats-${count}`;
        seatsEl.replaceChildren(...seats.map(seat => seat.element));
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
            }, location.origin);
        } else if (message.event === 'error') {
            seat.error = message.message;
        } else if (message.event === 'focus' && session.seats[message.target]) {
            focusSeat(session.seats[message.target]);
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
            const codes = pad ? input.padCodes(pad) : [];
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
            seat.element.classList.toggle('has-keyboard', document.activeElement === seat.frame);
            if (seat.frame.contentWindow?.AzaharUI?.isRunning()) running++;
        }
        const netplay = session.seats.map(seat => seat.frame.contentWindow?.AzaharNetplay?.status?.());
        const linked = netplay.filter(state => state?.joined).length;
        const shares = session.slots.map(slot => `${Math.round(slot[SLOT.share] * 100)}%`).join(' / ');
        const frames = netplay.reduce((sum, state) => sum + (state?.stats.sent || 0), 0);
        $('link-stats').textContent = `${running} of ${session.seats.length} consoles running, ` +
            `${linked} linked · ${frames} frames sent · main-thread shares ${shares}`;
        if (running === session.seats.length) say(`Playing ${session.rom.name} on ${running} consoles.`, 'ok');
    }

    function frame(now) {
        if (!session) return;
        const pads = pollPads();
        if (now - session.lastRebalance >= REBALANCE_MS) rebalance(now);
        if (now - session.lastStatus >= STATUS_MS) updateStatus(now, pads);
        session.frameHandle = requestAnimationFrame(frame);
    }

    // Ctrl+1..4 gives that console the keyboard (its frame forwards the keys once it has focus).
    window.addEventListener('keydown', event => {
        const index = /^Digit[1-4]$/.test(event.code) ? Number(event.code.slice(5)) - 1 : -1;
        if (!event.ctrlKey || !session || !(index >= 0 && index < session.seats.length)) return;
        event.preventDefault();
        focusSeat(session.seats[index]);
    });

    // ── Start-up ─────────────────────────────────────────────────
    (async () => {
        if (!(await ensureIsolation())) return;
        if (query.get('renderer') === 'software') $('renderer').value = 'software';
        if (query.get('players')) $('player-count').value = query.get('players');
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
        seats: () => session?.seats.map(seat => seat.frame) || [],
        shares: () => session?.slots.map(slot => slot[window.AzaharSharedLink.SLOT.share]) || [],
    };
})();
