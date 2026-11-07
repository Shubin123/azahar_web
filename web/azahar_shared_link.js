// Local Play between consoles on one device (split.html). Every console runs
// in its own frame of one page, and they talk through one SharedArrayBuffer
// instead of a network: a pool with one ring per console, which that console
// writes and every other console reads, carries their 802.11 frames and Local
// Play control messages, and a slot per console publishes its emulation timing
// so the page can split each display refresh between the consoles. The pool
// grows with the number of consoles, not with the number of pairs.
//
// Layout (all offsets in bytes):
//   0     Int32 header: magic, version, seats, ring capacity
//   64    `seats` slots of SLOT_DOUBLES Float64 (see SLOT below)
//   then  `seats` rings, each a header of Int32 [written, unused, then per reader:
//         read position, dropped] followed by `capacity` data bytes
// A message is a u32 word (payload length << 16 | recipient << 8 | kind; recipient
// 0xFF is everyone) and the payload, padded to 4 bytes. Positions are free-running
// u32 byte counters; the capacity is a power of two, so a message header never
// wraps but a payload may. A reader skips messages for other consoles.
//
// A reader that falls a whole ring behind (a console that stopped) does not hold
// the others up: its sender moves it past the oldest messages, which it loses as
// it would on a network, and counts them. Every console of split.html runs on the
// page's main thread, so a ring is never written while it is read.
(function () {
    'use strict';

    const MAGIC = 0x4C535A41; // "AZSL"
    const VERSION = 2;
    // The most consoles one local wireless network takes (UDS allows 16 nodes).
    const MAX_SEATS = 16;
    const SLOT_DOUBLES = 16;
    const SLOTS_OFFSET = 64;
    // About a second of a busy local wireless session.
    const RING_BYTES = 1 << 18;
    const MAX_MESSAGE = 0xFFFF;
    const EVERYONE = 0xFF;
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

    // Ring header: written, unused, then [read, dropped] per reader; 16-byte aligned.
    const ringHeaderBytes = seats => ((8 + seats * 8) + 15) & ~15;
    const ringsOffset = seats => SLOTS_OFFSET + seats * SLOT_DOUBLES * 8;

    function create(seats, capacity = RING_BYTES) {
        if (!(seats >= 2 && seats <= MAX_SEATS)) throw new RangeError(`2-${MAX_SEATS} consoles`);
        if (capacity & (capacity - 1)) throw new RangeError('ring capacity must be a power of two');
        const buffer = new SharedArrayBuffer(ringsOffset(seats) + seats * (ringHeaderBytes(seats) + capacity));
        const header = new Int32Array(buffer, 0, 4);
        header.set([MAGIC, VERSION, seats, capacity]);
        const slots = new Float64Array(buffer, SLOTS_OFFSET, seats * SLOT_DOUBLES);
        for (let seat = 0; seat < seats; seat++) slots[seat * SLOT_DOUBLES + SLOT.share] = 1 / seats;
        return buffer;
    }

    // One console's end of the link: its own ring, and its read position in every other one.
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
            this.slots = new Float64Array(buffer, SLOTS_OFFSET, this.seats * SLOT_DOUBLES);
            const headerBytes = ringHeaderBytes(this.seats);
            this.rings = Array.from({length: this.seats}, (_, from) => {
                const offset = ringsOffset(this.seats) + from * (headerBytes + this.capacity);
                return {
                    from,
                    control: new Int32Array(buffer, offset, headerBytes >> 2),
                    bytes: new Uint8Array(buffer, offset + headerBytes, this.capacity),
                    words: new Int32Array(buffer, offset + headerBytes, this.capacity >> 2),
                };
            });
            this.own = this.rings[seat];
        }

        // Moves `reader` past whole messages until `need` more bytes fit behind it.
        dropOldest(reader, written, need) {
            const control = this.own.control;
            let read = Atomics.load(control, 2 + reader * 2) >>> 0;
            let dropped = 0;
            while (this.capacity - ((written - read) >>> 0) < need) {
                const word = this.own.words[(read & this.mask) >> 2];
                read = (read + 4 + (((word >>> 16) + 3) & ~3)) >>> 0;
                if ((((word >>> 8) & 0xFF) === EVERYONE) || ((word >>> 8) & 0xFF) === reader) dropped++;
            }
            Atomics.store(control, 2 + reader * 2, read | 0);
            if (dropped) Atomics.add(control, 3 + reader * 2, dropped);
        }

        // Queues one message for console `to`, or for every other console.
        // Returns how many consoles it was queued for.
        send(kind, bytes, to = -1) {
            const length = bytes.length;
            const need = 4 + ((length + 3) & ~3);
            if (length > MAX_MESSAGE || need > this.capacity) throw new RangeError('message too long for the shared link');
            const control = this.own.control;
            const written = Atomics.load(control, 0) >>> 0;
            for (let reader = 0; reader < this.seats; reader++) {
                if (reader === this.seat) continue;
                const read = Atomics.load(control, 2 + reader * 2) >>> 0;
                if (this.capacity - ((written - read) >>> 0) < need) this.dropOldest(reader, written, need);
            }
            const at = written & this.mask;
            this.own.words[at >> 2] = (length << 16) | ((to >= 0 ? to : EVERYONE) << 8) | kind;
            const start = (at + 4) & this.mask;
            const first = Math.min(length, this.capacity - start);
            this.own.bytes.set(first === length ? bytes : bytes.subarray(0, first), start);
            if (first < length) this.own.bytes.set(bytes.subarray(first), 0);
            // Publish only after the payload is in place.
            Atomics.store(control, 0, (written + need) | 0);
            return to >= 0 ? (to !== this.seat && to < this.seats ? 1 : 0) : this.seats - 1;
        }

        // Hands every waiting message for this console to handler(kind, bytes, fromSeat).
        // `bytes` may alias the ring and is valid only during the call.
        receive(handler) {
            let count = 0;
            for (const ring of this.rings) {
                if (ring === this.own) continue;
                const cursor = 2 + this.seat * 2;
                const written = Atomics.load(ring.control, 0) >>> 0;
                let read = Atomics.load(ring.control, cursor) >>> 0;
                while (read !== written) {
                    const at = read & this.mask;
                    const word = ring.words[at >> 2];
                    const length = word >>> 16;
                    const to = (word >>> 8) & 0xFF;
                    const next = (read + 4 + ((length + 3) & ~3)) >>> 0;
                    if (to === EVERYONE || to === this.seat) {
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
                        try {
                            handler(word & 0xFF, bytes, ring.from);
                        } finally {
                            // Free the space only once the handler is done with it.
                            Atomics.store(ring.control, cursor, next | 0);
                        }
                        count++;
                    } else {
                        Atomics.store(ring.control, cursor, next | 0);
                    }
                    read = next;
                }
            }
            return count;
        }

        // Messages this console sent that a console lost by falling a ring behind.
        dropped() {
            let total = 0;
            for (let reader = 0; reader < this.seats; reader++) {
                if (reader !== this.seat) total += Atomics.load(this.own.control, 3 + reader * 2);
            }
            return total;
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
        // Bytes a link for `seats` consoles takes.
        bytes: (seats, capacity = RING_BYTES) => ringsOffset(seats) + seats * (ringHeaderBytes(seats) + capacity),
        wallNow,
    };
})();
