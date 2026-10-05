/**
 * Lazy ROM files for the Emscripten filesystem (web/azahar_romfs.js).
 *
 * Retail images reach 2-4 GiB. Copying one into MEMFS needs a single
 * ArrayBuffer of that size on top of the emulator heap, which Chrome refuses
 * ("Array buffer allocation failed") or which gets the tab killed. Picked
 * files and CacheStorage blobs are disk-backed, so this module mounts the
 * Blob itself as a read-only MEMFS node and reads byte ranges on demand.
 *
 * The emulator reads files synchronously on the browser main thread, where
 * Blob reads are asynchronous. A small dedicated worker performs the reads
 * and hands the bytes back through a SharedArrayBuffer; the main thread spins
 * on an atomic flag meanwhile (Atomics.wait is not allowed there). Recently
 * read 1 MiB blocks are kept in a small LRU cache so the many small
 * header/table reads do not each round-trip to the worker.
 *
 * The worker reads the Blob directly with FileReaderSync where it can. WebKit
 * (Safari on macOS, every browser on iOS) services a worker's Blob reads on
 * the main thread, so those reads never finish while it spins. mount()
 * therefore checks that one read completes; if it does not, the worker copies
 * the file into the Origin Private File System before the game starts and
 * reads it with a FileSystemSyncAccessHandle, which does not need the main
 * thread.
 *
 * Usage: await AzaharRomFS.mount(Module.FS, '/rom.3ds', fileOrBlob);
 */
(function () {
    'use strict';

    const BLOCK_BYTES = 1 << 20;
    // Blocks fetched per cache miss; sequential reads are the common case.
    const READ_AHEAD_BLOCKS = 4;
    const CACHE_BLOCKS = 64;
    // Largest single worker transfer. Reads at least this large bypass the
    // block cache and are copied straight into the destination buffer.
    const TRANSFER_BYTES = 8 * BLOCK_BYTES;

    // Control words: [0] state (0 idle, 1 requested, 2 done), [1] length
    // requested / returned, [2] error flag. The offset lives in a Float64Array
    // because images larger than 2 GiB exceed Int32 range.
    const WORKER_SOURCE = `
        'use strict';
        const STAGE_CHUNK = 16 << 20;
        onmessage = async (event) => {
            const { mode, blob, control, offsetBox, data, directory, name } = event.data;
            const bytes = new Uint8Array(data);
            let readAt;
            if (mode === 'staged') {
                // Copy the Blob into a private file; reads then come from disk
                // without the main thread's help.
                let handle;
                try {
                    const root = await navigator.storage.getDirectory();
                    const dir = await root.getDirectoryHandle(directory, { create: true });
                    const file = await dir.getFileHandle(name, { create: true });
                    handle = await file.createSyncAccessHandle();
                    handle.truncate(0);
                    for (let offset = 0; offset < blob.size; offset += STAGE_CHUNK) {
                        const chunk = await blob.slice(offset, offset + STAGE_CHUNK).arrayBuffer();
                        if (handle.write(new Uint8Array(chunk), { at: offset }) !== chunk.byteLength) {
                            throw new Error('short write');
                        }
                        postMessage({ progress: Math.min(1, (offset + chunk.byteLength) / blob.size) });
                    }
                    handle.flush();
                } catch (error) {
                    try { handle?.close(); } catch (_) {}
                    postMessage({ error: String(error && error.message || error) });
                    return;
                }
                readAt = (start, end) => handle.read(bytes.subarray(0, end - start), { at: start });
            } else {
                const reader = new FileReaderSync();
                readAt = (start, end) => {
                    const chunk = new Uint8Array(reader.readAsArrayBuffer(blob.slice(start, end)));
                    bytes.set(chunk);
                    return chunk.length;
                };
            }
            postMessage({ ready: true });
            for (;;) {
                Atomics.wait(control, 0, 0);
                if (Atomics.load(control, 0) !== 1) continue;
                try {
                    const start = offsetBox[0];
                    const end = Math.min(blob.size, start + control[1]);
                    control[1] = readAt(start, end);
                    control[2] = 0;
                } catch (error) {
                    control[1] = 0;
                    control[2] = 1;
                }
                Atomics.store(control, 0, 2);
            }
        };
    `;

    // Where WebKit's copy of the mounted file lives: one file, replaced on
    // every mount and removed on unmount, so copies never accumulate.
    const STAGING_DIRECTORY = 'staging';
    const STAGING_NAME = 'mounted.rom';
    // How long the main thread waits for the probe read before deciding that
    // a worker cannot read Blobs while it spins. Reading 64 KiB directly takes
    // well under a millisecond in Chrome.
    const PROBE_TIMEOUT_MS = 500;

    let workerUrl = null;

    // Starts a reader worker in `mode` ('direct' or 'staged') and resolves once
    // it serves reads, to { worker, staged, readRange, probe }.
    function startReader(blob, mode, onProgress) {
        if (typeof SharedArrayBuffer === 'undefined') {
            return Promise.reject(new Error('Lazy ROM loading needs a cross-origin isolated page.'));
        }
        workerUrl ||= URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        const worker = new Worker(workerUrl, { name: 'azahar-rom-reader' });
        const control = new Int32Array(new SharedArrayBuffer(3 * 4));
        const offsetBox = new Float64Array(new SharedArrayBuffer(8));
        const data = new SharedArrayBuffer(TRANSFER_BYTES);
        const view = new Uint8Array(data);

        // Returns a view of the shared buffer valid until the next call, or
        // null when `timeoutMs` passes without a reply.
        function request(offset, length, timeoutMs = Infinity) {
            offsetBox[0] = offset;
            control[1] = length;
            Atomics.store(control, 0, 1);
            Atomics.notify(control, 0);
            const deadline = performance.now() + timeoutMs;
            while (Atomics.load(control, 0) !== 2) {
                // Spin: the main thread may not block on Atomics.wait.
                if (timeoutMs !== Infinity && performance.now() > deadline) return null;
            }
            const failed = control[2] !== 0;
            const received = control[1];
            Atomics.store(control, 0, 0);
            if (failed) throw new Error(`ROM read failed at byte ${offset}`);
            return view.subarray(0, received);
        }

        return new Promise((resolve, reject) => {
            worker.onmessage = event => {
                const message = event.data;
                if (message.progress !== undefined) {
                    onProgress?.(message.progress);
                } else if (message.error) {
                    worker.terminate();
                    reject(new Error(`Could not copy the ROM into browser storage: ${message.error}`));
                } else if (message.ready) {
                    resolve({
                        worker,
                        staged: mode === 'staged',
                        readRange: (offset, length) => request(offset, length),
                        probe: () => request(0, Math.min(blob.size, 64 << 10), PROBE_TIMEOUT_MS),
                    });
                }
            };
            worker.onerror = event => reject(new Error(event.message || 'ROM reader worker failed'));
            worker.postMessage({ mode, blob, control, offsetBox, data,
                                 directory: STAGING_DIRECTORY, name: STAGING_NAME });
        });
    }

    // Reads the Blob directly when a worker can do so while the main thread
    // waits; otherwise (WebKit) serves reads from a staged copy.
    async function openReader(blob, onProgress) {
        const direct = await startReader(blob, 'direct');
        if (blob.size === 0 || direct.probe() !== null) return direct;
        // The probe read is still pending; discard the worker and its buffers.
        direct.worker.terminate();
        if (!navigator.storage?.getDirectory) {
            throw new Error('This browser cannot read the ROM file while the game runs.');
        }
        // Removing the previous title's copy must finish before this one is
        // created under the same name.
        await stagedCopyRemoval;
        return startReader(blob, 'staged', onProgress);
    }

    function createBlockCache(size, readRange) {
        const blocks = new Map();

        function block(index) {
            const cached = blocks.get(index);
            if (cached) {
                // Refresh LRU position.
                blocks.delete(index);
                blocks.set(index, cached);
                return cached;
            }
            const start = index * BLOCK_BYTES;
            const length = Math.min(READ_AHEAD_BLOCKS * BLOCK_BYTES, size - start);
            const bytes = readRange(start, length);
            let first = null;
            for (let offset = 0; offset < bytes.length; offset += BLOCK_BYTES) {
                const copy = bytes.slice(offset, Math.min(bytes.length, offset + BLOCK_BYTES));
                const blockIndex = index + offset / BLOCK_BYTES;
                blocks.delete(blockIndex);
                blocks.set(blockIndex, copy);
                first ||= copy;
            }
            while (blocks.size > CACHE_BLOCKS) {
                blocks.delete(blocks.keys().next().value);
            }
            return first;
        }

        // Copies [position, position + length) into target[targetOffset...].
        function read(target, targetOffset, length, position) {
            length = Math.max(0, Math.min(length, size - position));
            if (length >= TRANSFER_BYTES) {
                for (let done = 0; done < length;) {
                    const bytes = readRange(position + done, Math.min(TRANSFER_BYTES, length - done));
                    if (!bytes.length) break;
                    target.set(bytes, targetOffset + done);
                    done += bytes.length;
                }
                return length;
            }
            for (let done = 0; done < length;) {
                const absolute = position + done;
                const index = Math.floor(absolute / BLOCK_BYTES);
                const within = absolute - index * BLOCK_BYTES;
                const bytes = block(index);
                const count = Math.min(bytes.length - within, length - done);
                target.set(bytes.subarray(within, within + count), targetOffset + done);
                done += count;
            }
            return length;
        }

        return {
            get length() { return size; },
            get(index) {
                if (index < 0 || index >= size) return undefined;
                return block(Math.floor(index / BLOCK_BYTES))[index % BLOCK_BYTES];
            },
            read,
        };
    }

    const mounted = new Map();

    // options.onProgress(fraction) reports the copy when the file has to be
    // staged in browser storage first (WebKit).
    async function mount(FS, path, blob, options = {}) {
        unmount(FS, path);
        const reader = await openReader(blob, options.onProgress);
        const contents = createBlockCache(blob.size, reader.readRange);

        const slash = path.lastIndexOf('/');
        const parent = path.slice(0, slash) || '/';
        const name = path.slice(slash + 1);
        FS.mkdirTree?.(parent);
        const node = FS.createFile(parent, name, { isDevice: false, contents }, true, false);
        node.contents = contents;
        Object.defineProperty(node, 'usedBytes', { get() { return this.contents.length; } });

        const stream_ops = { ...node.stream_ops };
        stream_ops.read = (stream, buffer, offset, length, position) =>
            stream.node.contents.read(buffer, offset, length, position);
        stream_ops.write = () => { throw new FS.ErrnoError(29); };
        stream_ops.mmap = () => { throw new FS.ErrnoError(29); };
        node.stream_ops = stream_ops;

        mounted.set(path, reader);
        return node;
    }

    function unmount(FS, path) {
        const reader = mounted.get(path);
        if (reader) {
            reader.worker.terminate();
            mounted.delete(path);
            if (reader.staged) stagedCopyRemoval = removeStagedCopy();
        }
        try { FS.unlink(path); } catch (_) { /* not present */ }
    }

    let stagedCopyRemoval = Promise.resolve();

    async function removeStagedCopy() {
        try {
            const root = await navigator.storage.getDirectory();
            const directory = await root.getDirectoryHandle(STAGING_DIRECTORY);
            await directory.removeEntry(STAGING_NAME);
        } catch (_) { /* already gone, or still held by the closing worker */ }
    }

    // ── Disk-backed storage for downloaded titles ─────────────────────
    // Chrome cannot hold a multi-GiB download as one ArrayBuffer, and large
    // Blobs built in memory hit blob-storage quotas. The Origin Private File
    // System writes straight to disk under the site's storage quota and
    // returns a disk-backed File, which mount() reads lazily. Entries are
    // `<key>.rom` plus `<key>.json` metadata; an entry without metadata is an
    // interrupted download and is not listed.
    const STORE_DIRECTORY = 'playables';

    function storeAvailable() {
        return Boolean(navigator.storage?.getDirectory);
    }

    async function storeDirectory() {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(STORE_DIRECTORY, { create: true });
    }

    // Opens `<key>.rom` for writing. write(chunk) accepts Uint8Array/Blob;
    // close() resolves to the finished File; abort() discards it.
    async function createStoreWriter(key) {
        const directory = await storeDirectory();
        const handle = await directory.getFileHandle(`${key}.rom`, { create: true });
        const writable = await handle.createWritable();
        return {
            write: chunk => writable.write(chunk),
            async close() {
                await writable.close();
                return handle.getFile();
            },
            async abort() {
                await writable.abort().catch(() => {});
                await directory.removeEntry(`${key}.rom`).catch(() => {});
            },
        };
    }

    // Stores a Blob or Uint8Array under `key` and returns the stored File.
    async function storeData(key, data) {
        const writer = await createStoreWriter(key);
        try {
            await writer.write(data);
            return await writer.close();
        } catch (error) {
            await writer.abort();
            throw error;
        }
    }

    async function storeWriteMeta(key, meta) {
        const directory = await storeDirectory();
        const handle = await directory.getFileHandle(`${key}.json`, { create: true });
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(meta));
        await writable.close();
    }

    // Resolves to { file, meta } for a complete entry, otherwise null.
    async function storeRead(key) {
        try {
            const directory = await storeDirectory();
            const meta = JSON.parse(await (await (await directory.getFileHandle(`${key}.json`)).getFile()).text());
            const file = await (await directory.getFileHandle(`${key}.rom`)).getFile();
            return { file, meta };
        } catch (_) {
            return null;
        }
    }

    async function storeList() {
        const entries = [];
        const directory = await storeDirectory();
        for await (const [name] of directory.entries()) {
            if (!name.endsWith('.json')) continue;
            const entry = await storeRead(name.slice(0, -'.json'.length));
            if (entry) entries.push({ ...entry.meta, size: entry.file.size });
        }
        return entries;
    }

    async function storeRemove(key) {
        const directory = await storeDirectory();
        await directory.removeEntry(`${key}.json`).catch(() => {});
        await directory.removeEntry(`${key}.rom`).catch(() => {});
    }

    const store = {
        available: storeAvailable,
        createWriter: createStoreWriter,
        write: storeData,
        writeMeta: storeWriteMeta,
        read: storeRead,
        list: storeList,
        remove: storeRemove,
    };

    // Byte length of a ROM source, which may be a Blob/File or a Uint8Array.
    function sizeOf(data) {
        return data ? (typeof data.size === 'number' ? data.size : data.length) : 0;
    }

    // True when the file at `path` is served from a staged copy (WebKit).
    function isStaged(path) {
        return Boolean(mounted.get(path)?.staged);
    }

    window.AzaharRomFS = { mount, unmount, isStaged, store, sizeOf };
})();
