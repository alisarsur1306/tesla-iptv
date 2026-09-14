import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://tv.example';
const page = asset => `<html><meta name="tesla-shell" content="1"><script src="/assets/${asset}.js"></script></html>`;
async function worker() {
  const handlers = new Map();
  const records = new Map();
  const key = req => new URL(typeof req === 'string' ? req : req.url, origin).href;
  const cache = { match: async req => records.get(key(req))?.clone(), put: async (req, response) => records.set(key(req), response.clone()), keys: async () => [...records.keys()].map(url => ({ url })), delete: async req => records.delete(key(req)) };
  let request = async url => new Response(String(url).endsWith('/') ? page('old-123') : 'export{}', { headers: { 'Content-Type': String(url).endsWith('/') ? 'text/html' : 'text/javascript' } });
  vm.runInNewContext(code, { URL, Request, Response, AbortSignal, console, caches: { open: async () => cache }, fetch: (...args) => request(...args), self: { location: { origin }, addEventListener: (name, fn) => handlers.set(name, fn), skipWaiting: async () => {}, clients: { claim: async () => {} } } });
  const install = [];
  handlers.get('install')({ waitUntil: p => install.push(p) });
  await Promise.all(install);
  return { records, setFetch: fn => { request = fn; }, navigate(url = '/') {
    let response;
    const pending = [];
    handlers.get('fetch')({ request: { method: 'GET', mode: 'navigate', url: origin + url }, respondWith: p => { response = p; }, waitUntil: p => pending.push(p) });
    return { response, pending };
  }, request(url) {
    let intercepted = false;
    handlers.get('fetch')({ request: new Request(new URL(url, origin)), respondWith: () => { intercepted = true; }, waitUntil() {} });
    return intercepted;
  } };
}

test('cached shell loads during a network failure without caching access keys or API/media responses', async () => {
  const w = await worker();
  w.setFetch(async () => { throw new Error('offline'); });
  const navigation = w.navigate('/?key=PRIVATE');
  assert.match(await (await navigation.response).text(), /old-123/);
  await Promise.all(navigation.pending);
  assert.ok([...w.records.keys()].every(key => !key.includes('PRIVATE')));
  for (const path of ['/api/stream?id=1&key=PRIVATE', '/api/proxy?u=secret', '/config.json?key=PRIVATE', '/live.ts', 'https://other.example/assets/a-123.js']) assert.equal(w.request(path), false);
});

test('shell update waits for its assets and retains the old shell if a new asset fails', async () => {
  const w = await worker();
  w.setFetch(async url => String(url).endsWith('/') ? new Response(page('new-456'), { headers: { 'Content-Type': 'text/html' } }) : new Response('failed', { status: 502 }));
  const navigation = w.navigate();
  assert.match(await (await navigation.response).text(), /old-123/);
  await Promise.all(navigation.pending);
  assert.match(await w.records.get(origin + '/').text(), /old-123/);
});
