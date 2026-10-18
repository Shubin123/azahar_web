'use strict';
// Two browsers sharing save states through web/server.cjs: saves, overwrites
// and deletions reach the other browser, newer changes win, and the server
// refuses anything that is not a save state for the slot's title.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {listen} = require('../web/server.cjs');

const PROGRAM_ID = '0004000000055D00';

function cst(programId, fill) {
    const bytes = new Uint8Array(512).fill(fill);
    bytes.set([0x43, 0x53, 0x54, 0x1b]);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, Number.parseInt(programId.slice(8), 16), true);
    view.setUint32(8, Number.parseInt(programId.slice(0, 8), 16), true);
    return bytes;
}

// The IndexedDB-backed store's contract, in memory.
class MemoryStore {
    constructor() {
        this.live = new Map();
        this.deleted = new Map();
    }
    async list() { return [...this.live.values()]; }
    async listDeleted() { return [...this.deleted.values()]; }
    async get(key) { return this.live.get(key); }
    async put(record) {
        this.deleted.delete(record.key);
        this.live.set(record.key, record);
    }
    async delete(key, deletedAt = Date.now()) {
        const [programId, slot] = key.split(':');
        this.live.delete(key);
        this.deleted.set(key, {key, programId, slot: Number(slot), deletedAt});
    }
    save(slot, fill, savedAt) {
        const data = new Blob([cst(PROGRAM_ID, fill)]);
        return this.put({key: `${PROGRAM_ID}:${slot}`, programId: PROGRAM_ID, slot,
            romName: 'Game.3ds', savedAt, size: data.size, data});
    }
    async fill(slot) {
        const record = this.live.get(`${PROGRAM_ID}:${slot}`);
        return record ? new Uint8Array(await record.data.arrayBuffer())[300] : null;
    }
}

function loadSyncClass(origin) {
    const context = {
        window: {}, Blob, URL,
        fetch: (url, init) => fetch(new URL(url, origin), init),
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/azahar_savestates.js'), 'utf8'), context);
    return context.window.AzaharLanSaveSync;
}

(async () => {
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azahar-lan-saves-'));
    const server = await listen(0, '127.0.0.1', {saveDir});
    const plain = await listen(0, '127.0.0.1');
    try {
        const origin = `http://127.0.0.1:${server.address().port}/`;
        const LanSaveSync = loadSyncClass(origin);

        const unshared = loadSyncClass(`http://127.0.0.1:${plain.address().port}/`);
        assert.equal(await unshared.connect(new MemoryStore()), null,
            'A server without a save folder must leave saves browser-only');

        const storeA = new MemoryStore();
        const storeB = new MemoryStore();
        const a = await LanSaveSync.connect(storeA);
        const b = await LanSaveSync.connect(storeB);
        assert.ok(a && b);

        await storeA.save(1, 0x11, 1000);
        assert.deepEqual({...await a.sync()}, {uploaded: 1, downloaded: 0, deleted: 0});
        assert.ok(fs.existsSync(path.join(saveDir, `${PROGRAM_ID}.01.cst`)));
        assert.deepEqual({...await b.sync()}, {uploaded: 0, downloaded: 1, deleted: 0});
        assert.equal(await storeB.fill(1), 0x11);
        assert.equal((await storeB.get(`${PROGRAM_ID}:1`)).romName, 'Game.3ds');
        assert.deepEqual({...await b.sync()}, {uploaded: 0, downloaded: 0, deleted: 0},
            'An unchanged slot must not transfer again');

        // B overwrites; A's older copy is replaced rather than re-uploaded.
        await storeB.save(1, 0x22, 2000);
        await b.sync();
        assert.deepEqual({...await a.sync()}, {uploaded: 0, downloaded: 1, deleted: 0});
        assert.equal(await storeA.fill(1), 0x22);

        // A stale upload (offline browser with an older save) is refused.
        const stale = await fetch(`${origin}api/saves/${PROGRAM_ID}/1`, {method: 'PUT',
            headers: {'X-Saved-At': '1500'}, body: cst(PROGRAM_ID, 0x33)});
        assert.equal(stale.status, 409);

        // Deleting on A removes the slot from B on its next sync.
        await storeA.delete(`${PROGRAM_ID}:1`, 3000);
        assert.deepEqual({...await a.sync()}, {uploaded: 0, downloaded: 0, deleted: 1});
        assert.ok(!fs.existsSync(path.join(saveDir, `${PROGRAM_ID}.01.cst`)));
        assert.deepEqual({...await b.sync()}, {uploaded: 0, downloaded: 0, deleted: 1});
        assert.equal(await storeB.get(`${PROGRAM_ID}:1`), undefined);

        // An older deletion must not roll back the tombstone and allow an
        // offline save predating the latest deletion to resurrect the slot.
        const staleDelete = await fetch(`${origin}api/saves/${PROGRAM_ID}/1`, {
            method: 'DELETE', headers: {'X-Deleted-At': '2500'},
        });
        assert.equal(staleDelete.status, 409);
        const resurrect = await fetch(`${origin}api/saves/${PROGRAM_ID}/1`, {
            method: 'PUT', headers: {'X-Saved-At': '2800'}, body: cst(PROGRAM_ID, 0x33),
        });
        assert.equal(resurrect.status, 409);

        // Saving the slot again after the deletion brings it back everywhere.
        await storeB.save(1, 0x44, 4000);
        await b.sync();
        await a.sync();
        assert.equal(await storeA.fill(1), 0x44);

        // Concurrent callers share one pass.
        await storeA.save(2, 0x55, 5000);
        const [first, second] = await Promise.all([a.sync(), a.sync()]);
        assert.equal(first, second);
        assert.equal(first.uploaded, 1);

        const wrongTitle = await fetch(`${origin}api/saves/${PROGRAM_ID}/3`, {method: 'PUT',
            headers: {'X-Saved-At': '6000'}, body: cst('0004000000033500', 0x66)});
        assert.equal(wrongTitle.status, 400, 'A state for another title must be refused');
        const notState = await fetch(`${origin}api/saves/${PROGRAM_ID}/3`, {method: 'PUT',
            headers: {'X-Saved-At': '6000'}, body: new Uint8Array(512)});
        assert.equal(notState.status, 400);
        const traversal = await fetch(`${origin}api/saves/..%2F..%2Fetc/1`);
        assert.equal(traversal.status, 404);
        const staticPut = await fetch(`${origin}index.html`, {method: 'PUT', body: 'x'});
        assert.equal(staticPut.status, 405, 'Only the save API accepts writes');

        console.log('LAN save sync tests passed');
    } finally {
        server.close();
        plain.close();
        fs.rmSync(saveDir, {recursive: true, force: true});
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
