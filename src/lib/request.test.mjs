import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, RequestTimeout, HttpError } from './request.ts';

for (const stalledAt of ['headers', 'body']) {
  test(`deadline includes stalled ${stalledAt}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      signal = options.signal;
      if (stalledAt === 'headers') return new Promise(() => {});
      return new Response(new ReadableStream({ start() {} }));
    });
    const result = requestJson('/config.json', { timeoutMs: 100 }).catch(e => e);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(100);
    assert.ok(await result instanceof RequestTimeout);
    assert.equal(signal.aborted, true);
  });
}

test('leaving startup cancels the request and preserves cancellation', async (t) => {
  const parent = new AbortController();
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const result = requestJson('/config.json', { signal: parent.signal }).catch(e => e);
  parent.abort();
  assert.equal((await result).name, 'AbortError');
  assert.equal(signal.aborted, true);
});

test('an invalid key remains distinguishable from a server outage', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  await assert.rejects(requestJson('/config.json'), e => e instanceof HttpError && e.status === 403);
});

test('completed requests release deadline and parent listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const parent = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return Response.json({ managed: true });
  });
  assert.deepEqual(await requestJson('/config.json', { timeoutMs: 100, signal: parent.signal }), { managed: true });
  t.mock.timers.tick(100);
  parent.abort();
  assert.equal(signal.aborted, false);
});
