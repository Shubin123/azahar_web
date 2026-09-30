/**
 * Azahar Web — Input reference (azahar_input.js)
 * Documents the keyboard bindings the native core reads (the SDL frontend's
 * default Controls profile) and shows them in the keymap menu.
 */

(function () {
    'use strict';

    // Keep in sync with default_buttons / default_analogs in the engine's
    // src/citra_sdl/config.cpp. `code` is the DOM KeyboardEvent.code SDL
    // translates to that scancode.
    const KEYMAP = [
        { group: 'Face buttons', control: 'A', key: 'A', code: 'KeyA', keyCode: 65 },
        { group: 'Face buttons', control: 'B', key: 'S', code: 'KeyS', keyCode: 83 },
        { group: 'Face buttons', control: 'X', key: 'Z', code: 'KeyZ', keyCode: 90 },
        { group: 'Face buttons', control: 'Y', key: 'X', code: 'KeyX', keyCode: 88 },
        { group: 'D-pad', control: 'Up', key: 'T', code: 'KeyT', keyCode: 84 },
        { group: 'D-pad', control: 'Down', key: 'G', code: 'KeyG', keyCode: 71 },
        { group: 'D-pad', control: 'Left', key: 'F', code: 'KeyF', keyCode: 70 },
        { group: 'D-pad', control: 'Right', key: 'H', code: 'KeyH', keyCode: 72 },
        { group: 'Shoulders', control: 'L', key: 'Q', code: 'KeyQ', keyCode: 81 },
        { group: 'Shoulders', control: 'R', key: 'W', code: 'KeyW', keyCode: 87 },
        { group: 'Shoulders', control: 'ZL', key: '1', code: 'Digit1', keyCode: 49 },
        { group: 'Shoulders', control: 'ZR', key: '2', code: 'Digit2', keyCode: 50 },
        { group: 'System', control: 'Start', key: 'M', code: 'KeyM', keyCode: 77 },
        { group: 'System', control: 'Select', key: 'N', code: 'KeyN', keyCode: 78 },
        { group: 'System', control: 'Home', key: 'B', code: 'KeyB', keyCode: 66 },
        { group: 'System', control: 'Debug', key: 'O', code: 'KeyO', keyCode: 79 },
        { group: 'System', control: 'GPIO14', key: 'P', code: 'KeyP', keyCode: 80 },
        { group: 'Circle Pad', control: 'Up', key: '↑', code: 'ArrowUp', keyCode: 38 },
        { group: 'Circle Pad', control: 'Down', key: '↓', code: 'ArrowDown', keyCode: 40 },
        { group: 'Circle Pad', control: 'Left', key: '←', code: 'ArrowLeft', keyCode: 37 },
        { group: 'Circle Pad', control: 'Right', key: '→', code: 'ArrowRight', keyCode: 39 },
        { group: 'Circle Pad', control: 'Half tilt (hold)', key: 'D', code: 'KeyD', keyCode: 68 },
        { group: 'C-Stick', control: 'Up', key: 'I', code: 'KeyI', keyCode: 73 },
        { group: 'C-Stick', control: 'Down', key: 'K', code: 'KeyK', keyCode: 75 },
        { group: 'C-Stick', control: 'Left', key: 'J', code: 'KeyJ', keyCode: 74 },
        { group: 'C-Stick', control: 'Right', key: 'L', code: 'KeyL', keyCode: 76 },
        { group: 'Touch screen', control: 'Tap / drag', key: 'Mouse on bottom screen' }
    ];

    let dialogEl = null;

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
        for (const label of ['3DS control', 'Keyboard']) {
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
                th.colSpan = 2;
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
            row.append(control, key);
            tbody.appendChild(row);
        }
        table.append(thead, tbody);

        const note = document.createElement('p');
        note.className = 'mode-help';
        note.textContent = 'Keys are read while the page has focus. Click the game screen first if a text field is selected.';

        dialog.append(header, table, note);
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
    }

    window.AzaharInput = {
        KEYMAP,
        openKeymap,
        closeKeymap
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
