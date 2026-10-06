/**
 * Azahar Web — Fullscreen view (azahar_fullscreen.js)
 * Fills the display with the two 3DS screens. Each screen keeps its native
 * aspect ratio (top 5:3, bottom 4:3); the bottom screen is drawn smaller than
 * the top one, at a size the user bounds with a minimum and maximum
 * percentage of the top screen. The engine draws both screens directly into
 * a canvas sized to the display, so nothing is stretched or rescaled by CSS.
 */

(function () {
    'use strict';

    const TOP_W = 400, TOP_H = 240, BOTTOM_W = 320, BOTTOM_H = 240;
    const STORAGE_KEY = 'azahar-fullscreen-layout';
    const DEFAULTS = { arrangement: 'auto', bottomMin: 40, bottomMax: 70 };
    // Percent of the top screen's size; the bottom screen never exceeds it.
    const LIMIT_MIN = 20, LIMIT_MAX = 100;
    // The software renderer scales screens on the CPU every frame, so its
    // canvas is kept near native detail. Accelerated rendering draws at the
    // display's full device resolution.
    const SOFTWARE_MAX_TOP_WIDTH = 800;
    const MAX_CANVAS_SIDE = 8192;

    const stage = document.getElementById('screen-stage');
    const canvas = document.getElementById('canvas');
    if (!stage || !canvas) return;
    const isWebGL2 = (window.AzaharWebConfig || {}).renderer === 'webgl2';

    const enterButton = document.getElementById('btn-fullscreen');
    const exitButton = document.getElementById('btn-fullscreen-exit');
    const arrangementSelect = document.getElementById('fullscreen-arrangement');
    const minInput = document.getElementById('fullscreen-bottom-min');
    const maxInput = document.getElementById('fullscreen-bottom-max');
    const minOutput = document.getElementById('fullscreen-bottom-min-value');
    const maxOutput = document.getElementById('fullscreen-bottom-max-value');
    const helpEl = document.getElementById('fullscreen-help');
    const settingsBox = document.getElementById('fullscreen-settings');
    const overlay = document.getElementById('fullscreen-overlay');
    const overlayPanel = document.getElementById('fullscreen-overlay-panel');
    const overlaySettingsButton = document.getElementById('btn-fullscreen-settings');
    const settingsHome = settingsBox?.parentNode || null;
    const settingsNext = settingsBox?.nextSibling || null;

    const nativeFullscreen = !!(stage.requestFullscreen || stage.webkitRequestFullscreen);
    let active = false;
    let pseudo = false;
    let resizeObserver = null;
    let pendingFrame = 0;

    function clampPercent(value, fallback) {
        const number = Number.parseInt(value, 10);
        if (!Number.isInteger(number)) return fallback;
        return Math.max(LIMIT_MIN, Math.min(LIMIT_MAX, number));
    }

    function loadSettings() {
        let stored = {};
        try {
            stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
        } catch (_) {}
        const settings = {
            arrangement: ['auto', 'side', 'stacked'].includes(stored.arrangement) ?
                stored.arrangement : DEFAULTS.arrangement,
            bottomMin: clampPercent(stored.bottomMin, DEFAULTS.bottomMin),
            bottomMax: clampPercent(stored.bottomMax, DEFAULTS.bottomMax)
        };
        if (settings.bottomMin > settings.bottomMax) settings.bottomMax = settings.bottomMin;
        return settings;
    }

    const settings = loadSettings();

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (_) {}
    }

    // Largest top screen first, then the largest bottom screen the remaining
    // space and the user's bounds allow. `t` scales the top screen and `r` is
    // the bottom screen's size relative to it. Sizes are in CSS pixels.
    function arrange(kind, width, height, rMin, rMax) {
        let t, r;
        if (kind === 'side') {
            t = Math.min(height / TOP_H, width / (TOP_W + BOTTOM_W * rMin));
            r = Math.max(rMin, Math.min(rMax, (width / t - TOP_W) / BOTTOM_W));
        } else {
            t = Math.min(width / TOP_W, height / (TOP_H + BOTTOM_H * rMin));
            r = Math.max(rMin, Math.min(rMax, (height / t - TOP_H) / BOTTOM_H));
        }
        const top = { w: TOP_W * t, h: TOP_H * t };
        const bottom = { w: BOTTOM_W * t * r, h: BOTTOM_H * t * r };
        let totalW, totalH;
        if (kind === 'side') {
            totalW = top.w + bottom.w;
            totalH = top.h;
            top.x = 0; top.y = 0;
            bottom.x = top.w; bottom.y = (top.h - bottom.h) / 2;
        } else {
            totalW = top.w;
            totalH = top.h + bottom.h;
            top.x = 0; top.y = 0;
            bottom.x = (top.w - bottom.w) / 2; bottom.y = top.h;
        }
        const offsetX = (width - totalW) / 2, offsetY = (height - totalH) / 2;
        for (const rect of [top, bottom]) {
            rect.x += offsetX;
            rect.y += offsetY;
        }
        return { kind, t, r, top, bottom };
    }

    function computeLayout(width, height) {
        const rMin = settings.bottomMin / 100, rMax = settings.bottomMax / 100;
        if (settings.arrangement !== 'auto') {
            return arrange(settings.arrangement, width, height, rMin, rMax);
        }
        const side = arrange('side', width, height, rMin, rMax);
        const stacked = arrange('stacked', width, height, rMin, rMax);
        const sideTop = Math.round(side.t * 1000), stackedTop = Math.round(stacked.t * 1000);
        if (sideTop !== stackedTop) return sideTop > stackedTop ? side : stacked;
        return side.r >= stacked.r ? side : stacked;
    }

    function pixelRect(rect, scale, maxW, maxH) {
        const x = Math.max(0, Math.round(rect.x * scale));
        const y = Math.max(0, Math.round(rect.y * scale));
        const w = Math.max(1, Math.min(maxW - x, Math.round(rect.w * scale)));
        const h = Math.max(1, Math.min(maxH - y, Math.round(rect.h * scale)));
        return [x, y, w, h];
    }

    function describe(layout) {
        if (!helpEl) return;
        if (!layout) {
            helpEl.textContent = 'Screens keep their shape; the bottom screen is sized between ' +
                'your minimum and maximum share of the top screen.';
            return;
        }
        helpEl.textContent = `${layout.kind === 'side' ? 'Side by side' : 'Stacked'}: ` +
            `top ${Math.round(layout.top.w)}×${Math.round(layout.top.h)}, ` +
            `bottom ${Math.round(layout.bottom.w)}×${Math.round(layout.bottom.h)} ` +
            `(${Math.round(layout.r * 100)}% of top).`;
    }

    function applyLayout() {
        pendingFrame = 0;
        if (!active) return;
        // The canvas fills the stage, less any room the on-screen controls
        // take beside or below it.
        const width = canvas.clientWidth, height = canvas.clientHeight;
        if (width < 1 || height < 1) return;
        const layout = computeLayout(width, height);
        describe(layout);
        if (layout?.bottom) {
            stage.style.setProperty('--az-bottom-y', `${Math.round(layout.bottom.y)}px`);
            stage.style.setProperty('--az-bottom-h', `${Math.round(layout.bottom.h)}px`);
            stage.style.setProperty('--az-bottom-x', `${Math.round(layout.bottom.x)}px`);
            stage.style.setProperty('--az-bottom-w', `${Math.round(layout.bottom.w)}px`);
        }

        let scale = window.devicePixelRatio || 1;
        if (!isWebGL2) scale = Math.min(scale, SOFTWARE_MAX_TOP_WIDTH / layout.top.w);
        // The engine's drawable is never smaller than the native 400x480 frame.
        scale = Math.max(scale, TOP_W / width, (TOP_H + BOTTOM_H) / height);
        scale = Math.min(scale, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height);
        const canvasW = Math.round(width * scale), canvasH = Math.round(height * scale);

        const module = window.AzaharUI?.getModule?.();
        if (!module?._azahar_set_screen_layout) return;
        const result = module._azahar_set_screen_layout(canvasW, canvasH,
            ...pixelRect(layout.top, scale, canvasW, canvasH),
            ...pixelRect(layout.bottom, scale, canvasW, canvasH));
        if (result !== 0) window.AzaharUI?.log?.(`Fullscreen layout rejected (code ${result}).`);
    }

    function scheduleLayout() {
        if (!active || pendingFrame) return;
        pendingFrame = requestAnimationFrame(applyLayout);
    }

    function restoreNativeLayout() {
        stage.style.removeProperty('--az-bottom-y');
        stage.style.removeProperty('--az-bottom-h');
        stage.style.removeProperty('--az-bottom-x');
        stage.style.removeProperty('--az-bottom-w');
        const module = window.AzaharUI?.getModule?.();
        module?._azahar_set_screen_layout?.(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        describe(null);
    }

    function setOverlayOpen(open) {
        if (overlayPanel) overlayPanel.hidden = !open;
        overlay?.classList.toggle('is-open', open);
        overlaySettingsButton?.setAttribute('aria-expanded', String(open));
    }

    function fullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function announce() {
        window.dispatchEvent(new CustomEvent('azahar-fullscreen-changed', { detail: { active } }));
    }

    function activate(usePseudo) {
        active = true;
        pseudo = usePseudo;
        stage.classList.add('is-fullscreen');
        stage.classList.toggle('is-pseudo-fullscreen', usePseudo);
        document.documentElement.classList.toggle('has-pseudo-fullscreen', usePseudo);
        if (enterButton) enterButton.textContent = '⛶ Exit fullscreen';
        // The side panel is hidden behind the fullscreen view, so its screen
        // size controls move into the overlay.
        if (settingsBox && overlayPanel) overlayPanel.appendChild(settingsBox);
        if (!resizeObserver && 'ResizeObserver' in window) {
            resizeObserver = new ResizeObserver(scheduleLayout);
        }
        resizeObserver?.observe(stage);
        resizeObserver?.observe(canvas);
        window.addEventListener('resize', scheduleLayout);
        announce();
        scheduleLayout();
        // Keyboard input reaches the game through window listeners; keep the
        // focus off the settings controls the user clicked to get here.
        canvas.focus?.({ preventScroll: true });
    }

    function deactivate() {
        if (!active) return;
        active = false;
        if (pendingFrame) cancelAnimationFrame(pendingFrame);
        pendingFrame = 0;
        resizeObserver?.unobserve(stage);
        resizeObserver?.unobserve(canvas);
        window.removeEventListener('resize', scheduleLayout);
        stage.classList.remove('is-fullscreen', 'is-pseudo-fullscreen');
        document.documentElement.classList.remove('has-pseudo-fullscreen');
        pseudo = false;
        if (enterButton) enterButton.textContent = '⛶ Fullscreen';
        setOverlayOpen(false);
        if (settingsBox && settingsHome) settingsHome.insertBefore(settingsBox, settingsNext);
        restoreNativeLayout();
        announce();
    }

    async function enter() {
        if (active) return;
        if (nativeFullscreen) {
            try {
                const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
                await request.call(stage, { navigationUI: 'hide' });
                return; // fullscreenchange activates the layout.
            } catch (err) {
                window.AzaharUI?.log?.(`Browser fullscreen unavailable (${err.message}); filling the window instead.`);
            }
        }
        // iPhone Safari only grants fullscreen to video elements: fill the
        // viewport instead.
        activate(true);
    }

    function exit() {
        if (!active) return;
        if (!pseudo && fullscreenElement()) {
            const leave = document.exitFullscreen || document.webkitExitFullscreen;
            leave?.call(document);
            return; // fullscreenchange deactivates the layout.
        }
        deactivate();
    }

    function onFullscreenChange() {
        if (fullscreenElement() === stage) activate(false);
        else if (active && !pseudo) deactivate();
    }

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    // A layout chosen before the emulator finished initializing applies now.
    window.addEventListener('azahar-initialized', scheduleLayout);

    enterButton?.addEventListener('click', () => (active ? exit() : void enter()));
    exitButton?.addEventListener('click', exit);
    document.getElementById('btn-fullscreen-stage')?.addEventListener('click', () => void enter());
    overlaySettingsButton?.addEventListener('click', () => setOverlayOpen(overlayPanel?.hidden ?? false));
    // Alt+Enter toggles fullscreen; Escape also leaves the window-filling view
    // (the browser handles Escape for real fullscreen).
    window.addEventListener('keydown', event => {
        if (event.altKey && event.key === 'Enter') {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (active) exit(); else void enter();
        } else if (event.key === 'Escape' && active && pseudo) {
            deactivate();
        }
    }, true);

    function syncInputs() {
        if (arrangementSelect) arrangementSelect.value = settings.arrangement;
        if (minInput) minInput.value = String(settings.bottomMin);
        if (maxInput) maxInput.value = String(settings.bottomMax);
        if (minOutput) minOutput.textContent = `${settings.bottomMin}%`;
        if (maxOutput) maxOutput.textContent = `${settings.bottomMax}%`;
    }

    for (const input of [minInput, maxInput]) {
        if (!input) continue;
        input.min = String(LIMIT_MIN);
        input.max = String(LIMIT_MAX);
    }

    // Moving one bound past the other carries the other with it.
    minInput?.addEventListener('input', () => {
        settings.bottomMin = clampPercent(minInput.value, settings.bottomMin);
        if (settings.bottomMax < settings.bottomMin) settings.bottomMax = settings.bottomMin;
        syncInputs();
        saveSettings();
        scheduleLayout();
    });
    maxInput?.addEventListener('input', () => {
        settings.bottomMax = clampPercent(maxInput.value, settings.bottomMax);
        if (settings.bottomMin > settings.bottomMax) settings.bottomMin = settings.bottomMax;
        syncInputs();
        saveSettings();
        scheduleLayout();
    });
    arrangementSelect?.addEventListener('change', () => {
        settings.arrangement = arrangementSelect.value;
        saveSettings();
        scheduleLayout();
    });

    syncInputs();
    describe(null);

    window.AzaharFullscreen = {
        enter, exit,
        isActive: () => active,
        computeLayout,
        getSettings: () => ({ ...settings })
    };
})();
