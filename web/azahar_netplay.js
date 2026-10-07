// Serverless local wireless ("Local Play") between browser sessions.
//
// The engine's UDS service hands every 802.11 frame it transmits to
// Module.azaharNetSend; frames from peers go back in via _azahar_net_receive.
// This file only moves those bytes. Two transports carry them:
//   - "tabs":   BroadcastChannel between tabs of one browser profile. No setup.
//   - "direct": WebRTC data channels. Peers swap invite/reply codes by any
//               means (chat, email) instead of through a signalling server.
// A direct-link host relays frames between its guests (star topology), so
// three or more consoles need only one code exchange per guest.
(function () {
    'use strict';

    const INVITE_PREFIX = 'AZLINK1.';
    const REPLY_PREFIX = 'AZREPLY1.';
    // A public STUN server only tells a browser its own internet address. It
    // carries no game traffic; it is needed for play outside one network.
    const PUBLIC_STUN = [{urls: 'stun:stun.l.google.com:19302'}];
    const ICE_GATHER_TIMEOUT_MS = 5000;
    // Clock pacing: games' local-play netcode assumes every console runs at the same
    // real-time speed, as hardware does. Browsers do not, so consoles report their game
    // clocks and one that gets ahead of a peer by more than the tolerance waits for it.
    // A peer that stops reporting (hidden tab, lost link) is not waited for; pacing
    // resumes when its reports return.
    // Clock reports cross the network, so a peer's clock is estimated from its last report,
    // the travel time (half the measured round trip) and its measured rate. Measured leads
    // are smoothed and only a lead past PACE_DEADZONE_US, or past three times the measured
    // jitter, slows this console: network noise must not throttle consoles that both run at
    // full speed. The console that is ahead then runs at its peer's measured speed, slower
    // still in proportion to the excess lead (never under PACE_MIN_SCALE); with the dead
    // zone only one console of a pair is ever ahead, so they cannot drag each other down.
    // Only a lead
    // past PACE_HOLD_US pauses it, for at most MAX_HOLD_MS at a time with HOLD_COOLDOWN_MS of
    // running in between. A peer that is loading or stalled (running under
    // PEER_STALLED_RATE) is not followed; its clock is resynced when it runs again, as is a
    // lead held past PACE_HOLD_US for PACE_REBASE_MS.
    const CLOCK_REPORT_MS = 100;
    const CLOCK_STALE_MS = 1500;
    // Two consoles that both run at full speed still drift apart by up to ~150 ms as each
    // dips for a moment (measured on Smash Bros. battles); pacing waits beyond that.
    const PACE_DEADZONE_US = 150000;
    const PACE_SMOOTHING_MS = 800;
    const PACE_CORRECTION_PER_US = 0.25 / 250000;
    const PACE_MIN_SCALE = 0.5;
    const PACE_HOLD_US = 1000000;
    const MAX_HOLD_MS = 250;
    const HOLD_COOLDOWN_MS = 100;
    const PACE_REBASE_MS = 8000;
    const PEER_STALLED_RATE = 300;
    const OFFSET_SAMPLES = 9;

    // "drop=0.05,delay=60,jitter=40,burst=800/15000" -> {drop, delay, jitter, burst}
    function parseNetsim(text) {
        if (!text) return null;
        const options = {};
        for (const part of text.split(',')) {
            const [key, value] = part.split('=');
            if (key === 'burst') {
                const [length, every] = value.split('/').map(Number);
                if (length > 0 && every > length) options.burst = {length, every};
            } else if (['drop', 'delay', 'jitter', 'lossy'].includes(key) && Number.isFinite(Number(value))) {
                options[key] = Number(value);
            }
        }
        return Object.keys(options).length ? options : null;
    }

    function macText(mac) {
        return Array.from(mac, byte => byte.toString(16).padStart(2, '0')).join(':');
    }

    function randomId() {
        return Array.from(crypto.getRandomValues(new Uint8Array(6)),
            byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function packCode(prefix, object) {
        let bytes = new TextEncoder().encode(JSON.stringify(object));
        if (typeof CompressionStream === 'function') {
            const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
            bytes = new Uint8Array(await new Response(stream).arrayBuffer());
            prefix += 'z.';
        }
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return prefix + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    async function unpackCode(prefix, code) {
        code = String(code || '').replace(/\s+/g, '');
        if (!code.startsWith(prefix)) {
            throw new Error(prefix === INVITE_PREFIX ? 'That is not an invite code.' : 'That is not a reply code.');
        }
        let body = code.slice(prefix.length);
        const compressed = body.startsWith('z.');
        if (compressed) body = body.slice(2);
        const binary = atob(body.replace(/-/g, '+').replace(/_/g, '/'));
        let bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        if (compressed) {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        }
        return JSON.parse(new TextDecoder().decode(bytes));
    }

    function waitForIce(connection) {
        if (connection.iceGatheringState === 'complete') return Promise.resolve();
        return new Promise(resolve => {
            const timer = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
            connection.addEventListener('icegatheringstatechange', () => {
                if (connection.iceGatheringState === 'complete') {
                    clearTimeout(timer);
                    resolve();
                }
            });
        });
    }

    class Netplay extends EventTarget {
        constructor() {
            super();
            this.id = randomId();
            this.mac = null;           // the console's MAC address while joined
            this.name = 'Player';
            this.mode = null;          // null, 'tabs', 'direct-host' or 'direct-guest'
            this.joined = false;       // the engine is attached to the link
            this.crossVersion = true;
            this.useStun = true;
            this.peers = new Map();    // id -> {name, mac, title, channel?}
            this.pending = new Map();  // host: invite id -> RTCPeerConnection awaiting a reply
            // received counts frames off the wire; delivered counts frames handed to the engine.
            this.stats = {sent: 0, received: 0, delivered: 0, relayed: 0};
            this.channel = null;       // BroadcastChannel in tabs mode
            // Simulated network faults for testing: see setNetsim().
            this.netsim = parseNetsim(new URLSearchParams(location.search).get('netsim'));
            this.netsimStats = {dropped: 0, delayed: 0, retransmitted: 0};
            this.netsimLastAt = 0;
            this.pacing = new URLSearchParams(location.search).get('pacing') !== '0';
            this.pacingStats = {holds: 0, heldMs: 0, throttledMs: 0, gaveUp: 0};
            this.speedPermille = 1000;
            this.holdSince = 0;
        }

        guestTimeUs() {
            const module = this.module();
            if (!module?._azahar_get_perf_stats) return null;
            const pointer = module._malloc(16 * 8);
            try {
                if (module._azahar_get_perf_stats(pointer, 16) !== 0) return null;
                return new Float64Array(module.HEAPU8.buffer, pointer, 16)[10];
            } finally {
                module._free(pointer);
            }
        }

        sendControl(message) {
            const text = JSON.stringify({...message, from: this.id});
            // Control messages share the link with frames, so simulated delays apply to both.
            if (this.mode === 'tabs') {
                this.transmit(() => this.channel?.postMessage({...message, from: this.id}));
                return;
            }
            for (const peer of this.peers.values()) {
                this.transmit(() => {
                    if (peer.channel?.readyState === 'open') peer.channel.send(text);
                });
            }
        }

        // Control message for one peer (tabs broadcast it with a recipient).
        sendControlTo(peerKey, message) {
            const peer = this.peers.get(peerKey);
            if (!peer) return;
            if (this.mode === 'tabs') {
                this.transmit(() => this.channel?.postMessage({...message, from: this.id, to: peerKey}));
            } else {
                const text = JSON.stringify({...message, from: this.id});
                this.transmit(() => {
                    if (peer.channel?.readyState === 'open') peer.channel.send(text);
                });
            }
        }

        reportClock() {
            if (!this.joined) return;
            const t = this.guestTimeUs();
            if (!t) return;
            // Echo each peer's last report so it can measure the round trip.
            const now = performance.now();
            const echoes = {};
            for (const peer of this.peers.values()) {
                if (peer.ping && peer.netId != null) {
                    echoes[peer.netId] = {sentAt: peer.ping.sentAt, hold: now - peer.ping.receivedAt};
                }
            }
            this.sendControl({kind: 'clock', t, sentAt: now, echoes});
        }

        receiveClock(peer, message) {
            const now = performance.now();
            const t = message.t;
            if (typeof message.sentAt === 'number') peer.ping = {sentAt: message.sentAt, receivedAt: now};
            const echo = message.echoes?.[this.id];
            if (echo) {
                const rtt = now - echo.sentAt - echo.hold;
                if (rtt >= 0 && rtt < 5000) {
                    peer.rtts = [...(peer.rtts || []).slice(-49), rtt];
                    peer.minRttMs = Math.min(...peer.rtts);
                    const previousRtt = peer.rttMs ?? rtt;
                    peer.rttMs = previousRtt + (rtt - previousRtt) * 0.2;
                    peer.jitterMs = (peer.jitterMs ?? 0) + (Math.abs(rtt - previousRtt) - (peer.jitterMs ?? 0)) * 0.2;
                }
            }
            const previous = peer.clock;
            // The sender's own timestamps give its rate free of network jitter, and how much
            // later than the quickest recent report this one arrived (a resend after a loss,
            // a queue): `delta` is the one-way delay plus a constant clock difference.
            const sentAt = typeof message.sentAt === 'number' ? message.sentAt : null;
            let late = 0;
            if (sentAt != null) {
                const delta = now - sentAt;
                peer.deltas = [...(peer.deltas || []).slice(-49), delta];
                late = Math.max(0, delta - Math.min(...peer.deltas));
            }
            const span = previous && (sentAt != null && previous.sentAt != null ?
                sentAt - previous.sentAt : now - previous.at);
            const sample = previous && span > 20 ? (t - previous.t) / span : 1000;
            const rate = previous ? previous.rate + (Math.max(0, Math.min(1200, sample)) - previous.rate) * 0.3 : 1000;
            peer.clock = {t, at: now, rate, sentAt, late};
            const stalled = rate < PEER_STALLED_RATE;
            if (stalled) peer.wasStalled = true;
            // Consoles boot at different times, so only drift since the link matters. Both
            // sides of a pair must agree on the expected offset, or each could think it is
            // ahead and both would wait: the console with the lower id measures it (on the
            // first report, after an outage or stall, or when asked) and the other adopts
            // its mirror.
            const outage = previous && now - previous.at > CLOCK_STALE_MS;
            const resumed = peer.wasStalled && !stalled;
            if (resumed) {
                peer.wasStalled = false;
                peer.clockOffset = null;
                peer.smoothedLead = null;
                if (this.id > peer.netId) this.sendControlTo(peer.key, {kind: 'clock-rebase'});
            }
            // Wait for a round-trip measurement (or give up on one after a second) so the
            // baseline does not include the travel time.
            peer.reports = (peer.reports || 0) + 1;
            const travelKnown = peer.rttMs != null || peer.reports > 10;
            if (outage) peer.offsetSamples = [];
            if (this.id < peer.netId && (peer.clockOffset == null || outage) && !stalled && travelKnown) {
                // One report is off by its own jitter, and a baseline error would last the whole
                // session, so take the median of several.
                const local = this.guestTimeUs();
                if (local != null) {
                    if (outage) peer.clockOffset = null;
                    peer.offsetSamples = [...(peer.offsetSamples || []), local - this.peerClockEstimate(peer, now)];
                    if (peer.offsetSamples.length >= OFFSET_SAMPLES) {
                        const sorted = [...peer.offsetSamples].sort((a, b) => a - b);
                        peer.clockOffset = sorted[Math.floor(sorted.length / 2)];
                        peer.offsetSamples = [];
                        peer.smoothedLead = null;
                        this.sendControlTo(peer.key, {kind: 'clock-base', offset: peer.clockOffset});
                    }
                }
            }
        }

        // The peer's game clock now: its last report advanced by the time since it was sent.
        peerClockEstimate(peer, now) {
            const clock = peer.clock;
            // Quickest round trip seen, halved, plus how late this report was.
            const travel = (peer.minRttMs ?? peer.rttMs ?? 0) / 2 + (clock.late || 0);
            return clock.t + (now - clock.at + travel) * Math.min(clock.rate, 1200);
        }

        receiveClockBase(peer, offset) {
            if (this.id > peer.netId) {
                peer.clockOffset = -offset;
                peer.smoothedLead = null;
            }
        }

        handleClockControl(peer, message) {
            if (!peer) return;
            if (message.kind === 'clock') this.receiveClock(peer, message);
            else if (message.kind === 'clock-base') this.receiveClockBase(peer, message.offset);
            else if (message.kind === 'clock-rebase' && this.id < peer.netId) {
                peer.clockOffset = null;
                peer.offsetSamples = [];
            }
        }

        // How far this console's game clock is ahead of the peer that is furthest behind, in
        // µs, against the baseline agreed when the link started (or last resynced), with the
        // rate and jitter tolerance that go with it. Leads are smoothed over PACE_SMOOTHING_MS.
        clockLead() {
            const local = this.guestTimeUs();
            if (local == null) return null;
            const now = performance.now();
            let worst = null;
            for (const peer of this.peers.values()) {
                const clock = peer.clock;
                if (!clock || peer.netId == null || peer.clockOffset == null ||
                    now - clock.at > CLOCK_STALE_MS || clock.rate < PEER_STALLED_RATE) continue;
                const lead = local - this.peerClockEstimate(peer, now) - peer.clockOffset;
                const dt = now - (peer.leadAt || now);
                peer.leadAt = now;
                peer.smoothedLead = peer.smoothedLead == null ? lead :
                    peer.smoothedLead + (lead - peer.smoothedLead) * Math.min(1, dt / PACE_SMOOTHING_MS);
                const tolerance = Math.max(PACE_DEADZONE_US, 3000 * (peer.jitterMs || 0));
                const excess = peer.smoothedLead - tolerance;
                if (!worst || excess > worst.excess) worst = {excess, lead: peer.smoothedLead, rate: clock.rate};
            }
            return worst;
        }

        setSpeedScale(scale) {
            const permille = Math.round(scale * 1000);
            if (permille === this.speedPermille) return;
            this.speedPermille = permille;
            this.module()?._azahar_set_speed_scale?.(permille);
        }

        // Called before each emulation step. Slows this console while it is ahead of a peer and
        // returns true when the step should be skipped altogether.
        shouldHold() {
            const lead = this.pacing && this.joined && this.peers.size ? this.clockLead() : null;
            const now = performance.now();
            const elapsed = now - (this.lastPaceAt || now);
            this.lastPaceAt = now;
            if (!lead || lead.excess <= 0) {
                this.leadSince = 0;
                this.setSpeedScale(1);
                return this.endHold(false);
            }
            // A lead held past PACE_HOLD_US for PACE_REBASE_MS will not close (the peer
            // cannot keep up even with this console paused at times): resync from here
            // rather than hold forever. Authorities re-measure; others ask theirs to.
            if (lead.lead <= PACE_HOLD_US) this.leadSince = 0;
            else if (!this.leadSince) this.leadSince = now;
            if (this.leadSince && now - this.leadSince > PACE_REBASE_MS) {
                this.pacingStats.gaveUp++;
                this.leadSince = 0;
                for (const [key, peer] of this.peers) {
                    peer.clockOffset = null;
                    peer.smoothedLead = null;
                    if (this.id > peer.netId) this.sendControlTo(key, {kind: 'clock-rebase'});
                }
                this.setSpeedScale(1);
                return this.endHold(false);
            }
            // Run at the peer's measured speed, slower still in proportion to the lead. Only
            // the console that is ahead does this, so two consoles cannot drag each other down.
            const peerSpeed = Math.min(1, lead.rate / 1000);
            this.setSpeedScale(Math.max(PACE_MIN_SCALE, peerSpeed - lead.excess * PACE_CORRECTION_PER_US));
            if (this.speedPermille < 1000) this.pacingStats.throttledMs += elapsed;
            if (lead.lead <= PACE_HOLD_US) return this.endHold(false);
            if (this.holdSince && now - this.holdSince > MAX_HOLD_MS) {
                this.cooldownUntil = now + HOLD_COOLDOWN_MS;
                return this.endHold(false);
            }
            if (now < (this.cooldownUntil || 0)) return false;
            if (!this.holdSince) {
                this.holdSince = now;
                this.pacingStats.holds++;
            }
            return true;
        }

        endHold(result) {
            if (this.holdSince) {
                this.pacingStats.heldMs += performance.now() - this.holdSince;
                this.holdSince = 0;
            }
            return result;
        }

        // Simulates real-world network conditions on outgoing frames. The link is a reliable,
        // ordered WebRTC channel, so by default a "lost" frame is retransmitted and delays
        // every frame behind it, as SCTP does:
        //   delay, jitter  ms added to each frame (order is kept)
        //   drop           fraction of frames lost and resent after RETRANSMIT_MS
        //   burst          {length, every} ms outages; frames wait for the link to return
        //   lossy          frames really vanish (UDP-like), for stress testing
        // Pass null to turn it off.
        setNetsim(options) {
            this.netsim = options && Object.keys(options).length ? {...options} : null;
            this.netsimStats = {dropped: 0, delayed: 0, retransmitted: 0};
            this.netsimLastAt = 0;
        }

        // Sends now, later or never, as the simulated network decides.
        transmit(send) {
            const sim = this.netsim;
            if (!sim) return send();
            const RETRANSMIT_MS = 200;
            const now = performance.now();
            let at = now + (sim.delay || 0) + (sim.jitter ? Math.random() * sim.jitter : 0);
            const lost = sim.drop && Math.random() < sim.drop;
            const phase = sim.burst ? now % sim.burst.every : Infinity;
            const inOutage = sim.burst && phase < sim.burst.length;
            if (sim.lossy && (lost || inOutage)) {
                this.netsimStats.dropped++;
                return;
            }
            if (lost) {
                at += RETRANSMIT_MS;
                this.netsimStats.retransmitted++;
            }
            if (inOutage) at = Math.max(at, now - phase + sim.burst.length);
            // Reliable and ordered: nothing overtakes an earlier frame.
            if (!sim.lossy) at = Math.max(at, this.netsimLastAt || 0);
            this.netsimLastAt = at;
            if (at <= now) return send();
            this.netsimStats.delayed++;
            setTimeout(send, at - now);
        }

        module() {
            return window.AzaharUI?.getModule?.() || null;
        }

        titleId() {
            const module = this.module();
            if (!module?._azahar_get_program_id) return null;
            const pointer = module._malloc(8);
            try {
                if (module._azahar_get_program_id(pointer, 2) !== 0) return null;
                const words = new Uint32Array(module.HEAPU8.buffer, pointer, 2);
                return words[1].toString(16).padStart(8, '0').toUpperCase() +
                    words[0].toString(16).padStart(8, '0').toUpperCase();
            } finally {
                module._free(pointer);
            }
        }

        hello() {
            return {kind: 'hello', from: this.id, name: this.name,
                mac: this.mac ? macText(this.mac) : null, title: this.titleId()};
        }

        consoleMac() {
            const module = this.module();
            if (!module?._azahar_net_console_mac) return null;
            const pointer = module._malloc(6);
            try {
                return module._azahar_net_console_mac(pointer) === 0 ?
                    module.HEAPU8.slice(pointer, pointer + 6) : null;
            } finally {
                module._free(pointer);
            }
        }

        emit(type, detail) {
            this.dispatchEvent(new CustomEvent(type, {detail}));
            this.dispatchEvent(new CustomEvent('change'));
        }

        status() {
            return {
                mode: this.mode, joined: this.joined, id: this.id, name: this.name,
                mac: this.mac ? macText(this.mac) : null, title: this.titleId(), crossVersion: this.crossVersion,
                peers: Array.from(this.peers, ([id, peer]) => ({id, name: peer.name, mac: peer.mac,
                    title: peer.title, open: peer.channel ? peer.channel.readyState === 'open' : true})),
                stats: {...this.stats},
                netsim: this.netsim && {...this.netsim, ...this.netsimStats},
                pacing: this.pacing ? {...this.pacingStats, heldMs: Math.round(this.pacingStats.heldMs),
                    throttledMs: Math.round(this.pacingStats.throttledMs), speed: this.speedPermille / 1000} : null,
            };
        }

        // ── Engine attachment ────────────────────────────────────────
        // The console joins under its own MAC address, so it needs a running
        // title; until then frames are only counted. A restored save state can
        // bring a different address, so sync() rejoins when it changes.
        attach() {
            const module = this.module();
            if (!this.mode || this.joined || !module?._azahar_net_join) return false;
            const mac = this.consoleMac();
            if (!mac) return false;
            module.azaharNetSend = bytes => this.sendFrame(bytes);
            module._azahar_net_set_cross_version(this.crossVersion ? 1 : 0);
            const name = new TextEncoder().encode(this.name + '\0');
            const namePointer = module._malloc(name.length);
            try {
                module.HEAPU8.set(name, namePointer);
                if (module._azahar_net_join(namePointer, 0) !== 0) return false;
            } finally {
                module._free(namePointer);
            }
            this.mac = mac;
            this.joined = true;
            clearInterval(this.clockTimer);
            this.clockTimer = setInterval(() => this.reportClock(), CLOCK_REPORT_MS);
            this.announce();
            this.emit('joined', {mac: macText(mac)});
            return true;
        }

        sync() {
            if (!this.mode) return false;
            if (!this.joined) return this.attach();
            const mac = this.consoleMac();
            if (mac && macText(mac) !== macText(this.mac)) {
                this.joined = false;
                return this.attach();
            }
            return false;
        }

        // Tell peers our name, title and address after they change.
        announce() {
            if (this.mode === 'tabs') {
                this.channel.postMessage(this.hello());
                return;
            }
            const text = JSON.stringify(this.hello());
            for (const peer of this.peers.values()) {
                if (peer.channel?.readyState === 'open') peer.channel.send(text);
            }
        }

        detach() {
            clearInterval(this.clockTimer);
            this.endHold(false);
            this.setSpeedScale(1);
            const module = this.module();
            if (this.joined && module) {
                module._azahar_net_leave();
                module.azaharNetSend = null;
            }
            this.joined = false;
        }

        setCrossVersion(enabled) {
            this.crossVersion = !!enabled;
            this.module()?._azahar_net_set_cross_version?.(this.crossVersion ? 1 : 0);
            this.emit('change');
        }

        deliver(bytes) {
            this.stats.received++;
            const module = this.module();
            if (!this.joined || !module) return;
            const pointer = module._malloc(bytes.length);
            try {
                module.HEAPU8.set(bytes, pointer);
                module._azahar_net_receive(pointer, bytes.length);
                this.stats.delivered++;
            } finally {
                module._free(pointer);
            }
        }

        sendFrame(bytes) {
            this.stats.sent++;
            if (this.mode === 'tabs') {
                this.transmit(() => this.channel?.postMessage({kind: 'frame', from: this.id, bytes}));
                return;
            }
            for (const peer of this.peers.values()) {
                this.transmit(() => {
                    if (peer.channel?.readyState === 'open') peer.channel.send(bytes);
                });
            }
        }

        // ── Same-browser tabs ────────────────────────────────────────
        linkTabs(room = 'default') {
            this.leave();
            this.mode = 'tabs';
            this.room = room;
            this.channel = new BroadcastChannel('azahar-local-play:' + room);
            this.channel.onmessage = ({data}) => {
                if (!data || data.from === this.id) return;
                if (data.kind === 'frame') {
                    this.deliver(data.bytes);
                } else if (data.kind === 'hello' || data.kind === 'hello-reply') {
                    const known = this.peers.has(data.from);
                    const existing = this.peers.get(data.from);
                    this.peers.set(data.from, {...existing, name: data.name, mac: data.mac, title: data.title,
                        key: data.from, netId: data.from});
                    if (data.kind === 'hello') this.channel.postMessage({...this.hello(), kind: 'hello-reply'});
                    if (!known) this.emit('peer', {id: data.from, name: data.name});
                    else this.emit('change');
                } else if (data.kind?.startsWith('clock')) {
                    if (data.to && data.to !== this.id) return;
                    this.handleClockControl(this.peers.get(data.from), data);
                } else if (data.kind === 'bye') {
                    this.peers.delete(data.from);
                    this.emit('peer-left', {id: data.from});
                }
            };
            this.channel.postMessage(this.hello());
            this.attach();
            this.emit('change');
        }

        // ── Direct WebRTC link ───────────────────────────────────────
        newConnection() {
            return new RTCPeerConnection({iceServers: this.useStun ? PUBLIC_STUN : []});
        }

        // Frames are sent as binary; control messages as JSON text.
        wireChannel(channel, peerId) {
            channel.binaryType = 'arraybuffer';
            channel.onopen = () => {
                channel.send(JSON.stringify(this.hello()));
                this.attach();
                this.emit('change');
            };
            channel.onclose = () => {
                const peer = this.peers.get(peerId);
                if (peer?.channel === channel) {
                    this.peers.delete(peerId);
                    this.emit('peer-left', {id: peerId});
                }
            };
            channel.onmessage = ({data}) => {
                if (typeof data === 'string') {
                    const message = JSON.parse(data);
                    if (message.kind?.startsWith('clock')) {
                        this.handleClockControl(this.peers.get(peerId), {...message, to: undefined});
                        return;
                    }
                    if (message.kind !== 'hello') return;
                    const peer = this.peers.get(peerId);
                    const first = !peer.mac && peer.name === '…';
                    Object.assign(peer, {name: message.name, mac: message.mac, title: message.title,
                        netId: message.from});
                    if (first) this.emit('peer', {id: peerId, name: message.name});
                    else this.emit('change');
                    return;
                }
                const bytes = new Uint8Array(data);
                this.deliver(bytes);
                if (this.mode === 'direct-host') {
                    // Guests reach each other only through the host.
                    for (const [id, other] of this.peers) {
                        if (id !== peerId) {
                            this.transmit(() => {
                                if (other.channel?.readyState === 'open') other.channel.send(bytes);
                            });
                            this.stats.relayed++;
                        }
                    }
                }
            };
            this.peers.set(peerId, {name: '…', mac: null, title: null, channel, key: peerId, netId: null});
        }

        // Takes over a data channel that is already open, such as one a public
        // lobby set up, as a link to `peerId`. `mode` is 'direct-host' or 'direct-guest'.
        adoptPeer(connection, channel, peerId, mode) {
            if (this.mode !== mode) {
                this.leave();
                this.mode = mode;
            }
            this.pending.set(peerId, connection);
            this.wireChannel(channel, peerId);
            if (channel.readyState === 'open') channel.onopen();
        }

        // Host: make a one-use invite for the next guest.
        async createInvite() {
            if (this.mode !== 'direct-host') {
                this.leave();
                this.mode = 'direct-host';
            }
            const inviteId = randomId();
            const connection = this.newConnection();
            this.wireChannel(connection.createDataChannel('local-play', {ordered: true}), inviteId);
            this.pending.set(inviteId, connection);
            await connection.setLocalDescription(await connection.createOffer());
            await waitForIce(connection);
            this.emit('change');
            return packCode(INVITE_PREFIX, {invite: inviteId, host: this.id, sdp: connection.localDescription.sdp});
        }

        // Guest: answer an invite. Returns the reply code to send back.
        async acceptInvite(code) {
            const invite = await unpackCode(INVITE_PREFIX, code);
            this.leave();
            this.mode = 'direct-guest';
            const connection = this.newConnection();
            connection.ondatachannel = ({channel}) => this.wireChannel(channel, invite.host);
            this.pending.set(invite.host, connection);
            await connection.setRemoteDescription({type: 'offer', sdp: invite.sdp});
            await connection.setLocalDescription(await connection.createAnswer());
            await waitForIce(connection);
            this.emit('change');
            return packCode(REPLY_PREFIX, {invite: invite.invite, sdp: connection.localDescription.sdp});
        }

        // Host: finish the handshake with a guest's reply code.
        async acceptReply(code) {
            const reply = await unpackCode(REPLY_PREFIX, code);
            const connection = this.pending.get(reply.invite);
            if (!connection) throw new Error('That reply is for an invite this page did not create.');
            await connection.setRemoteDescription({type: 'answer', sdp: reply.sdp});
        }

        leave() {
            if (this.mode === 'tabs' && this.channel) {
                this.channel.postMessage({kind: 'bye', from: this.id});
                this.channel.close();
            }
            for (const peer of this.peers.values()) peer.channel?.close();
            for (const connection of this.pending.values()) connection.close();
            this.channel = null;
            this.peers.clear();
            this.pending.clear();
            this.detach();
            this.mode = null;
            this.emit('change');
        }
    }

    const netplay = new Netplay();
    window.AzaharNetplay = netplay;
    window.AzaharNetplayHelpers = {waitForIce, randomId, PUBLIC_STUN};
    window.addEventListener('pagehide', () => netplay.leave());

    // ── Card UI ──────────────────────────────────────────────────────
    function bindUi() {
        const $ = id => document.getElementById(id);
        const card = $('local-play-card');
        if (!card) return;
        const nickname = $('local-play-name');
        const status = $('local-play-status');
        const peers = $('local-play-peers');
        const codeOut = $('local-play-code-out');
        const codeIn = $('local-play-code-in');
        const say = (text, kind = '') => {
            status.textContent = text;
            status.dataset.kind = kind;
        };
        try {
            nickname.value = localStorage.getItem('azahar.localPlay.name') || '';
        } catch {}
        const applyName = () => {
            netplay.name = nickname.value.trim().slice(0, 10) || 'Player';
            try { localStorage.setItem('azahar.localPlay.name', nickname.value.trim()); } catch {}
        };
        applyName();
        nickname.addEventListener('change', applyName);
        $('local-play-cross-version').addEventListener('change', event => netplay.setCrossVersion(event.target.checked));
        $('local-play-stun').addEventListener('change', event => { netplay.useStun = event.target.checked; });

        const run = action => async () => {
            try {
                applyName();
                await action();
            } catch (error) {
                say(error.message || String(error), 'error');
            }
        };
        $('btn-local-play-tabs').addEventListener('click', run(() => {
            netplay.linkTabs($('local-play-room').value.trim() || 'default');
        }));
        $('btn-local-play-invite').addEventListener('click', run(async () => {
            say('Preparing an invite…');
            codeOut.value = await netplay.createInvite();
            codeOut.select();
            say('Send this invite to a friend, then paste their reply below.', 'ok');
        }));
        $('btn-local-play-accept').addEventListener('click', run(async () => {
            const code = codeIn.value.trim();
            if (code.startsWith(REPLY_PREFIX)) {
                await netplay.acceptReply(code);
                codeIn.value = '';
                say('Reply accepted. Connecting…');
            } else {
                say('Preparing a reply…');
                codeOut.value = await netplay.acceptInvite(code);
                codeIn.value = '';
                codeOut.select();
                say('Send this reply back to the host.', 'ok');
            }
        }));
        $('btn-local-play-copy').addEventListener('click', run(() => navigator.clipboard.writeText(codeOut.value)));
        $('btn-local-play-leave').addEventListener('click', run(() => netplay.leave()));

        const render = () => {
            const state = netplay.status();
            peers.replaceChildren(...state.peers.map(peer => {
                const item = document.createElement('li');
                const sameTitle = !peer.title || !state.title || peer.title === state.title;
                item.textContent = `${peer.name}${peer.open ? '' : ' (connecting)'}` +
                    (peer.title ? ` — ${peer.title}${sameTitle ? '' : ' (different build)'}` : '');
                return item;
            }));
            $('btn-local-play-leave').disabled = !state.mode;
            if (!state.mode) {
                if (!status.dataset.kind || status.dataset.kind === 'linked') say('Not linked.');
            } else if (state.mac && state.peers.some(peer => peer.mac === state.mac)) {
                // Consoles restored from one save state share an address and cannot see each other.
                say(`Another console has this console's address (${state.mac}). ` +
                    'Each player needs their own save, not a copy of someone else\'s.', 'error');
            } else {
                const count = state.peers.length;
                const consoles = `${count} other console${count === 1 ? '' : 's'}`;
                say(state.joined ?
                    `Linked (${state.mode.replace('direct-', 'direct, ')}) as ${state.mac} — ${consoles}. ` +
                    'Open the game\'s local wireless menu.' :
                    `Linked (${state.mode.replace('direct-', 'direct, ')}) — ${consoles}. Start a game to play.`, 'linked');
            }
        };
        netplay.addEventListener('change', render);
        render();
        // The title may start, or a save state may change the console, after linking.
        const timer = setInterval(() => {
            if (netplay.sync()) render();
        }, 500);
        window.addEventListener('pagehide', () => clearInterval(timer));

        // ?link=tabs:ROOM joins a same-browser room on load (tests and demos).
        const query = new URLSearchParams(location.search);
        const link = query.get('link');
        if (query.get('nick')) {
            nickname.value = query.get('nick');
            applyName();
        }
        if (query.get('crossVersion') === '0') {
            $('local-play-cross-version').checked = false;
            netplay.setCrossVersion(false);
        }
        if (link?.startsWith('tabs:')) netplay.linkTabs(link.slice(5) || 'default');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUi);
    else bindUi();
})();
