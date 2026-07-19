// Zero-dependency production server: serves dist/ statically and mounts the
// same /api/proxy handler used by the Vite dev server.
//
//   node server.js [--port N | --port=N] [--host H | --host=H]
//   PORT=8080 HOST=127.0.0.1 node server.js
//
// Defaults: port 7100, host 0.0.0.0

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleProxy, getRequiredKey, isKeyValid } from './proxy/hlsProxy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, 'dist');

function parseArgs(argv) {
  let port = process.env.PORT ? Number(process.env.PORT) : undefined;
  let host = process.env.HOST || undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) port = Number(arg.slice('--port='.length));
    else if (arg === '--host') host = argv[++i];
    else if (arg.startsWith('--host=')) host = arg.slice('--host='.length);
  }
  return {
    port: Number.isFinite(port) && port > 0 ? port : 7100,
    host: host || '0.0.0.0',
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  // Prevent path traversal.
  const safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(DIST_DIR, safePath);
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fs.stat(filePath);
    }
  } catch {
    // SPA fallback: unknown paths serve index.html (only for extension-less paths).
    if (!path.extname(pathname)) {
      filePath = path.join(DIST_DIR, 'index.html');
      try {
        stat = await fs.stat(filePath);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found — did you run `npm run build`?');
        return;
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
  };
  // Hash-fingerprinted assets are immutable; everything else: no-cache.
  headers['Cache-Control'] = filePath.includes(`${path.sep}assets${path.sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  res.writeHead(200, headers);
  const data = await fs.readFile(filePath);
  res.end(data);
}

const { port, host } = parseArgs(process.argv.slice(2));

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// /config.json: when the XTREAM_* env vars are set (public deployment), serve
// credentials from the environment so no secrets live in the repo. Requires a
// valid key when ACCESS_KEY is set. Otherwise falls through to the static file
// (local dev uses the untracked public/config.json).
function handleConfig(req, res, url) {
  const keyParam = url.searchParams.get('key') || '';
  if (getRequiredKey() && !isKeyValid(keyParam)) {
    sendJson(res, 403, { error: 'Invalid or missing access key', status: 403 });
    return true;
  }
  const { XTREAM_SERVER, XTREAM_USERNAME, XTREAM_PASSWORD } = process.env;
  if (XTREAM_SERVER && XTREAM_USERNAME && XTREAM_PASSWORD) {
    sendJson(res, 200, {
      server: XTREAM_SERVER,
      username: XTREAM_USERNAME,
      password: XTREAM_PASSWORD,
    });
    return true;
  }
  return false; // fall through to static
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/api/proxy') {
    void handleProxy(req, res);
    return;
  }
  if (url.pathname === '/config.json' && handleConfig(req, res, url)) {
    return;
  }
  void serveStatic(req, res, url.pathname);
});

server.listen(port, host, () => {
  console.log(`Tesla IPTV Player listening on http://${host}:${port}`);
  console.log(`Serving ${DIST_DIR}`);
});
