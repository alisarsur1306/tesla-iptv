import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessKeyError, TimeoutError, getLiveStreams, getLiveCatalogue, initAccessKeyFromUrl, getAccessKey, setAccessKey, readChannelCache, writeChannelCache, rememberManagedSession, hasCachedManagedSession } from './xtream.ts';

const creds = { server: 'managed', username: 'managed', password: 'managed' };

for (const status of [200, 502]) {
  test(`a stalled ${status} response body still reaches the channel-list deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    let body;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(controller) {
          body = controller;
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          controller.enqueue(new TextEncoder().encode(status === 200 ? '[' : '{'));
        },
      }), { status });
    });
    const result = getLiveStreams(creds).catch((error) => error);
    // Let fetch resolve and JSON consumption start, without completing the body.
    await new Promise((resolve) => setImmediate(resolve));
    try {
      t.mock.timers.tick(105_000);
      assert.equal(signal.aborted, true, 'deadline must remain active while reading JSON');
      const error = await result;
      assert.ok(error instanceof TimeoutError);
      assert.equal(error.ms, 105_000);
    } finally {
      if (!signal.aborted) body.error(new Error('test cleanup'));
      await result;
    }
  });
}

test('a complete list is returned and its deadline is cleared', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const channels = [{ stream_id: 7, name: 'Test channel' }];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return Response.json(channels);
  });
  assert.deepEqual(await getLiveStreams(creds), channels);
  t.mock.timers.tick(105_000);
  assert.equal(signal.aborted, false);
});

test('an invalid access key retains its distinct error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  await assert.rejects(getLiveStreams(creds), AccessKeyError);
});

test('upstream error details remain visible', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Source offline' }, { status: 502 }));
  await assert.rejects(getLiveStreams(creds), /Request failed \(502\).*Source offline/);
});

test('an empty refresh is rejected so it cannot replace the last visible channel list', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  await assert.rejects(getLiveStreams(creds), /empty/i);
});

test('browser cache skips identical writes, retains the old copy on quota errors, and follows the access key', t => {
  const records = new Map();
  let writes = 0;
  let quota = false;
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => records.get(key) || null,
    setItem: (key, value) => { if (quota) throw new Error('quota'); records.set(key, value); writes++; },
    removeItem: key => records.delete(key),
  } });
  t.after(() => { setAccessKey(''); if (old) Object.defineProperty(globalThis, 'localStorage', old); else delete globalThis.localStorage; });
  setAccessKey('cache-test');
  const cats = [{ category_id: '1', category_name: 'News' }];
  const rows = [{ stream_id: 1, name: 'Channel 1', category_id: '1', stream_icon: '' }];
  writeChannelCache(cats, rows);
  const first = readChannelCache();
  rememberManagedSession(true);
  assert.equal(hasCachedManagedSession(), true);
  const firstWrites = writes;
  writeChannelCache(cats, rows);
  assert.equal(writes, firstWrites);
  quota = true;
  writeChannelCache(cats, [{ ...rows[0], name: 'Changed' }]);
  assert.deepEqual(readChannelCache(), first);
  setAccessKey('another-key');
  assert.equal(readChannelCache(), null);
  assert.equal(hasCachedManagedSession(), false);
});

test('catalogue pagination exposes the first page before fetching the rest, then reuses an unchanged revision', async t => {
  let calls = 0;
  let firstVisible = false;
  const rows = Array.from({ length: 230 }, (_, i) => ({ stream_id: i + 1, name: `Channel ${i}` }));
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    const params = new URL(url, 'https://app.example').searchParams;
    assert.equal(params.get('limit'), '200');
    if (params.has('if_revision')) return Response.json([], { headers: { 'X-Catalogue-Revision': 'v1', 'X-Catalogue-Total': '230', 'X-Catalogue-Unchanged': 'true' } });
    const offset = Number(params.get('offset'));
    if (offset > 0) { assert.equal(firstVisible, true); assert.equal(params.get('revision'), 'v1'); }
    return Response.json(rows.slice(offset, offset + 200), { headers: { 'X-Catalogue-Revision': 'v1', 'X-Catalogue-Total': '230' } });
  });
  const result = await getLiveCatalogue(creds, { onPage: page => { if (!firstVisible) assert.equal(page.length, 200); firstVisible = true; } });
  assert.equal(result.streams.length, 230);
  assert.equal(result.revision, 'v1');
  assert.equal(calls, 2);
  const cached = { ...result, categories: [], at: Date.now() };
  assert.deepEqual(await getLiveCatalogue(creds, { cached }), result);
  assert.equal(calls, 3);
});

test('incomplete pagination rejects the refresh instead of returning a truncated catalogue', async t => {
  t.mock.method(globalThis, 'fetch', async url => Response.json(new URL(url, 'https://app.example').searchParams.get('offset') === '0' ? [{ stream_id: 1 }] : [], { headers: { 'X-Catalogue-Revision': 'v1', 'X-Catalogue-Total': '2' } }));
  await assert.rejects(getLiveCatalogue(creds), /incomplete/i);
});

test('URL access key works in memory and is removed from the address even when storage is unavailable', (t) => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let cleaned;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem() { throw new Error('storage disabled'); }, setItem() { throw new Error('storage disabled'); }, removeItem() {},
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { search: '?key=preview-only&lang=he', pathname: '/', hash: '#tv' },
    history: { replaceState(_state, _title, url) { cleaned = url; } },
  } });
  t.after(() => {
    setAccessKey('');
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete globalThis.window;
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete globalThis.localStorage;
  });
  initAccessKeyFromUrl();
  assert.equal(getAccessKey(), 'preview-only');
  assert.equal(cleaned, '/?lang=he#tv');
});
