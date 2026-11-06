// Local Play between consoles on one device (split.html). Every console runs
// in its own frame of one page, and they talk through one SharedArrayBuffer
// instead of a network: a single-producer, single-consumer ring for each
// ordered pair of consoles carries their 802.11 frames and Local Play control
// messages, and a slot per console publishes its emulation timing so the page
// can split each display refresh between the consoles.
//
// Layout (all offsets in bytes):
//   0     Int32 header: magic, version, seats, ring capacity
//   64    MAX_SEATS slots of SLOT_DOUBLES Float64 (see SLOT below)
//   RINGS (seats * (seats - 1)) rings, each RING_HEADER bytes of Int32
//         [written, read, dropped, 0] followed by `capacity` data bytes
// A message is a u32 word (payload length << 8 | kind) and the payload, padded
// to 4 bytes. Positions are free-running u32 byte counters; the capacity is a
// power of two, so a message header never wraps but a payload may.
(function () {
    'use strict';

    const MAGIC = 0x4C535A41; // "AZSL"
    const VERSION = 1;
    const MAX_SEATS = 4;
    const SLOT_DOUBLES = 16;
    const SLOTS_OFFSET = 64;
    const RINGS_OFFSET = SLOTS_OFFSET + MAX_SEATS * SLOT_DOUBLES * 8;
    const RING_HEADER = 16;
    // About a second of a busy local wireless session; a ring only fills when
    // its reader has stopped, and then frames are dropped as a network would.
    const RING_BYTES = 1 << 18;
    const KIND_FRAME = 1;
    const KIND_CONTROL = 2;
    // Per-console timing, written by that console and read by the page.
    const SLOT = {
        heartbeat: 0,   // wall-clock ms (timeOrigin-based) of the last emulation callback
        stepMs: 1,      // emulation time per callback, smoothed
        frameMs: 2,     // refresh span one callback may fill, all consoles together
        saturated: 3,   // share of callbacks that used their whole budget, smoothed
        share: 4,       // fraction of `frameMs` this console may use (written by the page)
    };

    // Comparable between frames: each document has its own performance.now() origin.
    const wallNow = () => performance.timeOrigin + performance.now();

    function ringIndex(from, to, seats) {
        return from * (seats - 1) + (to < from ? to : to - 1);
    }

    function create(seats, capacity = RING_BYTES) {
        if (!(seats >= 2 && seats <= MAX_SEATS)) throw new RangeError(`2-${MAX_SEATS} consoles`);
        if (capacity & (capacity - 1)) throw new RangeError('ring capacity must be a power of two');
        const buffer = new SharedArrayBuffer(RINGS_OFFSET + seats * (seats - 1) * (RING_HEADER + capacity));
        const header = new Int32Array(buffer, 0, 4);
        header.set([MAGIC, VERSION, seats, capacity]);
        const slots = new Float64Array(buffer, SLOTS_OFFSET, MAX_SEATS * SLOT_DOUBLES);
        for (let seat = 0; seat < seats; seat++) slots[seat * SLOT_DOUBLES + SLOT.share] = 1 / seats;
        return buffer;
    }

    // One console's end of the link: its outbound rings to every other console
    // and its inbound rings from them.
    class Endpoint {
        constructor(buffer, seat) {
            const header = new Int32Array(buffer, 0, 4);
            if (header[0] !== MAGIC || header[1] !== VERSION) throw new Error('Not a Local Play shared link.');
            this.buffer = buffer;
            this.seats = header[2];
            this.capacity = header[3];
            if (!(seat >= 0 && seat < this.seats)) throw new RangeError(`no console ${seat}`);
            this.seat = seat;
            this.mask = this.capacity - 1;
            this.slots = new Float64Array(buffer, SLOTS_OFFSET, MAX_SEATS * SLOT_DOUBLES);
            const ring = index => {
                const offset = RINGS_OFFSET + index * (RING_HEADER + this.capacity);
                return {
                    control: new Int32Array(buffer, offset, 4),
                    bytes: new Uint8Array(buffer, offset + RING_HEADER, this.capacity),
                    words: new Int32Array(buffer, offset + RING_HEADER, this.capacity >> 2),
                };
            };
            this.outbound = [];
            this.inbound = [];
            for (let other = 0; other < this.seats; other++) {
                if (other === seat) continue;
                this.outbound.push({to: other, ...ring(ringIndex(seat, other, this.seats))});
                this.inbound.push({from: other, ...ring(ringIndex(other, seat, this.seats))});
            }
        }

        // Queues one message for console `to`, or for every other console.
        // Returns how many consoles it was queued for.
        send(kind, bytes, to = -1) {
            const length = bytes.length;
            const need = 4 + ((length + 3) & ~3);
            let queued = 0;
            for (const ring of this.outbound) {
                if (to >= 0 && ring.to !== to) continue;
                const written = Atomics.load(ring.control, 0) >>> 0;
                const read = Atomics.load(ring.control, 1) >>> 0;
                if (this.capacity - ((written - read) >>> 0) < need) {
                    Atomics.add(ring.control, 2, 1);
                    continue;
                }
                const at = written & this.mask;
                ring.words[at >> 2] = (length << 8) | kind;
                const start = (at + 4) & this.mask;
                const first = Math.min(length, this.capacity - start);
                ring.bytes.set(first === length ? bytes : bytes.subarray(0, first), start);
                if (first < length) ring.bytes.set(bytes.subarray(first), 0);
                // Publish only after the payload is in place.
                Atomics.store(ring.control, 0, (written + need) | 0);
                queued++;
            }
            return queued;
        }

        // Hands every waiting message to handler(kind, bytes, fromSeat). `bytes`
        // may alias the ring and is valid only during the call.
        receive(handler) {
            let count = 0;
            for (const ring of this.inbound) {
                const written = Atomics.load(ring.control, 0) >>> 0;
                let read = Atomics.load(ring.control, 1) >>> 0;
                while (read !== written) {
                    const at = read & this.mask;
                    const word = ring.words[at >> 2];
                    const length = word >>> 8;
                    const start = (at + 4) & this.mask;
                    let bytes;
                    if (start + length <= this.capacity) {
                        bytes = ring.bytes.subarray(start, start + length);
                    } else {
                        const first = this.capacity - start;
                        bytes = new Uint8Array(length);
                        bytes.set(ring.bytes.subarray(start));
                        bytes.set(ring.bytes.subarray(0, length - first), first);
                    }
                    read = (read + 4 + ((length + 3) & ~3)) >>> 0;
                    try {
                        handler(word & 0xFF, bytes, ring.from);
                    } finally {
                        // Free the space only once the handler is done with it.
                        Atomics.store(ring.control, 1, read | 0);
                    }
                    count++;
                }
            }
            return count;
        }

        // Messages dropped because a console stopped reading (all outbound rings).
        dropped() {
            return this.outbound.reduce((sum, ring) => sum + Atomics.load(ring.control, 2), 0);
        }

        slot(seat = this.seat) {
            return this.slots.subarray(seat * SLOT_DOUBLES, (seat + 1) * SLOT_DOUBLES);
        }
    }

    window.AzaharSharedLink = {
        MAX_SEATS, SLOT, KIND_FRAME, KIND_CONTROL,
        create,
        open: (buffer, seat) => new Endpoint(buffer, seat),
        // Slots of every console, for the page that created the link.
        slots(buffer) {
            const seats = new Int32Array(buffer, 0, 4)[2];
            return Array.from({length: seats}, (_, seat) =>
                new Float64Array(buffer, SLOTS_OFFSET + seat * SLOT_DOUBLES * 8, SLOT_DOUBLES));
        },
        wallNow,
    };
})();
