'use strict';
// A minimal WebTorrent-style WebSocket tracker for testing public lobbies
// without the internet. Like the public trackers web/azahar_lobbies.js uses, it
// only forwards WebRTC offers to other peers announcing the same swarm and
// routes their answers back; it never sees game traffic.
const { WebSocketServer } = require('ws');

function startTracker(port = 0) {
    const swarms = new Map(); // info_hash -> Map(peer_id -> socket)
    const server = new WebSocketServer({ port, host: '127.0.0.1' });
    const stats = { announces: 0, offersForwarded: 0, answersForwarded: 0 };

    server.on('connection', socket => {
        const joined = new Set(); // [info_hash, peer_id] keys this socket announced
        socket.on('message', raw => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (message.action !== 'announce' || typeof message.info_hash !== 'string') return;
            stats.announces++;
            const swarm = swarms.get(message.info_hash) || new Map();
            swarms.set(message.info_hash, swarm);
            if (message.event === 'stopped') {
                swarm.delete(message.peer_id);
                return;
            }
            swarm.set(message.peer_id, socket);
            joined.add(JSON.stringify([message.info_hash, message.peer_id]));

            if (message.answer && message.to_peer_id) {
                const target = swarm.get(message.to_peer_id);
                if (target?.readyState === 1) {
                    target.send(JSON.stringify({ action: 'announce', info_hash: message.info_hash,
                        peer_id: message.peer_id, offer_id: message.offer_id, answer: message.answer }));
                    stats.answersForwarded++;
                }
                return;
            }
            const others = [...swarm].filter(([id, peer]) => id !== message.peer_id && peer.readyState === 1);
            for (const [index, offer] of (message.offers || []).entries()) {
                const [, peer] = others[index] || [];
                if (!peer) break;
                peer.send(JSON.stringify({ action: 'announce', info_hash: message.info_hash,
                    peer_id: message.peer_id, offer_id: offer.offer_id, offer: offer.offer }));
                stats.offersForwarded++;
            }
            socket.send(JSON.stringify({ action: 'announce', info_hash: message.info_hash, interval: 120,
                complete: others.length, incomplete: 0 }));
        });
        socket.on('close', () => {
            for (const key of joined) {
                const [hash, peer] = JSON.parse(key);
                if (swarms.get(hash)?.get(peer) === socket) swarms.get(hash).delete(peer);
            }
        });
    });

    return new Promise(resolve => server.on('listening', () => resolve({
        url: `ws://127.0.0.1:${server.address().port}`,
        stats,
        close: () => new Promise(done => server.close(done)),
    })));
}

module.exports = { startTracker };
