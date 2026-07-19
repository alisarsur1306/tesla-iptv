// Smallest check that fails if the proxy's gate breaks: node proxy/hlsProxy.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleProxy } from './hlsProxy.mjs';

const server = http.createServer(handleProxy);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/proxy`;

const call = async (u, key) => {
  const url = `${base}?u=${encodeURIComponent(u)}${key === undefined ? '' : `&key=${encodeURIComponent(key)}`}`;
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
};

process.env.ACCESS_KEY = 'test-key-123';

// Wrong/missing key is rejected before anything is fetched.
assert.equal((await call('http://example.com/x.ts', 'nope')).status, 403);
assert.equal((await call('http://example.com/x.ts')).status, 403);

// SSRF guard blocks private/loopback targets even WITH a valid key.
for (const u of ['http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://localhost/x']) {
  const { status, body } = await call(u, 'test-key-123');
  assert.equal(status, 403, `${u} should be blocked`);
  assert.match(body, /Forbidden target host/);
}

// The regression this file exists for: a valid key reaches an arbitrary public
// CDN host (bare IP included). Previously a hardcoded host list 403'd these,
// which silently broke playback whenever the provider changed CDN.
for (const u of ['http://45.139.122.205:5566/hlsr/abc.ts', 'http://some-new-cdn.example.net/x.ts']) {
  const { status, body } = await call(u, 'test-key-123');
  assert.notEqual(status, 403, `${u} should not be gate-blocked (got ${body})`);
}

// UPSTREAM_PROXY must route ONLY the Xtream API host. Video segments redirect to a
// CDN that does not block datacenter IPs, so they must stay direct — otherwise the
// whole stream would run over the exit node's home uplink.
const seenByProxy = [];
const stubProxy = http.createServer((req, res) => {
  seenByProxy.push(req.url);
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
  res.end('#EXTM3U\n');
});
await new Promise((r) => stubProxy.listen(0, '127.0.0.1', r));
process.env.UPSTREAM_PROXY = `127.0.0.1:${stubProxy.address().port}`;

await call('http://mhd.snapmediatoghater.site:8080/player_api.php', 'test-key-123');
assert.equal(seenByProxy.length, 1, 'Xtream API host must go through UPSTREAM_PROXY');
assert.match(seenByProxy[0], /snapmediatoghater\.site/);

// A CDN host must bypass the proxy entirely (this one fails to resolve, which is
// fine — the assertion is that the proxy never saw it).
await call('http://45.139.122.205:5566/hlsr/x.ts', 'test-key-123');
assert.equal(seenByProxy.length, 1, `CDN traffic must bypass the proxy, saw: ${seenByProxy[1]}`);

stubProxy.close();
delete process.env.UPSTREAM_PROXY;

server.close();
console.log('hlsProxy gate + routing checks passed');
