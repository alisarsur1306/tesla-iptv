import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/player/decoderWorker.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
const script = result.outputFiles[0].text;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, fetch, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const messages = [];
  const self = { postMessage: (message) => messages.push(message) };
  vm.runInNewContext(script, {
    self, fetch, AbortController, DOMException, TextDecoder, TextEncoder, Uint8Array,
    performance, setTimeout, clearTimeout, URL, console, ...overrides,
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
  t.mock.timers.tick(74_999);
  await flush();
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(x.messages.find((message) => message.t === 'error')?.msg, 'STREAM_TIMEOUT');
  assert.equal(x.messages.find((message) => message.t === 'error')?.sessionId, 1);
});

test('worker preserves settled refusal codes and the fatal flag', async (t) => {
  const x = setup(t, async () => Response.json({ code: 'STREAM_REJECTED', retryable: false, error: 'Sensitive upstream URL must not be forwarded' }, { status: 502 }));
  x.send({ t: 'play', url: '/stream', sessionId: 1 });
  await flush();
  const error = x.messages.find((message) => message.t === 'error');
  assert.equal(error?.msg, 'STREAM_REJECTED');
  assert.equal(error?.fatal, true);
});

// Two complete video PES packets. A mock decoder delays output until flush(),
// reproducing a real decoder retaining its last reordered frames at finite EOF.
function finiteTs() {
  const nals = [0, 0, 1, 0x67, 0x42, 0xc0, 0x1e, 0, 0, 1, 0x68, 0xce, 0, 0, 1, 0x65, 0xaa];
  const packet = new Uint8Array(188).fill(0xff);
  packet.set([0x47, 0x41, 0, 0x10, 0, 0, 1, 0xe0, 0, nals.length + 3, 0x80, 0, 0, ...nals]);
  return new Uint8Array([...packet, ...packet]);
}

async function presentation(t) {
  let now = 1000;
  let output;
  const drawn = [];
  class Decoder {
    state = 'unconfigured';
    decodeQueueSize = 0;
    constructor(callbacks) { output = callbacks.output; }
    configure() { this.state = 'configured'; }
    close() { this.state = 'closed'; }
    decode() {}
  }
  const x = setup(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(finiteTs()); },
  })), {
    VideoDecoder: Decoder,
    EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } },
    performance: { timeOrigin: 0, now: () => now },
  });
  x.send({ t: 'init', canvas: { width: 320, height: 180, getContext: () => ({ drawImage(frame) { drawn.push(frame.timestamp / 1000); } }) } });
  x.send({ t: 'play', url: '/stream', sessionId: 1 });
  const step = async ms => { now += ms; t.mock.timers.tick(ms); await flush(); };
  for (let i = 0; i < 5; i++) await step(20);
  assert.equal(typeof output, 'function');
  return { ...x, drawn, step,
    anchor: (mediaMs = 0, lead = 0) => x.send({ t: 'anchor', mediaMs, epochMs: now + lead, sessionId: 1 }),
    frame: pts => output({ timestamp: pts * 1000, displayWidth: 320, displayHeight: 180, close() {} }),
  };
}

test('startup buffering preserves the audio prebuffer instead of showing video ahead of sound', async t => {
  const x = await presentation(t);
  x.anchor(0, 1500);
  x.frame(0);
  await x.step(500);
  assert.deepEqual(x.drawn, [], 'video waits for the same 1.5-second lead as audio');
  await x.step(1000);
  assert.deepEqual(x.drawn, [0]);
  x.send({ t: 'stop' });
});

test('video catches up to the unchanged audio clock after starvation and a late frame', async t => {
  const x = await presentation(t);
  x.anchor();
  x.frame(0);
  await x.step(40);
  assert.deepEqual(x.drawn, [0]);
  x.anchor();
  await x.step(1000);
  x.frame(500);
  await x.step(40);
  x.frame(1040);
  await x.step(40);
  assert.ok(x.drawn.includes(1040), 'a late video frame must not move the speaker clock backwards');
  x.send({ t: 'stop' });
});

test('a future video frame cannot fast-forward the audio master clock', async t => {
  const x = await presentation(t);
  x.anchor();
  x.frame(10000);
  await x.step(6000);
  assert.deepEqual(x.drawn, [], 'the stall guard must not silently replace the audio timeline');
  await x.step(4000);
  assert.deepEqual(x.drawn, [10000]);
  x.send({ t: 'stop' });
});

for (const mode of ['TS', 'HLS ENDLIST']) {
  test(`${mode} delivered in one burst drains its first and final frames before reconnecting`, async (t) => {
    let draws = 0;
    const framesAtError = [];
    class Decoder {
      state = 'unconfigured';
      decodeQueueSize = 0;
      pending = [];
      constructor(callbacks) { this.callbacks = callbacks; }
      configure() { this.state = 'configured'; }
      close() { this.state = 'closed'; }
      decode(chunk) { this.pending.push(chunk); }
      async flush() {
        for (const chunk of this.pending.splice(0)) this.callbacks.output({ timestamp: chunk.timestamp, displayWidth: 320, displayHeight: 180, close() {} });
      }
    }
    const x = setup(t, async (url) => {
      if (mode === 'HLS ENDLIST' && url === '/stream') {
        return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n/segment.ts\n#EXT-X-ENDLIST\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      return new Response(finiteTs(), { headers: { 'content-type': 'video/mp2t' } });
    }, {
      VideoDecoder: Decoder,
      EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } },
    });
    x.send({ t: 'init', canvas: { width: 320, height: 180, getContext: () => ({ drawImage() { draws++; } }) } });
    x.send({ t: 'play', url: '/stream', sessionId: 1 });
    for (let i = 0; i < 20; i++) {
      await flush();
      if (x.messages.some((message) => message.t === 'error')) framesAtError.push(draws);
      t.mock.timers.tick(20);
    }
    assert.equal(draws, 2, 'EOF must not discard queued bytes or the final PES/decoder output');
    assert.ok(framesAtError.length > 0, 'finite live source eventually reaches the reconnect controller');
    assert.ok(framesAtError.every((count) => count === 2), 'reconnect must follow presentation');
    x.send({ t: 'stop' });
  });
}

for (const action of ['stop', 'timeout']) {
  test(`a decoder stuck flushing at EOF remains bounded and honors ${action}`, async (t) => {
    let now = 1;
    let flushes = 0;
    class Decoder {
      state = 'unconfigured';
      decodeQueueSize = 0;
      configure() { this.state = 'configured'; }
      close() { this.state = 'closed'; }
      decode() {}
      flush() { flushes++; return new Promise(() => {}); }
    }
    const x = setup(t, async () => new Response(finiteTs()), {
      VideoDecoder: Decoder,
      EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } },
      performance: { timeOrigin: 0, now: () => now },
    });
    x.send({ t: 'play', url: '/stream', sessionId: 1 });
    for (let i = 0; i < 5; i++) { await flush(); t.mock.timers.tick(20); }
    assert.equal(flushes, 1);
    if (action === 'stop') x.send({ t: 'stop' });
    now = 40_000;
    t.mock.timers.tick(40_000);
    await flush();
    const errors = x.messages.filter((message) => message.t === 'error');
    assert.equal(errors.length, action === 'stop' ? 0 : 1);
    if (action === 'timeout') assert.equal(errors[0].msg, 'STREAM_ENDED');
    x.send({ t: 'stop' });
  });
}

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
