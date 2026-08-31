// Smallest check that fails if the proxy's gate breaks: node proxy/hlsProxy.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleProxy, m3uHeaders, persistList, loadPersistedList } from './hlsProxy.mjs';

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

// --- M3U_AUTH -------------------------------------------------------------
// The exported playlist embeds the account in every stream URL, so it can only be
// hosted somewhere private — which the fetch has to be able to authenticate to.
{
  const before = process.env.M3U_AUTH;

  delete process.env.M3U_AUTH;
  const anon = m3uHeaders();
  assert.equal(anon.Authorization, undefined, 'no Authorization header without M3U_AUTH');
  assert.match(anon.Accept, /vnd\.github\.raw/, 'GitHub raw media type must be offered');
  assert.match(anon.Accept, /\*\/\*/, 'other hosts must still be accepted');
  assert.ok(anon['User-Agent'], 'User-Agent must survive');

  process.env.M3U_AUTH = 'Bearer ghp_example';
  assert.equal(
    m3uHeaders().Authorization,
    'Bearer ghp_example',
    'M3U_AUTH must be sent verbatim so any scheme works',
  );

  process.env.M3U_AUTH = 'Basic dXNlcjpwYXNz';
  assert.equal(m3uHeaders().Authorization, 'Basic dXNlcjpwYXNz', 'Basic auth must pass through');

  if (before === undefined) delete process.env.M3U_AUTH;
  else process.env.M3U_AUTH = before;
}

// --- disk-backed list cache ------------------------------------------------
// The in-memory cache dies with the process, so without this a restart has nothing to serve
// and the app falls back to an external M3U — a URL and a token that can fail on their own.
{
  const { mkdtempSync, existsSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  process.env.CACHE_DIR = dir;

  const channels = Array.from({ length: 300 }, (_, i) => ({ stream_id: i, name: `Ch ${i}` }));
  persistList('get_live_streams', channels);
  await new Promise((r) => setTimeout(r, 150)); // the write is async by design

  const file = path.join(dir, 'xt-get_live_streams.json');
  assert.ok(existsSync(file), 'a list action must be written to disk');

  const back = await loadPersistedList('get_live_streams');
  assert.equal(back?.length, 300, 'the persisted list must come back intact');
  assert.equal(back[0].name, 'Ch 0');

  // Actions that are not big lists are not worth persisting.
  persistList('', [{ user_info: {} }]);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!existsSync(path.join(dir, 'xt-login.json')), 'only list actions are persisted');

  // A corrupt or empty file must never take the app down — it just means no cache.
  writeFileSync(path.join(dir, 'xt-get_live_categories.json'), 'not json{');
  assert.equal(await loadPersistedList('get_live_categories'), null, 'corrupt cache reads as absent');
  assert.equal(await loadPersistedList('never_fetched'), null, 'missing cache reads as absent');
}

// --- stream ids agree across sources ---------------------------------------
// The M3U list numbered channels from zero while the Xtream API uses the provider's own ids,
// and the stream endpoint chose between the two tables from a module-global. A client holding
// one list while the server had switched to the other therefore resolved every channel wrongly.
{
  const { parseM3u } = await import('./hlsProxy.mjs');
  const m3u = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="Sports",beIN 1',
    'http://h:8080/live/USER/PASS/37312.m3u8',
    '#EXTINF:-1 group-title="News",Al Jazeera',
    'http://h:8080/live/USER/PASS/40255.ts',
    '#EXTINF:-1 group-title="Other",No Id Here',
    'http://h:8080/some/other/path.m3u8',
  ].join('\n');
  const parsed = parseM3u(m3u);
  assert.equal(parsed.length, 3);
  const { shapeM3uForTest } = await import('./hlsProxy.mjs');
  const shaped = shapeM3uForTest(parsed, 'get_live_streams');
  assert.equal(shaped[0].stream_id, 37312, 'the id in the stream URL must win over the index');
  assert.equal(shaped[1].stream_id, 40255, '.ts URLs carry ids too');
  assert.equal(shaped[2].stream_id, 2, 'a URL with no id falls back to its position');
}

// --- stream URL format -----------------------------------------------------
// The player consumes continuous MPEG-TS, not HLS, so an Xtream .m3u8 stream URL has to be
// normalised to .ts or the decoder waits on a manifest it cannot read.
{
  const norm = (u) =>
    String(u).replace(/^(https?:\/\/[^/]+\/(?:[^/?#]+\/){2}\d+)\.m3u8(\?|$)/i, '$1.ts$2');
  assert.equal(norm('http://h:8080/USER/PASS/37312.m3u8'), 'http://h:8080/USER/PASS/37312.ts');
  assert.equal(norm('http://h:8080/USER/PASS/37312.ts'), 'http://h:8080/USER/PASS/37312.ts');
  assert.equal(
    norm('http://h:8080/hls/chan/playlist.m3u8'),
    'http://h:8080/hls/chan/playlist.m3u8',
    'a non-Xtream HLS URL must be left alone',
  );
}

server.close();
console.log('hlsProxy gate + routing checks passed');
