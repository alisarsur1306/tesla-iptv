// Dependency-free HLS / IPTV proxy for Node http servers.
// Usage: handleProxy(req, res) for GET /api/proxy?u=<urlencoded absolute URL>[&key=...]
//
// Security model (so a public deployment is not an open proxy):
// - SSRF guard: private/loopback/link-local targets are blocked for ALL requests.
// - ACCESS_KEY env var (read at request time):
//     * set   → every request must carry a matching `key` query param, else 403 JSON.
//     * unset → open local-dev mode: everything (public, non-private) is allowed.
// - No host allowlist: the key is the gate. Providers redirect segments to
//   whatever CDN or bare IP they choose, so pinning hostnames silently breaks
//   playback the moment that changes. Keep ACCESS_KEY long and random.
// - Playlist rewriting propagates the incoming `key` param into every rewritten
//   /api/proxy?u=... URL (segments, sub-playlists, EXT-X-KEY URIs).

const TIMEOUT_MS = 25_000;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** The access key required by this deployment ('' = open local-dev mode). */
export function getRequiredKey() {
  return process.env.ACCESS_KEY || '';
}

/** Is this key parameter acceptable right now? Open mode accepts everything. */
export function isKeyValid(keyParam) {
  const required = getRequiredKey();
  if (!required) return true;
  return keyParam === required;
}

/** Reject loopback / private / link-local targets. */
function isForbiddenHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === 'localhost.localdomain' || h === 'ip6-localhost') return true;
  if (h === '[::1]' || h === '::1' || h === '0.0.0.0') return true;
  // IPv4 literals
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    if (a === 0) return true; // 0.0.0.0/8
  }
  return false;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length');
}

function sendError(res, status, message) {
  setCors(res);
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({ error: message, status });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** Build the same-origin proxied URL for an absolute target URL, propagating the key. */
function proxiedUrl(absoluteUrl, key) {
  let out = `/api/proxy?u=${encodeURIComponent(absoluteUrl)}`;
  if (key) out += `&key=${encodeURIComponent(key)}`;
  return out;
}

/**
 * Rewrite an m3u8 playlist so every reference goes back through this proxy.
 * `baseUrl` must be the FINAL url (after redirects) of the playlist itself.
 * The request's access key is propagated into every rewritten URL.
 */
function rewritePlaylist(text, baseUrl, key) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith('#')) {
      // Rewrite URI="..." attributes (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, ...)
      const rewritten = line.replace(/URI="([^"]*)"/g, (_m, uri) => {
        try {
          const abs = new URL(uri, baseUrl).toString();
          return `URI="${proxiedUrl(abs, key)}"`;
        } catch {
          return _m;
        }
      });
      out.push(rewritten);
      continue;
    }
    // Segment or sub-playlist line: resolve relative to the playlist's final URL.
    try {
      const abs = new URL(trimmed, baseUrl).toString();
      out.push(proxiedUrl(abs, key));
    } catch {
      out.push(line);
    }
  }
  return out.join('\n');
}

export async function handleProxy(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    sendError(res, 405, 'Method not allowed');
    return;
  }

  let target;
  let keyParam = '';
  try {
    const selfUrl = new URL(req.url || '/', 'http://localhost');
    const u = selfUrl.searchParams.get('u');
    keyParam = selfUrl.searchParams.get('key') || '';
    if (!u) {
      sendError(res, 400, 'Missing "u" query parameter');
      return;
    }
    target = new URL(u);
  } catch {
    sendError(res, 400, 'Invalid "u" query parameter: must be an absolute URL');
    return;
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    sendError(res, 403, 'Only http/https URLs are allowed');
    return;
  }

  // SSRF guard: applies to every request, keyed or not.
  if (isForbiddenHostname(target.hostname)) {
    sendError(res, 403, 'Forbidden target host');
    return;
  }

  // Access-key gate (only when ACCESS_KEY is configured).
  const keyValid = isKeyValid(keyParam);
  if (getRequiredKey() && !keyValid) {
    sendError(res, 403, 'Invalid or missing access key');
    return;
  }

  const headers = { 'User-Agent': USER_AGENT, Accept: '*/*' };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    sendError(res, isTimeout ? 504 : 502, `Upstream fetch failed: ${String(err && err.message ? err.message : err)}`);
    return;
  }

  const upstreamType = upstream.headers.get('content-type') || '';
  const finalUrl = upstream.url || target.toString();
  const isPlaylist =
    /\.m3u8($|\?)/i.test(finalUrl) ||
    /\.m3u8($|\?)/i.test(target.toString()) ||
    /mpegurl/i.test(upstreamType);

  try {
    if (isPlaylist) {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, finalUrl, keyParam);
      const body = Buffer.from(rewritten, 'utf-8');
      res.writeHead(upstream.status, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    // Binary passthrough (.ts segments, icons, ...) — stream it.
    const responseHeaders = {
      'Content-Type': upstreamType || (finalUrl.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream'),
      'Cache-Control': 'no-store',
    };
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) responseHeaders['Content-Length'] = contentLength;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) responseHeaders['Content-Range'] = contentRange;
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) responseHeaders['Accept-Ranges'] = acceptRanges;

    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }
    const { Readable } = await import('node:stream');
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (err) {
    sendError(res, 502, `Proxy error: ${String(err && err.message ? err.message : err)}`);
  }
}
