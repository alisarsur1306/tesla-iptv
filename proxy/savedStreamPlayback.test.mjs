import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SavedStreams, accountScope } from './savedStreams.mjs';
import { useIsolatedCacheDir } from './testCacheDir.mjs';

const directory = useIsolatedCacheDir();
const creds = { server: 'http://provider.example:8080', username: 'u', password: 'p' };
process.env.XTREAM_SERVER = creds.server;
process.env.XTREAM_USERNAME = creds.username;
process.env.XTREAM_PASSWORD = creds.password;
process.env.RENDER = 'true';
delete process.env.ACCESS_KEY;
delete process.env.M3U_URL;
delete process.env.XTREAM_PROXY_URL;
const store = new SavedStreams({ directory, scope: accountScope(creds) });
await store.remember('501', 'https://video.example/saved.m3u8');
await store.remember('502', 'https://video.example/expired.ts');
await store.flush();
const packets = Buffer.alloc(188 * 3); packets[0] = packets[188] = packets[376] = 0x47;
const hits = [];
let offline = false;
const tunnel = http.createServer((req, res) => {
  hits.push(req.url);
  if (offline) return res.writeHead(502).end('Tunnel unavailable');
  if (new URL(req.url).pathname === '/player_api.php') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([{ stream_id: 504, name: 'Fresh channel', category_id: '1', direct_source: 'https://video.example/PRIVATE_ACCESS_URL.m3u8' }]));
  if (new URL(req.url).pathname.endsWith('/503.ts')) return res.writeHead(302, { Location: 'https://video.example/learned.ts' }).end();
  res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(packets);
});
await new Promise(resolve => tunnel.listen(0, '127.0.0.1', resolve));
process.env.UPSTREAM_PROXY = `127.0.0.1:${tunnel.address().port}`;
const { handleStream, handleUnavailable, handleXtreamApi } = await import('./hlsProxy.mjs');
const app = http.createServer((req, res) => {
  if (req.url.startsWith('/api/unavailable')) return void handleUnavailable(req, res);
  if (req.url.startsWith('/api/xt')) return void handleXtreamApi(req, res);
  void handleStream(req, res);
});
await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
const clientFetch = globalThis.fetch;
const endpoint = `http://127.0.0.1:${app.address().port}`;
test.after(() => { for (const server of [app, tunnel]) { server.closeAllConnections(); server.close(); } });
test.beforeEach(() => { hits.length = 0; offline = false; });

test('a saved address plays when the provider tunnel is offline, without a provider request', async t => {
  offline = true;
  const direct = t.mock.method(globalThis, 'fetch', async () => new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }));
  const res = await clientFetch(`${endpoint}/api/stream?id=501`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^#EXTM3U/);
  assert.equal(res.headers.get('x-stream-source'), 'saved');
  assert.equal(hits.length, 0);
  assert.equal(direct.mock.callCount(), 1);
});

test('an expired cached token falls back and does not mark the channel refused by the account', async t => {
  const direct = t.mock.method(globalThis, 'fetch', async () => new Response('Forbidden', { status: 403 }));
  const res = await clientFetch(`${endpoint}/api/stream?id=502`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), packets);
  assert.equal(hits.length, 1);
  assert.equal(direct.mock.callCount(), 1);
  const unavailable = await clientFetch(`${endpoint}/api/unavailable`);
  assert.deepEqual((await unavailable.json()).ids, []);
  hits.length = 0;
  await (await clientFetch(`${endpoint}/api/stream?id=502`)).arrayBuffer();
  assert.equal(hits.length, 1);
  assert.equal(direct.mock.callCount(), 1, 'the refused cached token is not retried');
});

test('a successful direct redirect is learned and the next start needs no provider', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(packets, { headers: { 'Content-Type': 'video/mp2t' } }));
  const first = await clientFetch(`${endpoint}/api/stream?id=503`);
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  assert.equal(hits.length, 1);
  hits.length = 0;
  offline = true;
  const second = await clientFetch(`${endpoint}/api/stream?id=503`);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-stream-source'), 'saved');
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), packets);
  assert.equal(hits.length, 0);
});

test('fresh catalogue addresses are learned server-side and excluded from channel metadata', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }));
  const list = await clientFetch(`${endpoint}/api/xt?action=get_live_streams`);
  const body = await list.text();
  assert.doesNotMatch(body, /PRIVATE_ACCESS_URL|direct_source/);
  assert.match(body, /Fresh channel/);
  hits.length = 0;
  offline = true;
  const video = await clientFetch(`${endpoint}/api/stream?id=504`);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('x-stream-source'), 'saved');
  await video.text();
  assert.equal(hits.length, 0);
});
