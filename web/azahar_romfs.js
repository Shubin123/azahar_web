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
 * with FileReaderSync and hands the bytes back through a SharedArrayBuffer;
 * the main thread spins on an atomic flag meanwhile (Atomics.wait is not
 * allowed there). Recently read 1 MiB blocks are kept in a small LRU cache so
 * the many small header/table reads do not each round-trip to the worker.
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
        onmessage = (event) => {
            const { blob, control, offsetBox, data } = event.data;
            const bytes = new Uint8Array(data);
            const reader = new FileReaderSync();
            postMessage('ready');
            for (;;) {
                Atomics.wait(control, 0, 0);
                if (Atomics.load(control, 0) !== 1) continue;
                try {
                    const start = offsetBox[0];
                    const end = Math.min(blob.size, start + control[1]);
                    const chunk = new Uint8Array(reader.readAsArrayBuffer(blob.slice(start, end)));
                    bytes.set(chunk);
                    control[1] = chunk.length;
                    control[2] = 0;
                } catch (error) {
                    control[1] = 0;
                    control[2] = 1;
                }
                Atomics.store(control, 0, 2);
            }
        };
    `;

    let workerUrl = null;

    function startReader(blob) {
        if (typeof SharedArrayBuffer === 'undefined') {
            return Promise.reject(new Error('Lazy ROM loading needs a cross-origin isolated page.'));
        }
        workerUrl ||= URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        const worker = new Worker(workerUrl, { name: 'azahar-rom-reader' });
        const control = new Int32Array(new SharedArrayBuffer(3 * 4));
        const offsetBox = new Float64Array(new SharedArrayBuffer(8));
        const data = new SharedArrayBuffer(TRANSFER_BYTES);
        const view = new Uint8Array(data);

        // Returns a view of the shared buffer valid until the next call.
        function readRange(offset, length) {
            offsetBox[0] = offset;
            control[1] = length;
            Atomics.store(control, 0, 1);
            Atomics.notify(control, 0);
            while (Atomics.load(control, 0) !== 2) {
                // Spin: the main thread may not block on Atomics.wait.
            }
            const failed = control[2] !== 0;
            const received = control[1];
            Atomics.store(control, 0, 0);
            if (failed) throw new Error(`ROM read failed at byte ${offset}`);
            return view.subarray(0, received);
        }

        return new Promise((resolve, reject) => {
            worker.onmessage = () => resolve({ worker, readRange });
            worker.onerror = event => reject(new Error(event.message || 'ROM reader worker failed'));
            worker.postMessage({ blob, control, offsetBox, data });
        });
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

    async function mount(FS, path, blob) {
        unmount(FS, path);
        const reader = await startReader(blob);
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
        }
        try { FS.unlink(path); } catch (_) { /* not present */ }
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

    window.AzaharRomFS = { mount, unmount, store, sizeOf };
})();
