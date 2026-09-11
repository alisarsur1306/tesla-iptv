import test from 'node:test';
import assert from 'node:assert/strict';
import { openStream, StreamTimeoutError } from './streamRequest.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('headers that never arrive time out and abort the request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const result = openStream('/stream', new AbortController().signal, 20).catch((e) => e);
  t.mock.timers.tick(20);
  assert.ok(await result instanceof StreamTimeoutError);
  assert.equal(signal.aborted, true);
});

test('silent bodies time out, while real data resets the read deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let body;
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(c) { body = c; },
    cancel() { cancelled = true; },
  })));
  const stream = await openStream('/stream', new AbortController().signal, 20);
  const first = stream.read();
  t.mock.timers.tick(19);
  body.enqueue(new Uint8Array([1]));
  assert.deepEqual((await first).value, new Uint8Array([1]));
  // Decoder backpressure isn't network inactivity: no deadline between reads.
  t.mock.timers.tick(5000);
  const next = stream.read().catch((e) => e);
  t.mock.timers.tick(19);
  await flush();
  assert.equal(cancelled, false);
  t.mock.timers.tick(1);
  assert.ok(await next instanceof StreamTimeoutError);
  await flush();
  assert.equal(cancelled, true);
});

test('stop cancels an active body and rejects outstanding reads immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = new AbortController();
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const stream = await openStream('/stream', session.signal, 20);
  const result = stream.read().catch((e) => e);
  session.abort();
  assert.equal((await result).name, 'AbortError');
  assert.equal(cancelled, true);
  t.mock.timers.tick(1000);
});

test('empty chunks cannot keep a silent stream alive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let body;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(c) { body = c; } })));
  const stream = await openStream('/stream', new AbortController().signal, 20);
  const result = stream.read().catch((e) => e);
  t.mock.timers.tick(10);
  body.enqueue(new Uint8Array());
  await flush();
  t.mock.timers.tick(10);
  assert.ok(await result instanceof StreamTimeoutError);
});

test('a session cancelled before fetch never opens a request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const session = new AbortController();
  session.abort();
  await assert.rejects(openStream('/stream', session.signal), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('failed HTTP responses release their bodies and retain a safe status code', async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 }));
  await assert.rejects(openStream('/stream', new AbortController().signal), /HTTP_403/);
  assert.equal(cancelled, true);
});
