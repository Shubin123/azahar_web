/**
 * Azahar Web UI — azahar_ui.js
 * Loads the Azahar WebAssembly module and provides the emulator UI.
 */

(function () {
    'use strict';

    // ── DOM refs ──────────────────────────────────────────────────
    const webConfig = window.AzaharWebConfig || {};
    const isWebGL2Artifact = webConfig.renderer === 'webgl2';
    const artifactName = webConfig.artifact || (isWebGL2Artifact ? 'azahar_webgl2' : 'azahar');
    const softwareFallbackUrl = webConfig.softwareFallbackUrl || 'index.html';
    const autoStart = new URLSearchParams(location.search).get('autostart') !== '0';
    const explicitWebGL2 = new URLSearchParams(location.search).get('renderer') === 'webgl2';
    const canvas = document.getElementById('canvas');
    // The startup presentation guard reads pixels until the first visible
    // game frame arrives.  Request a readback-oriented 2D context once,
    // before Emscripten initializes SDL's software canvas, rather than
    // repeatedly creating an unhinted context in the run loop.
    // A canvas can hold either a 2D or WebGL context, never both. The stable
    // page claims its 2D software canvas here; the separately bootstrapped
    // WebGL2 page intentionally leaves it untouched until SDL creates GLES 3.
    const canvas2dContext = isWebGL2Artifact ? null :
        canvas.getContext('2d', {willReadFrequently: true});
    const romInput = document.getElementById('rom-file');
    const fileLabel = document.getElementById('file-label');
    const btnLoad = document.getElementById('btn-load');
    const btnInit = document.getElementById('btn-init');
    const btnStep = document.getElementById('btn-step');
    const btnRun = document.getElementById('btn-run');
    const btnStop = document.getElementById('btn-stop');
    const statusEl = document.getElementById('status');
    const progressEl = document.getElementById('progress');
    const fpsEl = document.getElementById('fps');
    const logEl = document.getElementById('log');
    // The adapter string keys the remembered verdict, so a result measured on
    // one GPU/driver never suppresses the accelerated path on another. A
    // Windows D3D11 or Vulkan machine therefore keeps its own answer.
    let webglAdapter = '';
    const RENDERER_VERDICT_KEY = 'azahar-renderer-verdict';
    const RENDERER_VERDICT_VERSION = 1;

    function readRendererVerdict() {
        try {
            const stored = JSON.parse(localStorage.getItem(RENDERER_VERDICT_KEY) || 'null');
            if (!stored || stored.v !== RENDERER_VERDICT_VERSION) return null;
            return stored;
        } catch (_) {
            return null;
        }
    }

    function storeRendererVerdict(entry) {
        try {
            localStorage.setItem(RENDERER_VERDICT_KEY, JSON.stringify({
                v: RENDERER_VERDICT_VERSION,
                adapter: webglAdapter || 'masked/unknown',
                at: Date.now(),
                ...entry,
            }));
        } catch (_) {}
    }

    function clearRendererVerdict() {
        try {
            localStorage.removeItem(RENDERER_VERDICT_KEY);
        } catch (_) {}
    }

    // An accelerated backend can be slower than the software renderer without
    // ever failing: some drivers stall frame production instead of rejecting
    // work, which caps emulation at the frame rate rather than at the CPU.
    // `?autoFallback=0` pins the selected renderer for measurement.
    const autoFallbackEnabled =
        new URLSearchParams(location.search).get('autoFallback') !== '0';
    // Only Auto re-picks a backend. Choosing "Accelerated (WebGL2)" in the
    // dropdown is a decision to run that backend, including where it is slow,
    // so throughput never overrides it; the hard-failure fallbacks above still
    // apply to both because a backend that cannot present is not a choice.
    const throughputFallbackAllowed = autoFallbackEnabled && !explicitWebGL2;
    const throughputWindowMs = 8000;
    // Scene loads and the first frames after a title screen briefly starve the
    // callback rate on a backend that is otherwise keeping up. Only a run of
    // consecutive bad samples is evidence of a sustained limit, so the switch
    // needs ~6 s of them rather than one unlucky half-second.
    const throughputBadSamplesRequired = 12;
    let throughputBadSamples = 0;

    const rendererMode = document.getElementById('renderer-mode');
    const rendererModeHelp = document.getElementById('renderer-mode-help');
    const rendererRemeasure = document.getElementById('renderer-remeasure');
    const resolutionScale = document.getElementById('resolution-scale');
    const resolutionScaleHelp = document.getElementById('resolution-scale-help');
    const saveStateSlot = document.getElementById('save-state-slot');
    const btnSaveState = document.getElementById('btn-save-state');
    const saveStorageInfo = document.getElementById('save-storage-info');
    const saveStateStatus = document.getElementById('save-state-status');
    const saveStateList = document.getElementById('save-state-list');
    const fastForward = document.getElementById('fast-forward');
    const fastForwardValue = document.getElementById('fast-forward-value');

    // ── State ─────────────────────────────────────────────────────
    let wasmModule = null;
    let romData = null;
    let romMounted = false;
    let romName = '';
    let romPath = '/rom.bin';
    let initialized = false;
    let initializing = false;
    let romLoaded = false;
    let running = false;
    let runAnimationFrame = null;
    let frameCount = 0;
    let runStartedAt = 0;
    let nextBootStatusAt = 0;
    let rendererGraphicsDetected = false;
    let gameGraphicsDetected = false;
    let lastFpsAt = 0;
    let lastFrameCount = 0;
    let displayFps = 0;
    let emulationSpeed = 0;
    // Display-path throughput accounting. `stepWorkMs` is the time actually
    // spent emulating, so it separates "the browser delivers few frames" from
    // "each frame is expensive", which need opposite remedies.
    let stepWorkMs = 0;
    let stepWorkFrames = 0;
    let gameGraphicsAt = 0;
    let saveStateStore = null;
    let saveStateBusy = false;
    let currentProgramId = '';
    const saveStateDirectory = '/home/web_user/.local/share/azahar-emu/states';
    const resolutionQuery = new URLSearchParams(location.search).get('resolution');
    let selectedResolutionScale = Number.parseInt(resolutionQuery || '', 10);
    if (!Number.isInteger(selectedResolutionScale)) {
        try {
            selectedResolutionScale = Number.parseInt(localStorage.getItem('azahar-resolution-scale') || '1', 10);
        } catch (_) {
            selectedResolutionScale = 1;
        }
    }
    selectedResolutionScale = Math.max(1, Math.min(4, selectedResolutionScale || 1));
    const fastForwardQuery = new URLSearchParams(location.search).get('speed');
    let selectedFastForward = Number.parseInt(fastForwardQuery || '', 10);
    if (!Number.isInteger(selectedFastForward)) {
        try {
            selectedFastForward = Number.parseInt(localStorage.getItem('azahar-fast-forward') || '1', 10);
        } catch (_) {
            selectedFastForward = 1;
        }
    }
    selectedFastForward = Math.max(1, Math.min(4, selectedFastForward || 1));

    function updateResolutionHelp() {
        if (!resolutionScaleHelp) return;
        if (!isWebGL2Artifact) {
            resolutionScaleHelp.textContent =
                'Software compatibility mode renders at 1x native resolution.';
            return;
        }
        resolutionScaleHelp.textContent = selectedResolutionScale === 1 ?
            'Native internal resolution preserves maximum emulation speed.' :
            `${selectedResolutionScale}x supersampling improves 3D edges and detail but increases GPU work.`;
    }

    function applyResolutionScale() {
        if (!initialized || !wasmModule?._azahar_set_resolution_scale || !isWebGL2Artifact) return;
        const applied = wasmModule._azahar_set_resolution_scale(selectedResolutionScale);
        if (applied !== selectedResolutionScale) {
            log(`Resolution ${selectedResolutionScale}x rejected (native result ${applied}).`);
            return;
        }
        log(`Internal resolution set to ${applied}x.`);
    }

    function applyFastForward() {
        if (!initialized || !wasmModule?._azahar_set_fast_forward) return;
        const applied = wasmModule._azahar_set_fast_forward(selectedFastForward);
        if (applied !== selectedFastForward) {
            log(`Fast-forward ${selectedFastForward}x rejected (${applied}).`);
            return;
        }
        log(`Fast-forward set to ${applied}x.`);
    }

    // Renderer changes require a fresh document because a browser canvas may
    // own either a 2D or WebGL context, never both. Keep both builds behind a
    // single deployment page and make that required reload explicit.
    if (rendererMode) {
        const query = new URLSearchParams(location.search);
        // An automatic fallback lands on `renderer=software`, but the mode the
        // user selected is still Auto. Showing "Compatibility" there would
        // misreport their setting and make the switch look manual.
        rendererMode.value = query.has('webgl2-fallback') ?
            'auto' : (query.get('renderer') || 'auto');
        if (!rendererMode.options[rendererMode.selectedIndex]) rendererMode.value = 'auto';
        const remembered = readRendererVerdict();
        if (isWebGL2Artifact) {
            rendererModeHelp.textContent = explicitWebGL2 ?
                'Active: accelerated WebGL2, pinned by your choice. Auto would switch ' +
                'if this GPU path measured slower.' :
                'Active: accelerated WebGL2. Auto switches if this GPU path fails or ' +
                'cannot keep up.';
        } else if (remembered && remembered.verdict === 'software') {
            // Say what was measured, not just that something happened: the
            // accelerated option is still selectable and this is the evidence
            // for leaving it alone.
            rendererModeHelp.textContent =
                `Active: compatibility renderer — fastest measured on this GPU ` +
                `(${remembered.adapter}). Accelerated gave ${remembered.fps} frames/s ` +
                `at ${remembered.speed}% speed.`;
        } else {
            rendererModeHelp.textContent =
                `Active: compatibility renderer${query.has('webgl2-fallback') ? ' (automatic fallback)' : ''}.`;
        }
        if (rendererRemeasure && remembered) {
            rendererRemeasure.hidden = false;
            rendererRemeasure.addEventListener('click', () => {
                clearRendererVerdict();
                const destination = new URL('index.html', location.href);
                if (selectedResolutionScale !== 1) {
                    destination.searchParams.set('resolution', String(selectedResolutionScale));
                }
                if (selectedFastForward !== 1) {
                    destination.searchParams.set('speed', String(selectedFastForward));
                }
                if (!autoStart) destination.searchParams.set('autostart', '0');
                location.assign(destination.toString());
            });
        }
        rendererMode.addEventListener('change', () => {
            // Picking a renderer by hand retires the remembered measurement:
            // choosing Accelerated is a request to run it, and returning to
            // Auto afterwards should measure again rather than replay an old
            // verdict the user has just overridden.
            if (rendererMode.value !== 'auto') clearRendererVerdict();
            const destination = new URL('index.html', location.href);
            if (rendererMode.value !== 'auto') {
                destination.searchParams.set('renderer', rendererMode.value);
            }
            if (selectedResolutionScale !== 1) {
                destination.searchParams.set('resolution', String(selectedResolutionScale));
            }
            if (selectedFastForward !== 1) {
                destination.searchParams.set('speed', String(selectedFastForward));
            }
            if (!autoStart) destination.searchParams.set('autostart', '0');
            location.assign(destination.toString());
        });
    }

    if (resolutionScale) {
        resolutionScale.value = String(selectedResolutionScale);
        resolutionScale.disabled = !isWebGL2Artifact;
        updateResolutionHelp();
        resolutionScale.addEventListener('change', () => {
            selectedResolutionScale = Number.parseInt(resolutionScale.value, 10) || 1;
            try {
                localStorage.setItem('azahar-resolution-scale', String(selectedResolutionScale));
            } catch (_) {}
            const currentUrl = new URL(location.href);
            if (selectedResolutionScale === 1) {
                currentUrl.searchParams.delete('resolution');
            } else {
                currentUrl.searchParams.set('resolution', String(selectedResolutionScale));
            }
            history.replaceState(null, '', currentUrl);
            updateResolutionHelp();
            applyResolutionScale();
        });
    }

    if (fastForward) {
        fastForward.value = String(selectedFastForward);
        fastForwardValue.textContent = `${selectedFastForward}x`;
        fastForward.addEventListener('input', () => {
            selectedFastForward = Number.parseInt(fastForward.value, 10) || 1;
            fastForwardValue.textContent = `${selectedFastForward}x`;
            try {
                localStorage.setItem('azahar-fast-forward', String(selectedFastForward));
            } catch (_) {}
            const currentUrl = new URL(location.href);
            if (selectedFastForward === 1) currentUrl.searchParams.delete('speed');
            else currentUrl.searchParams.set('speed', String(selectedFastForward));
            history.replaceState(null, '', currentUrl);
            applyFastForward();
        });
    }

    // ── Logging ───────────────────────────────────────────────────
    function log(msg) {
        const time = new Date().toLocaleTimeString();
        logEl.textContent += `[${time}] ${msg}\n`;
        logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(msg, cls) {
        statusEl.textContent = msg;
        statusEl.className = cls || '';
    }

    function showProgress(value) {
        progressEl.hidden = false;
        if (value === null || value === undefined) {
            progressEl.removeAttribute('value');
        } else {
            progressEl.value = Math.max(0, Math.min(100, value));
        }
    }

    function hideProgress() {
        progressEl.hidden = true;
        progressEl.value = 0;
    }

    function yieldToBrowser() {
        return new Promise(resolve => requestAnimationFrame(resolve));
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    }

    function stateKey(programId, slot) {
        return `${programId}:${slot}`;
    }

    function nativeStatePath(programId, slot) {
        return `${saveStateDirectory}/${programId}.${String(slot).padStart(2, '0')}.cst`;
    }

    function inspectCst(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength < 256) {
            throw new Error('Save file is incomplete');
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint8(0) !== 0x43 || view.getUint8(1) !== 0x53 ||
            view.getUint8(2) !== 0x54 || view.getUint8(3) !== 0x1b) {
            throw new Error('Save file has an invalid CST header');
        }
        const low = view.getUint32(4, true);
        const high = view.getUint32(8, true);
        const programId = high.toString(16).padStart(8, '0') +
            low.toString(16).padStart(8, '0');
        const timestamp = Number(view.getBigUint64(32, true)) * 1000;
        return {programId: programId.toUpperCase(), timestamp};
    }

    function readCurrentProgramId() {
        if (!wasmModule?._azahar_get_program_id) return '';
        const pointer = wasmModule._malloc(8);
        try {
            if (wasmModule._azahar_get_program_id(pointer, 2) !== 0) return '';
            const view = new DataView(wasmModule.HEAPU8.buffer, pointer, 8);
            const low = view.getUint32(0, true);
            const high = view.getUint32(4, true);
            return (high.toString(16).padStart(8, '0') +
                low.toString(16).padStart(8, '0')).toUpperCase();
        } finally {
            wasmModule._free(pointer);
        }
    }

    function setSaveStateMessage(message, isError = false) {
        if (!saveStateStatus) return;
        saveStateStatus.textContent = message;
        saveStateStatus.style.color = isError ? '#ff6b6b' : '#8fcf9f';
    }

    function updateSaveControls() {
        if (btnSaveState) btnSaveState.disabled = saveStateBusy || !romLoaded ||
            !currentProgramId || !saveStateStore;
        if (!saveStateList) return;
        for (const button of saveStateList.querySelectorAll('button')) {
            const matchesGame = button.closest('.save-entry')?.dataset.programId === currentProgramId;
            button.disabled = saveStateBusy || (button.dataset.action === 'load' &&
                (!romLoaded || !matchesGame));
        }
    }

    function setSaveStateBusy(busy) {
        saveStateBusy = busy;
        if (saveStateSlot) saveStateSlot.disabled = busy;
        updateSaveControls();
    }

    async function refreshSaveStateList() {
        if (!saveStateStore || !saveStateList) return;
        const records = await saveStateStore.list();
        saveStateList.replaceChildren();
        if (!records.length) {
            const empty = document.createElement('div');
            empty.className = 'save-empty';
            empty.textContent = 'No browser saves yet.';
            saveStateList.appendChild(empty);
        }
        const groups = new Map();
        for (const record of records) {
            let group = groups.get(record.programId);
            if (!group) {
                group = document.createElement('section');
                group.className = 'save-game-group';
                group.dataset.programId = record.programId;
                const gameTitle = document.createElement('div');
                gameTitle.className = 'save-game-title';
                gameTitle.textContent = record.romName || 'Unknown game';
                const gameId = document.createElement('div');
                gameId.className = 'save-game-id';
                gameId.textContent = `Title ID ${record.programId}`;
                group.append(gameTitle, gameId);
                groups.set(record.programId, group);
                saveStateList.appendChild(group);
            }
            const entry = document.createElement('div');
            entry.className = 'save-entry';
            entry.dataset.stateKey = record.key;
            entry.dataset.programId = record.programId;

            const title = document.createElement('div');
            title.className = 'save-entry-title';
            title.textContent = `Slot ${record.slot}`;
            const meta = document.createElement('div');
            meta.className = 'save-entry-meta';
            meta.textContent = `${formatBytes(record.size)} - ${new Date(record.savedAt).toLocaleString()}`;
            const actions = document.createElement('div');
            actions.className = 'save-actions';
            const loadButton = document.createElement('button');
            loadButton.className = 'btn btn-secondary';
            loadButton.dataset.action = 'load';
            loadButton.dataset.stateKey = record.key;
            loadButton.textContent = 'Load';
            const deleteButton = document.createElement('button');
            deleteButton.className = 'btn btn-danger';
            deleteButton.dataset.action = 'delete';
            deleteButton.dataset.stateKey = record.key;
            deleteButton.textContent = 'Delete';
            actions.append(loadButton, deleteButton);
            entry.append(title, meta, actions);
            group.appendChild(entry);
        }
        const totalBytes = records.reduce((sum, record) => sum + record.size, 0);
        const persistence = await saveStateStore.persistence();
        const durability = persistence.persistent ? 'persistent storage granted' :
            (persistence.supported ? 'standard browser storage' : 'browser-managed storage');
        saveStorageInfo.textContent = `${records.length} save${records.length === 1 ? '' : 's'}, ` +
            `${formatBytes(totalBytes)} total - ${durability}.`;
        updateSaveControls();
    }

    async function initializeSaveStateStorage() {
        if (!window.AzaharSaveStateStore) {
            saveStorageInfo.textContent = 'Persistent save storage is unavailable.';
            return;
        }
        try {
            saveStateStore = await window.AzaharSaveStateStore.open();
            await refreshSaveStateList();
        } catch (error) {
            saveStorageInfo.textContent = `Save storage unavailable: ${error.message}`;
            setSaveStateMessage('Browser saves are disabled.', true);
            log(`Save storage error: ${error.message}`);
        }
    }

    async function stepForStateOperation() {
        await yieldToBrowser();
        frameCount++;
        const result = wasmModule._azahar_step_frame();
        if (result !== 0) throw new Error(`Emulator rejected save-state operation (${result})`);
        updateCanvasFromWasm();
    }

    async function waitForNativeStateOperation(kind, path = null) {
        const deadline = performance.now() + 30000;
        let advanced = false;
        while (performance.now() < deadline) {
            if (!running) {
                await stepForStateOperation();
                advanced = true;
            } else {
                const before = frameCount;
                await delay(25);
                if (!running) {
                    throw new Error(`Emulation stopped while ${kind} the state`);
                }
                advanced ||= frameCount > before;
            }
            const operation = wasmModule._azahar_get_state_operation?.();
            if (operation === -1) throw new Error('Native state-operation acknowledgement is unavailable');
            if (advanced && operation === 0) {
                if (!path) return;
                try {
                    const stat = wasmModule.FS.stat(path);
                    if (stat.size >= 256) return stat.size;
                } catch (_) {}
                throw new Error('Native save completed without producing a valid state file');
            }
            await delay(25);
        }
        throw new Error(`Timed out waiting for Azahar to finish ${kind}ing the state`);
    }

    async function saveCurrentState() {
        if (saveStateBusy || !saveStateStore || !romLoaded || !currentProgramId) return;
        const slot = Number.parseInt(saveStateSlot.value, 10);
        setSaveStateBusy(true);
        setSaveStateMessage(`Saving slot ${slot} (compressed)...`);
        try {
            await saveStateStore.requestPersistence();
            wasmModule.FS.mkdirTree(saveStateDirectory);
            const path = nativeStatePath(currentProgramId, slot);
            try { wasmModule.FS.unlink(path); } catch (_) {}
            const request = wasmModule._azahar_save_state(slot);
            if (request !== 0) throw new Error(`Save request rejected (${request})`);
            await waitForNativeStateOperation('sav', path);
            const bytes = wasmModule.FS.readFile(path);
            const header = inspectCst(bytes);
            if (header.programId !== currentProgramId) {
                throw new Error('Azahar returned a save for a different title');
            }
            const storedBytes = bytes.slice();
            await saveStateStore.put({
                key: stateKey(currentProgramId, slot),
                programId: currentProgramId,
                slot,
                romName,
                savedAt: header.timestamp || Date.now(),
                size: storedBytes.byteLength,
                data: new Blob([storedBytes], {type: 'application/octet-stream'}),
            });
            // IndexedDB now owns the durable compressed copy. Removing the
            // transient MEMFS file avoids retaining another ~20 MiB in the tab.
            try { wasmModule.FS.unlink(path); } catch (_) {}
            log(`Save slot ${slot} persisted for ${currentProgramId} (${formatBytes(storedBytes.byteLength)}).`);
            await refreshSaveStateList();
            setSaveStateMessage(`Saved slot ${slot} - ${formatBytes(storedBytes.byteLength)}.`);
        } catch (error) {
            setSaveStateMessage(`Save failed: ${error.message}`, true);
            log(`Save-state error: ${error.message}`);
        } finally {
            setSaveStateBusy(false);
        }
    }

    async function loadStoredState(key) {
        if (saveStateBusy || !saveStateStore || !romLoaded) return;
        setSaveStateBusy(true);
        try {
            const record = await saveStateStore.get(key);
            if (!record) throw new Error('The selected save no longer exists');
            if (record.programId !== currentProgramId) {
                throw new Error('Load the matching ROM before restoring this save');
            }
            setSaveStateMessage(`Loading slot ${record.slot}...`);
            const bytes = new Uint8Array(await record.data.arrayBuffer());
            const header = inspectCst(bytes);
            if (header.programId !== currentProgramId) throw new Error('Save belongs to another title');
            wasmModule.FS.mkdirTree(saveStateDirectory);
            const path = nativeStatePath(currentProgramId, record.slot);
            wasmModule.FS.writeFile(path, bytes, {canOwn: true});
            const request = wasmModule._azahar_load_state(record.slot);
            if (request !== 0) throw new Error(`Load request rejected (${request})`);
            await waitForNativeStateOperation('load');
            setSaveStateMessage(`Loaded slot ${record.slot} - ${formatBytes(record.size)}.`);
            log(`Loaded persistent save slot ${record.slot} for ${currentProgramId}.`);
        } catch (error) {
            setSaveStateMessage(`Load failed: ${error.message}`, true);
            log(`Load-state error: ${error.message}`);
        } finally {
            setSaveStateBusy(false);
        }
    }

    async function deleteStoredState(key) {
        if (saveStateBusy || !saveStateStore) return;
        const record = await saveStateStore.get(key);
        if (!record) return refreshSaveStateList();
        if (!window.confirm(`Delete ${record.romName || record.programId} slot ${record.slot}?`)) return;
        setSaveStateBusy(true);
        try {
            await saveStateStore.delete(key);
            if (record.programId === currentProgramId && wasmModule) {
                try { wasmModule.FS.unlink(nativeStatePath(record.programId, record.slot)); } catch (_) {}
            }
            setSaveStateMessage(`Deleted slot ${record.slot}.`);
            log(`Deleted persistent save ${key}.`);
            await refreshSaveStateList();
        } catch (error) {
            setSaveStateMessage(`Delete failed: ${error.message}`, true);
        } finally {
            setSaveStateBusy(false);
        }
    }

    btnSaveState?.addEventListener('click', () => void saveCurrentState());
    saveStateList?.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (!button || button.disabled) return;
        if (button.dataset.action === 'load') void loadStoredState(button.dataset.stateKey);
        if (button.dataset.action === 'delete') void deleteStoredState(button.dataset.stateKey);
    });

    let softwareFallbackStarted = false;
    function restartInSoftware(reason) {
        if (!isWebGL2Artifact || softwareFallbackStarted) return;
        softwareFallbackStarted = true;
        log(`WebGL2 fallback: ${reason}`);
        setStatus(`WebGL2 unavailable (${reason}). Restarting in software...`, 'error');
        const destination = new URL(softwareFallbackUrl, window.location.href);
        const currentUrl = new URL(window.location.href);
        // Preserve harness/user-flow controls across the fresh-document
        // renderer switch. In particular, losing autostart=0 would begin
        // execution while an uploaded save state is still being installed.
        for (const name of ['autostart', 'resolution', 'speed', 'scheduler']) {
            if (currentUrl.searchParams.has(name)) {
                destination.searchParams.set(name, currentUrl.searchParams.get(name));
            }
        }
        destination.searchParams.set('webgl2-fallback', '1');
        // Preserve the precise preflight/native failure across the required
        // fresh-document fallback. This makes automated backend gates
        // diagnostic without weakening the user-facing recovery path.
        destination.searchParams.set('webgl2-fallback-reason', reason);
        window.setTimeout(() => window.location.replace(destination.toString()), 0);
    }

    /**
     * Fall back when the accelerated path is throughput-limited rather than
     * broken.
     *
     * Emulation advances once per browser frame, so a backend that delivers
     * few frames caps guest speed no matter how little work each frame costs.
     * The duty cycle distinguishes the two causes: when the callback is idle
     * most of the time, the CPU is not the limit and the software renderer,
     * which needs no GPU-process work at all, runs faster. A busy callback
     * means the opposite, and switching would make things worse.
     */
    function checkDisplayThroughput(now) {
        if (!isWebGL2Artifact || softwareFallbackStarted || !throughputFallbackAllowed) return;
        if (!gameGraphicsDetected || !gameGraphicsAt) return;
        if (now - gameGraphicsAt < throughputWindowMs) return;
        if (!stepWorkFrames || displayFps <= 0) return;
        const dutyCycle = (stepWorkMs / stepWorkFrames) * displayFps / 1000;
        if (displayFps >= 20 || dutyCycle >= 0.35 || emulationSpeed >= 60) {
            throughputBadSamples = 0;
            return;
        }
        if (++throughputBadSamples < throughputBadSamplesRequired) return;
        const reason =
            `accelerated path delivered ${displayFps.toFixed(1)} frames/s at ` +
            `${(dutyCycle * 100).toFixed(0)}% duty cycle ` +
            `(${emulationSpeed.toFixed(0)}% speed) over ` +
            `${throughputBadSamples} consecutive samples`;
        // Remember it so Auto does not repeat a ~14 s probe, and a second ROM
        // upload, on every visit to a machine whose answer is already known.
        storeRendererVerdict({
            verdict: 'software', reason,
            fps: Number(displayFps.toFixed(1)),
            speed: Number(emulationSpeed.toFixed(0)),
        });
        restartInSoftware(reason);
    }

    function compileWebGL2Probe(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
        const logText = gl.getShaderInfoLog(shader) || '';
        gl.deleteShader(shader);
        return {ok, logText};
    }

    // Validate the exact baseline used by RendererWebGL2 on an isolated probe
    // canvas. This does not touch #canvas, preserving the fresh-session
    // software fallback if context or shader creation fails.
    function preflightWebGL2() {
        if (!isWebGL2Artifact) return true;
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2', {
            alpha: false, antialias: false, depth: true, stencil: true,
        });
        if (!gl) {
            restartInSoftware('WebGL2 context creation failed');
            return false;
        }
        const debugRenderer = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = debugRenderer ?
            gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL) : '';
        webglAdapter = renderer || 'masked/unknown';
        log(`WebGL2 adapter: ${webglAdapter}`);
        // Auto already measured this adapter and found the accelerated path
        // slower. Act on that here, before the WebGL2 module is fetched, so the
        // repeat visit costs a redirect instead of another timed probe.
        const remembered = readRendererVerdict();
        if (throughputFallbackAllowed && remembered &&
            remembered.adapter === webglAdapter && remembered.verdict === 'software') {
            restartInSoftware(`remembered result for this GPU: ${remembered.reason}`);
            return false;
        }
        // ANGLE/D3D11 can spend about a minute synchronously translating the
        // generated PICA vertex shaders. Keep the WebGL2 rasterizer and select
        // its CPU-vertex path instead; this reaches gameplay in a few seconds
        // and is faster than the full software renderer. Vulkan/native GL keep
        // hardware vertices. `?hwShader=1` remains a diagnostic override.
        const requestedMode = new URLSearchParams(location.search);
        if (requestedMode.get('hwShader') !== '1' && /(?:direct3d|d3d11)/i.test(renderer)) {
            const compatibleUrl = new URL(location.href);
            compatibleUrl.searchParams.set('hwShader', '0');
            history.replaceState(null, '', compatibleUrl);
            log('ANGLE/D3D11 detected: using WebGL2 with CPU vertex translation.');
            if (rendererModeHelp) {
                rendererModeHelp.textContent =
                    'Active: WebGL2 with the D3D11-compatible CPU vertex path.';
            }
        }
        const vertex = compileWebGL2Probe(gl, gl.VERTEX_SHADER, `#version 300 es
precision highp float;
layout(location = 0) in vec2 vert_position;
void main() { gl_Position = vec4(vert_position, 0.0, 1.0); }`);
        const fragment = compileWebGL2Probe(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
out vec4 frag_color;
void main() { frag_color = vec4(1.0); }`);
        if (!vertex.ok || !fragment.ok) {
            restartInSoftware(`GLSL ES 3.00 shader preflight failed: ${vertex.logText || fragment.logText}`);
            return false;
        }

        // Context loss cannot safely become a 2D session in this document.
        // Navigate before title loading so the stable page gets a new canvas.
        canvas.addEventListener('webglcontextlost', event => {
            event.preventDefault();
            restartInSoftware('WebGL2 context lost');
        }, {once: true});
        return true;
    }

    function memfsRomPath(filename) {
        // Loader::GetLoader uses an extension as a fallback when a container
        // (notably CIA) cannot be identified from its header. Keep only the
        // final, safe extension: browser filenames are untrusted input and
        // need not become filesystem paths in MEMFS.
        const match = /\.[a-z0-9]+$/i.exec(filename);
        return `/rom${match ? match[0].toLowerCase() : '.bin'}`;
    }

    // Chrome's Blob/FileReader read pipeline fails on a single whole-file
    // read somewhere around 2.1-2.15 GB -- verified against a real 2 GiB
    // decrypted title (not a clean power-of-two boundary, so it's an
    // internal cap in Blink's own file-reading path, not a fixed constant
    // we can special-case, and not this machine's available memory: the
    // WASM heap already holds > 2 GB fine via MAXIMUM_MEMORY). Reading in
    // bounded chunks keeps every individual Blob read well under that
    // ceiling while still producing one contiguous Uint8Array for
    // FS.writeFile, and doubles as natural progress reporting.
    const ROM_READ_CHUNK_BYTES = 256 * 1024 * 1024;

    async function readFileInChunks(file) {
        const bytes = new Uint8Array(file.size);
        for (let offset = 0; offset < file.size; offset += ROM_READ_CHUNK_BYTES) {
            const end = Math.min(offset + ROM_READ_CHUNK_BYTES, file.size);
            const chunk = await file.slice(offset, end).arrayBuffer();
            bytes.set(new Uint8Array(chunk), offset);
            const percent = Math.round(end / file.size * 100);
            showProgress(percent);
            setStatus(`Reading ROM... ${percent}%`);
        }
        return bytes;
    }

    // ── File picker ───────────────────────────────────────────────
    romInput.addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (!file) return;

        romName = file.name;
        romPath = memfsRomPath(romName);
        fileLabel.textContent = `📄 ${romName} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;

        btnLoad.disabled = true;
        showProgress(0);
        setStatus('Reading ROM... 0%');
        readFileInChunks(file).then(function (bytes) {
            romData = bytes;
            romMounted = false;
            log(`File loaded: ${romName} (${romData.length} bytes)`);
            showProgress(100);
            setStatus(initialized ? `ROM ready: ${romName}` :
                `ROM ready; starting emulator...`, 'ok');
            btnLoad.disabled = !initialized;
            window.setTimeout(hideProgress, 250);
        }).catch(function (err) {
            hideProgress();
            setStatus('Failed to read file!', 'error');
            log(`ERROR: file read failed: ${err && err.message ? err.message : err}`);
        });
    });

    // ── WASM Module Loading ──────────────────────────────────────
    async function loadWasmModule() {
        await ensureCrossOriginIsolated();
        if (!preflightWebGL2()) {
            // restartInSoftware has scheduled a navigation to a fresh canvas.
            return new Promise(() => {});
        }
        log(`Loading ${artifactName}.js glue script...`);
        setStatus('Loading WebAssembly module...');

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = `${artifactName}.js`;
            // SDL2's Emscripten backend must use the UI canvas that already
            // exists in the page. Set this before loading the generated glue
            // script so it does not create an unbound canvas target.
            window.Module = window.Module || {};
            window.Module.canvas = canvas;
            // Keep native frontend/core diagnostics visible in the browser UI.
            // Emscripten invokes these hooks for stdout and stderr after the
            // generated runtime starts, which lets real-ROM testing expose
            // service/configuration failures instead of appearing as a
            // permanently black canvas.
            window.Module.print = function (message) {
                log(`[native] ${message}`);
            };
            window.Module.printErr = function (message) {
                log(`[native] ${message}`);
            };
            window.Module.setStatus = function (message) {
                if (message) {
                    showProgress(null);
                    setStatus(`WASM: ${message}`);
                }
            };
            script.onload = function () {
                // Emscripten-generated Module object
                if (typeof Module !== 'undefined') {
                    Module['onRuntimeInitialized'] = function () {
                        log('WebAssembly runtime initialized.');
                        wasmModule = Module;
                        setStatus('WASM ready. Starting emulator...', 'ok');
                        resolve(Module);
                    };
                    // In case it's already initialized
                    if (Module.calledRun) {
                        log('WebAssembly already initialized.');
                        wasmModule = Module;
                        setStatus('WASM ready. Starting emulator...', 'ok');
                        resolve(Module);
                    }
                } else {
                    // If no Module object, script may be self-initializing
                    log('Waiting for WASM runtime...');
                    // Poll for Module
                    const check = setInterval(() => {
                        if (typeof Module !== 'undefined' && Module.calledRun) {
                            clearInterval(check);
                            wasmModule = Module;
                            log('WebAssembly runtime detected.');
                            setStatus('WASM ready. Starting emulator...', 'ok');
                            resolve(Module);
                        }
                    }, 200);
                    setTimeout(() => { clearInterval(check); reject(new Error('WASM timeout')); }, 30000);
                }
            };
            script.onerror = function () {
                reject(new Error('Failed to load azahar.js'));
            };
            document.head.appendChild(script);
        });
    }

    async function ensureCrossOriginIsolated() {
        if (window.crossOriginIsolated) {
            try { sessionStorage.removeItem('azahar-coi-reload'); } catch (_) {}
            return;
        }

        // GitHub Pages and other static hosts cannot set COOP/COEP headers.
        // The local service worker can add them after one controlled reload.
        const canUseServiceWorker = 'serviceWorker' in navigator &&
            (window.location.protocol === 'https:' ||
                window.location.hostname === 'localhost' ||
                window.location.hostname === '127.0.0.1');
        if (!canUseServiceWorker) {
            throw new Error('This server is missing COOP/COEP headers. Use serve_web.bat or HTTPS with coi-serviceworker.js.');
        }

        let attemptedReload = false;
        try { attemptedReload = sessionStorage.getItem('azahar-coi-reload') === '1'; } catch (_) {}
        if (attemptedReload) {
            throw new Error('Browser isolation is unavailable after reload. Serve web/ with COOP: same-origin and COEP: require-corp.');
        }

        try {
            try { sessionStorage.setItem('azahar-coi-reload', '1'); } catch (_) {}
            setStatus('Enabling threaded WebAssembly; reloading once...', 'ok');
            showProgress(null);
            await navigator.serviceWorker.register('coi-serviceworker.js', {scope: './'});
            await navigator.serviceWorker.ready;
            window.location.reload();
            await new Promise(() => {});
        } catch (error) {
            throw new Error(`Unable to enable browser isolation: ${error.message}`);
        }
    }

    // ── Initialize Emulator ──────────────────────────────────────
    async function initializeEmulator() {
        if (initialized || initializing) return;
        initializing = true;
        btnInit.disabled = true;
        showProgress(null);
        setStatus('Initializing emulator...');

        try {
            if (!wasmModule) await loadWasmModule();
            await yieldToBrowser();
            const result = wasmModule._azahar_init();
            if (result !== 0) {
                if (isWebGL2Artifact && result === -7) {
                    restartInSoftware('native WebGL2 context setup failed');
                    return;
                }
                setStatus(`Init failed (code ${result})`, 'error');
                log(`ERROR: azahar_init returned ${result}`);
                btnInit.disabled = false;
                return;
            }
            initialized = true;
            applyResolutionScale();
            applyFastForward();
            log('Emulator initialized successfully.');
            hideProgress();
            setStatus('Emulator ready. Choose a ROM to load and run.', 'ok');
            if (romData) btnLoad.disabled = false;
        } catch (err) {
            hideProgress();
            setStatus(`Init error: ${err.message}`, 'error');
            log(`ERROR: ${err.message}`);
            btnInit.disabled = false;
        } finally {
            initializing = false;
        }
    }

    btnInit.addEventListener('click', function () {
        void initializeEmulator();
    });

    // ── Load ROM ─────────────────────────────────────────────────
    async function loadAndRunRom() {
        if (!initialized || (!romData && !romMounted)) {
            setStatus('Initialize emulator and select a ROM first.', 'error');
            return;
        }

        try {
            setStatus('Mounting ROM...');
            showProgress(null);
            btnLoad.disabled = true;
            await yieldToBrowser();

            // Write ROM to MEMFS so the C++ side can read it. Preserve the
            // selected extension because the native loader uses it as a
            // fallback for encrypted CIA containers.
            // A retail .3ds image can be 1 GiB.  The default MEMFS write
            // copies the FileReader buffer, briefly keeping two full browser
            // heap copies alive before the core begins loading it.  Let
            // MEMFS take ownership instead; the selected file can be chosen
            // again if the user needs to retry with another image.
            if (romData) {
                wasmModule.FS.writeFile(romPath, romData, {canOwn: true});
                romData = null;
                romMounted = true;
                log(`ROM written to MEMFS: ${romPath}`);
            }

            setStatus('Opening game...');
            await yieldToBrowser();
            const result = wasmModule.ccall('azahar_load_rom', 'number', ['string'], [romPath]);
            if (result === 0) {
                romLoaded = true;
                currentProgramId = readCurrentProgramId();
                if (!currentProgramId) {
                    log('WARNING: Could not determine the loaded title ID; browser saves are disabled.');
                    setSaveStateMessage('Could not identify this title for browser saves.', true);
                }
                updateSaveControls();
                if (saveStateStore) void refreshSaveStateList();
                log('ROM loaded successfully!');
                hideProgress();
                if (autoStart) {
                    btnStep.disabled = true;
                    startRunning();
                } else {
                    btnStep.disabled = false;
                    btnRun.disabled = false;
                    setStatus('ROM loaded successfully. Ready to run.', 'ok');
                }
            } else if (isWebGL2Artifact && result === -7) {
                hideProgress();
                restartInSoftware('native GLSL ES 3.00 setup failed');
            } else if (result === -8) {
                hideProgress();
                setStatus('ROM is encrypted. Use a decrypted dump with your own keys.', 'error');
                log('ERROR: azahar_load_rom rejected an encrypted ROM');
                btnLoad.disabled = false;
            } else if (result === -4) {
                hideProgress();
                setStatus('ROM file could not be opened from browser storage.', 'error');
                log('ERROR: azahar_load_rom could not open the mounted ROM path');
                btnLoad.disabled = false;
            } else {
                hideProgress();
                setStatus(`ROM load failed (code ${result})`, 'error');
                log(`ERROR: azahar_load_rom returned ${result}`);
                btnLoad.disabled = false;
            }
        } catch (err) {
            hideProgress();
            setStatus(`Load error: ${err.message}`, 'error');
            log(`ERROR: ${err.message}`);
            btnLoad.disabled = false;
        }
    }

    btnLoad.addEventListener('click', function () {
        void loadAndRunRom();
    });

    // ── Step One Frame ───────────────────────────────────────────
    btnStep.addEventListener('click', function () {
        if (!romLoaded) {
            setStatus('Load a ROM first.', 'error');
            return;
        }

        try {
            frameCount++;
            const result = wasmModule._azahar_step_frame();

            if (result === 0) {
                // Copy the Emscripten GL/Canvas framebuffer to our canvas
                // SDL2 in Emscripten renders to the default canvas; we grab it
                updateCanvasFromWasm();
                setStatus(`Frame ${frameCount} OK`, 'ok');
            } else if (result === 1) {
                setStatus('Emulation ended (shutdown)', 'error');
                log('Emulator requested shutdown.');
                stopRunning();
            } else {
                setStatus(`Frame step error (code ${result})`, 'error');
                log(`ERROR: azahar_step_frame returned ${result}`);
            }
        } catch (err) {
            setStatus(`Step error: ${err.message}`, 'error');
            log(`ERROR: ${err.message}`);
        }
    });

    // ── Run Loop ─────────────────────────────────────────────────
    function visibleCanvasPixels() {
        if (canvas2dContext) {
            return canvas2dContext.getImageData(0, 0, canvas.width, canvas.height).data;
        }
        // This runs only after the WebGL2 renderer has claimed the canvas.
        // Asking for its existing context is safe; creating a 2D context here
        // would make the experimental fallback contract impossible.
        const gl = canvas.getContext('webgl2');
        if (!gl) return null;
        try {
            const pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            return pixels;
        } catch (_) {
            return null;
        }
    }

    function updateBootStatus(now) {
        if (now < nextBootStatusAt) return;
        nextBootStatusAt = now + 500;
        if (!rendererGraphicsDetected && wasmModule._azahar_framebuffer_nonblack_pixels) {
            const framebufferPixels = wasmModule._azahar_framebuffer_nonblack_pixels();
            // WebGL2 can keep the framebuffer GPU-resident, so it deliberately
            // reports -2 rather than exposing an unsynchronized CPU vector.
            // Continue to the existing compositor readback gate in that case.
            rendererGraphicsDetected = framebufferPixels > 0 ||
                (isWebGL2Artifact && framebufferPixels === -2);
        }
        if (rendererGraphicsDetected && !gameGraphicsDetected) {
            // A non-black software framebuffer proves only that emulation and
            // rasterization work. Confirm that those pixels arrived at the
            // visible UI canvas before reporting graphics as detected.
            const data = visibleCanvasPixels();
            if (data) {
                const colors = new Set();
                let nonBlackSamples = 0;
                for (let index = 0; index < data.length; index += 64) {
                    const red = data[index];
                    const green = data[index + 1];
                    const blue = data[index + 2];
                    if (red || green || blue) {
                        nonBlackSamples++;
                        colors.add(`${red},${green},${blue}`);
                    }
                }
                gameGraphicsDetected = nonBlackSamples >= 16 && colors.size >= 2;
                if (gameGraphicsDetected) gameGraphicsAt = now;
            }
        }
        if (gameGraphicsDetected) {
            hideProgress();
            setStatus(`Running. Visible game graphics detected after ${((now - runStartedAt) / 1000).toFixed(1)}s`, 'ok');
        } else if (rendererGraphicsDetected) {
            // A context and shader preflight are not enough: an experimental
            // backend can still fail to put its drawing buffer on the browser
            // compositor. Recover into the stable artifact rather than
            // leaving the user at a black screen.
            const presentationTimeout = explicitWebGL2 ? 90000 : 10000;
            if (isWebGL2Artifact && now - runStartedAt >= presentationTimeout) {
                restartInSoftware('WebGL2 presentation produced no visible frame');
                return;
            }
            showProgress(null);
            setStatus(`Renderer graphics ready; waiting for canvas presentation... ${((now - runStartedAt) / 1000).toFixed(1)}s`, 'ok');
        } else {
            showProgress(null);
            setStatus(`Booting game... ${((now - runStartedAt) / 1000).toFixed(1)}s (step ${frameCount})`, 'ok');
        }
    }

    function startRunning() {
        if (!romLoaded || running) return;

        running = true;
        runStartedAt = performance.now();
        nextBootStatusAt = runStartedAt;
        rendererGraphicsDetected = false;
        gameGraphicsDetected = false;
        lastFpsAt = 0;
        lastFrameCount = 0;
        displayFps = 0;
        emulationSpeed = 0;
        btnRun.disabled = true;
        btnStop.disabled = false;
        btnStep.disabled = true;
        log('Starting run loop at display refresh rate...');
        showProgress(null);

        function tick(now) {
            if (!running) return;

            try {
                frameCount++;
                const stepStartedAt = performance.now();
                const result = wasmModule._azahar_step_frame();
                stepWorkMs += performance.now() - stepStartedAt;
                stepWorkFrames++;

                if (result === 0) {
                    updateCanvasFromWasm();
                    updateBootStatus(now);
                    // Update FPS meter every ~500 ms
                    if (now - lastFpsAt >= 500) {
                        if (lastFpsAt > 0) {
                            displayFps = (frameCount - lastFrameCount) /
                                ((now - lastFpsAt) / 1000);
                        }
                        lastFpsAt = now;
                        lastFrameCount = frameCount;
                        // Pull emulation speed from the C++ perf counters
                        let gameFps = 0;
                        if (wasmModule._azahar_get_perf_stats) {
                            var buf = wasmModule._malloc(64); // 8 × f64
                            if (wasmModule._azahar_get_perf_stats(buf, 8) === 0) {
                                const stats = new Float64Array(wasmModule.HEAPU8.buffer, buf, 8);
                                gameFps = stats[0];
                                emulationSpeed = stats[2] * 100;
                            }
                            wasmModule._free(buf);
                        }
                        if (displayFps > 0) {
                            fpsEl.textContent = gameFps.toFixed(0) + ' game FPS' +
                                (emulationSpeed > 0 ? ' | ' + emulationSpeed.toFixed(0) + '% speed' : '');
                        }
                        checkDisplayThroughput(now);
                        stepWorkMs = 0;
                        stepWorkFrames = 0;
                    }
                    runAnimationFrame = AzaharScheduler.request(tick);
                } else if (result === 1) {
                    log('Emulation ended.');
                    setStatus('Emulation ended.', '');
                    stopRunning();
                } else {
                    log(`Frame error: ${result}`);
                    setStatus(`Frame error (code ${result})`, 'error');
                    stopRunning();
                }
            } catch (err) {
                // Preserve the WebAssembly function/offset stack in the UI.
                // A bare `unreachable` message hides the native renderer path
                // that trapped, making scene-transition failures impossible
                // to diagnose from an uploaded static deployment.
                log(`Run error: ${err.stack || err.message}`);
                setStatus(`Error: ${err.message}`, 'error');
                stopRunning();
            }
        }

        runAnimationFrame = AzaharScheduler.request(tick);
    }

    btnRun.addEventListener('click', startRunning);

    btnStop.addEventListener('click', function () {
        stopRunning();
    });

    function stopRunning() {
        running = false;
        if (runAnimationFrame !== null) {
            AzaharScheduler.cancel(runAnimationFrame);
            runAnimationFrame = null;
        }
        hideProgress();
        fpsEl.textContent = '';
        btnRun.disabled = !romLoaded;
        btnStop.disabled = true;
        btnStep.disabled = !romLoaded;
        if (romLoaded) setStatus(`Stopped at step ${frameCount}`, '');
    }

    // ── Canvas Update ────────────────────────────────────────────
    function updateCanvasFromWasm() {
        if (isWebGL2Artifact || !canvas2dContext) {
            // RendererWebGL2 draws directly to Module.canvas. A 2D blit would
            // either fail or attempt to claim the already-WebGL canvas.
            return;
        }
        // SDL2 on Emscripten renders to its own canvas (Module.canvas).
        // Our canvas (#canvas) is separate, so we copy the pixels.
        // If Module.canvas is different, blit from it.
        var srcCanvas = null;
        if (wasmModule && wasmModule.canvas) {
            srcCanvas = wasmModule.canvas;
        } else {
            // Fallback: find the canvas SDL2 creates
            var canvases = document.querySelectorAll('canvas');
            if (canvases.length > 1) {
                srcCanvas = canvases[1]; // SDL often creates a second canvas
            }
        }

        if (srcCanvas && srcCanvas !== canvas) {
            canvas2dContext.drawImage(srcCanvas, 0, 0, canvas.width, canvas.height);
        }
    }

    async function loadRomBytes(bytes, name, shouldAutoStart = true) {
        if (!initialized) {
            setStatus('Initializing emulator for ROM...', 'ok');
            await initializeEmulator();
        }
        if (running) {
            stopRunning();
        }
        romName = name;
        romPath = memfsRomPath(name);
        if (fileLabel) {
            fileLabel.textContent = `📄 ${romName} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`;
        }
        romData = bytes;
        romMounted = false;
        log(`Loading ROM: ${romName} (${bytes.length} bytes)`);
        await loadAndRunRom();
        if (shouldAutoStart && romLoaded && !running) {
            startRunning();
        }
    }

    // ── Public API for Shared Library & External Integration ─────
    window.AzaharUI = {
        loadRomBytes,
        initializeEmulator,
        isInitialized: () => initialized,
        isRunning: () => running,
        stopRunning,
        startRunning,
        setStatus,
        showProgress,
        hideProgress,
        log,
        getCanvas: () => canvas
    };

    // ── Auto-init on page load ───────────────────────────────────
    log('Azahar Web UI ready.');
    setStatus('Loading WASM module...');
    showProgress(null);
    void initializeSaveStateStorage();
    loadWasmModule().then(function () {
        return initializeEmulator();
    }).catch(function (err) {
        hideProgress();
        log(`WASM load failed: ${err.message}`);
        setStatus(`Failed to load WASM: ${err.message}. Ensure ${artifactName}.js and ${artifactName}.wasm are in the same directory.`, 'error');
        // Allow manual retry via Init button
        btnInit.disabled = false;
    });
})();
