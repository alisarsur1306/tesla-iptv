import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SavedStreams, accountScope, publicStreamUrl, sidecarSource, snapshotFromCatalogue } from './savedStreams.mjs';

const creds = { server: 'http://provider.example:8080/', username: 'u', password: 'p' };
const scope = accountScope(creds);
const directory = await mkdtemp(path.join(os.tmpdir(), 'saved-stream-test-'));
test.after(async () => {
  const actual = await realpath(directory);
  const parent = await realpath(os.tmpdir());
  assert.equal(path.dirname(actual), parent);
  assert.ok(path.basename(actual).startsWith('saved-stream-test-'));
  await rm(actual, { recursive: true, force: true });
});

test('addresses survive reload but cannot cross accounts or their application expiry', async () => {
  let now = 1700000000000;
  const cache = new SavedStreams({ directory, scope, now: () => now, ttlMs: 10000 });
  await cache.remember('1', 'https://video.example/live.m3u8');
  await cache.flush();
  const restored = new SavedStreams({ directory, scope, now: () => now, ttlMs: 10000 });
  assert.equal((await restored.get('1')).url, 'https://video.example/live.m3u8');
  const other = new SavedStreams({ directory, scope: accountScope({ ...creds, password: 'other' }), now: () => now });
  assert.equal(await other.get('1'), null);
  assert.equal(await other.merge({ version: 1, scope, entries: [{ id: '1', url: 'https://video.example/a', savedAt: now }] }), 0);
  now += 10001;
  assert.equal(await restored.get('1'), null);
  assert.equal(accountScope({ ...creds, server: creds.server.slice(0, -1) }), scope);
});

test('private and malformed targets cannot enter the saved address cache', async () => {
  for (const url of ['file:///etc/passwd', 'http://127.1/a', 'http://2130706433/a', 'http://[::1]/a', 'http://[::ffff:127.0.0.1]/a', 'http://10.0.0.1/a', 'http://100.100.100.100/a', 'http://169.254.169.254/a', 'http://192.168.1.1/a', 'http://198.19.254.2/a', 'http://localhost/a', 'http://host.local/a', 'http://user:password@video.example/a']) {
    assert.equal(publicStreamUrl(url), null, url);
  }
  assert.equal(publicStreamUrl('https://video.example/live?token=private'), 'https://video.example/live?token=private');
  const cache = new SavedStreams({ directory, scope: 'a'.repeat(64) });
  assert.equal(await cache.remember('2', 'http://127.0.0.1/a'), false);
  assert.equal(await cache.remember('../2', 'https://video.example/a'), false);
});

test('known signed expiry is respected and rejected addresses are not resurrected by an old sidecar', async () => {
  let now = 1700000000000;
  const cache = new SavedStreams({ directory, scope: 'b'.repeat(64), now: () => now });
  const url = 'https://video.example/live.ts?expires=1700000060';
  await cache.remember('3', url);
  assert.ok((await cache.get('3')).expiresAt <= 1700000060000);
  const snapshot = await cache.snapshot();
  now += 1000;
  await cache.invalidate('3', url);
  await cache.merge(snapshot);
  assert.equal(await cache.get('3'), null);
  await cache.flush();
  const restored = new SavedStreams({ directory, scope: 'b'.repeat(64), now: () => now });
  await restored.merge(snapshot);
  assert.equal(await restored.get('3'), null);
  now += 1000;
  await restored.remember('3', 'https://video.example/fresh.ts');
  assert.equal((await restored.get('3')).url, 'https://video.example/fresh.ts');
  await restored.flush();
});

test('cache size is bounded and malformed disk contents do not break playback', async () => {
  const cache = new SavedStreams({ directory, scope: 'c'.repeat(64), maxEntries: 2 });
  for (const id of ['1', '2', '3']) await cache.remember(id, `https://video.example/${id}.ts`);
  assert.equal((await cache.snapshot()).entries.length, 2);
  await cache.flush();
  assert.equal(JSON.parse(await readFile(cache.file, 'utf8')).scope, 'c'.repeat(64));
  assert.equal(await cache.merge({ version: 1, scope: 'c'.repeat(64), entries: 'invalid' }), 0);
});

test('only the same private GitHub repository gets the existing backup credential', () => {
  const source = sidecarSource({ M3U_URL: 'https://api.github.com/repos/owner/private/contents/backup/list.m3u?ref=main', M3U_AUTH: 'Bearer PRIVATE' });
  assert.equal(source.url, 'https://api.github.com/repos/owner/private/contents/backup/resolved-streams.json?ref=main');
  assert.equal(source.headers.Authorization, 'Bearer PRIVATE');
  assert.equal(sidecarSource({ M3U_URL: 'https://other.example/list.m3u', M3U_AUTH: 'Bearer PRIVATE' }), null);
  assert.equal(sidecarSource({ M3U_URL: 'http://api.github.com/repos/owner/private/contents/list.m3u', M3U_AUTH: 'Bearer PRIVATE' }), null);
});

test('catalogue sync extracts public direct sources without opening every channel', () => {
  const snapshot = snapshotFromCatalogue([
    { stream_id: 4, direct_source: 'https://video.example/live.m3u8' },
    { stream_id: 5, direct_source: `${creds.server}live/u/p/5.ts` },
    { stream_id: 6, direct_source: '' },
    { stream_id: 7, direct_source: 'http://127.0.0.1/a' },
  ], creds, 1700000000000);
  assert.equal(snapshot.scope, scope);
  assert.deepEqual(snapshot.entries.map(row => row.id), ['4']);
  assert.equal(snapshot.entries[0].savedAt, 1700000000000);
});
