import test from 'node:test';
import assert from 'node:assert/strict';
import { SavedStreams, accountScope } from './savedStreams.mjs';
import { useIsolatedCacheDir } from './testCacheDir.mjs';
import { mergeCatalogue, syncAddresses, resolvePublicStream } from './incrementalSync.mjs';

const directory = useIsolatedCacheDir();
const creds = { server: 'http://provider.example:8080', username: 'u', password: 'p' };
const epoch = 1700000000000;
const categories = [{ category_id: '1', category_name: 'News' }];
const channel = (id, direct_source = '') => ({ stream_id: id, name: `Channel ${id}`, category_id: '1', stream_icon: '', direct_source });

test('catalogue delta changes only new/modified records and preserves missing rows', () => {
  const first = mergeCatalogue(null, [channel(1), channel(2)], categories, creds, epoch);
  const again = mergeCatalogue(first.snapshot, [channel(2), channel(1)], categories, creds, epoch + 1000);
  assert.deepEqual(again.stats, { added: 0, updated: 0, unchanged: 2, retained: 0 });
  assert.deepEqual(again.snapshot, first.snapshot, 'reordering and checking again are not changes');
  const delta = mergeCatalogue(first.snapshot, [{ ...channel(1), name: 'Renamed' }, channel(3)], categories, creds, epoch + 1000);
  assert.deepEqual(delta.stats, { added: 1, updated: 1, unchanged: 0, retained: 1 });
  assert.equal(delta.snapshot.channels.length, 3);
  assert.equal(delta.snapshot.channels.find(c => c.stream_id === 2).name, 'Channel 2');
  assert.throws(() => mergeCatalogue(first.snapshot, [], categories, creds, epoch), /catalogue/i);
  assert.throws(() => mergeCatalogue(first.snapshot, [channel(1), channel(1)], categories, creds, epoch), /duplicate/i);
  assert.throws(() => mergeCatalogue(first.snapshot, [channel(1)], categories, { ...creds, password: 'other' }, epoch), /account/i);
});

test('unchanged URLs retain timestamps and learned URLs; only changed or expiring candidates renew', async () => {
  let now = epoch;
  const store = new SavedStreams({ directory, scope: accountScope(creds), now: () => now });
  const channels = [channel(1, 'https://video.example/a.m3u8'), channel(2)];
  const catalogue = mergeCatalogue(null, channels, categories, creds, now).snapshot;
  await syncAddresses({ store, channels, catalogue, creds, now });
  await store.remember(2, 'https://video.example/learned.ts');
  const before = await store.snapshot();
  now += 1000;
  const result = await syncAddresses({ store, channels, catalogue, previousCatalogue: catalogue, creds, now });
  assert.equal(result.stats.changed, 0);
  assert.deepEqual(await store.snapshot(), before);
  now += 6.5 * 86400000;
  const renewed = await syncAddresses({ store, channels, catalogue, previousCatalogue: catalogue, creds, now });
  assert.equal(renewed.stats.changed, 1);
  assert.ok((await store.get(1)).savedAt > before.entries[0].savedAt);
  await store.flush();
});

test('missing address discovery is sequential, bounded and resumes without retrying recent failures', async () => {
  const now = epoch;
  const store = new SavedStreams({ directory, scope: 'e'.repeat(64), now: () => now });
  const channels = [channel(10), channel(11), channel(12), channel(13)];
  const catalogue = mergeCatalogue(null, channels, categories, creds, now).snapshot;
  const calls = [];
  const resolve = async c => { calls.push(c.stream_id); return c.stream_id === 10 ? { status: 'unavailable' } : { status: 'resolved', url: `https://video.example/${c.stream_id}.ts` }; };
  const first = await syncAddresses({ store, channels, catalogue, creds, now, resolve, maxResolve: 2 });
  assert.deepEqual(calls, [10, 11]);
  calls.length = 0;
  const next = await syncAddresses({ store, channels, catalogue, previousCatalogue: catalogue, creds, now: now + 1000, resolve, maxResolve: 2, state: first.state });
  assert.deepEqual(calls, [12, 13]);
  assert.equal(next.stats.attempted, 2);
  assert.equal((await store.snapshot()).entries.length, 3);
  await store.flush();
});

test('resolver accepts a public media redirect and refuses private targets or provider-only video', async () => {
  const packets = new Uint8Array(188); packets[0] = 0x47;
  const requests = [];
  const request = async url => { requests.push(String(url)); return requests.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://video.example/live.ts' } }) : new Response(packets); };
  const result = await resolvePublicStream(channel(1), creds, { request });
  assert.equal(result.status, 'resolved');
  assert.equal(result.url, 'https://video.example/live.ts');
  assert.equal(requests.length, 2);
  const privateResult = await resolvePublicStream(channel(1), creds, { request: async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }) });
  assert.equal(privateResult.status, 'unavailable');
  const dependent = await resolvePublicStream(channel(1), creds, { request: async () => new Response(packets) });
  assert.equal(dependent.status, 'provider_required');
});
