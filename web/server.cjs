#!/usr/bin/env node
'use strict';

// Minimal local server for the experimental web build.  Pthreads require the
// SharedArrayBuffer isolation headers on every response, including workers and
// the .wasm file, so a generic static-file server is not sufficient.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createLanSaveStore} = require('./lan_saves.cjs');

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
    // Shared saves are opt-in so test servers never touch a real save folder.
    const lanSaves = options.saveDir ? createLanSaveStore(options.saveDir) : null;
    const handler = (request, response) => {
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

        if (lanSaves && (pathname === '/api/saves' || pathname.startsWith('/api/saves/'))) {
            lanSaves.handle(request, response, pathname, isolationHeaders);
            return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, {Allow: 'GET, HEAD'});
            response.end();
            return;
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
    };
    return options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
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

function lanAddresses() {
    return Object.values(os.networkInterfaces()).flat()
        .filter(entry => entry && entry.family === 'IPv4' && !entry.internal)
        .map(entry => entry.address);
}

// Other devices must load the page over HTTPS: browsers only allow the
// SharedArrayBuffer the emulator needs in a secure context, and plain HTTP
// is secure only on localhost. TLS_CERT/TLS_KEY take a trusted certificate
// (for example from mkcert); otherwise a self-signed one is made once with
// openssl, which each device accepts on its first visit.
function loadTlsCredentials(directory) {
    if (process.env.TLS_CERT && process.env.TLS_KEY) {
        return {cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY)};
    }
    const cert = path.join(directory, 'cert.pem');
    const key = path.join(directory, 'key.pem');
    const names = ['DNS:localhost', `DNS:${os.hostname()}`, 'IP:127.0.0.1',
        ...lanAddresses().map(address => `IP:${address}`)];
    const namesFile = path.join(directory, 'names.txt');
    let previousNames = '';
    try { previousNames = fs.readFileSync(namesFile, 'utf8'); } catch (_) {}
    // Regenerate when this machine's addresses change so the certificate
    // still names the address other devices type.
    if (!fs.existsSync(cert) || !fs.existsSync(key) || previousNames !== names.join(',')) {
        fs.mkdirSync(directory, {recursive: true});
        const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-sha256', '-days', '825', '-subj', '/CN=Azahar Web LAN',
            '-addext', `subjectAltName=${names.join(',')}`, '-keyout', key, '-out', cert],
        {stdio: 'pipe'});
        if (result.status !== 0) return null;
        fs.writeFileSync(namesFile, names.join(','));
    }
    return {cert: fs.readFileSync(cert), key: fs.readFileSync(key)};
}

if (require.main === module) {
    const lan = process.argv.includes('--lan');
    const port = Number.parseInt(process.env.PORT || '8765', 10);
    const host = process.env.HOST || (lan ? '0.0.0.0' : '127.0.0.1');
    const saveDir = process.env.SAVE_DIR || path.join(__dirname, '..', 'saves');
    let tls = null;
    if (lan) {
        tls = loadTlsCredentials(path.join(__dirname, '..', '.tls'));
        if (!tls) {
            console.warn('openssl was not found, so the LAN server uses plain HTTP. Other devices\n' +
                'cannot run the emulator over HTTP; set TLS_CERT and TLS_KEY to serve HTTPS.');
        }
    }
    listen(port, host, {saveDir, tls}).then(server => {
        const address = server.address();
        const scheme = tls ? 'https' : 'http';
        const shown = address.address === '0.0.0.0' ? 'localhost' : address.address;
        console.log(`Azahar web server: ${scheme}://${shown}:${address.port}/`);
        if (address.address === '0.0.0.0') {
            for (const lanAddress of lanAddresses()) {
                console.log(`  on your network: ${scheme}://${lanAddress}:${address.port}/`);
            }
        }
        console.log(`Shared save states: ${path.resolve(saveDir)}`);
    }).catch(error => {
        console.error(error.stack || error);
        process.exitCode = 1;
    });
}

module.exports = {createWebServer, listen};
