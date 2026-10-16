'use strict';

// Shared save-state store for every browser that opens the page from this
// server. Each slot is kept as the CST file Azahar wrote plus a small JSON
// record; a deleted slot keeps only its record (a tombstone) so a browser
// that still holds the old copy deletes it instead of uploading it again.
// Browsers decide what to send or fetch by comparing `savedAt` (see
// LanSaveSync in azahar_savestates.js); the server only refuses writes that
// are older than what it already has.
const fs = require('node:fs');
const path = require('node:path');

const SLOT_PATH = /^\/api\/saves\/([0-9A-F]{16})\/([1-9][0-9]?)$/;
const MAX_STATE_BYTES = 512 * 1024 * 1024;
const MIN_STATE_BYTES = 256;
const MAX_ROM_NAME = 512;

function slotFiles(directory, programId, slot) {
    const base = path.join(directory, `${programId}.${String(slot).padStart(2, '0')}`);
    return {state: `${base}.cst`, record: `${base}.json`};
}

function cstProgramId(bytes) {
    if (bytes.length < MIN_STATE_BYTES || bytes[0] !== 0x43 || bytes[1] !== 0x53 ||
        bytes[2] !== 0x54 || bytes[3] !== 0x1b) {
        return null;
    }
    const low = bytes.readUInt32LE(4);
    const high = bytes.readUInt32LE(8);
    return (high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0')).toUpperCase();
}

function parseTime(value) {
    const time = Number(value);
    return Number.isSafeInteger(time) && time > 0 ? time : null;
}

async function writeAtomic(file, data) {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temporary, data);
    await fs.promises.rename(temporary, file);
}

function readBody(request, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error('Save state is too large'), {status: 413}));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

function createLanSaveStore(directory) {
    const root = path.resolve(directory);
    // Writes to one slot are serialised so two browsers saving at once
    // cannot interleave the state file and its record.
    const pending = new Map();

    function exclusive(key, task) {
        const previous = pending.get(key) || Promise.resolve();
        const next = previous.catch(() => {}).then(task);
        pending.set(key, next);
        next.finally(() => {
            if (pending.get(key) === next) pending.delete(key);
        }).catch(() => {});
        return next;
    }

    async function readRecord(file) {
        try {
            return JSON.parse(await fs.promises.readFile(file, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }

    async function list() {
        let names;
        try {
            names = await fs.promises.readdir(root);
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
        const records = [];
        for (const name of names) {
            if (!/^[0-9A-F]{16}\.\d{2}\.json$/.test(name)) continue;
            const record = await readRecord(path.join(root, name)).catch(() => null);
            if (record) records.push(record);
        }
        return records;
    }

    function send(response, status, headers, body) {
        response.writeHead(status, headers);
        response.end(body);
    }

    function sendJson(response, status, headers, value) {
        send(response, status, {
            ...headers,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        }, JSON.stringify(value));
    }

    async function handle(request, response, pathname, headers) {
        if (pathname === '/api/saves' || pathname === '/api/saves/') {
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                send(response, 405, {...headers, Allow: 'GET, HEAD'});
                return;
            }
            sendJson(response, 200, headers, {version: 1, saves: await list()});
            return;
        }

        const match = SLOT_PATH.exec(pathname);
        if (!match) {
            sendJson(response, 404, headers, {error: 'Unknown save slot'});
            return;
        }
        const programId = match[1];
        const slot = Number(match[2]);
        const key = `${programId}:${slot}`;
        const files = slotFiles(root, programId, slot);

        if (request.method === 'GET' || request.method === 'HEAD') {
            const record = await readRecord(files.record);
            if (!record || record.deleted) {
                sendJson(response, 404, headers, {error: 'No save in this slot'});
                return;
            }
            const stat = await fs.promises.stat(files.state);
            response.writeHead(200, {
                ...headers,
                'Content-Type': 'application/octet-stream',
                'Content-Length': stat.size,
                'Cache-Control': 'no-store',
                'X-Saved-At': String(record.savedAt),
            });
            if (request.method === 'HEAD') {
                response.end();
            } else {
                fs.createReadStream(files.state).pipe(response);
            }
            return;
        }

        if (request.method === 'PUT') {
            const savedAt = parseTime(request.headers['x-saved-at']);
            if (!savedAt) {
                sendJson(response, 400, headers, {error: 'Missing X-Saved-At'});
                return;
            }
            let romName = '';
            try {
                romName = decodeURIComponent(request.headers['x-rom-name'] || '').slice(0, MAX_ROM_NAME);
            } catch (_) {}
            const bytes = await readBody(request, MAX_STATE_BYTES);
            if (cstProgramId(bytes) !== programId) {
                sendJson(response, 400, headers, {error: 'Body is not a save state for this title'});
                return;
            }
            await exclusive(key, async () => {
                const current = await readRecord(files.record);
                const currentTime = current && (current.deleted ? current.deletedAt : current.savedAt);
                if (currentTime && currentTime > savedAt) {
                    sendJson(response, 409, headers, {error: 'A newer save exists', current});
                    return;
                }
                const record = {key, programId, slot, romName, savedAt, size: bytes.length};
                await fs.promises.mkdir(root, {recursive: true});
                await writeAtomic(files.state, bytes);
                await writeAtomic(files.record, JSON.stringify(record));
                sendJson(response, 200, headers, record);
            });
            return;
        }

        if (request.method === 'DELETE') {
            const deletedAt = parseTime(request.headers['x-deleted-at']);
            if (!deletedAt) {
                sendJson(response, 400, headers, {error: 'Missing X-Deleted-At'});
                return;
            }
            await exclusive(key, async () => {
                const current = await readRecord(files.record);
                if (current && !current.deleted && current.savedAt > deletedAt) {
                    sendJson(response, 409, headers, {error: 'A newer save exists', current});
                    return;
                }
                const record = {key, programId, slot, deleted: true, deletedAt};
                await fs.promises.mkdir(root, {recursive: true});
                await writeAtomic(files.record, JSON.stringify(record));
                await fs.promises.unlink(files.state).catch(() => {});
                sendJson(response, 200, headers, record);
            });
            return;
        }

        send(response, 405, {...headers, Allow: 'GET, HEAD, PUT, DELETE'});
    }

    return {
        directory: root,
        handle(request, response, pathname, headers) {
            handle(request, response, pathname, headers).catch(error => {
                if (response.headersSent) {
                    response.destroy(error);
                    return;
                }
                sendJson(response, error.status || 500, headers, {error: error.message});
            });
        },
    };
}

module.exports = {createLanSaveStore};
