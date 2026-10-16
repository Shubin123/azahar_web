/** Durable storage for Azahar's already-Zstandard-compressed CST files, optionally shared over the LAN. */
(function () {
    'use strict';

    const DATABASE = 'azahar-web';
    const VERSION = 2;
    const STORE = 'saveStates';
    // When each slot was deleted, so LAN sync deletes it elsewhere instead
    // of copying it back from a browser that still has it.
    const DELETED_STORE = 'deletedStates';

    function openDatabase() {
        return new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                reject(new Error('IndexedDB is unavailable in this browser'));
                return;
            }
            const request = indexedDB.open(DATABASE, VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(STORE)) {
                    const store = database.createObjectStore(STORE, {keyPath: 'key'});
                    store.createIndex('programId', 'programId', {unique: false});
                    store.createIndex('savedAt', 'savedAt', {unique: false});
                }
                if (!database.objectStoreNames.contains(DELETED_STORE)) {
                    database.createObjectStore(DELETED_STORE, {keyPath: 'key'});
                }
            };
            request.onerror = () => reject(request.error || new Error('Unable to open save storage'));
            request.onsuccess = () => {
                request.result.onversionchange = () => request.result.close();
                resolve(request.result);
            };
        });
    }

    function completeTransaction(database, mode, operation, stores = STORE) {
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(stores, mode);
            const store = Array.isArray(stores) ? transaction : transaction.objectStore(stores);
            let result;
            try {
                result = operation(store);
            } catch (error) {
                reject(error);
                return;
            }
            transaction.oncomplete = () => resolve(result?.result);
            transaction.onerror = () => reject(transaction.error || new Error('Save storage transaction failed'));
            transaction.onabort = () => reject(transaction.error || new Error('Save storage transaction aborted'));
        });
    }

    class SaveStateStore {
        constructor(database) {
            this.database = database;
        }

        static async open() {
            return new SaveStateStore(await openDatabase());
        }

        async list() {
            const records = await completeTransaction(this.database, 'readonly', store => store.getAll());
            return (records || []).sort((a, b) => b.savedAt - a.savedAt);
        }

        async get(key) {
            return completeTransaction(this.database, 'readonly', store => store.get(key));
        }

        async put(record) {
            await completeTransaction(this.database, 'readwrite', transaction => {
                transaction.objectStore(DELETED_STORE).delete(record.key);
                transaction.objectStore(STORE).put(record);
            }, [STORE, DELETED_STORE]);
        }

        async delete(key, deletedAt = Date.now()) {
            const separator = key.lastIndexOf(':');
            const tombstone = {
                key,
                programId: key.slice(0, separator),
                slot: Number(key.slice(separator + 1)),
                deletedAt,
            };
            await completeTransaction(this.database, 'readwrite', transaction => {
                transaction.objectStore(STORE).delete(key);
                transaction.objectStore(DELETED_STORE).put(tombstone);
            }, [STORE, DELETED_STORE]);
        }

        async listDeleted() {
            return (await completeTransaction(this.database, 'readonly',
                store => store.getAll(), DELETED_STORE)) || [];
        }

        async persistence() {
            if (!navigator.storage) return {persistent: false, supported: false};
            let persistent = false;
            try {
                persistent = await navigator.storage.persisted();
            } catch (_) {}
            return {persistent, supported: typeof navigator.storage.persist === 'function'};
        }

        async requestPersistence() {
            if (!navigator.storage?.persist) return false;
            try {
                return await navigator.storage.persist();
            } catch (_) {
                return false;
            }
        }
    }

    /**
     * Two-way sync with the save folder of the server that served this page
     * (web/server.cjs), so every browser on the network sees the same slots.
     * The newest change to a slot wins, whether it is a save or a deletion.
     * Static hosts have no /api/saves, so there connect() returns null and
     * saves stay in this browser only.
     */
    class LanSaveSync {
        constructor(store, baseUrl) {
            this.store = store;
            this.baseUrl = baseUrl;
            this.running = null;
        }

        static async connect(store, baseUrl = 'api/saves') {
            try {
                const response = await fetch(baseUrl, {cache: 'no-store'});
                if (!response.ok) return null;
                const body = await response.json();
                return Array.isArray(body?.saves) ? new LanSaveSync(store, baseUrl) : null;
            } catch (_) {
                return null;
            }
        }

        slotUrl(programId, slot) {
            return `${this.baseUrl}/${encodeURIComponent(programId)}/${slot}`;
        }

        /** Resolves to {uploaded, downloaded, deleted} counts for this pass. */
        sync() {
            // Callers may overlap (timer, focus, a fresh save); share one pass.
            if (!this.running) {
                this.running = this.syncOnce().finally(() => { this.running = null; });
            }
            return this.running;
        }

        async syncOnce() {
            const response = await fetch(this.baseUrl, {cache: 'no-store'});
            if (!response.ok) throw new Error(`Save server answered ${response.status}`);
            const remote = new Map((await response.json()).saves.map(record => [record.key, record]));
            const local = new Map();
            for (const record of await this.store.listDeleted()) local.set(record.key, record);
            for (const record of await this.store.list()) local.set(record.key, record);

            const result = {uploaded: 0, downloaded: 0, deleted: 0};
            const changeTime = record => record.deletedAt ?? record.savedAt;
            for (const key of new Set([...local.keys(), ...remote.keys()])) {
                const mine = local.get(key);
                const theirs = remote.get(key);
                const mineDeleted = Boolean(mine && !mine.data);
                if (theirs && (!mine || changeTime(theirs) > changeTime(mine))) {
                    if (theirs.deleted) {
                        if (mine && !mineDeleted) {
                            await this.store.delete(key, theirs.deletedAt);
                            result.deleted++;
                        }
                    } else if (await this.download(theirs)) {
                        result.downloaded++;
                    }
                } else if (mine && (!theirs || changeTime(mine) > changeTime(theirs))) {
                    if (mineDeleted) {
                        if (theirs && !theirs.deleted && await this.remove(mine)) result.deleted++;
                    } else if (await this.upload(mine)) {
                        result.uploaded++;
                    }
                }
            }
            return result;
        }

        async upload(record) {
            const response = await fetch(this.slotUrl(record.programId, record.slot), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Saved-At': String(record.savedAt),
                    'X-Rom-Name': encodeURIComponent(record.romName || ''),
                },
                body: record.data,
            });
            // 409: another browser saved this slot more recently; the next
            // pass downloads that copy.
            if (response.status === 409) return false;
            if (!response.ok) throw new Error(`Uploading slot ${record.slot} failed (${response.status})`);
            return true;
        }

        async remove(tombstone) {
            const response = await fetch(this.slotUrl(tombstone.programId, tombstone.slot), {
                method: 'DELETE',
                headers: {'X-Deleted-At': String(tombstone.deletedAt)},
            });
            if (response.status === 409) return false;
            if (!response.ok) throw new Error(`Deleting slot ${tombstone.slot} failed (${response.status})`);
            return true;
        }

        async download(meta) {
            const response = await fetch(this.slotUrl(meta.programId, meta.slot), {cache: 'no-store'});
            // Deleted or replaced since the listing; the next pass catches up.
            if (response.status === 404) return false;
            if (!response.ok) throw new Error(`Downloading slot ${meta.slot} failed (${response.status})`);
            const data = await response.blob();
            await this.store.put({
                key: meta.key,
                programId: meta.programId,
                slot: meta.slot,
                romName: meta.romName,
                savedAt: Number(response.headers.get('X-Saved-At')) || meta.savedAt,
                size: data.size,
                data: new Blob([data], {type: 'application/octet-stream'}),
            });
            return true;
        }
    }

    window.AzaharSaveStateStore = SaveStateStore;
    window.AzaharLanSaveSync = LanSaveSync;
})();
