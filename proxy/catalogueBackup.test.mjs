import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { useIsolatedCacheDir } from './testCacheDir.mjs';
import { accountScope } from './savedStreams.mjs';
import { mergeCatalogue } from './incrementalSync.mjs';

useIsolatedCacheDir();
const creds = { server: 'http://provider.example:8080', username: 'u', password: 'p' };
process.env.XTREAM_SERVER = creds.server;
process.env.XTREAM_USERNAME = creds.username;
process.env.XTREAM_PASSWORD = creds.password;
process.env.M3U_URL = 'https://api.github.com/repos/owner/private/contents/playlist.m3u';
process.env.M3U_AUTH = 'Bearer TEST_ONLY';
process.env.RENDER = 'true';
delete process.env.ACCESS_KEY;
delete process.env.XTREAM_PROXY_URL;
let providerHits = 0;
const provider = http.createServer((_req, res) => { providerHits++; res.writeHead(502).end(); });
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
process.env.UPSTREAM_PROXY = `127.0.0.1:${provider.address().port}`;
const proxy = await import('./hlsProxy.mjs');
let handler = proxy.handleXtreamApi;
const app = http.createServer((req, res) => void handler(req, res));
await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
const clientFetch = globalThis.fetch;
const endpoint = `http://127.0.0.1:${app.address().port}/api/xt`;
test.after(() => { for (const server of [app, provider]) { server.closeAllConnections(); server.close(); } });

test('the complete private catalogue restores after restart and serves both lists without a provider request', async t => {
  const catalogue = mergeCatalogue(null, Array.from({ length: 5000 }, (_, i) => ({ stream_id: i + 1, name: `Channel ${i + 1}`, category_id: '1', direct_source: 'https://video.example/PRIVATE_URL' })), [{ category_id: '1', category_name: 'News' }], creds).snapshot;
  t.mock.method(globalThis, 'fetch', async url => new Response(JSON.stringify(String(url).includes('catalogue-snapshot') ? catalogue : { version: 1, scope: accountScope(creds), entries: [] }), { headers: { ETag: '"backup-1"' } }));
  // The first request after a cold Render start must restore the private
  // catalogue before falling back to the unavailable home/provider route.
  for (const action of ['get_live_streams', 'get_live_categories']) {
    const response = await clientFetch(`${endpoint}?action=${action}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-catalogue-source'), 'saved');
    const text = await response.text();
    assert.doesNotMatch(text, /PRIVATE_URL|sourceHashes|direct_source/);
    assert.equal(JSON.parse(text).length, action === 'get_live_streams' ? 5000 : 1);
  }
  assert.equal(providerHits, 0);
  const page = await clientFetch(`${endpoint}?action=get_live_streams&offset=0&limit=200`);
  const first = await page.json();
  assert.equal(first.length, 200);
  assert.equal(page.headers.get('x-catalogue-total'), '5000');
  const revision = page.headers.get('x-catalogue-revision');
  const next = await clientFetch(`${endpoint}?action=get_live_streams&offset=200&limit=200&revision=${revision}`);
  assert.equal((await next.json())[0].stream_id, 201);
  const unchanged = await clientFetch(`${endpoint}?action=get_live_streams&limit=200&if_revision=${revision}`);
  assert.equal(unchanged.headers.get('x-catalogue-unchanged'), 'true');
  assert.deepEqual(await unchanged.json(), []);
  assert.equal((await clientFetch(`${endpoint}?action=get_live_streams&limit=200&revision=old`)).status, 409);
  assert.equal((await clientFetch(`${endpoint}?action=get_live_streams&limit=20000`)).status, 400);
  handler = (await import('./hlsProxy.mjs?restarted')).handleXtreamApi;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Backup offline'); });
  const restored = await clientFetch(`${endpoint}?action=get_live_streams`);
  assert.equal((await restored.json()).length, 5000);
  assert.equal(providerHits, 0);
});
