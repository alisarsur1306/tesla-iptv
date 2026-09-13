import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { useIsolatedCacheDir } from './testCacheDir.mjs';

const provider = 'http://changed-provider.example:8080';
useIsolatedCacheDir();
process.env.XTREAM_SERVER = provider;
process.env.XTREAM_USERNAME = 'test-user';
process.env.XTREAM_PASSWORD = 'test-password';
delete process.env.ACCESS_KEY;
delete process.env.XTREAM_PROXY_URL;
delete process.env.UPSTREAM_PROXY;
delete process.env.RENDER;

const { handleProxy } = await import('./hlsProxy.mjs');
const app = http.createServer(handleProxy);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const clientFetch = globalThis.fetch;
const request = (url) => clientFetch(`http://127.0.0.1:${app.address().port}/api/proxy?u=${encodeURIComponent(url)}`);
const tunnelHits = [];
const tunnel = http.createServer((req, res) => {
  tunnelHits.push(req.url);
  res.setHeader('Content-Type', 'application/json');
  res.end('{"via":"tunnel"}');
});
await new Promise((resolve) => tunnel.listen(0, '127.0.0.1', resolve));
const tunnelAddress = `127.0.0.1:${tunnel.address().port}`;

test.beforeEach(() => {
  tunnelHits.length = 0;
  delete process.env.UPSTREAM_PROXY;
  delete process.env.RENDER;
});
test.after(() => {
  app.closeAllConnections();
  app.close();
  tunnel.closeAllConnections();
  tunnel.close();
});

test('a configured provider outside the legacy suffix list uses the tunnel', async (t) => {
  process.env.UPSTREAM_PROXY = tunnelAddress;
  const direct = t.mock.method(globalThis, 'fetch', async () => Response.json({ via: 'direct' }));
  const res = await request(`${provider}/player_api.php`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { via: 'tunnel' });
  assert.equal(tunnelHits.length, 1);
  assert.equal(direct.mock.callCount(), 0);
});

test('Render refuses a provider request without a proxy instead of using its cloud IP', async (t) => {
  process.env.RENDER = 'true';
  const direct = t.mock.method(globalThis, 'fetch', async () => Response.json({ via: 'direct' }));
  const res = await request(`${provider}/player_api.php`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /proxy.*not configured/i);
  assert.equal(direct.mock.callCount(), 0);
});

test('local development can still fetch the provider directly', async (t) => {
  const direct = t.mock.method(globalThis, 'fetch', async () => Response.json({ via: 'direct' }));
  const res = await request(`${provider}/player_api.php`);
  assert.deepEqual(await res.json(), { via: 'direct' });
  assert.equal(direct.mock.callCount(), 1);
});

test('an unrelated CDN stays direct even on Render', async (t) => {
  process.env.RENDER = 'true';
  process.env.UPSTREAM_PROXY = tunnelAddress;
  const direct = t.mock.method(globalThis, 'fetch', async () => new Response('cdn data'));
  const res = await request('https://cdn.example/segment.ts');
  assert.equal(await res.text(), 'cdn data');
  assert.equal(direct.mock.callCount(), 1);
  assert.equal(tunnelHits.length, 0);
});

test('redirects onto the configured provider select the tunnel again', async (t) => {
  process.env.UPSTREAM_PROXY = tunnelAddress;
  const direct = t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).startsWith('https://cdn.example/')
      ? new Response(null, { status: 302, headers: { location: `${provider}/player_api.php` } })
      : Response.json({ via: 'direct' }));
  const res = await request('https://cdn.example/redirect');
  assert.deepEqual(await res.json(), { via: 'tunnel' });
  assert.equal(direct.mock.callCount(), 1);
  assert.equal(tunnelHits.length, 1);
});

test('a failed tunnel never retries directly', async (t) => {
  // The selected local proxy refuses every request; no public network is used.
  const broken = http.createServer((_req, res) => res.writeHead(502).end('Tunnel unavailable'));
  await new Promise((resolve) => broken.listen(0, '127.0.0.1', resolve));
  t.after(() => { broken.closeAllConnections(); broken.close(); });
  process.env.UPSTREAM_PROXY = `127.0.0.1:${broken.address().port}`;
  const direct = t.mock.method(globalThis, 'fetch', async () => Response.json({ via: 'direct' }));
  const res = await request(`${provider}/player_api.php`);
  assert.equal(res.status, 502);
  assert.equal(direct.mock.callCount(), 0);
});
