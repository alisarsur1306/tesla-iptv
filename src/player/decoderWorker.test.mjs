import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/player/decoderWorker.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
const script = result.outputFiles[0].text;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, fetch) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const messages = [];
  const self = { postMessage: (message) => messages.push(message) };
  vm.runInNewContext(script, {
    self, fetch, AbortController, DOMException, TextDecoder, TextEncoder, Uint8Array,
    performance, setTimeout, clearTimeout, URL, console,
  });
  return { messages, send: (data) => self.onmessage({ data }) };
}

test('worker reports a silent header timeout and aborts that session', async (t) => {
  let signal;
  const x = setup(t, (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  x.send({ t: 'play', url: '/stream', sessionId: 1 });
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(x.messages.find((message) => message.t === 'error')?.msg, 'STREAM_TIMEOUT');
  assert.equal(x.messages.find((message) => message.t === 'error')?.sessionId, 1);
});

test('stop followed by play cancels the old reader and cannot restart old fetches', async (t) => {
  const calls = [];
  const x = setup(t, async (url, options) => {
    const call = { url, signal: options.signal, cancelled: false };
    calls.push(call);
    return new Response(new ReadableStream({ cancel() { call.cancelled = true; } }));
  });
  x.send({ t: 'play', url: '/first', sessionId: 1 });
  await flush();
  x.send({ t: 'stop' });
  x.send({ t: 'play', url: '/second', sessionId: 2 });
  await flush();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[0].cancelled, true);
  assert.equal(calls[1].signal.aborted, false);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(x.messages.filter((message) => message.t === 'error').length, 0);
  x.send({ t: 'stop' });
  await flush();
  assert.equal(calls[1].cancelled, true);
});
