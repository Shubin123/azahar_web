#!/usr/bin/env node
'use strict';

// Serves the local W1-1 state fixture to browser-harness-driven E2E checks.
// It deliberately has no browser automation dependency: the test browser is
// controlled separately through the shared CDP harness.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {createWebServer} = require('../web/server.cjs');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function argument(name, fallback = null) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] || fallback : fallback;
}

const statePath = argument('--state');
const port = Number.parseInt(argument('--port', '8765'), 10);

if (!statePath || !fs.existsSync(statePath)) {
    throw new Error('Usage: node tests/serve_gameplay_fixture.cjs --state <moving-gameplay.cst> [--port 8765]');
}

const state = fs.readFileSync(statePath);
const webServer = createWebServer(path.join(root, 'web'));
const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/gameplay_state') {
        response.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': state.length,
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'no-store',
        });
        response.end(state);
        return;
    }
    webServer.emit('request', request, response);
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Gameplay fixture server: http://127.0.0.1:${port}/`);
});
