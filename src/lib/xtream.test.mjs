import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessKeyError, TimeoutError, getLiveStreams } from './xtream.ts';

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
