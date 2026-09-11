import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

let imports = 0;
const provider = 'http://health-provider.example:8080';
const secret = 'private-health-password';

async function handlers() {
  return import(`./hlsProxy.mjs?health-test=${imports++}`);
}

function invoke(handler, url = '/api/health', method = 'GET') {
  return new Promise((resolve, reject) => {
    const res = new EventEmitter();
    const headers = {};
    res.setHeader = (key, value) => { headers[key.toLowerCase()] = value; };
    res.writeHead = (status, values) => {
      res.statusCode = status;
      for (const [key, value] of Object.entries(values)) res.setHeader(key, value);
    };
    res.end = (body) => resolve({ status: res.statusCode, headers, data: JSON.parse(String(body)) });
    Promise.resolve(handler({ url, method, headers: {} }, res)).catch(reject);
  });
}

test.beforeEach(() => {
  process.env.XTREAM_SERVER = provider;
  process.env.XTREAM_USERNAME = 'private-health-user';
  process.env.XTREAM_PASSWORD = secret;
  for (const key of ['RENDER', 'ACCESS_KEY', 'UPSTREAM_PROXY', 'XTREAM_PROXY_URL', 'M3U_URL', 'M3U_AUTH']) {
    delete process.env[key];
  }
});

test('health is key gated before making any upstream request', async (t) => {
  process.env.ACCESS_KEY = 'health-key';
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  const { handleHealth } = await handlers();
  for (const url of ['/api/health', '/api/health?key=wrong']) {
    assert.equal((await invoke(handleHealth, url)).status, 403);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await invoke(handleHealth, '/api/health?key=health-key', 'POST')).status, 405);
  assert.equal((await invoke(handleHealth, '/api/health?key=health-key')).status, 200);
  assert.equal(fetch.mock.callCount(), 1);
});

test('health validates the account, returns only its safe contract, and caches requests', async (t) => {
  let release;
  const fetch = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).searchParams.has('action'), false, 'only the small login request');
    await new Promise((resolve) => { release = resolve; });
    return Response.json({ user_info: { auth: 1, status: 'Active', password: secret } });
  });
  const { handleHealth } = await handlers();
  const requests = [invoke(handleHealth), invoke(handleHealth), invoke(handleHealth)];
  await Promise.resolve();
  release();
  const responses = await Promise.all(requests);
  for (const res of responses) {
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(res.data).sort(), ['checkedAt', 'route', 'status']);
    assert.equal(res.data.status, 'ok');
    assert.equal(res.data.route, 'direct');
    assert.equal(typeof res.data.checkedAt, 'number');
  }
  assert.deepEqual((await invoke(handleHealth)).data, responses[0].data);
  assert.equal(fetch.mock.callCount(), 1);
});

test('health rechecks after 15 seconds and immediately after a transport change', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ user_info: { auth: '1', status: 'Active' } }));
  const { handleHealth } = await handlers();
  await invoke(handleHealth);
  now += 14_999;
  await invoke(handleHealth);
  assert.equal(fetch.mock.callCount(), 1);
  now += 1;
  assert.equal((await invoke(handleHealth)).data.checkedAt, now);
  assert.equal(fetch.mock.callCount(), 2);
  process.env.XTREAM_PROXY_URL = 'https://worker.example/';
  assert.equal((await invoke(handleHealth)).data.route, 'worker');
  assert.equal(fetch.mock.callCount(), 3);
});

test('an HTTP 200 with a rejected or inactive account is not healthy', async (t) => {
  for (const user_info of [{ auth: 0 }, { auth: '1', status: 'Expired' }, { auth: 1, status: 'Banned' }]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ user_info }));
    const { handleHealth } = await handlers();
    assert.equal((await invoke(handleHealth)).data.status, 'provider_rejected');
    t.mock.restoreAll();
  }
});

test('HTML, malformed JSON, and incomplete login data stay unknown', async (t) => {
  for (const body of ['<html>challenge</html>', '{bad', '{}', '{"user_info":{"auth":1}}']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body));
    const { handleHealth } = await handlers();
    assert.equal((await invoke(handleHealth)).data.status, 'unknown');
    t.mock.restoreAll();
  }
});

test('HTTP refusal is reported without exposing an upstream block page', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(`${secret} blocked`, { status: 403 }));
  const { handleHealth } = await handlers();
  assert.deepEqual((await invoke(handleHealth)).data.status, 'provider_rejected');
});

test('a failing configured transport is distinguished from a direct network failure', async (t) => {
  process.env.XTREAM_PROXY_URL = 'https://worker.example/';
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError(`fetch failed ${secret}`); });
  const { handleHealth } = await handlers();
  const result = await invoke(handleHealth);
  assert.equal(result.data.status, 'proxy_unreachable');
  assert.equal(result.data.route, 'worker');
  assert.doesNotMatch(JSON.stringify(result.data), /private-health|example/);
  delete process.env.XTREAM_PROXY_URL;
  const direct = await handlers();
  const directResult = await invoke(direct.handleHealth);
  assert.equal(directResult.data.route, 'direct');
  assert.equal(directResult.data.status, 'unknown');
});

test('missing proxy configuration on Render fails closed without a fetch', async (t) => {
  process.env.RENDER = 'true';
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  const { handleHealth } = await handlers();
  const { data } = await invoke(handleHealth);
  assert.equal(data.status, 'not_configured');
  assert.equal(data.route, 'blocked');
  assert.equal(fetch.mock.callCount(), 0);
});

test('missing or malformed account configuration is reported without fetching', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  for (const configured of ['', 'not a URL', 'file:///private/config']) {
    process.env.XTREAM_SERVER = configured;
    const { handleHealth } = await handlers();
    assert.equal((await invoke(handleHealth)).data.status, 'not_configured');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('the ten second deadline includes a stalled login response body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"user_info":'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
  });
  const { handleHealth } = await handlers();
  const pending = invoke(handleHealth);
  await Promise.resolve();
  t.mock.timers.tick(10_000);
  assert.equal((await pending).data.status, 'timeout');
  assert.equal(signal.aborted, true);
});

test('the deadline also resolves a fetch that never sends headers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  const { handleHealth } = await handlers();
  const pending = invoke(handleHealth);
  t.mock.timers.tick(10_000);
  assert.equal((await pending).data.status, 'timeout');
});

test('quick diagnostics measure the selected Worker route even with a tunnel configured', async (t) => {
  process.env.ACCESS_KEY = 'health-key';
  process.env.XTREAM_PROXY_URL = 'https://worker.example/';
  process.env.UPSTREAM_PROXY = '127.0.0.1:1';
  const fetch = t.mock.method(globalThis, 'fetch', async (url) => {
    const wrapped = new URL(url);
    assert.equal(wrapped.hostname, 'worker.example');
    assert.equal(new URL(wrapped.searchParams.get('u')).hostname, 'api.ipify.org');
    return Response.json({ ip: '203.0.113.8' });
  });
  const { handleDiag } = await handlers();
  const { data } = await invoke(handleDiag, '/api/diag?quick=1&key=health-key');
  assert.equal(data.transport, 'worker');
  assert.equal(data.egressTransport, 'worker');
  assert.equal(data.egressIp, '203.0.113.8');
  assert.equal(fetch.mock.callCount(), 1);
});

test('quick diagnostics do not use Render egress when provider routing is blocked', async (t) => {
  process.env.ACCESS_KEY = 'health-key';
  process.env.RENDER = 'true';
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ip: '203.0.113.9' }));
  const { handleDiag } = await handlers();
  const { data } = await invoke(handleDiag, '/api/diag?quick=1&key=health-key');
  assert.equal(data.egressTransport, 'blocked');
  assert.equal(data.egressIp, null);
  assert.equal(fetch.mock.callCount(), 0);
});
