/** Durable, origin-local storage for Azahar's already-Zstandard-compressed CST files. */
(function () {
    'use strict';

    const DATABASE = 'azahar-web';
    const VERSION = 1;
    const STORE = 'saveStates';

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
            };
            request.onerror = () => reject(request.error || new Error('Unable to open save storage'));
            request.onsuccess = () => {
                request.result.onversionchange = () => request.result.close();
                resolve(request.result);
            };
        });
    }

    function completeTransaction(database, mode, operation) {
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE, mode);
            const store = transaction.objectStore(STORE);
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
            await completeTransaction(this.database, 'readwrite', store => store.put(record));
        }

        async delete(key) {
            await completeTransaction(this.database, 'readwrite', store => store.delete(key));
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

    window.AzaharSaveStateStore = SaveStateStore;
})();
