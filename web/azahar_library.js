/**
 * Azahar Web — Shared Game Library (azahar_library.js)
 * Manages the 3DS game catalog from Internet Archive (3ds-decrypted-roms321com).
 * Provides search, region filtering, pagination, and direct streaming into Azahar Web.
 */

(function () {
    'use strict';

    const REGION_FLAGS = {
        'USA': '🇺🇸',
        'Europe': '🇪🇺',
        'Japan': '🇯🇵',
        'Korea': '🇰🇷',
        'Taiwan': '🇹🇼',
        'China': '🇨🇳',
        'Australia': '🇦🇺',
        'Germany': '🇩🇪',
        'France': '🇫🇷',
        'Spain': '🇪🇸',
        'Italy': '🇮🇹',
        'Netherlands': '🇳🇱',
        'Russia': '🇷🇺',
        'World': '🌐',
        'Other': '🌐'
    };

    const LIBRARY_SOURCES = {
        decrypted: {
            label: 'Decrypted 3DS ROM set',
            baseUrl: 'https://archive.org/download/3ds-decrypted-roms321com/all/',
            catalogUrl: 'games_library.json'
        },
        cia: {
            label: '3DS CIA files archive',
            baseUrl: 'https://archive.org/download/3ds-cia-files/',
            metadataUrl: 'https://archive.org/metadata/3ds-cia-files',
            identifier: '3ds-cia-files'
        }
    };
    const CATALOG_CACHE_NAME = 'azahar-library-catalog-v1';

    let allGames = [];
    let filteredGames = [];
    let currentRegion = 'all';
    let searchQuery = '';
    let sortMode = 'title-asc';
    let currentPage = 1;
    let pageSize = 50;

    let activeDownload = null; // { controller, game, startTime, loadedBytes, totalBytes }
    let cachedPlayableDownload = null; // keep the last played game ready in memory
    const PLAYABLE_CACHE_NAME = 'azahar-playable-library-v1';
    let searchDebounceTimer = null;
    let currentSourceId = 'decrypted';
    const catalogCache = new Map();
    let catalogRequestId = 0;

    // DOM Elements
    let containerEl = null;
    let countBadgeEl = null;
    let sourceSelectEl = null;
    let sourceLinkEl = null;
    let searchInputEl = null;
    let searchClearEl = null;
    let regionFiltersEl = null;
    let sortSelectEl = null;
    let listEl = null;
    let emptyEl = null;
    let prevBtnEl = null;
    let nextBtnEl = null;
    let pageInfoEl = null;
    let pageSizeEl = null;
    let downloadCardEl = null;
    let downloadTitleEl = null;
    let downloadStatsEl = null;
    let downloadBarEl = null;
    let downloadSpeedEl = null;
    let downloadCancelEl = null;
    let readyCardEl = null;
    let readyListEl = null;

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function formatSpeed(bytesPerSec) {
        if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
        if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
        return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
    }

    async function getPlayableCacheRequest(url) {
        if (!window.crypto?.subtle || !window.caches) return null;
        const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
        const key = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        return new Request(new URL(`/__azahar_playable_cache__/${key}`, window.location.origin));
    }

    async function readCachedPlayable(url) {
        if (cachedPlayableDownload?.url === url) return cachedPlayableDownload;
        try {
            const request = await getPlayableCacheRequest(url);
            if (!request) return null;
            const cache = await window.caches.open(PLAYABLE_CACHE_NAME);
            const response = await cache.match(request);
            if (!response) return null;
            const playable = {
                url,
                bytes: new Uint8Array(await response.arrayBuffer()),
                name: decodeURIComponent(response.headers.get('X-Azahar-Rom-Name') || '')
            };
            cachedPlayableDownload = playable;
            return playable;
        } catch (error) {
            console.warn('Could not read the locally cached game:', error);
            return null;
        }
    }

    // Titles already downloaded (and extracted) that can start without another
    // network request. Legacy cache entries lack a source URL and are skipped.
    async function listReadyPlayables() {
        const ready = new Map();
        if (cachedPlayableDownload) {
            const { url, name, title, bytes } = cachedPlayableDownload;
            ready.set(url, { url, name, title: title || name, size: bytes.length });
        }
        try {
            if (!window.caches) return [...ready.values()];
            const cache = await window.caches.open(PLAYABLE_CACHE_NAME);
            for (const request of await cache.keys()) {
                const response = await cache.match(request);
                const url = decodeURIComponent(response?.headers.get('X-Azahar-Source-Url') || '');
                if (!url || ready.has(url)) continue;
                const name = decodeURIComponent(response.headers.get('X-Azahar-Rom-Name') || '');
                ready.set(url, {
                    url,
                    name,
                    title: decodeURIComponent(response.headers.get('X-Azahar-Title') || '') || name,
                    size: Number.parseInt(response.headers.get('Content-Length') || '0', 10)
                });
            }
        } catch (error) {
            console.warn('Could not list locally cached games:', error);
        }
        return [...ready.values()];
    }

    async function forgetPlayable(url) {
        if (cachedPlayableDownload?.url === url) cachedPlayableDownload = null;
        try {
            const request = await getPlayableCacheRequest(url);
            if (request) await (await window.caches.open(PLAYABLE_CACHE_NAME)).delete(request);
        } catch (error) {
            console.warn('Could not remove the locally cached game:', error);
        }
        await renderReadyList();
    }

    async function renderReadyList() {
        if (!readyListEl) return;
        const ready = await listReadyPlayables();
        ready.sort((a, b) => a.title.localeCompare(b.title));
        const fragment = document.createDocumentFragment();
        for (const entry of ready) {
            const li = document.createElement('li');
            li.className = 'ready-game';
            const info = document.createElement('div');
            info.className = 'ready-game-info';
            const nameDiv = document.createElement('div');
            nameDiv.className = 'game-name';
            nameDiv.textContent = entry.title;
            const fileDiv = document.createElement('div');
            fileDiv.className = 'game-filename';
            fileDiv.textContent = `${entry.name} • ${formatBytes(entry.size)}`;
            info.append(nameDiv, fileDiv);

            const playBtn = document.createElement('button');
            playBtn.type = 'button';
            playBtn.className = 'btn btn-primary btn-sm';
            playBtn.dataset.action = 'play-ready';
            playBtn.dataset.url = entry.url;
            playBtn.textContent = '▶ Play';
            playBtn.disabled = Boolean(activeDownload);
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn btn-secondary btn-sm';
            removeBtn.dataset.action = 'remove-ready';
            removeBtn.dataset.url = entry.url;
            removeBtn.textContent = '✕';
            removeBtn.title = 'Remove from local cache';
            li.append(info, playBtn, removeBtn);
            fragment.appendChild(li);
        }
        readyListEl.replaceChildren(fragment);
        if (readyCardEl) readyCardEl.hidden = ready.length === 0;
    }

    async function fetchCatalogJson(url) {
        const request = new Request(new URL(url, window.location.href));
        let cache = null;
        try { cache = await window.caches?.open(CATALOG_CACHE_NAME) || null; } catch (_) {}
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            if (cache) void cache.put(request, response.clone()).catch(error =>
                console.warn('Could not persist the library catalog:', error));
            return await response.json();
        } catch (networkError) {
            if (cache) {
                const stored = await cache.match(request).catch(() => null);
                if (stored) return stored.json();
            }
            throw networkError;
        }
    }

    function rememberPlayable(url, bytes, name, title) {
        cachedPlayableDownload = { url, bytes, name, title };
        void renderReadyList();
        // Keep a browser-managed copy so played titles are available after a
        // reload. Storage quota failures leave the in-memory replay cache intact.
        void (async () => {
            try {
                const request = await getPlayableCacheRequest(url);
                if (!request) return;
                const cache = await window.caches.open(PLAYABLE_CACHE_NAME);
                await cache.put(request, new Response(bytes, {
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-Azahar-Rom-Name': encodeURIComponent(name),
                        'X-Azahar-Title': encodeURIComponent(title || name),
                        'X-Azahar-Source-Url': encodeURIComponent(url),
                        'Content-Length': String(bytes.length)
                    }
                }));
                void renderReadyList();
            } catch (error) {
                console.warn('Could not persist the played game in the local cache:', error);
            }
        })();
    }

    function parseArchiveGame(file, index, source) {
        const filename = String(file.name || '');
        const title = filename.replace(/\.[^.]+$/, '').replace(/^\d+\s*-\s*/, '').trim();
        const regionMatch = title.match(/\((USA|Europe|Japan|World|Korea|Taiwan|China|Australia|Germany|France|Spain|Italy|Netherlands|Russia)\)/i);
        const region = regionMatch ? regionMatch[1] : 'Other';
        const extension = filename.match(/\.([^.]+)$/)?.[1]?.toLowerCase() || 'file';
        const encodedName = filename.split('/').map(encodeURIComponent).join('/');
        const canPlayDirectly = ['3ds', 'cia'].includes(extension);
        const canExtractAndPlay = extension === 'rar';

        return {
            id: index + 1,
            title,
            fullName: title,
            region,
            languages: [],
            romName: filename,
            zipName: filename,
            size: Number(file.size) || 0,
            sizeFormatted: formatBytes(Number(file.size) || 0),
            downloadUrl: `${source.baseUrl}${encodedName}`,
            viewArchiveUrl: `https://archive.org/details/${source.identifier}`,
            downloadOnly: !canPlayDirectly && !canExtractAndPlay,
            extractBeforePlay: canExtractAndPlay
        };
    }

    async function loadSourceCatalog(sourceId) {
        const source = LIBRARY_SOURCES[sourceId] || LIBRARY_SOURCES.decrypted;
        if (catalogCache.has(sourceId)) return catalogCache.get(sourceId);

        if (source.catalogUrl) {
            const data = await fetchCatalogJson(source.catalogUrl);
            const games = Array.isArray(data.games) ? data.games : [];
            catalogCache.set(sourceId, games);
            return games;
        }

        const metadata = await fetchCatalogJson(source.metadataUrl);
        const files = Array.isArray(metadata.files) ? metadata.files : [];
        const games = files
            .filter(file => /\.(?:rar|cia|3ds|zip)$/i.test(file.name || ''))
            .map((file, index) => parseArchiveGame(file, index, source));
        catalogCache.set(sourceId, games);
        return games;
    }

    function getRegionFlag(region) {
        return REGION_FLAGS[region] || '🌐';
    }

    function getRegionClass(region) {
        const lower = (region || '').toLowerCase();
        if (lower.includes('usa')) return 'badge-usa';
        if (lower.includes('europe') || lower.includes('germany') || lower.includes('france') ||
            lower.includes('spain') || lower.includes('italy') || lower.includes('netherlands')) return 'badge-europe';
        if (lower.includes('japan')) return 'badge-japan';
        return 'badge-other';
    }

    function matchesRegion(gameRegion, filter) {
        if (filter === 'all') return true;
        const reg = (gameRegion || '').toLowerCase();
        if (filter === 'USA') return reg === 'usa';
        if (filter === 'Japan') return reg === 'japan';
        if (filter === 'Europe') {
            return reg === 'europe' || reg === 'germany' || reg === 'france' ||
                   reg === 'spain' || reg === 'italy' || reg === 'netherlands' || reg === 'russia';
        }
        if (filter === 'other') {
            return reg !== 'usa' && reg !== 'japan' && reg !== 'europe' &&
                   reg !== 'germany' && reg !== 'france' && reg !== 'spain' &&
                   reg !== 'italy' && reg !== 'netherlands' && reg !== 'russia';
        }
        return true;
    }

    // Catalog data can contain optional or legacy fields. Normalize searchable
    // values here so one incomplete entry cannot abort an entire search.
    function normalizeSearchText(value) {
        return String(value == null ? '' : value)
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase();
    }

    function applyFilterAndSort() {
        const query = normalizeSearchText(searchQuery.trim());

        filteredGames = allGames.filter(game => {
            if (!matchesRegion(game.region, currentRegion)) {
                return false;
            }
            if (!query) return true;

            const languages = Array.isArray(game.languages) ? game.languages : [];
            return [game.title, game.fullName, game.region, game.romName, game.zipName,
                ...languages].some(value => normalizeSearchText(value).includes(query));
        });

        filteredGames.sort((a, b) => {
            switch (sortMode) {
                case 'title-asc':
                    return String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true, sensitivity: 'base' });
                case 'title-desc':
                    return String(b.title || '').localeCompare(String(a.title || ''), undefined, { numeric: true, sensitivity: 'base' });
                case 'size-asc':
                    return (a.size || 0) - (b.size || 0);
                case 'size-desc':
                    return (b.size || 0) - (a.size || 0);
                default:
                    return 0;
            }
        });

        currentPage = 1;
        renderPagination();
        renderCurrentPage();
    }

    function renderPagination() {
        const total = filteredGames.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        if (currentPage > totalPages) currentPage = totalPages;

        if (pageInfoEl) {
            pageInfoEl.textContent = `Page ${currentPage} of ${totalPages} (${total.toLocaleString()} games)`;
        }
        if (prevBtnEl) prevBtnEl.disabled = currentPage <= 1;
        if (nextBtnEl) nextBtnEl.disabled = currentPage >= totalPages;
    }

    function renderCurrentPage() {
        readyListEl?.querySelectorAll('button[data-action="play-ready"]')
            .forEach(btn => { btn.disabled = Boolean(activeDownload); });
        if (!listEl) return;

        const total = filteredGames.length;
        if (total === 0) {
            listEl.replaceChildren();
            if (emptyEl) emptyEl.hidden = false;
            return;
        }

        if (emptyEl) emptyEl.hidden = true;

        const startIdx = (currentPage - 1) * pageSize;
        const endIdx = Math.min(startIdx + pageSize, total);
        const pageItems = filteredGames.slice(startIdx, endIdx);

        const fragment = document.createDocumentFragment();

        for (const game of pageItems) {
            const tr = document.createElement('tr');
            tr.className = 'game-row';
            tr.dataset.id = game.id;

            const isDownloading = activeDownload && activeDownload.game.id === game.id;

            // Title column
            const tdTitle = document.createElement('td');
            tdTitle.className = 'game-title-col';
            const nameDiv = document.createElement('div');
            nameDiv.className = 'game-name';
            nameDiv.textContent = game.title;
            const fileDiv = document.createElement('div');
            fileDiv.className = 'game-filename';
            fileDiv.textContent = game.romName;
            tdTitle.append(nameDiv, fileDiv);

            // Region column
            const tdRegion = document.createElement('td');
            const badgeSpan = document.createElement('span');
            badgeSpan.className = `region-badge ${getRegionClass(game.region)}`;
            badgeSpan.textContent = `${getRegionFlag(game.region)} ${game.region}`;
            tdRegion.appendChild(badgeSpan);

            // Size column
            const tdSize = document.createElement('td');
            const sizeSpan = document.createElement('span');
            sizeSpan.className = 'size-badge';
            sizeSpan.textContent = game.sizeFormatted || formatBytes(game.size);
            tdSize.appendChild(sizeSpan);

            // Actions column
            const tdActions = document.createElement('td');
            tdActions.className = 'game-actions-col';

            if (!game.downloadOnly) {
                const playBtn = document.createElement('button');
                playBtn.type = 'button';
                playBtn.className = 'btn btn-primary btn-sm play-btn';
                playBtn.dataset.action = 'play';
                playBtn.dataset.id = game.id;
                playBtn.textContent = isDownloading ? '⏳ Loading...' : (game.extractBeforePlay ? '▶ Extract & Play' : '▶ Play');
                playBtn.disabled = Boolean(activeDownload && !isDownloading);
                playBtn.title = game.extractBeforePlay
                    ? 'Stream this RAR archive, extract its 3DS game, and load it into Azahar Web'
                    : 'Stream and play this game directly in Azahar Web';
                tdActions.appendChild(playBtn);
            }

            const downloadLink = document.createElement('a');
            downloadLink.href = game.downloadUrl;
            downloadLink.className = 'btn btn-secondary btn-sm icon-btn';
            downloadLink.target = '_blank';
            downloadLink.rel = 'noopener';
            downloadLink.download = game.romName;
            const fileExtension = String(game.romName || '').match(/\.([^.]+)$/)?.[1] || 'file';
            downloadLink.textContent = `⬇ .${fileExtension}`;
            downloadLink.title = `Open ${game.romName} on Internet Archive`;

            const archiveLink = document.createElement('a');
            archiveLink.href = game.viewArchiveUrl;
            archiveLink.className = 'btn btn-secondary btn-sm icon-btn';
            archiveLink.target = '_blank';
            archiveLink.rel = 'noopener';
            archiveLink.textContent = '📁 Archive';
            archiveLink.title = 'View zip contents on Internet Archive';

            tdActions.append(downloadLink, archiveLink);

            tr.append(tdTitle, tdRegion, tdSize, tdActions);
            fragment.appendChild(tr);
        }

        listEl.replaceChildren(fragment);
    }

    async function loadPlayableBytes(bytes, name) {
        if (downloadCardEl) downloadCardEl.hidden = true;
        activeDownload = null;
        renderCurrentPage();
        if (!window.AzaharUI?.loadRomBytes) {
            throw new Error('Azahar UI is not ready to accept ROM bytes.');
        }
        await window.AzaharUI.loadRomBytes(bytes, name, true);
        const canvas = window.AzaharUI.getCanvas ? window.AzaharUI.getCanvas() : document.getElementById('canvas');
        if (canvas) canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    async function streamRom(game) {
        if (activeDownload) {
            cancelDownload();
        }

        const controller = new AbortController();
        activeDownload = {
            controller,
            game,
            startTime: Date.now(),
            loadedBytes: 0,
            totalBytes: game.size || 0
        };

        // UI state
        if (downloadCardEl) downloadCardEl.hidden = false;
        if (downloadTitleEl) downloadTitleEl.textContent = `Streaming ${game.title}...`;
        if (downloadStatsEl) downloadStatsEl.textContent = `0% (0 / ${game.sizeFormatted || formatBytes(game.size)})`;
        if (downloadBarEl) downloadBarEl.style.width = '0%';
        if (downloadSpeedEl) downloadSpeedEl.textContent = 'Connecting to Internet Archive...';

        renderCurrentPage();

        if (window.AzaharUI) {
            window.AzaharUI.setStatus(`Downloading ${game.title}... 0%`);
            window.AzaharUI.showProgress(0);
        }

        // Try direct download URL first, fall back to server proxy if CORS or network fails
        const directUrl = game.downloadUrl;
        const proxyUrl = `/api/rom-proxy?url=${encodeURIComponent(directUrl)}`;
        const isRarArchive = /\.rar$/i.test(game.romName || '');

        let response = null;
        let usedProxy = false;
        try {
            const cachedPlayable = await readCachedPlayable(directUrl);
            if (cachedPlayable) {
                if (controller.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
                if (downloadTitleEl) downloadTitleEl.textContent = `Loading cached ${game.title}...`;
                if (downloadStatsEl) downloadStatsEl.textContent = `${formatBytes(cachedPlayable.bytes.length)} cached locally`;
                if (downloadBarEl) downloadBarEl.style.width = '100%';
                if (downloadSpeedEl) downloadSpeedEl.textContent = 'Using the local game cache; no download or extraction needed.';
                if (window.AzaharUI) {
                    window.AzaharUI.setStatus(`Loading cached ${game.title}...`);
                    window.AzaharUI.showProgress(100);
                }
                await loadPlayableBytes(cachedPlayable.bytes, cachedPlayable.name);
                return;
            }

            if (!response) {
                try {
                    response = await fetch(directUrl, {
                        signal: controller.signal,
                        headers: { 'Accept-Encoding': 'identity' }
                    });
                    if (!response.ok) {
                        throw new Error(`Direct download returned HTTP ${response.status}`);
                    }
                } catch (directErr) {
                    if (controller.signal.aborted) throw directErr;
                    console.warn('Direct fetch from archive.org failed, trying local proxy:', directErr.message);
                    if (downloadSpeedEl) downloadSpeedEl.textContent = 'Connecting via proxy...';
                    response = await fetch(proxyUrl, { signal: controller.signal });
                    if (!response.ok) {
                        throw new Error(`Proxy download returned HTTP ${response.status}`);
                    }
                    usedProxy = true;
                }
            }

            const contentLengthHeader = response.headers.get('content-length');
            const totalBytes = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : (game.size || 0);
            activeDownload.totalBytes = totalBytes;

            const reader = response.body.getReader();
            const chunks = [];
            let loadedBytes = 0;
            let lastUpdate = Date.now();
            let lastLoaded = 0;
            let speed = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                chunks.push(value);
                loadedBytes += value.length;
                activeDownload.loadedBytes = loadedBytes;

                const now = Date.now();
                if (now - lastUpdate >= 200) {
                    const elapsed = (now - lastUpdate) / 1000;
                    speed = (loadedBytes - lastLoaded) / elapsed;
                    lastUpdate = now;
                    lastLoaded = loadedBytes;

                    const percent = totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : 0;
                    const statsText = `${percent}% (${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)})`;

                    if (downloadBarEl) downloadBarEl.style.width = `${percent}%`;
                    if (downloadStatsEl) downloadStatsEl.textContent = statsText;

                    let speedText = formatSpeed(speed);
                    if (totalBytes > loadedBytes && speed > 0) {
                        const etaSec = Math.round((totalBytes - loadedBytes) / speed);
                        speedText += ` • ~${etaSec}s remaining`;
                    }
                    if (usedProxy) speedText += ' (proxy)';
                    if (downloadSpeedEl) downloadSpeedEl.textContent = speedText;

                    if (window.AzaharUI) {
                        window.AzaharUI.setStatus(`Downloading ${game.title}... ${statsText}`);
                        window.AzaharUI.showProgress(percent);
                    }
                }
            }

            // Combine chunks
            if (downloadSpeedEl) downloadSpeedEl.textContent = 'Preparing ROM for emulator...';
            if (window.AzaharUI) {
                window.AzaharUI.setStatus('Preparing ROM for emulator...');
                window.AzaharUI.showProgress(100);
            }

            const combined = new Uint8Array(loadedBytes);
            let offset = 0;
            for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }
            // eShop items are RAR archives containing a playable CIA. Extract
            // the game in a worker so decompression does not block the UI.
            let playableBytes = combined;
            let playableName = game.romName;
            if (isRarArchive) {
                if (downloadSpeedEl) downloadSpeedEl.textContent = 'Extracting game from RAR archive...';
                if (window.AzaharUI) window.AzaharUI.setStatus(`Extracting ${game.title}...`);
                const rarModule = window.AzaharRarReady || import('./vendor/rars/index.js');
                const { RarArchive } = await rarModule;
                if (downloadSpeedEl) downloadSpeedEl.textContent = 'Opening RAR archive...';
                const rarArchive = await RarArchive.open(combined);
                try {
                    if (downloadSpeedEl) downloadSpeedEl.textContent = 'Finding a playable game in the archive...';
                    const supportedEntry = rarArchive.entries.find(entry =>
                        !entry.isDirectory && /\.(?:cia|3ds|cci|cxi|app|3dsx|elf)$/i.test(entry.name)
                    );
                    if (!supportedEntry) {
                        throw new Error('This RAR archive does not contain a supported 3DS game file.');
                    }
                    if (downloadSpeedEl) downloadSpeedEl.textContent = `Extracting ${supportedEntry.name}...`;
                    playableBytes = await supportedEntry.bytes();
                    playableName = supportedEntry.name;
                } finally {
                    rarArchive.close();
                }
            }

            rememberPlayable(directUrl, playableBytes, playableName, game.title);

            if (controller.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');

            // Load into Azahar
            await loadPlayableBytes(playableBytes, playableName);

        } catch (err) {
            if (controller.signal.aborted) {
                if (window.AzaharUI) {
                    window.AzaharUI.setStatus('Download cancelled.', '');
                    window.AzaharUI.hideProgress();
                }
            } else {
                console.error('Failed to stream ROM:', err);
                if (window.AzaharUI) {
                    window.AzaharUI.setStatus(`Failed to stream ROM: ${err.message}`, 'error');
                    window.AzaharUI.hideProgress();
                }
                alert(`Could not stream game: ${err.message}\n\nYou can still download the original file from Internet Archive.`);
            }
            if (downloadCardEl) downloadCardEl.hidden = true;
            activeDownload = null;
            renderCurrentPage();
        }
    }

    function cancelDownload() {
        if (activeDownload && activeDownload.controller) {
            activeDownload.controller.abort();
            activeDownload = null;
        }
        if (downloadCardEl) downloadCardEl.hidden = true;
        renderCurrentPage();
    }

    async function loadCatalog(sourceId = currentSourceId) {
        const requestId = ++catalogRequestId;
        currentSourceId = LIBRARY_SOURCES[sourceId] ? sourceId : 'decrypted';
        const source = LIBRARY_SOURCES[currentSourceId];
        if (sourceSelectEl && sourceSelectEl.value !== currentSourceId) sourceSelectEl.value = currentSourceId;
        if (sourceLinkEl) {
            sourceLinkEl.href = source.baseUrl;
            sourceLinkEl.textContent = source.baseUrl;
        }
        if (listEl) listEl.replaceChildren();
        if (emptyEl) {
            emptyEl.textContent = 'Loading games from Internet Archive...';
            emptyEl.hidden = false;
        }
        if (countBadgeEl) countBadgeEl.textContent = 'Loading catalog...';

        try {
            const games = await loadSourceCatalog(currentSourceId);
            if (requestId !== catalogRequestId) return;
            allGames = games;

            if (countBadgeEl) {
                const noun = currentSourceId === 'decrypted' ? 'games' : 'files';
                countBadgeEl.textContent = `${allGames.length.toLocaleString()} ${noun} available`;
            }
            if (emptyEl) emptyEl.textContent = 'No matching files found.';

            applyFilterAndSort();
        } catch (err) {
            if (requestId !== catalogRequestId) return;
            console.error('Failed to load games library catalog:', err);
            if (countBadgeEl) countBadgeEl.textContent = 'Catalog error';
            if (emptyEl) {
                emptyEl.textContent = `Failed to load game library: ${err.message}.`;
                emptyEl.hidden = false;
            }
        }
    }

    function init() {
        containerEl = document.getElementById('library-section');
        countBadgeEl = document.getElementById('library-count-badge');
        sourceSelectEl = document.getElementById('library-source');
        sourceLinkEl = document.getElementById('library-source-link');
        searchInputEl = document.getElementById('library-search');
        searchClearEl = document.getElementById('library-search-clear');
        regionFiltersEl = document.getElementById('region-filters');
        sortSelectEl = document.getElementById('library-sort');
        listEl = document.getElementById('library-list');
        emptyEl = document.getElementById('library-empty');
        prevBtnEl = document.getElementById('library-prev-page');
        nextBtnEl = document.getElementById('library-next-page');
        pageInfoEl = document.getElementById('library-page-info');
        pageSizeEl = document.getElementById('library-page-size');
        downloadCardEl = document.getElementById('library-active-download');
        downloadTitleEl = document.getElementById('active-download-title');
        downloadStatsEl = document.getElementById('active-download-stats');
        downloadBarEl = document.getElementById('active-download-bar');
        downloadSpeedEl = document.getElementById('active-download-speed');
        downloadCancelEl = document.getElementById('active-download-cancel');
        readyCardEl = document.getElementById('library-ready');
        readyListEl = document.getElementById('library-ready-list');

        if (!containerEl) return;

        if (sourceSelectEl) {
            sourceSelectEl.addEventListener('change', () => {
                currentRegion = 'all';
                if (regionFiltersEl) {
                    regionFiltersEl.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
                    regionFiltersEl.querySelector('.filter-pill[data-region="all"]')?.classList.add('active');
                }
                void loadCatalog(sourceSelectEl.value);
            });
        }

        // Search input
        if (searchInputEl) {
            searchInputEl.addEventListener('keydown', e => {
                e.stopPropagation();
                if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;

                const value = searchInputEl.value;
                const start = searchInputEl.selectionStart ?? value.length;
                const end = searchInputEl.selectionEnd ?? value.length;
                let nextValue = value;
                let cursor = start;

                if (e.key.length === 1) {
                    nextValue = value.slice(0, start) + e.key + value.slice(end);
                    cursor = start + e.key.length;
                } else if (e.key === 'Backspace') {
                    if (start !== end) nextValue = value.slice(0, start) + value.slice(end);
                    else if (start > 0) {
                        nextValue = value.slice(0, start - 1) + value.slice(end);
                        cursor = start - 1;
                    } else return;
                } else if (e.key === 'Delete') {
                    if (start !== end) nextValue = value.slice(0, start) + value.slice(end);
                    else if (end < value.length) nextValue = value.slice(0, start) + value.slice(end + 1);
                    else return;
                } else {
                    return;
                }

                // Handle text keys here so they still work when the emulator's
                // keyboard capture prevents the browser from editing the field.
                e.preventDefault();
                searchInputEl.value = nextValue;
                searchInputEl.setSelectionRange(cursor, cursor);
                searchInputEl.dispatchEvent(new Event('input', { bubbles: true }));
            });
            searchInputEl.addEventListener('keyup', e => e.stopPropagation());
            searchInputEl.addEventListener('input', () => {
                searchQuery = searchInputEl.value;
                if (searchClearEl) searchClearEl.hidden = !searchQuery.trim();

                clearTimeout(searchDebounceTimer);
                searchDebounceTimer = null;
                // The catalog is small enough to filter synchronously. Updating
                // on each input event avoids a delay that feels like a dead field.
                applyFilterAndSort();
            });
        }

        // Search clear
        if (searchClearEl) {
            searchClearEl.addEventListener('click', () => {
                if (searchInputEl) {
                    clearTimeout(searchDebounceTimer);
                    searchDebounceTimer = null;
                    searchInputEl.value = '';
                    searchQuery = '';
                    searchClearEl.hidden = true;
                    applyFilterAndSort();
                    searchInputEl.focus();
                }
            });
        }

        // Region filters
        if (regionFiltersEl) {
            regionFiltersEl.addEventListener('click', event => {
                const btn = event.target instanceof Element ? event.target.closest('.filter-pill') : null;
                if (!btn) return;

                regionFiltersEl.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');

                currentRegion = btn.dataset.region || 'all';
                applyFilterAndSort();
            });
        }

        // Sort select
        if (sortSelectEl) {
            sortSelectEl.addEventListener('change', () => {
                sortMode = sortSelectEl.value;
                applyFilterAndSort();
            });
        }

        // Page size
        if (pageSizeEl) {
            pageSizeEl.addEventListener('change', () => {
                pageSize = Number.parseInt(pageSizeEl.value, 10) || 50;
                currentPage = 1;
                renderPagination();
                renderCurrentPage();
            });
        }

        // Prev page
        if (prevBtnEl) {
            prevBtnEl.addEventListener('click', () => {
                if (currentPage > 1) {
                    currentPage--;
                    renderPagination();
                    renderCurrentPage();
                    if (listEl) listEl.closest('.library-table-container').scrollTop = 0;
                }
            });
        }

        // Next page
        if (nextBtnEl) {
            nextBtnEl.addEventListener('click', () => {
                const totalPages = Math.ceil(filteredGames.length / pageSize);
                if (currentPage < totalPages) {
                    currentPage++;
                    renderPagination();
                    renderCurrentPage();
                    if (listEl) listEl.closest('.library-table-container').scrollTop = 0;
                }
            });
        }

        // Cancel download
        if (downloadCancelEl) {
            downloadCancelEl.addEventListener('click', cancelDownload);
        }

        // Table delegation for Play button
        if (listEl) {
            listEl.addEventListener('click', event => {
                const btn = event.target.closest('button[data-action="play"]');
                if (!btn || btn.disabled) return;

                const gameId = Number.parseInt(btn.dataset.id, 10);
                const game = allGames.find(g => g.id === gameId);
                if (game) {
                    void streamRom(game);
                }
            });
        }

        if (readyListEl) {
            readyListEl.addEventListener('click', event => {
                const btn = event.target.closest('button[data-action]');
                if (!btn || btn.disabled) return;
                const url = btn.dataset.url;
                if (btn.dataset.action === 'remove-ready') {
                    void forgetPlayable(url);
                    return;
                }
                const game = allGames.find(g => g.downloadUrl === url) || {
                    id: `ready:${url}`,
                    title: btn.closest('li')?.querySelector('.game-name')?.textContent || url,
                    romName: '',
                    downloadUrl: url,
                    size: 0
                };
                void streamRom(game);
            });
        }

        // Load catalog
        void loadCatalog();
        void renderReadyList();
    }

    // Export API
    window.AzaharLibrary = {
        init,
        loadCatalog,
        streamRom,
        cancelDownload,
        getAllGames: () => allGames,
        listReadyPlayables,
        getFilteredGames: () => filteredGames
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
