// Browser-assisted address lookup: /api/resolve redirects to the Worker, /api/learn stores its answer.
// Run: node --test proxy/resolve.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { useIsolatedCacheDir } from './testCacheDir.mjs';

useIsolatedCacheDir();
process.env.XTREAM_SERVER = 'http://provider.example:8080';
process.env.XTREAM_USERNAME = 'u';
process.env.XTREAM_PASSWORD = 'p';
process.env.ACCESS_KEY = 'k';
delete process.env.STREAM_RESOLVER_URL;
const { handleResolve, handleLearn } = await import('./hlsProxy.mjs');

const server = http.createServer((req, res) => (req.url.startsWith('/api/learn') ? handleLearn : handleResolve)(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());
const call = (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect: 'manual', ...init });

test('resolve needs the key and does nothing until a resolver is configured', async () => {
  assert.equal((await call('/api/resolve?id=7')).status, 403);
  assert.equal((await call('/api/resolve?id=x&key=k')).status, 400);
  assert.equal((await call('/api/resolve?id=7&key=k')).status, 204);
});

test('resolve redirects to the Worker until an address is learned; learn rejects private targets', async () => {
  process.env.STREAM_RESOLVER_URL = 'https://resolver.example/?t=secret';
  const redirect = await call('/api/resolve?id=7&key=k');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://resolver.example/?t=secret&resolve=7');

  const learn = (u, key = 'k') => call(`/api/learn?id=7&key=${key}&u=${encodeURIComponent(u)}`, { method: 'POST' });
  assert.equal((await learn('https://video.example/live/7.ts?token=a', 'wrong')).status, 403);
  assert.equal((await learn('http://127.0.0.1/7.ts')).status, 400);
  assert.equal((await learn('https://video.example/live/7.ts?token=a')).status, 204);
  assert.equal((await call('/api/resolve?id=7&key=k')).status, 204);
});
