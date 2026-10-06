/**
 * Azahar Web — On-screen controls (azahar_touch_controls.js)
 * Touch buttons for every 3DS control: Circle Pad, D-pad, A/B/X/Y, L/R,
 * ZL/ZR, C-Stick, Start, Select and Home. They appear on touch-screen devices
 * while no gamepad is connected (or always/never, by the user's choice) and
 * press the same keys the keyboard and gamepads do, through
 * AzaharInput.setSourceCodes.
 *
 * The controls never cover the game: in the page they sit under the screens,
 * and in the fullscreen view they take a strip below the screens (portrait)
 * or columns beside them (landscape), and the screens are laid out in the
 * space that is left. Every finger is tracked on its own, so a direction and
 * buttons can be held together, and a finger can slide between buttons.
 */

(function () {
    'use strict';

    const input = window.AzaharInput;
    const stage = document.getElementById('screen-stage');
    if (!input || !stage) return;

    const STORAGE_KEY = 'azahar-touch-controls';
    const MODES = ['auto', 'on', 'off'];
    // Same thresholds as gamepad sticks: a direction counts past the dead
    // zone, and below full tilt the Circle Pad gets a half-strength push.
    const STICK_DEAD_ZONE = 0.3;
    const STICK_FULL_TILT = 0.75;
    // The D-pad ignores touches near its centre. A direction is held while
    // the touch is within about 63° of it, so diagonals need a clear angle.
    const DPAD_DEAD_ZONE = 0.2;
    const DPAD_AXIS_SHARE = 0.45;

    function keyCode(group, control) {
        const entry = input.KEYMAP.find(item => item.group === group && item.control === control);
        if (!entry) throw new Error(`No key for ${group} ${control}`);
        return entry.code;
    }

    const DPAD = {
        up: keyCode('D-pad', 'Up'), down: keyCode('D-pad', 'Down'),
        left: keyCode('D-pad', 'Left'), right: keyCode('D-pad', 'Right')
    };
    const STICKS = {
        circle: {
            label: 'Circle Pad',
            up: keyCode('Circle Pad', 'Up'), down: keyCode('Circle Pad', 'Down'),
            left: keyCode('Circle Pad', 'Left'), right: keyCode('Circle Pad', 'Right'),
            halfTilt: keyCode('Circle Pad', 'Half tilt (hold)')
        },
        cstick: {
            label: 'C-Stick',
            up: keyCode('C-Stick', 'Up'), down: keyCode('C-Stick', 'Down'),
            left: keyCode('C-Stick', 'Left'), right: keyCode('C-Stick', 'Right')
        }
    };

    function loadMode() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (MODES.includes(stored)) return stored;
        } catch (_) {}
        return 'auto';
    }

    let mode = loadMode();
    const coarsePointer = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;

    // ── Building the controls ─────────────────────────────────────────

    function el(tag, className, attrs = {}) {
        const node = document.createElement(tag);
        node.className = className;
        for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
        return node;
    }

    function button(label, code, className, ariaLabel = label) {
        const node = el('div', `touch-btn ${className}`, { role: 'button', 'aria-label': ariaLabel });
        node.dataset.code = code;
        node.textContent = label;
        return node;
    }

    function stick(kind) {
        const base = el('div', `touch-stick touch-stick-${kind}`, { role: 'group', 'aria-label': STICKS[kind].label });
        base.dataset.stick = kind;
        base.appendChild(el('div', 'touch-stick-knob'));
        return base;
    }

    function dpad() {
        const pad = el('div', 'touch-dpad', { role: 'group', 'aria-label': 'D-pad' });
        for (const dir of ['up', 'left', 'right', 'down']) {
            const arm = el('div', `touch-dpad-arm touch-dpad-${dir}`, {
                role: 'button', 'aria-label': `D-pad ${dir}`
            });
            arm.dataset.code = DPAD[dir];
            pad.appendChild(arm);
        }
        pad.appendChild(el('div', 'touch-dpad-center'));
        return pad;
    }

    function row(className, children) {
        const node = el('div', className);
        node.append(...children);
        return node;
    }

    function build() {
        const deck = el('div', 'touch-controls', { id: 'touch-controls', role: 'group', 'aria-label': 'On-screen controls' });
        deck.hidden = true;

        // Left hand: L/ZL, Circle Pad over the D-pad, Select and Home.
        const left = row('touch-half touch-left', [
            row('touch-shoulders', [
                button('L', keyCode('Shoulders', 'L'), 'touch-shoulder'),
                button('ZL', keyCode('Shoulders', 'ZL'), 'touch-shoulder touch-shoulder-z')
            ]),
            stick('circle'),
            dpad(),
            row('touch-system', [
                button('SELECT', keyCode('System', 'Select'), 'touch-system-btn', 'Select'),
                button('HOME', keyCode('System', 'Home'), 'touch-system-btn', 'Home')
            ])
        ]);

        // Right hand: ZR/R, C-Stick over the face buttons, Start.
        const face = row('touch-face', [
            button('X', keyCode('Face buttons', 'X'), 'touch-face-btn touch-face-x'),
            button('Y', keyCode('Face buttons', 'Y'), 'touch-face-btn touch-face-y'),
            button('A', keyCode('Face buttons', 'A'), 'touch-face-btn touch-face-a'),
            button('B', keyCode('Face buttons', 'B'), 'touch-face-btn touch-face-b')
        ]);
        const right = row('touch-half touch-right', [
            row('touch-shoulders', [
                button('ZR', keyCode('Shoulders', 'ZR'), 'touch-shoulder touch-shoulder-z'),
                button('R', keyCode('Shoulders', 'R'), 'touch-shoulder')
            ]),
            stick('cstick'),
            face,
            row('touch-system', [
                button('START', keyCode('System', 'Start'), 'touch-system-btn', 'Start')
            ])
        ]);

        deck.append(left, right);
        return deck;
    }

    const deck = build();
    const pressables = [...deck.querySelectorAll('[data-code]')];
    const sticks = [...deck.querySelectorAll('.touch-stick')];

    // ── Reading touches ────────────────────────────────────────────────

    // pointerId -> { stick: element | null, codes: string[], x, y }
    const pointers = new Map();

    function clampUnit(dx, dy) {
        const length = Math.hypot(dx, dy);
        return length > 1 ? [dx / length, dy / length] : [dx, dy];
    }

    function stickCodes(kind, x, y) {
        const map = STICKS[kind];
        const codes = [];
        if (x > STICK_DEAD_ZONE) codes.push(map.right);
        else if (x < -STICK_DEAD_ZONE) codes.push(map.left);
        if (y > STICK_DEAD_ZONE) codes.push(map.down);
        else if (y < -STICK_DEAD_ZONE) codes.push(map.up);
        const tilt = Math.hypot(x, y);
        if (map.halfTilt && codes.length && tilt < STICK_FULL_TILT) codes.push(map.halfTilt);
        return codes;
    }

    function dpadCodes(pad, clientX, clientY) {
        const rect = pad.getBoundingClientRect();
        const half = Math.min(rect.width, rect.height) / 2;
        const dx = (clientX - rect.left - rect.width / 2) / half;
        const dy = (clientY - rect.top - rect.height / 2) / half;
        const length = Math.hypot(dx, dy);
        if (length < DPAD_DEAD_ZONE) return [];
        const codes = [];
        if (dx / length > DPAD_AXIS_SHARE) codes.push(DPAD.right);
        else if (dx / length < -DPAD_AXIS_SHARE) codes.push(DPAD.left);
        if (dy / length > DPAD_AXIS_SHARE) codes.push(DPAD.down);
        else if (dy / length < -DPAD_AXIS_SHARE) codes.push(DPAD.up);
        return codes;
    }

    // Keys for a finger at (x, y) that is not holding a stick: whatever
    // control is under it now, so sliding onto another button presses it.
    function codesAt(clientX, clientY) {
        const target = document.elementFromPoint(clientX, clientY);
        if (!target || !deck.contains(target)) return [];
        const pad = target.closest('.touch-dpad');
        if (pad) return dpadCodes(pad, clientX, clientY);
        const control = target.closest('[data-code]');
        return control ? [control.dataset.code] : [];
    }

    function moveKnob(base, x, y) {
        const knob = base.firstElementChild;
        const travel = (base.clientWidth - knob.offsetWidth) / 2;
        knob.style.transform = x || y ? `translate(${x * travel}px, ${y * travel}px)` : '';
    }

    function readPointer(state, event) {
        if (state.stick) {
            const rect = state.stick.getBoundingClientRect();
            const radius = rect.width / 2;
            const [x, y] = clampUnit((event.clientX - rect.left - radius) / radius,
                (event.clientY - rect.top - rect.height / 2) / radius);
            moveKnob(state.stick, x, y);
            state.codes = stickCodes(state.stick.dataset.stick, x, y);
        } else {
            let codes = codesAt(event.clientX, event.clientY);
            if (!codes.length && event.target && deck.contains(event.target)) {
                const pad = event.target.closest('.touch-dpad');
                if (pad) {
                    codes = dpadCodes(pad, event.clientX, event.clientY);
                } else {
                    const control = event.target.closest('[data-code]');
                    if (control) codes = [control.dataset.code];
                }
            }
            state.codes = codes;
        }
    }

    function publish() {
        const held = new Set();
        for (const state of pointers.values()) {
            for (const code of state.codes) held.add(code);
        }
        for (const node of pressables) node.classList.toggle('is-pressed', held.has(node.dataset.code));
        const activeSticks = new Set([...pointers.values()].map(state => state.stick).filter(Boolean));
        for (const base of sticks) base.classList.toggle('is-active', activeSticks.has(base));
        input.setSourceCodes('touch', held);
    }

    function onPointerDown(event) {
        if (event.button > 0) return;
        event.preventDefault();
        // Keep receiving this finger's moves when it leaves its control. The
        // half has a box even when the deck is laid out as display: contents.
        try { event.target.closest('.touch-half')?.setPointerCapture(event.pointerId); } catch (_) {}
        const state = { stick: event.target.closest('.touch-stick'), codes: [] };
        pointers.set(event.pointerId, state);
        readPointer(state, event);
        publish();
    }

    function onPointerMove(event) {
        const state = pointers.get(event.pointerId);
        if (!state) return;
        event.preventDefault();
        const before = state.codes.join();
        readPointer(state, event);
        if (state.codes.join() !== before) publish();
    }

    function onPointerEnd(event) {
        const state = pointers.get(event.pointerId);
        if (!state) return;
        pointers.delete(event.pointerId);
        if (state.stick) moveKnob(state.stick, 0, 0);
        publish();
    }

    function releaseAll() {
        if (!pointers.size) return;
        for (const state of pointers.values()) {
            if (state.stick) moveKnob(state.stick, 0, 0);
        }
        pointers.clear();
        publish();
    }

    deck.addEventListener('pointerdown', onPointerDown);
    deck.addEventListener('pointermove', onPointerMove);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        deck.addEventListener(type, onPointerEnd);
    }
    // No text selection, magnifier, callout or context menu on long presses.
    deck.addEventListener('touchstart', event => event.preventDefault(), { passive: false });
    deck.addEventListener('contextmenu', event => event.preventDefault());
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) releaseAll();
    });

    // ── Showing and placing the controls ──────────────────────────────

    function isTouchDevice() {
        if (coarsePointer?.matches) return true;
        if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
        if (('ontouchstart' in window || navigator.maxTouchPoints > 0) && window.innerWidth <= 1024) return true;
        return false;
    }

    function shouldShow() {
        if (mode === 'on') return true;
        if (mode === 'off') return false;
        return isTouchDevice() && !input.hasGamepad();
    }

    // Inside the stage while fullscreen (the stage is what fills the
    // display), otherwise directly under it.
    function place() {
        const fullscreen = !!window.AzaharFullscreen?.isActive();
        if (fullscreen && deck.parentNode !== stage) stage.appendChild(deck);
        else if (!fullscreen && deck.previousElementSibling !== stage) stage.after(deck);
    }

    const modeSelect = document.getElementById('touch-controls-mode');
    const helpEl = document.getElementById('touch-controls-help');

    function describe(show) {
        if (!helpEl) return;
        if (mode === 'on') helpEl.textContent = 'Shown on every device.';
        else if (mode === 'off') helpEl.textContent = 'Hidden. Use the keyboard or a gamepad.';
        else if (input.hasGamepad()) helpEl.textContent = 'Hidden while a gamepad is connected.';
        else if (show) helpEl.textContent = 'Shown: this is a touch screen and no gamepad is connected.';
        else helpEl.textContent = 'Shown on touch screens while no gamepad is connected.';
    }

    function refresh() {
        const show = shouldShow();
        if (!show) releaseAll();
        deck.hidden = !show;
        stage.classList.toggle('has-touch-controls', show);
        place();
        describe(show);
    }

    function setMode(next) {
        if (!MODES.includes(next)) return;
        mode = next;
        try { localStorage.setItem(STORAGE_KEY, mode); } catch (_) {}
        if (modeSelect) modeSelect.value = mode;
        refresh();
    }

    if (modeSelect) {
        modeSelect.value = mode;
        modeSelect.addEventListener('change', () => setMode(modeSelect.value));
    }
    coarsePointer?.addEventListener?.('change', refresh);
    window.addEventListener('azahar-gamepads-changed', refresh);
    window.addEventListener('azahar-fullscreen-changed', refresh);

    refresh();

    window.AzaharTouchControls = {
        setMode,
        getMode: () => mode,
        isVisible: () => !deck.hidden,
        element: deck
    };
})();
