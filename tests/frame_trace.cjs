/**
 * frame_trace.cjs
 * Counts the local wireless frames a console sends and receives, per second of its
 * game time, so a test that fails can show which side went quiet first and on which
 * data channel. Frames are the engine's (see RoomMember::SendWifiPacket): message id,
 * frame type, channel, transmitter and destination MACs, a big-endian length and the
 * 802.11 payload; data frames carry an LLC header and the UDS secure-data header.
 */
'use strict';

const fs = require('node:fs');

// Wraps the console's frame paths (Module.azaharNetSend calls netplay.sendFrame; every
// link hands frames to netplay.deliver).
async function installFrameTrace(target) {
    await target.evaluate(() => {
        const netplay = window.AzaharNetplay;
        if (netplay.frameTrace) return;
        const trace = netplay.frameTrace = { seconds: new Map(), clocks: [], unicast: [] };
        // Once a second of real time: the game clock, the pacing speed and the lead over
        // the peer furthest behind, to line the consoles' clocks up afterwards.
        setInterval(() => {
            const lead = netplay.clockLead?.();
            trace.clocks.push(`wall=${(Date.now() / 1000).toFixed(1)} game=${((netplay.guestTimeUs() || 0) / 1e6).toFixed(2)}` +
                ` speed=${netplay.speedPermille} lead=${lead ? Math.round(lead.lead / 1000) : '-'}ms` +
                ` peerRate=${lead ? Math.round(lead.rate) : '-'} cpu=${window.AzaharUI.getCpuClock?.().percent ?? '-'}%`);
        }, 1000);
        const TYPES = ['beacon', 'data', 'auth', 'assoc', 'deauth', 'nodemap'];
        const count = (direction, bytes) => {
            let kind = TYPES[bytes[1]] || `type${bytes[1]}`;
            if (bytes[1] === 1 && bytes.length >= 41 && bytes[25] === 0x87 && bytes[26] === 0x6D) {
                const destination = (bytes[37] << 8) | bytes[38];
                const size = ((bytes[27] << 8) | bytes[28]) - 14;
                kind = `ch${bytes[34]} ${(bytes[39] << 8) | bytes[40]}>${destination}`;
                // Unicast messages are rare and tell the protocol's steps apart: keep each one.
                if (destination !== 0xFFFF && trace.unicast.length < 20000) {
                    const head = Array.from(bytes.subarray(41, 41 + Math.min(size, 24)),
                        b => b.toString(16).padStart(2, '0')).join('');
                    trace.unicast.push(`${((netplay.guestTimeUs() || 0) / 1e6).toFixed(3)} ${direction} ${kind} ${size}B ${head}`);
                }
                kind += ` ${size}B`;
            } else if (bytes[1] === 1 && bytes[25] === 0x88 && bytes[26] === 0x8E) {
                kind = 'eapol';
            }
            const second = Math.floor((netplay.guestTimeUs() || 0) / 1e6);
            if (!trace.seconds.has(second)) trace.seconds.set(second, new Map());
            const counts = trace.seconds.get(second);
            const key = `${direction} ${kind}`;
            counts.set(key, (counts.get(key) || 0) + 1);
        };
        const send = netplay.sendFrame.bind(netplay);
        netplay.sendFrame = bytes => { count('out', bytes); return send(bytes); };
        const deliver = netplay.deliver.bind(netplay);
        netplay.deliver = bytes => { count('in', bytes); return deliver(bytes); };
    });
}

// One line per second of game time: "t=271 out ch1 2>1 x30, in ch1 1>2 x31, ...".
async function frameTraceLines(target) {
    return target.evaluate(() => {
        const trace = window.AzaharNetplay.frameTrace;
        if (!trace) return [];
        return [...trace.seconds].sort((a, b) => a[0] - b[0]).map(([second, counts]) =>
            `t=${second} ${[...counts].sort().map(([key, n]) => `${key} x${n}`).join(', ')}`)
            .concat(['', 'clocks:'], trace.clocks, ['', 'unicast:'], trace.unicast);
    }).catch(() => []);
}

// Writes the trace to `file` and returns the last `tail` seconds of frames.
async function saveFrameTrace(target, file, tail = 8) {
    const lines = await frameTraceLines(target);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const frames = lines.indexOf('');
    return lines.slice(0, frames < 0 ? lines.length : frames).slice(-tail);
}

module.exports = { installFrameTrace, frameTraceLines, saveFrameTrace };
