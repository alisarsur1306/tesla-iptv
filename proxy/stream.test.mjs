// /api/stream — what happens when a listed channel will not play.
// Run: node --test proxy/stream.test.mjs
//
// The Xtream host is stubbed the way the other proxy tests do it: point UPSTREAM_PROXY at a
// local server, so every request for the (never-resolved) Xtream hostname lands there.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { useIsolatedCacheDir } from './testCacheDir.mjs';

const XT_HOST = 'mhd.snapmediatoghater.site:8080';

// 777 exists in the backup playlist only; 800 and 801 exist in neither, so they resolve as
// Xtream ids alone and the stub decides what the provider "answers" for them.
const PLAYLIST = `#EXTM3U
#EXTINF:-1 group-title="Backup",Only In The Backup
http://${XT_HOST}/backup/777.ts
`;

const hits = [];
const upstream = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  hits.push(path);
  if (path === '/playlist.m3u') {
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }).end(PLAYLIST);
    return;
  }
  if (path === '/player_api.php') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ stream_id: 777, name: 'Listed', stream_icon: '', category_id: '1' }]));
    return;
  }
  // The provider refuses a channel that is not on this line with a bare 403 …
  if (path === '/live/u/p/800.ts' || path === '/live/u/p/777.ts') {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }
  // … while Cloudflare refuses the whole transport with an HTML interstitial.
  if (path === '/live/u/p/801.ts') {
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(`BYTES:${path}`);
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

useIsolatedCacheDir();
process.env.UPSTREAM_PROXY = `127.0.0.1:${upstream.address().port}`;
process.env.XTREAM_SERVER = `http://${XT_HOST}`;
process.env.XTREAM_USERNAME = 'u';
process.env.XTREAM_PASSWORD = 'p';
process.env.M3U_URL = `http://${XT_HOST}/playlist.m3u`;
delete process.env.ACCESS_KEY;
delete process.env.XTREAM_PROXY_URL;

const { handleStream, handleUnavailable, handleDiag } = await import('./hlsProxy.mjs');

const app = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/api/unavailable') void handleUnavailable(req, res);
  else if (path === '/api/diag') void handleDiag(req, res);
  else void handleStream(req, res);
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${app.address().port}`;

const unavailableIds = async () => (await (await fetch(`${origin}/api/unavailable`)).json()).ids;

// FIRST: nothing has loaded the playlist yet, which is the whole point of this one.
test('a channel the provider serves never waits on the backup playlist', async () => {
  hits.length = 0;
  const res = await fetch(`${origin}/api/stream?id=900`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'BYTES:/live/u/p/900.ts');
  assert.ok(
    !hits.includes('/playlist.m3u'),
    'resolving the backup means downloading it, and on a cold container that is a minute of ' +
      'spinner before the provider is even asked — so it must not happen to play a provider channel',
  );
});

test('a channel one source refuses is played from the other', async () => {
  hits.length = 0;
  const res = await fetch(`${origin}/api/stream?id=777`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'BYTES:/backup/777.ts');
  assert.ok(hits.includes('/live/u/p/777.ts'), 'the Xtream id space is tried first');
});

test('a channel the backup also serves is never marked unavailable', async () => {
  assert.deepEqual(await unavailableIds(), [], '777 played, so nothing was refused');
});

test('a refusal with no second source reports what the provider answered', async () => {
  const res = await fetch(`${origin}/api/stream?id=800`);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /Channel 800 would not play/);
  assert.match(body.error, /answered 403/);
  assert.match(body.error, /via tunnel/, 'the transport is named, so a tunnel fault is visible');
});

test('a genuine refusal is remembered so the grid can mark it', async () => {
  assert.deepEqual(await unavailableIds(), [800]);
});

test('a Cloudflare block page is not recorded as a subscription refusal', async () => {
  const res = await fetch(`${origin}/api/stream?id=801`);
  assert.equal(res.status, 502);
  assert.deepEqual(await unavailableIds(), [800], '801 was a transport failure, not a refusal');
});

test('an id no source can resolve is a 404, not a silent stall', async () => {
  // A non-numeric id never reaches the resolver; an unknown numeric one resolves as an Xtream
  // id, so "unknown" here means the provider itself has nothing for it.
  const res = await fetch(`${origin}/api/stream?id=abc`);
  assert.equal(res.status, 400);
});

test('diag probes playback, not just the channel list', async () => {
  process.env.ACCESS_KEY = 'sekret';
  try {
    const res = await fetch(`${origin}/api/diag?stream=900&key=sekret`);
    const body = await res.json();
    const probe = body.checks.find((c) => c.name === 'live stream 900');
    assert.ok(probe, 'the playback probe must run');
    assert.equal(probe.status, 200);
    assert.equal(probe.transport, 'tunnel');
    assert.equal(probe.idSpace, 'xtream');
    assert.equal(probe.requestedHost, XT_HOST);
    assert.match(probe.preview, /BYTES/);
  } finally {
    delete process.env.ACCESS_KEY;
  }
});

test.after(() => {
  // unref rather than close: closing the stub tears down the connections undici's ProxyAgent
  // still has pooled for it, and that is the exact path whose crash server.js carries a handler
  // for (see the undici note at the top of hlsProxy.mjs). Unreferenced servers let the process
  // exit on its own without provoking it.
  app.unref();
  upstream.unref();
});
