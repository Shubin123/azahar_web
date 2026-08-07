#!/usr/bin/env node
'use strict';

// Minimal local server for the experimental web build.  Pthreads require the
// SharedArrayBuffer isolation headers on every response, including workers and
// the .wasm file, so a generic static-file server is not sufficient.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WEB_ROOT = __dirname;
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};

function createWebServer(root = WEB_ROOT) {
    const resolvedRoot = path.resolve(root);
    return http.createServer((request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, {Allow: 'GET, HEAD'});
            response.end();
            return;
        }

        let pathname;
        try {
            pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        } catch (_) {
            response.writeHead(400);
            response.end('Bad request');
            return;
        }
        if (pathname === '/') pathname = '/index.html';
        // Allow both the direct server URL (/) and the user's existing
        // /web/index.html URL when this script is launched from the workspace.
        if (pathname === '/web' || pathname.startsWith('/web/')) {
            pathname = pathname.slice('/web'.length) || '/index_webgl2.html';
        }

        const file = path.resolve(resolvedRoot, `.${pathname}`);
        if (file !== resolvedRoot && !file.startsWith(`${resolvedRoot}${path.sep}`)) {
            response.writeHead(403);
            response.end('Forbidden');
            return;
        }

        fs.stat(file, (error, stat) => {
            if (error || !stat.isFile()) {
                response.writeHead(404);
                response.end('Not found');
                return;
            }
            response.writeHead(200, {
                'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Resource-Policy': 'same-origin',
                'Cache-Control': 'no-store',
            });
            if (request.method === 'HEAD') {
                response.end();
            } else {
                fs.createReadStream(file).pipe(response);
            }
        });
    });
}

function listen(port = 8765, host = '127.0.0.1') {
    const server = createWebServer();
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            resolve(server);
        });
    });
}

if (require.main === module) {
    const port = Number.parseInt(process.env.PORT || '8765', 10);
    const host = process.env.HOST || '127.0.0.1';
    listen(port, host).then(server => {
        const address = server.address();
        console.log(`Azahar web server: http://${address.address}:${address.port}/`);
    }).catch(error => {
        console.error(error.stack || error);
        process.exitCode = 1;
    });
}

module.exports = {createWebServer, listen};
