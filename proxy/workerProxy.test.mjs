// XTREAM_PROXY_URL routing: the Cloudflare Worker transport for the Xtream host.
// Run: node --test proxy/workerProxy.test.mjs
//
// The Worker exists because the Xtream host's Cloudflare refuses datacenter IPs
// but not Cloudflare's own network. What must hold: only the Xtream host is
// wrapped, the token is attached, a relayed Location resolves against the ORIGIN
// rather than the Worker URL, and playlists rewrite against the origin too.
// (Nothing here can target 127.0.0.1 as an upstream — the SSRF guard blocks it —
// so "went direct" is asserted by the Worker never seeing the request.)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const XT = 'http://mhd.snapmediatoghater.site:8080';

const seenByWorker = [];
const worker = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const target = url.searchParams.get('u') || '';
  seenByWorker.push({ target, token: url.searchParams.get('t') || '' });

  if (target.includes('/live/')) {
    // The real Worker relays the origin's 3xx without following it. A
    // host-relative Location is the interesting case: it must resolve against
    // the Xtream origin, never against the Worker's own URL.
    res.writeHead(302, { location: '/hlsr/token123/play.m3u8' });
    res.end();
    return;
  }
  if (target.endsWith('.m3u8')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\nseg1.ts\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
});
await new Promise((r) => worker.listen(0, '127.0.0.1', r));

process.env.XTREAM_PROXY_URL = `http://127.0.0.1:${worker.address().port}/worker`;
process.env.XTREAM_PROXY_TOKEN = 'tok-abc';
delete process.env.ACCESS_KEY;
delete process.env.UPSTREAM_PROXY;

const { handleProxy } = await import('./hlsProxy.mjs');
const app = http.createServer(handleProxy);
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const call = (u) =>
  fetch(`http://127.0.0.1:${app.address().port}/api/proxy?u=${encodeURIComponent(u)}`);

test('the Xtream host is fetched through the Worker, with the token attached', async () => {
  seenByWorker.length = 0;
  const res = await call(`${XT}/player_api.php?username=u&password=p`);
  assert.equal(res.status, 200);
  assert.equal(seenByWorker.length, 1);
  assert.match(seenByWorker[0].target, /player_api\.php/);
  assert.equal(seenByWorker[0].token, 'tok-abc');
});

test('a non-Xtream host never touches the Worker', async () => {
  seenByWorker.length = 0;
  // Fails to resolve, which is fine — the assertion is that it went direct.
  await call('http://some-cdn.example.invalid/x.ts');
  assert.equal(seenByWorker.length, 0, 'CDN traffic must never ride the Worker');
});

test('a Location the Worker relays resolves against the origin, not the Worker', async () => {
  seenByWorker.length = 0;
  const res = await call(`${XT}/live/u/p/5.ts`);
  assert.equal(res.status, 200);
  // Hop 1: the /live/ URL. Hop 2: the relative Location resolved against the
  // Xtream origin (still the Xtream host, so it rides the Worker again).
  assert.equal(seenByWorker.length, 2);
  assert.equal(seenByWorker[1].target, `${XT}/hlsr/token123/play.m3u8`);
});

test('a playlist served via the Worker rewrites segments against the origin', async () => {
  const res = await call(`${XT}/hlsr/token123/play.m3u8`);
  const body = await res.text();
  // The bug this guards: resp.url is the URL fetch was ASKED for — the Worker's.
  // Resolving 'seg1.ts' against that would point every segment at the Worker.
  assert.match(body, /u=http%3A%2F%2Fmhd\.snapmediatoghater\.site%3A8080%2Fhlsr%2Ftoken123%2Fseg1\.ts/);
  assert.doesNotMatch(body, /127\.0\.0\.1/, 'no segment may point at the Worker');
});

test('with XTREAM_PROXY_URL unset, UPSTREAM_PROXY still carries the Xtream host', async () => {
  delete process.env.XTREAM_PROXY_URL;
  const viaTunnel = [];
  const tunnel = http.createServer((req, res) => {
    viaTunnel.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise((r) => tunnel.listen(0, '127.0.0.1', r));
  process.env.UPSTREAM_PROXY = `127.0.0.1:${tunnel.address().port}`;

  seenByWorker.length = 0;
  await call(`${XT}/player_api.php`);
  assert.equal(viaTunnel.length, 1, 'the tunnel must still work when the Worker is unset');
  assert.equal(seenByWorker.length, 0);

  delete process.env.UPSTREAM_PROXY;
  tunnel.close();
});

test.after(() => {
  app.close();
  worker.close();
});
