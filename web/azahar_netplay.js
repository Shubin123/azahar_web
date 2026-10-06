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
                this.channel.postMessage({kind: 'frame', from: this.id, bytes});
                return;
            }
            for (const peer of this.peers.values()) {
                if (peer.channel?.readyState === 'open') peer.channel.send(bytes);
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
                    this.peers.set(data.from, {name: data.name, mac: data.mac, title: data.title});
                    if (data.kind === 'hello') this.channel.postMessage({...this.hello(), kind: 'hello-reply'});
                    if (!known) this.emit('peer', {id: data.from, name: data.name});
                    else this.emit('change');
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
                    if (message.kind !== 'hello') return;
                    const peer = this.peers.get(peerId);
                    const first = !peer.mac && peer.name === '…';
                    Object.assign(peer, {name: message.name, mac: message.mac, title: message.title});
                    if (first) this.emit('peer', {id: peerId, name: message.name});
                    else this.emit('change');
                    return;
                }
                const bytes = new Uint8Array(data);
                this.deliver(bytes);
                if (this.mode === 'direct-host') {
                    // Guests reach each other only through the host.
                    for (const [id, other] of this.peers) {
                        if (id !== peerId && other.channel?.readyState === 'open') {
                            other.channel.send(bytes);
                            this.stats.relayed++;
                        }
                    }
                }
            };
            this.peers.set(peerId, {name: '…', mac: null, title: null, channel});
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
