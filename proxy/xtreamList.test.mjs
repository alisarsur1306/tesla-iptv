// Channel-list resilience: cache, and the M3U fallback when Xtream fails.
// Run: node --test proxy/xtreamList.test.mjs
//
// The Xtream host is stubbed the same way hlsProxy.test.mjs does it: point
// UPSTREAM_PROXY at a local server, so every request for the (never-resolved)
// Xtream hostname lands there instead. Order matters — the module's caches are
// process-global, so the failure case runs before the success case.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const XT_HOST = 'mhd.snapmediatoghater.site:8080';
// Each process must own its list cache: production temp files or another test
// suite must not decide whether this suite sees an M3U fallback.
const cachePrefix = path.join(os.tmpdir(), 'tesla-list-test-');
const cacheDirectory = await mkdtemp(cachePrefix);
process.env.CACHE_DIR = cacheDirectory;

// --- stub upstream ---------------------------------------------------------
let playerApiOk = false; // flipped once the fallback case has run
const playerApiHits = [];
const otherHits = [];

const PLAYLIST = `#EXTM3U
#EXTINF:-1 tvg-logo="http://logo/a.png" group-title="Fallback",Channel A
http://${XT_HOST}/ch0.ts
#EXTINF:-1 group-title="Fallback",Channel B
http://${XT_HOST}/ch1.ts
`;

const XT_STREAMS = [{ stream_id: 77, name: 'Xtream One', stream_icon: '', category_id: '1' }];

const upstream = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/player_api.php') {
    playerApiHits.push(req.url);
    if (!playerApiOk) {
      res.writeHead(500).end('nope');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(XT_STREAMS));
    return;
  }
  otherHits.push(path);
  if (path === '/playlist.m3u') {
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }).end(PLAYLIST);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(`BYTES:${path}`);
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
process.env.UPSTREAM_PROXY = `127.0.0.1:${upstream.address().port}`;

// Credentials are read once, on first use — set them before importing.
process.env.XTREAM_SERVER = `http://${XT_HOST}`;
process.env.XTREAM_USERNAME = 'u';
process.env.XTREAM_PASSWORD = 'p';
process.env.M3U_URL = `http://${XT_HOST}/playlist.m3u`;
delete process.env.ACCESS_KEY;

const { handleXtreamApi, handleStream } = await import('./hlsProxy.mjs');

const app = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/api/stream') void handleStream(req, res);
  else void handleXtreamApi(req, res);
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${app.address().port}`;

test('a failing Xtream list falls back to the M3U playlist', async () => {
  const res = await fetch(`${origin}/api/xt?action=get_live_streams`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.deepEqual(
    list.map((c) => [c.stream_id, c.name]),
    [[0, 'Channel A'], [1, 'Channel B']],
  );
  assert.ok(playerApiHits.length > 0, 'Xtream must have been tried first');
});

test('ids from a fallback list stream from the M3U, not as Xtream ids', async () => {
  const res = await fetch(`${origin}/api/stream?id=1`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'BYTES:/ch1.ts');
});

test('a recovered provider takes back over, and its list is then cached', async () => {
  playerApiOk = true;
  playerApiHits.length = 0;

  // The first retry serves the fallback immediately while a background probe
  // checks recovery. Wait for that probe, instead of assuming its network
  // response completes before the fallback response reaches the caller.
  let first;
  for (let attempt = 0; attempt < 50; attempt++) {
    first = await (await fetch(`${origin}/api/xt?action=get_live_streams`)).json();
    if (first[0]?.stream_id === 77) break;
    await delay(20);
  }
  assert.deepEqual(first, XT_STREAMS, 'the successful background probe restores the Xtream list');
  assert.equal(playerApiHits.length, 1);

  const fresh = await (await fetch(`${origin}/api/xt?action=get_live_streams`)).json();
  assert.deepEqual(fresh, XT_STREAMS, 'once the probe succeeds, the provider list wins again');

  const hits = playerApiHits.length;
  const second = await (await fetch(`${origin}/api/xt?action=get_live_streams`)).json();
  assert.deepEqual(second, XT_STREAMS);
  assert.equal(playerApiHits.length, hits, 'the cached list must not re-hit player_api');
});

test('parallel cold requests for one action share a single upstream download', async () => {
  playerApiHits.length = 0;
  const results = await Promise.all(
    [0, 1, 2].map(() => fetch(`${origin}/api/xt?action=get_live_categories`).then((r) => r.json())),
  );
  for (const r of results) assert.deepEqual(r, XT_STREAMS);
  assert.equal(playerApiHits.length, 1, 'three parallel callers must share one fetch');
});

test('once Xtream serves the list again, ids resolve as Xtream stream ids', async () => {
  otherHits.length = 0;
  const res = await fetch(`${origin}/api/stream?id=42`);
  assert.equal(res.status, 200);
  assert.deepEqual(otherHits, ['/live/u/p/42.ts']);
});

test.after(async () => {
  app.closeAllConnections();
  app.close();
  upstream.closeAllConnections();
  upstream.close();
  assert.ok(path.resolve(cacheDirectory).startsWith(path.resolve(cachePrefix)));
  await rm(cacheDirectory, { recursive: true, force: true });
});
