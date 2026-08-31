// HLS / IPTV proxy for Node http servers. Uses undici (the same HTTP stack Node's
// global fetch is built on) for its ProxyAgent — see UPSTREAM_PROXY below.
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
// - Two optional transports exist for the Xtream API host, which Cloudflare
//   refuses to serve to datacenter IPs. Either one carries ONLY that host's
//   small API/redirect requests; video segments always go direct. See DEPLOY.md.
//     * XTREAM_PROXY_URL — a Cloudflare Worker that re-fetches the host from
//       Cloudflare's own network (which the origin does not block). Needs no
//       always-on hardware, so it wins when both are set.
//     * UPSTREAM_PROXY — an HTTP proxy (a Tailscale exit node, or a commercial
//       residential proxy) that borrows a non-datacenter IP.

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// undici's fetch is used ONLY for requests routed through the Tailscale proxy
// (plain HTTP to the Xtream host). Direct traffic uses Node's built-in fetch:
// undici 8.7's standalone agent crashes the process with an uncaught TypeError
// in closeClientIfUnused when an HTTP/2 CDN connection closes after streaming.
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { gzip } from 'node:zlib';

// Connect timeout for a streaming request: it covers the handshake only and is
// cleared once the headers arrive, because a live channel's body never ends.
const TIMEOUT_MS = 25_000;
// Whole-response timeout for a bulk list download (the Xtream player_api channel
// lists and the M3U playlist). Those are megabytes of JSON pulled through the
// upstream proxy in one shot, so the streaming budget was routinely too short and
// the client got "Channel list failed" instead of a channel list. Streaming is
// unaffected — it keeps TIMEOUT_MS.
const LIST_TIMEOUT_MS = 90_000;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Hosts reached through UPSTREAM_PROXY when it is set. Only the Xtream API host
// belongs here: it sits behind Cloudflare, which blocks datacenter IPs, so on a
// cloud deployment those requests must exit via a residential IP (see DEPLOY.md).
// Segments redirect to a CDN that does NOT block datacenter IPs and whose tokens
// are not IP-bound, so they go direct — keeping the video off the tunnel.
const PROXY_HOST_SUFFIXES = ['snapmediatoghater.site'];

/** HTTP proxy for Cloudflare-blocked hosts, e.g. '127.0.0.1:1055'. Unset = direct. */
function getUpstreamProxy() {
  return process.env.UPSTREAM_PROXY || '';
}

/** Cloudflare Worker base URL that re-fetches the Xtream host. Unset = direct. */
function getXtreamProxyUrl() {
  return process.env.XTREAM_PROXY_URL || '';
}

function isXtreamHost(hostname) {
  const h = hostname.toLowerCase();
  return PROXY_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

/**
 * How a request to `hostname` is carried: 'worker' | 'tunnel' | 'direct'.
 * Only the Xtream host is ever diverted. The Worker wins when both transports
 * are configured — it needs no always-on hardware, so it is the more reliable
 * of the two; leaving UPSTREAM_PROXY set keeps the tunnel one env var away.
 */
function transportFor(hostname) {
  if (!isXtreamHost(hostname)) return 'direct';
  if (getXtreamProxyUrl()) return 'worker';
  if (getUpstreamProxy()) return 'tunnel';
  return 'direct';
}

/** Wrap a target URL as a call to the Worker: <worker>?u=<target>&t=<token>. */
function toWorkerUrl(target) {
  const base = getXtreamProxyUrl();
  const token = process.env.XTREAM_PROXY_TOKEN || '';
  let out = `${base}${base.includes('?') ? '&' : '?'}u=${encodeURIComponent(target)}`;
  if (token) out += `&t=${encodeURIComponent(token)}`;
  return out;
}

let cachedAgent = null;
let cachedAgentFor = '';
function proxyAgent() {
  const spec = getUpstreamProxy();
  if (cachedAgentFor !== spec) {
    cachedAgent = new ProxyAgent(spec.includes('://') ? spec : `http://${spec}`);
    cachedAgentFor = spec;
  }
  return cachedAgent;
}

/**
 * fetch() with per-hop transport selection. Redirects are followed manually for
 * two reasons: the Xtream host 302s to an HTTPS CDN that must be fetched DIRECTLY
 * (otherwise the whole video would ride the Worker or the tunnel), and letting
 * undici follow it lands the CDN connection on undici's H2 client — whose idle
 * close crashes the process (agent.js closeClientIfUnused TypeError). Each hop
 * therefore re-picks its transport and re-checks the SSRF guard.
 */
async function upstreamFetch(target, options) {
  let url = target;
  for (let hop = 0; hop < 5; hop++) {
    if (isForbiddenHostname(url.hostname)) throw new Error('Redirect to forbidden host');
    const transport = transportFor(url.hostname);
    let resp;
    if (transport === 'worker') {
      // The Worker is asked for the target; `url` stays the real one, so a
      // relayed Location still resolves against the origin, not the Worker.
      resp = await globalThis.fetch(toWorkerUrl(url.toString()), { ...options, redirect: 'manual' });
    } else if (transport === 'tunnel') {
      resp = await undiciFetch(url.toString(), { ...options, dispatcher: proxyAgent(), redirect: 'manual' });
    } else {
      resp = await globalThis.fetch(url.toString(), { ...options, redirect: 'manual' });
    }
    const location = resp.status >= 300 && resp.status < 400 && resp.headers.get('location');
    if (!location) {
      // resp.url is the URL fetch was ASKED for — the Worker's, on a worker hop.
      // Playlist rewriting resolves segment URLs against this, so record the
      // origin URL that actually served the body.
      Object.defineProperty(resp, 'realUrl', { value: url.toString() });
      return resp;
    }
    try {
      await resp.body?.cancel();
    } catch {
      /* ignore */
    }
    url = new URL(location, url);
  }
  throw new Error('Too many redirects');
}

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

// --- Server-side Xtream credentials ---------------------------------------
// The account (server/username/password) is resolved ONLY here, on the server,
// and never sent to the browser. The client asks for "the channel list" or
// "stream channel N" via opaque same-origin endpoints; this module attaches the
// credentials. A reverse-engineered client therefore reveals no usable account.
//
// Source order: XTREAM_* env vars (production), else public/config.json (dev).

let cachedCreds;
function getXtreamCreds() {
  if (cachedCreds !== undefined) return cachedCreds;
  const { XTREAM_SERVER, XTREAM_USERNAME, XTREAM_PASSWORD } = process.env;
  if (XTREAM_SERVER && XTREAM_USERNAME && XTREAM_PASSWORD) {
    cachedCreds = {
      server: XTREAM_SERVER.replace(/\/+$/, ''),
      username: XTREAM_USERNAME,
      password: XTREAM_PASSWORD,
    };
    return cachedCreds;
  }
  try {
    const cfg = JSON.parse(readFileSync(new URL('../public/config.json', import.meta.url), 'utf8'));
    if (cfg.server && cfg.username && cfg.password) {
      cachedCreds = {
        server: String(cfg.server).replace(/\/+$/, ''),
        username: cfg.username,
        password: cfg.password,
      };
      return cachedCreds;
    }
  } catch {
    /* no config file — managed mode unavailable */
  }
  cachedCreds = null;
  return cachedCreds;
}

// --- Server-side M3U playlist source (alternative to Xtream) ---------------
// A plain M3U/M3U8 CHANNEL LIST (#EXTINF lines + a stream URL per channel), as
// many providers hand out instead of Xtream credentials. Parsed and cached
// server-side; the client sees only opaque channel ids and metadata (name /
// logo / group) — never the playlist URL or the stream URLs (which usually
// embed the account). Source: M3U_URL env var, else public/playlist.m3u (dev).

const M3U_TTL_MS = 30 * 60 * 1000; // re-fetch the playlist at most twice an hour
let m3uCache = null;
let m3uCacheAt = 0;

// A playlist exported from this server contains the account in every stream URL, so the only
// safe place to host it is somewhere private — which means the fetch needs to authenticate.
// M3U_AUTH is sent verbatim as the Authorization header, so any scheme works:
//   M3U_AUTH="Bearer ghp_..."   with a GitHub contents API URL (private repo)
//   M3U_AUTH="Basic <base64>"   for anything using HTTP basic auth
// The GitHub raw media type is offered first so a contents URL returns the file itself rather
// than its JSON metadata; */* keeps every other host happy.
export function m3uHeaders() {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github.raw, */*',
  };
  if (process.env.M3U_AUTH) headers.Authorization = process.env.M3U_AUTH;
  return headers;
}

function getM3uSource() {
  if (process.env.M3U_URL) return { kind: 'url', value: process.env.M3U_URL };
  try {
    const p = new URL('../public/playlist.m3u', import.meta.url);
    readFileSync(p); // throws if absent
    return { kind: 'file', value: p };
  } catch {
    return null;
  }
}

/** Parse an M3U channel list into { name, logo, group, url } entries. */
export function parseM3u(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let pending = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      const comma = line.lastIndexOf(',');
      pending = {
        name: (comma >= 0 ? line.slice(comma + 1) : line).trim(),
        logo: (line.match(/tvg-logo="([^"]*)"/i) || [])[1] || '',
        group: (line.match(/group-title="([^"]*)"/i) || [])[1] || 'Uncategorized',
      };
    } else if (line && !line.startsWith('#')) {
      // The URL line closes the current entry (or stands alone if malformed).
      channels.push({
        name: pending?.name || line,
        logo: pending?.logo || '',
        group: pending?.group || 'Uncategorized',
        url: line,
      });
      pending = null;
    }
  }
  return channels;
}

/** Fetch + parse the configured M3U (cached). Null when no M3U source is set. */
async function getM3uChannels() {
  const src = getM3uSource();
  if (!src) return null;
  if (m3uCache && Date.now() - m3uCacheAt < M3U_TTL_MS) return m3uCache;
  let text;
  if (src.kind === 'file') {
    text = readFileSync(src.value, 'utf8');
  } else {
    const resp = await upstreamFetch(new URL(src.value), {
      redirect: 'follow',
      headers: m3uHeaders(),
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // 401/404 on a private host almost always means the token, not the file: GitHub returns
      // 404 rather than 403 for a repo the credential cannot see, which reads as "wrong URL".
      const hint =
        resp.status === 401 || resp.status === 403
          ? ' — M3U_AUTH was rejected'
          : resp.status === 404 && process.env.M3U_AUTH
            ? ' — not found, or M3U_AUTH cannot see it (private hosts often return 404 instead of 403)'
            : '';
      throw new Error(`M3U fetch failed (${resp.status})${hint}`);
    }
    text = await resp.text();
  }
  m3uCache = parseM3u(text);
  m3uCacheAt = Date.now();
  return m3uCache;
}

/**
 * Shape parsed M3U channels as the Xtream response the client expects for
 * `action`. The channel's array index is its opaque stream id.
 */
function shapeM3uAs(channels, action) {
  if (action === 'get_live_categories') {
    const seen = new Set();
    const data = [];
    for (const c of channels) {
      if (seen.has(c.group)) continue;
      seen.add(c.group);
      data.push({ category_id: c.group, category_name: c.group });
    }
    return data;
  }
  if (action === 'get_live_streams') {
    return channels.map((c, i) => ({
      stream_id: i,
      name: c.name,
      stream_icon: c.logo,
      category_id: c.group,
    }));
  }
  return { user_info: { auth: 1, status: 'Active' } }; // login: always active
}

/** The M3U answer for `action`, or null when no M3U source is configured. */
async function m3uResponse(action) {
  const channels = await getM3uChannels();
  if (!channels) return null;
  return shapeM3uAs(channels, action);
}

/** Which source is configured — Xtream takes priority when both are set. */
function getSourceType() {
  if (getXtreamCreds()) return 'xtream';
  if (getM3uSource()) return 'm3u';
  return null;
}

/** True when the server holds a source (Xtream or M3U), so the client can skip the login screen. */
export function isManaged() {
  return getSourceType() !== null;
}

function keyGate(req, res, url) {
  const keyParam = url.searchParams.get('key') || '';
  if (getRequiredKey() && !isKeyValid(keyParam)) {
    sendError(res, 403, 'Invalid or missing access key');
    return false;
  }
  return true;
}

// The player_api actions that download the whole channel list (as opposed to the
// tiny login probe): slow, big, and worth both the long timeout and the cache.
const LIST_ACTIONS = new Set(['get_live_streams', 'get_live_categories']);

// player_api responses are cached for 30 minutes, matching M3U_TTL_MS. The list
// changes rarely but every page load asked for it again, re-paying a multi-
// megabyte download through the upstream proxy — the reason the channel list
// timed out under load. Entries are kept past their TTL on purpose: a stale list
// still beats an error when the upstream is down (see handleXtreamApi).
// When Xtream is unreachable, every request paid the full LIST_TIMEOUT_MS before falling back
// — so an app with a perfectly good M3U backup still took 90s per list, twice over, and looked
// dead. One failure is enough to know: skip straight to the fallback for a cooldown, then try
// again. This is what makes a broken exit node degrade into "slightly stale" rather than "down".
// Short, because a background probe (below) is what actually detects recovery — this is only
// the ceiling on how long we would stay pessimistic if every probe also failed.
const XTREAM_COOLDOWN_MS = 60 * 1000;
// One probe at a time while marked down, so a burst of requests does not become a burst of
// upstream calls.
let xtreamProbe = null;
// How long a viewer may be made to wait for the provider when we already hold something to
// show. The cooldown alone was not enough: it expires, the next request retries live, and that
// one viewer pays the full 90s. Nobody should ever wait 90s for a list we could serve instantly
// — so the provider gets this long to win the race, and otherwise keeps loading in the
// background to populate the cache for next time.
const FAST_FAIL_MS = 8000;

/** Races a call against a deadline, reporting WHICH of the three things happened. The
 *  distinction matters more than it looks: an instant Cloudflare 403 and a silent blackhole are
 *  opposite diagnoses — one means the request arrived and was refused, the other means it never
 *  got there — and collapsing both into "no answer" sends you to debug the wrong layer.
 *  On timeout the underlying promise keeps running, so its result still reaches the cache. */
function raceDeadline(promise, ms) {
  let timer;
  const attempt = promise.then((value) => ({ value }), (error) => ({ error }));
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([attempt, deadline]).finally(() => clearTimeout(timer));
}
let xtreamDownUntil = 0;
let xtreamLastError = '';
const xtreamIsDown = () => Date.now() < xtreamDownUntil;
function noteXtreamFailure(err) {
  xtreamDownUntil = Date.now() + XTREAM_COOLDOWN_MS;
  xtreamLastError = String(err && err.message ? err.message : err);
}
function noteXtreamSuccess() {
  xtreamDownUntil = 0;
  xtreamLastError = '';
}

const XTREAM_TTL_MS = 30 * 60 * 1000;
const xtreamCache = new Map(); // action -> { at, data }

// The in-memory cache dies with the process, so a restart began with nothing and the app was
// entirely dependent on an external backup — a GitHub-hosted M3U, its URL, and a token that
// can read it. That is a lot of moving parts for "show the channels we already had".
//
// Every list that loads is therefore also written to disk. It costs one write per 30 minutes
// and removes the external dependency from the common case: a restarted or redeployed instance
// serves the last known list immediately, with no network and no credentials involved. The M3U
// backup stays as the layer below this, for a container that has never seen a good list.
//
// CACHE_DIR defaults to the system temp dir. That survives a process restart but not a fresh
// container; point it at a mounted disk to outlive deploys.
// Read at call time, not at import: a value captured once cannot be changed by a test and
// silently ignores an env var set after the module loads.
const listCacheDir = () => process.env.CACHE_DIR || path.join(os.tmpdir(), 'tesla-iptv-lists');
const listCacheFile = (action) =>
  path.join(listCacheDir(), `xt-${(action || 'login').replace(/[^a-z0-9_-]/gi, '_')}.json`);

export function persistList(action, data) {
  if (!LIST_ACTIONS.has(action)) return; // only the big lists are worth keeping
  fsp
    .mkdir(listCacheDir(), { recursive: true })
    .then(() => fsp.writeFile(listCacheFile(action), JSON.stringify({ at: Date.now(), data })))
    .catch((e) => console.error(`[cache] could not persist ${action}: ${e.message}`));
}

/** The last list written for this action, or null. Never throws. */
export async function loadPersistedList(action) {
  try {
    const rec = JSON.parse(await fsp.readFile(listCacheFile(action), 'utf8'));
    if (!rec || !Array.isArray(rec.data) || rec.data.length === 0) return null;
    xtreamCache.set(action, { at: rec.at || 0, data: rec.data });
    console.log(`[cache] restored ${action} from disk (${rec.data.length} entries)`);
    return rec.data;
  } catch {
    return null;
  }
}
const xtreamInflight = new Map(); // action -> Promise, so parallel callers share one fetch

/** The cached response for `action` regardless of age, or undefined. */
function staleXtreamResponse(action) {
  return xtreamCache.get(action)?.data;
}

/** Fetch a player_api.php action server-side and return the parsed JSON (cached). */
async function xtreamApi(creds, action, budgetMs) {
  const hit = xtreamCache.get(action);
  if (hit && Date.now() - hit.at < XTREAM_TTL_MS) return hit.data;
  // A second request arriving while the first is still downloading must not
  // start its own — that is how one slow list turns into several.
  const inflight = xtreamInflight.get(action);
  if (inflight) return inflight;

  const base = `${creds.server}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
  const url = new URL(action ? `${base}&action=${action}` : base);
  const pending = (async () => {
    const resp = await upstreamFetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(budgetMs || (LIST_ACTIONS.has(action) ? LIST_TIMEOUT_MS : TIMEOUT_MS)),
    });
    if (!resp.ok) throw new Error(`upstream ${resp.status}`);
    const data = await resp.json();
    xtreamCache.set(action, { at: Date.now(), data });
    persistList(action, data);
    noteXtreamSuccess();
    return data;
  })().finally(() => xtreamInflight.delete(action));

  xtreamInflight.set(action, pending);
  return pending;
}

// Which source produced the channel list the client is currently holding.
// /api/stream ids are source-specific (an Xtream stream_id vs. the channel's
// index in the parsed M3U), so a list served from the M3U fallback must also be
// played from the M3U. Reset as soon as Xtream serves a list again.
let liveListSource = null; // 'xtream' | 'm3u' | null

/**
 * GET /api/xt?action=get_live_streams|get_live_categories  (login = no action)
 * Server-side player_api call; the response carries only channel metadata
 * (id/name/icon/category) — never the account.
 */
// A live channel list is megabytes of extremely repetitive JSON, and it was going out
// uncompressed — on a car's connection that transfer dominates the wait. gzip typically cuts
// it by an order of magnitude. Compression is async so a multi-megabyte list does not block
// the event loop for every other request, and any failure just sends the plain body.
function sendJsonBody(res, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  const accepts = String(res.req?.headers?.['accept-encoding'] || '');
  const plain = () => {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
    });
    res.end(body);
  };
  // Not worth a compressor for a small payload (login, an empty list).
  if (body.length < 4096 || !/\bgzip\b/.test(accepts)) return plain();
  gzip(body, (err, packed) => {
    if (err || res.writableEnded || res.destroyed) return err ? plain() : undefined;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Encoding': 'gzip',
      'Vary': 'Accept-Encoding',
      'Content-Length': packed.length,
    });
    res.end(packed);
  });
}

export async function handleXtreamApi(req, res) {
  res.on('error', () => {});
  setCors(res);
  const url = new URL(req.url || '/', 'http://localhost');
  if (!keyGate(req, res, url)) return;

  const action = url.searchParams.get('action') || '';
  if (action !== '' && !LIST_ACTIONS.has(action)) return sendError(res, 400, 'Unsupported action');

  const source = getSourceType();
  if (!source) return sendError(res, 503, 'Server has no IPTV source configured');

  if (source === 'm3u') {
    try {
      const data = await m3uResponse(action);
      if (action === 'get_live_streams') liveListSource = 'm3u';
      return sendJsonBody(res, data);
    } catch (err) {
      return sendError(res, 502, `Channel list failed: ${String(err && err.message ? err.message : err)}`);
    }
  }

  // Xtream: server-side player_api call, cached for XTREAM_TTL_MS.
  // A cached answer is still served while Xtream is down — only the network call is skipped.
  if (xtreamIsDown()) {
    // Recovery has to be noticed by trying, and nobody should wait for that trial. Probe in the
    // background while this request is served from the fallback: a success calls
    // noteXtreamSuccess() and clears the mark, so the very next request goes to the provider
    // again. Without this, a provider that came back stayed "down" for the whole cooldown —
    // which is exactly what a fixed exit node looked like from outside.
    if (!xtreamProbe) {
      xtreamProbe = xtreamApi(getXtreamCreds(), action)
        .then(() => {}, () => {})
        .finally(() => { xtreamProbe = null; });
    }
    const cached = xtreamCache.get(action) || null;
    if (cached) return sendJsonBody(res, cached.data);
    const fromDisk = await loadPersistedList(action);
    if (fromDisk) {
      if (action === 'get_live_streams') liveListSource = 'xtream';
      return sendJsonBody(res, fromDisk);
    }
    // Both routes are down, so BOTH reasons have to reach the caller. Reporting only the
    // Xtream error sent people to look at the exit node when the actual problem was the
    // backup — a missing M3U_URL, or a token that cannot read the file.
    let m3uErr = 'M3U_URL is not configured';
    try {
      const quick = await m3uResponse(action);
      if (quick !== null) {
        if (action === 'get_live_streams') liveListSource = 'm3u';
        return sendJsonBody(res, quick);
      }
    } catch (err) {
      m3uErr = String(err && err.message ? err.message : err);
    }
    return sendError(
      res,
      502,
      `Channel list failed. Provider: ${xtreamLastError}. Backup playlist: ${m3uErr}.`,
    );
  }
  // With a cached list or an M3U backup in hand, the provider gets FAST_FAIL_MS to answer and
  // no longer. Losing that race is not a failure: the request carries on in the background and
  // its result is cached, so the next viewer gets fresh data without this one waiting for it.
  const haveFallback = Boolean(xtreamCache.get(action)) || Boolean(getM3uSource());
  if (haveFallback) {
    const raced = await raceDeadline(xtreamApi(getXtreamCreds(), action), FAST_FAIL_MS);
    if (raced.value !== undefined) {
      if (action === 'get_live_streams') liveListSource = 'xtream';
      return sendJsonBody(res, raced.value);
    }
    // Report what actually happened: a refusal names itself, a blackhole reads as a timeout.
    noteXtreamFailure(
      raced.error ||
        new Error(`no answer within ${FAST_FAIL_MS}ms (no refusal, no reset — the request went nowhere, ` +
          `which is what a dead proxy or exit node looks like); still loading in the background`),
    );
    const stale = staleXtreamResponse(action);
    if (stale !== undefined) {
      if (action === 'get_live_streams') liveListSource = 'xtream';
      return sendJsonBody(res, stale);
    }
    try {
      const backup = await m3uResponse(action);
      if (backup !== null) {
        if (action === 'get_live_streams') liveListSource = 'm3u';
        return sendJsonBody(res, backup);
      }
    } catch (e) {
      return sendError(res, 502, `Channel list failed. Provider: ${xtreamLastError}. ` +
        `Backup playlist: ${String(e && e.message ? e.message : e)}.`);
    }
  }

  try {
    const data = await xtreamApi(getXtreamCreds(), action);
    if (action === 'get_live_streams') liveListSource = 'xtream';
    return sendJsonBody(res, data);
  } catch (err) {
    noteXtreamFailure(err);
    // Xtream is down or too slow. Rather than leave the car with no channels,
    // fall back in order of fidelity: the last list we saw (stale, but the real
    // account), then the M3U playlist (M3U_URL, else public/playlist.m3u).
    const stale = staleXtreamResponse(action) ?? (await loadPersistedList(action)) ?? undefined;
    if (stale !== undefined && stale !== null) {
      if (action === 'get_live_streams') liveListSource = 'xtream';
      return sendJsonBody(res, stale);
    }
    let fallback = null;
    let m3uErr = process.env.M3U_URL ? 'unknown' : 'M3U_URL is not configured';
    try {
      fallback = await m3uResponse(action);
    } catch (e) {
      m3uErr = String(e && e.message ? e.message : e);
    }
    if (fallback !== null) {
      if (action === 'get_live_streams') liveListSource = 'm3u';
      return sendJsonBody(res, fallback);
    }
    sendError(
      res,
      502,
      `Channel list failed. Provider: ${String(err && err.message ? err.message : err)}. ` +
        `Backup playlist: ${m3uErr}.`,
    );
  }
}

/**
 * Replace the account's secrets in text meant for display.
 *
 * Only DELIMITED occurrences are replaced. A plain substring swap corrupts the
 * text it is supposed to make readable — a one-character username turns
 * "Attention Required! | Cloudflare" into "Attention Req***ired! | Clo***dflare",
 * destroying the diagnosis. Credentials always sit against a non-alphanumeric
 * boundary where they matter (\"username\":\"x\", ?username=x&, /live/x/y/1.ts),
 * so that is what is matched.
 */
function redact(text, creds) {
  let out = String(text);
  for (const secret of [creds?.username, creds?.password].filter(Boolean)) {
    const escaped = String(secret).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=[^A-Za-z0-9]|$)`, 'g'), '$1***');
  }
  return out;
}

/** Run one upstream probe and describe the outcome without ever throwing. */
async function probe(name, run, creds) {
  const started = Date.now();
  try {
    const { status, body } = await run();
    return {
      name,
      ok: status >= 200 && status < 300,
      status,
      ms: Date.now() - started,
      bytes: body.length,
      // Enough to recognise a Cloudflare interstitial or an Xtream error, no more.
      preview: redact(body.slice(0, 200).replace(/\s+/g, ' ').trim(), creds),
    };
  } catch (err) {
    return {
      name,
      ok: false,
      ms: Date.now() - started,
      error: redact(String(err && err.message ? err.message : err), creds),
    };
  }
}

/**
 * GET /api/diag?key=... — what the server sees when it talks upstream, right now.
 *
 * Exists because every failure so far has looked identical from the browser
 * ("Channel list failed") whether the cause was a Cloudflare block, a dead exit
 * node, a slow list, or missing configuration. This distinguishes them: which
 * source and transport are in play, and what the upstream actually answers.
 * Probes bypass the cache — a cached list would hide a broken upstream.
 *
 * Reports only whether each secret is SET, never its value, and redacts the
 * account out of every upstream preview. Gated like the export.
 */
export async function handleDiag(req, res) {
  res.on('error', () => {});
  const url = new URL(req.url || '/', 'http://localhost');
  setCors(res);

  if (!getRequiredKey()) {
    return sendError(res, 403, 'Diagnostics require ACCESS_KEY to be configured on the server');
  }
  if (!keyGate(req, res, url)) return;

  const creds = getXtreamCreds();
  const m3u = getM3uSource();
  const out = {
    source: getSourceType(),
    env: {
      XTREAM_SERVER: Boolean(process.env.XTREAM_SERVER),
      XTREAM_USERNAME: Boolean(process.env.XTREAM_USERNAME),
      XTREAM_PASSWORD: Boolean(process.env.XTREAM_PASSWORD),
      M3U_URL: Boolean(process.env.M3U_URL),
      M3U_AUTH: Boolean(process.env.M3U_AUTH),
      UPSTREAM_PROXY: Boolean(process.env.UPSTREAM_PROXY),
      XTREAM_PROXY_URL: Boolean(process.env.XTREAM_PROXY_URL),
      ACCESS_KEY: true,
    },
    m3uSource: m3u ? m3u.kind : null,
    xtreamDown: xtreamIsDown(),
    xtreamLastError: xtreamLastError || null,
    xtreamRetryInSec: xtreamIsDown() ? Math.ceil((xtreamDownUntil - Date.now()) / 1000) : 0,
    cachedActions: [...xtreamCache.entries()].map(([action, v]) => ({
      action: action || '(login)',
      ageMs: Date.now() - v.at,
    })),
    checks: [],
  };

  // ?quick=1 answers "how is this configured?" without the probes, which take up to
  // LIST_TIMEOUT_MS each against an unresponsive provider — long enough that the diagnostic
  // itself times out in most clients, exactly when it is most needed.
  const quick = url.searchParams.get('quick') === '1';

  if (creds) {
    out.xtreamHost = new URL(creds.server).host;
    out.transport = transportFor(new URL(creds.server).hostname);
    const base = `${creds.server}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
    const hit = async (suffix, timeout) => {
      const resp = await upstreamFetch(new URL(base + suffix), {
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
      return { status: resp.status, body: await resp.text() };
    };
    if (!quick) {
      out.checks.push(await probe('player_api login', () => hit('', TIMEOUT_MS), creds));
      out.checks.push(
        await probe('player_api get_live_streams', () => hit('&action=get_live_streams', LIST_TIMEOUT_MS), creds),
      );
    }
  }
  if (quick) {
    out.quick = true;
    // The backup is a separate failure domain from the provider, and its config is the part
    // people get wrong: a stale URL, a token that cannot see the repo, a missing Bearer prefix.
    // Reporting the URL (which carries no credentials) plus the real status makes it a
    // one-request answer instead of a guessing game. The token itself is never echoed.
    if (process.env.M3U_URL) {
      out.m3uUrl = process.env.M3U_URL;
      const auth = process.env.M3U_AUTH || '';
      out.m3uAuthScheme = auth.split(' ')[0] || null;
      // Enough to tell WHICH credential is stored without disclosing it: the token family and
      // its length. A value that arrived mangled (wrapped, truncated, an extra prefix, a
      // trailing newline) shows up here as a wrong length or a prefix that is not a token at
      // all — which is invisible when only the status code is reported. This route is
      // ACCESS_KEY-gated, and a 4-character family prefix plus a length reconstructs nothing.
      const token = auth.replace(/^\S+\s+/, '');
      out.m3uAuthToken = token
        ? { family: token.slice(0, 4), length: token.length, hasWhitespace: /\s/.test(token) }
        : null;
      // Who does GitHub think we are? Distinguishes "valid credential, no access to that repo"
      // (404 here but a login below) from "the credential itself is wrong" (401 on both).
      if (token) {
        try {
          const who = await upstreamFetch(new URL('https://api.github.com/user'), {
            headers: m3uHeaders(),
            signal: AbortSignal.timeout(15000),
          });
          const body = await who.json().catch(() => ({}));
          out.m3uAuthIdentity = who.ok
            ? { login: body.login, status: who.status }
            : { status: who.status, message: body.message || null };
        } catch (e) {
          out.m3uAuthIdentity = { error: String(e && e.message ? e.message : e) };
        }
      }
      try {
        const r = await upstreamFetch(new URL(process.env.M3U_URL), {
          redirect: 'follow',
          headers: m3uHeaders(),
          signal: AbortSignal.timeout(20000),
        });
        const head = (await r.text()).slice(0, 120);
        out.m3uCheck = {
          status: r.status,
          ok: r.ok,
          looksLikeM3u: head.startsWith('#EXTM3U'),
          firstBytes: head.replace(/[^\x20-\x7e]/g, '.').slice(0, 90),
          hint:
            r.status === 404
              ? 'Either the path is wrong, or the token cannot see that repository — GitHub returns 404, not 403, for a repo outside a token\'s scope.'
              : r.status === 401
                ? 'The token was rejected. Check that M3U_AUTH starts with "Bearer " and has no stray whitespace.'
                : r.ok
                  ? 'Backup is reachable.'
                  : null,
        };
      } catch (e) {
        out.m3uCheck = { error: String(e && e.message ? e.message : e) };
      }
    }
    out.env.TS_AUTHKEY = Boolean(process.env.TS_AUTHKEY);
    out.env.TS_EXIT_NODE = process.env.TS_EXIT_NODE || null;
    out.upstreamProxy = process.env.UPSTREAM_PROXY
      ? String(process.env.UPSTREAM_PROXY).replace(/\/\/[^@]*@/, '//***@')
      : null;
    out.note =
      out.transport === 'tunnel'
        ? 'All provider traffic is being forced through UPSTREAM_PROXY. If the tunnel or its exit node is down, every request fails here regardless of whether the provider is reachable.'
        : out.transport === 'worker'
          ? 'Provider traffic goes through the Cloudflare Worker.'
          : 'Provider traffic leaves from this host\'s own IP.';
    setCors(res);
    return sendJsonBody(res, out);
  }

  if (m3u) {
    out.checks.push(
      await probe(
        `m3u fallback (${m3u.kind})`,
        async () => {
          if (m3u.kind === 'file') return { status: 200, body: readFileSync(m3u.value, 'utf8') };
          const resp = await upstreamFetch(new URL(m3u.value), {
            redirect: 'follow',
            headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
            signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
          });
          return { status: resp.status, body: await resp.text() };
        },
        creds,
      ),
    );
  }

  sendJsonBody(res, out);
}

/**
 * GET /api/export.m3u?key=... — the live channel list as a plain M3U, for use as
 * the offline backup (host it and point M3U_URL at it; see DEPLOY.md).
 *
 * This is the one endpoint that hands out the account in the clear: every line
 * carries the credentialed stream URL. It is therefore refused outright unless
 * ACCESS_KEY is configured — an open deployment must not be able to export it.
 */
export async function handleExportM3u(req, res) {
  res.on('error', () => {});
  const url = new URL(req.url || '/', 'http://localhost');
  setCors(res);

  if (!getRequiredKey()) {
    return sendError(res, 403, 'Export requires ACCESS_KEY to be configured on the server');
  }
  if (!keyGate(req, res, url)) return;

  const source = getSourceType();
  if (!source) return sendError(res, 503, 'Server has no IPTV source configured');

  try {
    let channels;
    if (source === 'm3u') {
      channels = await getM3uChannels();
    } else {
      const creds = getXtreamCreds();
      const [streams, categories] = await Promise.all([
        xtreamApi(creds, 'get_live_streams'),
        xtreamApi(creds, 'get_live_categories').catch(() => []),
      ]);
      // get_live_streams carries category_id; the readable name lives in
      // get_live_categories. A missing categories call only costs group names.
      const names = new Map(
        (Array.isArray(categories) ? categories : []).map((c) => [String(c.category_id), c.category_name]),
      );
      channels = (Array.isArray(streams) ? streams : []).map((c) => ({
        name: c.name || `Channel ${c.stream_id}`,
        logo: c.stream_icon || '',
        group: names.get(String(c.category_id)) || 'Uncategorized',
        url: `${creds.server}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${c.stream_id}.ts`,
      }));
    }

    const body = Buffer.from(buildM3u(channels || []), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'audio/x-mpegurl; charset=utf-8',
      'Content-Disposition': 'attachment; filename="playlist.m3u"',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    sendError(res, 502, `Export failed: ${String(err && err.message ? err.message : err)}`);
  }
}

/** Serialise channels as an M3U that parseM3u() can read back. */
export function buildM3u(channels) {
  const lines = ['#EXTM3U'];
  for (const c of channels) {
    const attrs = [];
    if (c.logo) attrs.push(`tvg-logo="${String(c.logo).replace(/"/g, '')}"`);
    attrs.push(`group-title="${String(c.group || 'Uncategorized').replace(/"/g, '')}"`);
    // The name follows the last comma, so a comma inside it would split the
    // entry when read back — parseM3u splits on lastIndexOf(',').
    lines.push(`#EXTINF:-1 ${attrs.join(' ')},${String(c.name).replace(/\s*,\s*/g, ' ').trim()}`);
    lines.push(c.url);
  }
  return lines.join('\n') + '\n';
}

/**
 * GET /api/stream?id=N  — stream live channel N. The credentialed upstream URL
 * is built here and handed to the existing proxy pipeline, so the browser only
 * ever sees the opaque channel id.
 */
export async function handleStream(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  setCors(res);
  if (!keyGate(req, res, url)) return;

  const id = url.searchParams.get('id') || '';
  if (!/^\d+$/.test(id)) return sendError(res, 400, 'Invalid channel id');

  const source = getSourceType();
  if (!source) return sendError(res, 503, 'Server has no IPTV source configured');

  let upstreamUrl;
  // The M3U path also covers an Xtream deployment whose last channel list came
  // from the fallback: those ids are M3U indexes, not Xtream stream ids.
  if (source === 'm3u' || liveListSource === 'm3u') {
    // The id is the channel's index in the parsed M3U; look up its stream URL.
    let channels;
    try {
      channels = await getM3uChannels();
    } catch (err) {
      return sendError(res, 502, `Playlist load failed: ${String(err && err.message ? err.message : err)}`);
    }
    const idx = Number(id);
    if (!channels || idx < 0 || idx >= channels.length) return sendError(res, 404, 'Unknown channel');
    upstreamUrl = channels[idx].url;
  } else {
    const creds = getXtreamCreds();
    upstreamUrl = `${creds.server}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${id}.ts`;
  }

  // Delegate to the existing proxy by rewriting the request to its internal form.
  // The stream URL (which may embed the account) lives only here, on the server —
  // the client's request was /api/stream?id=N and its response is the bytes.
  const key = url.searchParams.get('key') || '';
  req.url = `/api/proxy?u=${encodeURIComponent(upstreamUrl)}${key ? `&key=${encodeURIComponent(key)}` : ''}`;
  return handleProxy(req, res);
}

export async function handleProxy(req, res) {
  // A client abort / edge RST emits 'error' on res; with no listener that is an
  // uncaughtException and kills the whole process mid-stream.
  res.on('error', () => {});
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

  // The timeout must cover CONNECTING only, not the response body. A live
  // channel is one continuous MPEG-TS response that never ends, so a whole-
  // request timeout would tear playback down every TIMEOUT_MS. The timer is
  // therefore cleared as soon as the headers arrive.
  // The controller is also aborted when the client goes away, so an abandoned
  // stream releases the upstream connection immediately — this matters on
  // accounts limited to a single concurrent connection.
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  res.on('close', () => controller.abort());

  let upstream;
  try {
    upstream = await upstreamFetch(target, {
      redirect: 'follow',
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(connectTimer);
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    sendError(res, isTimeout ? 504 : 502, `Upstream fetch failed: ${String(err && err.message ? err.message : err)}`);
    return;
  }
  clearTimeout(connectTimer); // headers are in; the body may now stream forever

  const upstreamType = upstream.headers.get('content-type') || '';
  const finalUrl = upstream.realUrl || upstream.url || target.toString();
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
    const responseType = upstreamType || (finalUrl.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream');
    // Channel logos never change, so let the browser cache them — otherwise the
    // grid re-downloads every icon on each visit and scroll (costly on the
    // phone/car). Video and everything else stays uncacheable.
    const isImage = /^image\//i.test(responseType);
    const responseHeaders = {
      'Content-Type': responseType,
      'Cache-Control': isImage ? 'public, max-age=604800, immutable' : 'no-store',
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
    // pipeline (unlike pipe) propagates errors in BOTH directions and rejects
    // instead of leaving an unhandled 'error' event to crash the process.
    try {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch {
      res.destroy();
    }
  } catch (err) {
    sendError(res, 502, `Proxy error: ${String(err && err.message ? err.message : err)}`);
  }
}
