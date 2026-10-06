/**
 * Azahar Web — Input reference (azahar_input.js)
 * Documents the keyboard bindings the native core reads (the SDL frontend's
 * default Controls profile), shows them in the keymap menu, and drives the
 * same bindings from gamepads through the browser Gamepad API. Other input
 * sources (the on-screen touch controls) hold keys through setSourceCodes.
 */

(function () {
    'use strict';

    // Keep in sync with default_buttons / default_analogs in the engine's
    // src/citra_sdl/config.cpp. `code` is the DOM KeyboardEvent.code SDL
    // translates to that scancode.
    const KEYMAP = [
        { group: 'Face buttons', control: 'A', key: 'A', code: 'KeyA', keyCode: 65,
          pad: { button: 1 }, padLabel: 'Right face button (B on Xbox, A on Switch)' },
        { group: 'Face buttons', control: 'B', key: 'S', code: 'KeyS', keyCode: 83,
          pad: { button: 0 }, padLabel: 'Bottom face button (A on Xbox, B on Switch)' },
        { group: 'Face buttons', control: 'X', key: 'Z', code: 'KeyZ', keyCode: 90,
          pad: { button: 3 }, padLabel: 'Top face button (Y on Xbox, X on Switch)' },
        { group: 'Face buttons', control: 'Y', key: 'X', code: 'KeyX', keyCode: 88,
          pad: { button: 2 }, padLabel: 'Left face button (X on Xbox, Y on Switch)' },
        { group: 'D-pad', control: 'Up', key: 'T', code: 'KeyT', keyCode: 84,
          pad: { button: 12 }, padLabel: 'D-pad up' },
        { group: 'D-pad', control: 'Down', key: 'G', code: 'KeyG', keyCode: 71,
          pad: { button: 13 }, padLabel: 'D-pad down' },
        { group: 'D-pad', control: 'Left', key: 'F', code: 'KeyF', keyCode: 70,
          pad: { button: 14 }, padLabel: 'D-pad left' },
        { group: 'D-pad', control: 'Right', key: 'H', code: 'KeyH', keyCode: 72,
          pad: { button: 15 }, padLabel: 'D-pad right' },
        { group: 'Shoulders', control: 'L', key: 'Q', code: 'KeyQ', keyCode: 81,
          pad: { button: 4 }, padLabel: 'Left bumper' },
        { group: 'Shoulders', control: 'R', key: 'W', code: 'KeyW', keyCode: 87,
          pad: { button: 5 }, padLabel: 'Right bumper' },
        { group: 'Shoulders', control: 'ZL', key: '1', code: 'Digit1', keyCode: 49,
          pad: { button: 6 }, padLabel: 'Left trigger' },
        { group: 'Shoulders', control: 'ZR', key: '2', code: 'Digit2', keyCode: 50,
          pad: { button: 7 }, padLabel: 'Right trigger' },
        { group: 'System', control: 'Start', key: 'M', code: 'KeyM', keyCode: 77,
          pad: { button: 9 }, padLabel: 'Start / Menu / +' },
        { group: 'System', control: 'Select', key: 'N', code: 'KeyN', keyCode: 78,
          pad: { button: 8 }, padLabel: 'Back / View / −' },
        { group: 'System', control: 'Home', key: 'B', code: 'KeyB', keyCode: 66,
          pad: { button: 16 }, padLabel: 'Guide / Home' },
        { group: 'System', control: 'Debug', key: 'O', code: 'KeyO', keyCode: 79 },
        { group: 'System', control: 'GPIO14', key: 'P', code: 'KeyP', keyCode: 80 },
        { group: 'Circle Pad', control: 'Up', key: '↑', code: 'ArrowUp', keyCode: 38,
          pad: { axis: 1, direction: -1 }, padLabel: 'Left stick up' },
        { group: 'Circle Pad', control: 'Down', key: '↓', code: 'ArrowDown', keyCode: 40,
          pad: { axis: 1, direction: 1 }, padLabel: 'Left stick down' },
        { group: 'Circle Pad', control: 'Left', key: '←', code: 'ArrowLeft', keyCode: 37,
          pad: { axis: 0, direction: -1 }, padLabel: 'Left stick left' },
        { group: 'Circle Pad', control: 'Right', key: '→', code: 'ArrowRight', keyCode: 39,
          pad: { axis: 0, direction: 1 }, padLabel: 'Left stick right' },
        { group: 'Circle Pad', control: 'Half tilt (hold)', key: 'D', code: 'KeyD', keyCode: 68,
          pad: { halfTilt: true }, padLabel: 'Left stick, partly tilted' },
        { group: 'C-Stick', control: 'Up', key: 'I', code: 'KeyI', keyCode: 73,
          pad: { axis: 3, direction: -1 }, padLabel: 'Right stick up' },
        { group: 'C-Stick', control: 'Down', key: 'K', code: 'KeyK', keyCode: 75,
          pad: { axis: 3, direction: 1 }, padLabel: 'Right stick down' },
        { group: 'C-Stick', control: 'Left', key: 'J', code: 'KeyJ', keyCode: 74,
          pad: { axis: 2, direction: -1 }, padLabel: 'Right stick left' },
        { group: 'C-Stick', control: 'Right', key: 'L', code: 'KeyL', keyCode: 76,
          pad: { axis: 2, direction: 1 }, padLabel: 'Right stick right' },
        { group: 'Touch screen', control: 'Tap / drag', key: 'Mouse on bottom screen' }
    ];

    // Standard-mapping thresholds. A stick counts as pushed past the dead
    // zone; below full tilt the Circle Pad modifier gives a half-strength push.
    const STICK_DEAD_ZONE = 0.3;
    const STICK_FULL_TILT = 0.75;
    const TRIGGER_THRESHOLD = 0.5;

    let dialogEl = null;
    const padStatusEls = [];
    let pollHandle = null;
    const pressedCodes = new Set();
    // Keys each input source (gamepads, on-screen controls) currently holds.
    // A key stays down while any source holds it.
    const sourceCodes = new Map();
    let lastPadCount = -1;

    function entryByCode(code) {
        return KEYMAP.find(entry => entry.code === code);
    }

    // SDL reads keyboard input from window keydown/keyup events (keyCode and
    // code), so gamepad input is delivered as those same events.
    function sendKey(code, down) {
        const entry = entryByCode(code);
        if (!entry || pressedCodes.has(code) === down) return;
        if (down) pressedCodes.add(code);
        else pressedCodes.delete(code);
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
            key: entry.key.length === 1 ? entry.key.toLowerCase() : entry.code,
            code: entry.code,
            keyCode: entry.keyCode,
            which: entry.keyCode,
            bubbles: true,
            cancelable: true
        }));
    }

    function syncKeys() {
        const wanted = new Set();
        for (const codes of sourceCodes.values()) {
            for (const code of codes) wanted.add(code);
        }
        for (const code of [...pressedCodes]) {
            if (!wanted.has(code)) sendKey(code, false);
        }
        for (const code of wanted) sendKey(code, true);
    }

    // Replaces the set of keys one source holds.
    function setSourceCodes(source, codes) {
        const next = new Set(codes);
        if (next.size) sourceCodes.set(source, next);
        else sourceCodes.delete(source);
        syncKeys();
    }

    function releaseAll() {
        sourceCodes.clear();
        syncKeys();
    }

    function connectedPads() {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        return [...pads].filter(pad => pad && pad.connected);
    }

    function isButtonPressed(pad, index) {
        const button = pad.buttons[index];
        if (!button) return false;
        return button.pressed || button.value > TRIGGER_THRESHOLD;
    }

    // Desired key state for all connected pads (any pad may press a key).
    function readPadCodes(pads) {
        const codes = new Set();
        for (const pad of pads) {
            for (const entry of KEYMAP) {
                const binding = entry.pad;
                if (!binding) continue;
                if (binding.button !== undefined && isButtonPressed(pad, binding.button)) {
                    codes.add(entry.code);
                } else if (binding.axis !== undefined) {
                    const value = pad.axes[binding.axis] || 0;
                    if (value * binding.direction > STICK_DEAD_ZONE) codes.add(entry.code);
                }
            }
            const lx = pad.axes[0] || 0;
            const ly = pad.axes[1] || 0;
            const tilt = Math.hypot(lx, ly);
            if (tilt > STICK_DEAD_ZONE && tilt < STICK_FULL_TILT) codes.add(KEYMAP.find(entry => entry.pad?.halfTilt).code);
        }
        return codes;
    }

    function pollGamepads() {
        pollHandle = null;
        const pads = connectedPads();
        if (!pads.length) {
            setSourceCodes('gamepad', []);
            updatePadStatus();
            return;
        }
        setSourceCodes('gamepad', document.hidden ? [] : readPadCodes(pads));
        pollHandle = window.requestAnimationFrame(pollGamepads);
    }

    function startPolling() {
        updatePadStatus();
        if (pollHandle === null) pollHandle = window.requestAnimationFrame(pollGamepads);
    }

    function updatePadStatus() {
        const pads = connectedPads();
        const text = pads.length
            ? `🎮 ${pads.map(pad => pad.id.replace(/\s*\(.*$/, '') || 'Gamepad').join(', ')} connected`
            : '🎮 No gamepad connected — press a button on your controller to connect it.';
        for (const el of padStatusEls) el.textContent = text;
        if (pads.length !== lastPadCount) {
            lastPadCount = pads.length;
            window.dispatchEvent(new CustomEvent('azahar-gamepads-changed', {
                detail: { connected: pads.length }
            }));
        }
    }

    function createPadStatus() {
        const el = document.createElement('div');
        el.className = 'mode-help gamepad-status';
        el.setAttribute('aria-live', 'polite');
        padStatusEls.push(el);
        updatePadStatus();
        return el;
    }

    function buildDialog() {
        const dialog = document.createElement('dialog');
        dialog.id = 'keymap-dialog';
        dialog.className = 'keymap-dialog';
        dialog.setAttribute('aria-labelledby', 'keymap-title');

        const header = document.createElement('div');
        header.className = 'keymap-header';
        const title = document.createElement('h2');
        title.id = 'keymap-title';
        title.textContent = '⌨ Keymap';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn btn-secondary btn-sm keymap-close';
        close.textContent = '✕';
        close.setAttribute('aria-label', 'Close keymap');
        close.addEventListener('click', () => dialog.close());
        header.append(title, close);

        const table = document.createElement('table');
        table.className = 'keymap-table';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const label of ['3DS control', 'Keyboard', 'Gamepad']) {
            const th = document.createElement('th');
            th.scope = 'col';
            th.textContent = label;
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);

        const tbody = document.createElement('tbody');
        let lastGroup = null;
        for (const entry of KEYMAP) {
            if (entry.group !== lastGroup) {
                lastGroup = entry.group;
                const groupRow = document.createElement('tr');
                groupRow.className = 'keymap-group';
                const th = document.createElement('th');
                th.colSpan = 3;
                th.scope = 'rowgroup';
                th.textContent = entry.group;
                groupRow.appendChild(th);
                tbody.appendChild(groupRow);
            }
            const row = document.createElement('tr');
            row.dataset.control = `${entry.group}:${entry.control}`;
            const control = document.createElement('td');
            control.textContent = entry.control;
            const key = document.createElement('td');
            const kbd = document.createElement('kbd');
            kbd.textContent = entry.key;
            key.appendChild(kbd);
            const pad = document.createElement('td');
            pad.className = 'keymap-pad';
            pad.textContent = entry.padLabel || '—';
            row.append(control, key, pad);
            tbody.appendChild(row);
        }
        table.append(thead, tbody);

        const note = document.createElement('p');
        note.className = 'mode-help';
        note.textContent = 'Keys are read while the page has focus. Click the game screen first if a text field is selected.';

        dialog.append(header, createPadStatus(), table, note);
        // Clicking the backdrop closes the menu.
        dialog.addEventListener('click', event => {
            if (event.target === dialog) dialog.close();
        });
        // Keep keys pressed while reading the menu away from the game.
        dialog.addEventListener('keydown', event => {
            if (event.key !== 'Escape') event.stopPropagation();
        });
        document.body.appendChild(dialog);
        return dialog;
    }

    function openKeymap() {
        if (!dialogEl) dialogEl = buildDialog();
        if (!dialogEl.open) dialogEl.showModal();
    }

    function closeKeymap() {
        dialogEl?.close();
    }

    function init() {
        document.getElementById('btn-keymap')?.addEventListener('click', openKeymap);
        document.getElementById('btn-keymap')?.insertAdjacentElement('afterend', createPadStatus());
        window.addEventListener('gamepadconnected', startPolling);
        window.addEventListener('gamepaddisconnected', () => {
            updatePadStatus();
            if (!connectedPads().length) setSourceCodes('gamepad', []);
        });
        window.addEventListener('blur', releaseAll);
        // Pads already connected before this page loaded report no event
        // until a button is pressed; pick up any that are already visible.
        if (connectedPads().length) startPolling();
    }

    window.AzaharInput = {
        KEYMAP,
        openKeymap,
        closeKeymap,
        setSourceCodes,
        hasGamepad: () => connectedPads().length > 0,
        getPressedCodes: () => [...pressedCodes]
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
