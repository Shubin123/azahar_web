// Public Local Play lobbies, found through public WebTorrent trackers.
//
// A tracker only introduces browsers to each other: it forwards WebRTC offers
// and answers between peers that announce the same swarm. Game traffic then
// flows directly between the browsers, exactly as with invite codes.
//
//   - Everyone announces one shared Azahar lobby swarm.
//   - Browsers looking for lobbies attach WebRTC offers to their announces.
//     Hosts answer them; the opened channel carries the host's lobby card
//     (name, title, players) to the browser.
//   - Joining asks the host to admit that same connection, which then becomes
//     the Local Play link (AzaharNetplay.adoptPeer). Hosts relay game frames
//     only to admitted players, never to browsers that are just looking.
//
// ?trackers=wss://a,wss://b replaces the default trackers (the tests use a
// local one).
(function () {
    'use strict';

    const DEFAULT_TRACKERS = [
        'wss://tracker.openwebtorrent.com',
        'wss://tracker.webtorrent.dev',
        'wss://tracker.files.fm:7073/announce',
    ];
    const SWARM_NAME = 'azahar-public-local-play-lobbies/v1';
    const OFFERS_PER_ANNOUNCE = 8;
    const BROWSE_ANNOUNCE_MS = 10000;
    const HOST_ANNOUNCE_MS = 20000;
    const VISITOR_TIMEOUT_MS = 45000;
    const MAX_PLAYERS = 8;

    const helpers = () => window.AzaharNetplayHelpers;
    const netplay = () => window.AzaharNetplay;

    // Trackers identify swarms and peers by 20-byte strings sent as Latin-1 text.
    function randomBinaryId() {
        return String.fromCharCode(...crypto.getRandomValues(new Uint8Array(20)));
    }

    async function swarmHash() {
        const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(SWARM_NAME));
        return String.fromCharCode(...new Uint8Array(digest));
    }

    function trackerUrls() {
        const requested = new URLSearchParams(location.search).get('trackers');
        return requested ? requested.split(',').map(url => url.trim()).filter(Boolean) : DEFAULT_TRACKERS;
    }

    // One WebSocket per tracker, reconnecting while the lobby feature is active.
    class Tracker {
        constructor(url, onMessage, onOpen) {
            this.url = url;
            this.onMessage = onMessage;
            this.onOpen = onOpen;
            this.closed = false;
            this.connect();
        }

        connect() {
            if (this.closed) return;
            try {
                this.socket = new WebSocket(this.url);
            } catch {
                this.retry();
                return;
            }
            this.socket.onopen = () => this.onOpen(this);
            this.socket.onmessage = ({data}) => {
                try {
                    this.onMessage(this, JSON.parse(data));
                } catch {}
            };
            this.socket.onclose = () => this.retry();
            this.socket.onerror = () => {};
        }

        retry() {
            if (!this.closed) this.timer = setTimeout(() => this.connect(), 5000);
        }

        get open() {
            return this.socket?.readyState === WebSocket.OPEN;
        }

        send(message) {
            if (this.open) this.socket.send(JSON.stringify(message));
        }

        close() {
            this.closed = true;
            clearTimeout(this.timer);
            this.socket?.close();
        }
    }

    class Lobbies extends EventTarget {
        constructor() {
            super();
            this.role = null;          // null, 'host' or 'browse'
            this.peerId = randomBinaryId();
            this.trackers = [];
            this.offers = new Map();   // browser: offer id -> {connection, channel, created}
            this.visitors = new Map(); // host: tracker peer id -> {connection, channel, opened}
            this.lobbies = new Map();  // browser: host id -> lobby card plus connection
            this.lobbyName = '';
        }

        change() {
            this.dispatchEvent(new CustomEvent('change'));
        }

        status() {
            return {
                role: this.role,
                lobbyName: this.lobbyName,
                trackers: this.trackers.map(tracker => ({url: tracker.url, open: tracker.open})),
                lobbies: Array.from(this.lobbies.values(), ({connection, channel, ...card}) => card),
                visitors: this.visitors.size,
            };
        }

        async start(role) {
            this.stop();
            this.role = role;
            this.infoHash = await swarmHash();
            for (const url of trackerUrls()) {
                this.trackers.push(new Tracker(url, (tracker, message) => this.onTrackerMessage(tracker, message),
                    tracker => this.announce(tracker)));
            }
            this.announceTimer = setInterval(() => this.trackers.forEach(tracker => this.announce(tracker)),
                role === 'host' ? HOST_ANNOUNCE_MS : BROWSE_ANNOUNCE_MS);
            this.change();
        }

        stop() {
            clearInterval(this.announceTimer);
            if (this.onLinkChange) {
                netplay().removeEventListener('change', this.onLinkChange);
                this.onLinkChange = null;
            }
            for (const tracker of this.trackers) {
                tracker.send({action: 'announce', event: 'stopped', info_hash: this.infoHash,
                    peer_id: this.peerId, numwant: 0, uploaded: 0, downloaded: 0, left: 0});
                tracker.close();
            }
            this.trackers = [];
            for (const {connection} of this.offers.values()) connection.close();
            for (const {connection} of this.visitors.values()) connection.close();
            for (const {connection} of this.lobbies.values()) connection?.close();
            this.offers.clear();
            this.visitors.clear();
            this.lobbies.clear();
            this.role = null;
            this.change();
        }

        // ── Hosting ──────────────────────────────────────────────────────
        async host(name) {
            const link = netplay();
            if (!link.titleId()) throw new Error('Start the game first, then host its lobby.');
            this.lobbyName = (name || `${link.name}'s room`).slice(0, 40);
            if (link.mode !== 'direct-host') {
                link.leave();
                link.mode = 'direct-host';
                link.emit('change');
            }
            await this.start('host');
            // Hosting ends when the player leaves Local Play.
            this.onLinkChange = () => {
                if (this.role === 'host' && !netplay().mode) this.stop();
                else this.broadcastCard();
            };
            link.addEventListener('change', this.onLinkChange);
        }

        card() {
            const link = netplay();
            return {kind: 'lobby', host: link.id, name: this.lobbyName, nickname: link.name,
                title: link.titleId(), players: 1 + link.peers.size, max: MAX_PLAYERS};
        }

        broadcastCard() {
            const text = JSON.stringify(this.card());
            for (const visitor of this.visitors.values()) {
                if (visitor.channel?.readyState === 'open') visitor.channel.send(text);
            }
        }

        async answerOffer(tracker, message) {
            const visitorId = message.peer_id;
            if (this.visitors.has(visitorId) || netplay().peers.size + 1 >= MAX_PLAYERS) return;
            const connection = new RTCPeerConnection({iceServers: netplay().useStun ? helpers().PUBLIC_STUN : []});
            const visitor = {connection, channel: null, opened: Date.now()};
            this.visitors.set(visitorId, visitor);
            connection.ondatachannel = ({channel}) => {
                visitor.channel = channel;
                channel.onopen = () => channel.send(JSON.stringify(this.card()));
                channel.onmessage = ({data}) => {
                    if (typeof data !== 'string' || JSON.parse(data).kind !== 'join') return;
                    // Admit the browser: this connection becomes a Local Play link.
                    this.visitors.delete(visitorId);
                    channel.send(JSON.stringify({kind: 'joined', host: netplay().id}));
                    netplay().adoptPeer(connection, channel, 'lobby-' + btoa(visitorId), 'direct-host');
                    this.change();
                };
            };
            setTimeout(() => {
                if (this.visitors.get(visitorId) === visitor) {
                    this.visitors.delete(visitorId);
                    connection.close();
                    this.change();
                }
            }, VISITOR_TIMEOUT_MS);
            await connection.setRemoteDescription(message.offer);
            await connection.setLocalDescription(await connection.createAnswer());
            await helpers().waitForIce(connection);
            tracker.send({action: 'announce', info_hash: this.infoHash, peer_id: this.peerId,
                to_peer_id: visitorId, offer_id: message.offer_id,
                answer: {type: 'answer', sdp: connection.localDescription.sdp}});
            this.change();
        }

        // ── Browsing ─────────────────────────────────────────────────────
        browse() {
            return this.start('browse');
        }

        async makeOffers(count) {
            const offers = [];
            for (let i = 0; i < count; i++) {
                const connection = new RTCPeerConnection({iceServers: netplay().useStun ? helpers().PUBLIC_STUN : []});
                const channel = connection.createDataChannel('local-play', {ordered: true});
                channel.binaryType = 'arraybuffer';
                const offerId = randomBinaryId();
                this.offers.set(offerId, {connection, channel, created: Date.now()});
                await connection.setLocalDescription(await connection.createOffer());
                offers.push({connection, offerId});
            }
            await Promise.all(offers.map(({connection}) => helpers().waitForIce(connection)));
            return offers.map(({connection, offerId}) => ({offer_id: offerId,
                offer: {type: 'offer', sdp: connection.localDescription.sdp}}));
        }

        acceptAnswer(message) {
            const pending = this.offers.get(message.offer_id);
            if (!pending) return;
            this.offers.delete(message.offer_id);
            const {connection, channel} = pending;
            channel.onmessage = ({data}) => {
                if (typeof data !== 'string') return;
                const card = JSON.parse(data);
                if (card.kind === 'lobby') {
                    const known = this.lobbies.get(card.host);
                    if (known && known.connection !== connection) {
                        connection.close(); // already listed through another tracker or offer
                        return;
                    }
                    this.lobbies.set(card.host, {...card, connection, channel, seen: Date.now()});
                    this.change();
                } else if (card.kind === 'joined') {
                    this.finishJoin(card, connection, channel);
                }
            };
            channel.onclose = () => {
                for (const [id, lobby] of this.lobbies) {
                    if (lobby.connection === connection) this.lobbies.delete(id);
                }
                this.change();
            };
            connection.setRemoteDescription(message.answer).catch(() => connection.close());
        }

        join(hostId) {
            const lobby = this.lobbies.get(hostId);
            if (!lobby || lobby.channel.readyState !== 'open') throw new Error('That lobby is no longer available.');
            this.joining = hostId;
            lobby.channel.send(JSON.stringify({kind: 'join'}));
        }

        finishJoin(card, connection, channel) {
            const lobby = this.lobbies.get(card.host ?? this.joining) || this.lobbies.get(this.joining);
            if (!lobby || lobby.connection !== connection) return;
            // Keep this connection; close every other lobby and stop browsing.
            this.lobbies.delete(lobby.host);
            this.joining = null;
            this.stop();
            netplay().adoptPeer(connection, channel, lobby.host, 'direct-guest');
            this.dispatchEvent(new CustomEvent('joined', {detail: lobby}));
        }

        // ── Tracker protocol ─────────────────────────────────────────────
        async announce(tracker) {
            if (!this.role || !tracker.open) return;
            const message = {action: 'announce', info_hash: this.infoHash, peer_id: this.peerId,
                uploaded: 0, downloaded: 0, left: this.role === 'host' ? 0 : 1, event: 'started'};
            if (this.role === 'browse') {
                // Drop unanswered offers from earlier announces.
                for (const [id, pending] of this.offers) {
                    if (Date.now() - pending.created > BROWSE_ANNOUNCE_MS * 2) {
                        pending.connection.close();
                        this.offers.delete(id);
                    }
                }
                message.numwant = OFFERS_PER_ANNOUNCE;
                message.offers = await this.makeOffers(OFFERS_PER_ANNOUNCE);
            } else {
                message.numwant = 0;
            }
            tracker.send(message);
        }

        onTrackerMessage(tracker, message) {
            if (message.info_hash !== this.infoHash || message.peer_id === this.peerId) return;
            if (message.offer && this.role === 'host') {
                this.answerOffer(tracker, message).catch(() => {});
            } else if (message.answer && this.role === 'browse') {
                this.acceptAnswer(message);
            }
        }
    }

    const lobbies = new Lobbies();
    window.AzaharLobbies = lobbies;
    window.addEventListener('pagehide', () => lobbies.stop());

    // ── Card UI ──────────────────────────────────────────────────────────
    function bindUi() {
        const $ = id => document.getElementById(id);
        const list = $('public-lobby-list');
        if (!list) return;
        const status = $('public-lobby-status');
        const say = (text, kind = '') => {
            status.textContent = text;
            status.dataset.kind = kind;
        };
        const run = action => async () => {
            try {
                await action();
            } catch (error) {
                say(error.message || String(error), 'error');
            }
        };
        $('btn-public-lobby-host').addEventListener('click', run(async () => {
            await lobbies.host($('public-lobby-name').value.trim());
            say('Your lobby is public. Players who find it can join; then open the game\'s local wireless menu.', 'ok');
        }));
        $('btn-public-lobby-find').addEventListener('click', run(async () => {
            await lobbies.browse();
            say('Looking for public lobbies…');
        }));
        $('btn-public-lobby-stop').addEventListener('click', () => {
            lobbies.stop();
            say('Not listed and not looking.');
        });
        lobbies.addEventListener('joined', ({detail}) =>
            say(`Joined ${detail.name}. Open the game's local wireless menu.`, 'ok'));

        const render = () => {
            const state = lobbies.status();
            const ownTitle = netplay()?.titleId();
            $('btn-public-lobby-stop').disabled = !state.role;
            const trackersUp = state.trackers.filter(tracker => tracker.open).length;
            if (state.role && !trackersUp) say('Connecting to lobby trackers…');
            else if (state.role === 'host') {
                say(`Hosting "${state.lobbyName}" publicly (${trackersUp} tracker${trackersUp === 1 ? '' : 's'}).`, 'ok');
            }
            list.replaceChildren(...state.lobbies.map(lobby => {
                const item = document.createElement('li');
                const sameGame = !ownTitle || lobby.title === ownTitle;
                item.textContent = `${lobby.name} — ${lobby.players}/${lobby.max} — ${lobby.title || 'no game'}` +
                    (sameGame ? '' : ' (different game)');
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn btn-success';
                button.textContent = 'Join';
                button.disabled = lobby.players >= lobby.max;
                button.addEventListener('click', run(() => {
                    lobbies.join(lobby.host);
                    say(`Joining ${lobby.name}…`);
                }));
                item.append(' ', button);
                return item;
            }));
            if (state.role === 'browse' && trackersUp && !state.lobbies.length) say('Looking for public lobbies…');
        };
        lobbies.addEventListener('change', render);
        render();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUi);
    else bindUi();
})();
