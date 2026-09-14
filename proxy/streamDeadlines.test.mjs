import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

let imports = 0;
const provider = 'http://deadline-provider.example';
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function handlers() { return import(`./hlsProxy.mjs?deadline=${imports++}`); }
function response() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.headers = {};
  res.headersSent = false;
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headersSent = true; Object.assign(res.headers, headers); };
  res.json = () => JSON.parse(Buffer.concat(chunks).toString());
  res.bytes = () => Buffer.concat(chunks);
  return res;
}
function start(handler, res, url = '/api/stream?id=7') {
  return handler({ method: 'GET', url, headers: {} }, res);
}
function mockedBody(t, type, initial) {
  let writer;
  let signal;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      writer = controller;
      ready();
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      if (initial) controller.enqueue(initial);
    } }), { headers: { 'content-type': type } });
  });
  return { started, write: (chunk) => writer.enqueue(chunk), signal: () => signal, end: () => writer.close() };
}

test.beforeEach(() => {
  process.env.XTREAM_SERVER = provider;
  process.env.XTREAM_USERNAME = 'test-only-user';
  process.env.XTREAM_PASSWORD = 'test-only-password';
  for (const key of ['RENDER', 'ACCESS_KEY', 'UPSTREAM_PROXY', 'XTREAM_PROXY_URL', 'M3U_URL', 'M3U_AUTH']) delete process.env[key];
});

test('headers without stream bytes reach the shared 60s start deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const body = mockedBody(t, 'video/mp2t');
  const { handleStream } = await handlers();
  const res = response();
  const pending = start(handleStream, res);
  await body.started;
  await flush();
  t.mock.timers.tick(59_999);
  await flush();
  assert.equal(res.headersSent, false, 'do not promise a successful stream before its first byte');
  t.mock.timers.tick(1);
  await pending;
  assert.equal(res.statusCode, 504);
  assert.equal(res.json().code, 'STREAM_TIMEOUT');
  assert.equal(res.json().retryable, true);
  assert.equal(body.signal().aborted, true);
});

test('a manifest with progress still has a total startup deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const body = mockedBody(t, 'application/vnd.apple.mpegurl', Buffer.from('#EXTM3U\n'));
  const { handleStream } = await handlers();
  const res = response();
  const pending = start(handleStream, res);
  await body.started;
  await flush();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(10_000);
    body.write(Buffer.from('# keepalive\n'));
    await flush();
  }
  t.mock.timers.tick(10_000);
  await pending;
  assert.equal(res.statusCode, 504);
  assert.equal(res.json().code, 'STREAM_TIMEOUT');
  assert.equal(body.signal().aborted, true);
});

test('active streams outlive the startup budget but stop after 20s without data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const body = mockedBody(t, 'video/mp2t', new Uint8Array([0x47, 1]));
  const { handleStream } = await handlers();
  const res = response();
  const pending = start(handleStream, res);
  await body.started;
  await flush();
  for (let i = 0; i < 7; i++) {
    t.mock.timers.tick(10_000);
    body.write(new Uint8Array([0x47, i]));
    await flush();
    assert.equal(body.signal().aborted, false);
  }
  assert.equal(res.statusCode, 200);
  assert.equal(res.bytes().length, 16, 'TS streams progressively instead of buffering to completion');
  t.mock.timers.tick(20_000);
  await pending;
  assert.equal(body.signal().aborted, true);
  assert.equal(res.destroyed, true);
  assert.equal(res.bytes().length, 16, 'never append error JSON into MPEG-TS');
});

test('every refused candidate is aborted before the next source is opened', async (t) => {
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (signals.length) assert.equal(signals.at(-1).aborted, true);
    signals.push(options.signal);
    return new Response('Forbidden', { status: 403 });
  });
  const { handleProxy } = await handlers();
  const res = response();
  await handleProxy({ method: 'GET', headers: {}, url: `/api/proxy?u=${encodeURIComponent(provider + '/first.ts')}`,
    streamId: '7', streamTargets: [{ url: provider + '/first.ts' }, { url: provider + '/second.ts' }],
  }, res);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(res.json().code, 'STREAM_REJECTED');
  assert.equal(res.json().retryable, false);
  assert.doesNotMatch(JSON.stringify(res.json()), /test-only|deadline-provider|http:/);
});

test('a stalled refusal body is cancelled without permanently marking the channel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let signal;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    ready();
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }), { status: 403 });
  });
  const { handleStream } = await handlers();
  const res = response();
  const pending = start(handleStream, res);
  await started;
  await flush();
  t.mock.timers.tick(3000);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(res.json().retryable, true);
  assert.notEqual(res.json().code, 'STREAM_REJECTED');
});

test('leaving during cold backup discovery aborts it without opening a video', async (t) => {
  delete process.env.XTREAM_SERVER;
  process.env.M3U_URL = 'http://backup.example/list.m3u';
  let signal;
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const { handleStream } = await handlers();
  const res = response();
  const pending = start(handleStream, res);
  await flush();
  res.destroy();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(res.headersSent, false);
});

test('a cold M3U diagnostic aborts resolution after eight seconds, before probing video', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  delete process.env.XTREAM_SERVER;
  process.env.M3U_URL = 'http://backup.example/list.m3u';
  process.env.ACCESS_KEY = 'diagnostic-test-key';
  let signal;
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const { handleDiag } = await handlers();
  const res = response();
  const pending = start(handleDiag, res, '/api/diag?quick=1&stream=7&key=diagnostic-test-key');
  await flush();
  // Isolate the stream-resolution probe from the separate backup status check.
  delete process.env.M3U_URL;
  t.mock.timers.tick(8000);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(fetch.mock.callCount(), 1);
  const probe = res.json().checks.find((check) => check.name === 'live stream 7');
  assert.equal(probe.ok, false);
  assert.match(probe.error, /time/i);
});

test('downstream backpressure does not consume the network inactivity budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const body = mockedBody(t, 'video/mp2t', new Uint8Array([0x47, 1]));
  const { handleStream } = await handlers();
  const res = response();
  res._writableState.highWaterMark = 1;
  let release;
  res._write = (_chunk, _encoding, done) => { release = done; };
  const pending = start(handleStream, res);
  await body.started;
  await flush();
  try {
    assert.equal(res.writableNeedDrain, true);
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(body.signal().aborted, false);
  } finally {
    release?.();
    res.destroy();
    await pending;
  }
});

test('a fallback timeout cannot permanently mark a channel refused by the other source', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { handleProxy, handleUnavailable } = await handlers();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return new Response('Forbidden', { status: 403 });
    return new Promise(() => {});
  });
  const res = response();
  const pending = handleProxy({ method: 'GET', headers: {}, url: `/api/proxy?u=${encodeURIComponent(provider + '/first.ts')}`,
    streamId: '98123', streamTargets: [{ url: provider + '/first.ts' }, { url: provider + '/second.ts' }],
  }, res);
  await flush();
  t.mock.timers.tick(25_000);
  await pending;
  assert.equal(res.json().code, 'STREAM_TIMEOUT');
  assert.equal(res.json().retryable, true);
  const availability = response();
  await start(handleUnavailable, availability, '/api/unavailable');
  assert.ok(!availability.json().ids.includes(98123));
});
