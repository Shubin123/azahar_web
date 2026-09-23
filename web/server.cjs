#!/usr/bin/env node
'use strict';

// Minimal local server for the experimental web build.  Pthreads require the
// SharedArrayBuffer isolation headers on every response, including workers and
// the .wasm file, so a generic static-file server is not sufficient.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

function proxyArchiveUrl(targetUrl, request, response, isolationHeaders, redirectCount = 0) {
    if (redirectCount > 5) {
        response.writeHead(502, {'Content-Type': 'text/plain; charset=utf-8', ...isolationHeaders});
        response.end('Too many redirects from upstream');
        return;
    }
    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch (_) {
        response.writeHead(400, {'Content-Type': 'text/plain; charset=utf-8', ...isolationHeaders});
        response.end('Invalid URL');
        return;
    }
    if (!parsed.hostname.endsWith('archive.org')) {
        response.writeHead(403, {'Content-Type': 'text/plain; charset=utf-8', ...isolationHeaders});
        response.end('Only archive.org URLs are allowed');
        return;
    }

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AzaharWeb/1.0',
    };
    if (request.headers.range) {
        headers['Range'] = request.headers.range;
    }

    const client = parsed.protocol === 'http:' ? http : https;
    const proxyReq = client.get(parsed, { headers }, upstreamRes => {
        if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && upstreamRes.headers.location) {
            const nextUrl = new URL(upstreamRes.headers.location, targetUrl).toString();
            proxyArchiveUrl(nextUrl, request, response, isolationHeaders, redirectCount + 1);
            return;
        }

        const outHeaders = {
            'Content-Type': upstreamRes.headers['content-type'] || 'application/octet-stream',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Range, Accept-Encoding',
            'Accept-Ranges': 'bytes',
        };
        if (upstreamRes.headers['content-length']) {
            outHeaders['Content-Length'] = upstreamRes.headers['content-length'];
        }
        if (upstreamRes.headers['content-disposition']) {
            outHeaders['Content-Disposition'] = upstreamRes.headers['content-disposition'];
        }
        if (upstreamRes.headers['content-range']) {
            outHeaders['Content-Range'] = upstreamRes.headers['content-range'];
        }

        response.writeHead(upstreamRes.statusCode || 200, outHeaders);
        if (request.method === 'HEAD') {
            response.end();
            proxyReq.destroy();
        } else {
            upstreamRes.pipe(response);
        }
    });

    proxyReq.on('error', err => {
        if (!response.headersSent) {
            response.writeHead(502, {'Content-Type': 'text/plain; charset=utf-8', ...isolationHeaders});
            response.end(`Upstream request failed: ${err.message}`);
        }
    });

    request.on('close', () => {
        proxyReq.destroy();
    });
}

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

function createWebServer(root = WEB_ROOT, virtualFiles = {}, options = {}) {
    const resolvedRoot = path.resolve(root);
    const isolationHeaders = options.crossOriginIsolation === false ? {} : {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
    };
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
            pathname = pathname.slice('/web'.length) || '/index.html';
        }

        if (pathname === '/api/rom-proxy') {
            const urlParam = new URL(request.url, 'http://localhost').searchParams.get('url');
            if (!urlParam) {
                response.writeHead(400, {'Content-Type': 'text/plain; charset=utf-8', ...isolationHeaders});
                response.end('Missing required "url" parameter');
                return;
            }
            proxyArchiveUrl(urlParam, request, response, isolationHeaders);
            return;
        }

        if (pathname === '/api/games' || pathname === '/api/library') {
            pathname = '/games_library.json';
        }

        const virtualFile = virtualFiles[pathname];
        if (virtualFile) {
            response.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                ...isolationHeaders,
                'Cache-Control': 'no-store',
            });
            response.end(request.method === 'HEAD' ? undefined : virtualFile);
            return;
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
                ...isolationHeaders,
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

function listen(port = 8765, host = '127.0.0.1', options = {}) {
    const server = createWebServer(options.root || WEB_ROOT, options.virtualFiles || {}, options);
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
