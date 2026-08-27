// GET /api/diag — tells apart failures that all look like "Channel list failed".
// Run: node --test proxy/diag.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const XT_HOST = 'mhd.snapmediatoghater.site:8080';
const PASSWORD = 'sup3r-s3cret-pw';

// Stands in for the upstream: a Cloudflare block page, the way the real one
// fails — HTTP 403 with an HTML interstitial rather than a network error.
let mode = 'blocked';
const upstream = http.createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname.endsWith('playlist.m3u')) {
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    res.end('#EXTM3U\n#EXTINF:-1,Backup Channel\nhttp://cdn.example.net/1.ts\n');
    return;
  }
  if (mode === 'blocked') {
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ user_info: { auth: 1, username: 'u', password: PASSWORD } }));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

process.env.UPSTREAM_PROXY = `127.0.0.1:${upstream.address().port}`;
process.env.XTREAM_SERVER = `http://${XT_HOST}`;
process.env.XTREAM_USERNAME = 'u';
process.env.XTREAM_PASSWORD = PASSWORD;
process.env.M3U_URL = `http://${XT_HOST}/playlist.m3u`;
delete process.env.XTREAM_PROXY_URL;
delete process.env.ACCESS_KEY;

const { handleDiag } = await import('./hlsProxy.mjs');
const app = http.createServer(handleDiag);
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${app.address().port}`;
const diag = async (key = 'sekret') => (await fetch(`${origin}/api/diag?key=${key}`)).json();

test('diagnostics are refused when the deployment has no ACCESS_KEY', async () => {
  const res = await fetch(`${origin}/api/diag`);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /require ACCESS_KEY/);
  process.env.ACCESS_KEY = 'sekret';
  assert.equal((await fetch(`${origin}/api/diag?key=wrong`)).status, 403);
});

test('a Cloudflare block is reported as a block, not a generic failure', async () => {
  const d = await diag();
  assert.equal(d.source, 'xtream');
  assert.equal(d.transport, 'tunnel', 'UPSTREAM_PROXY is set, so the tunnel carries it');
  const login = d.checks.find((c) => c.name === 'player_api login');
  assert.equal(login.ok, false);
  assert.equal(login.status, 403);
  assert.match(login.preview, /Cloudflare/, 'the preview must name the actual cause');
  // The fallback is probed independently, so you can see it is ready to cover.
  const fallback = d.checks.find((c) => c.name.startsWith('m3u fallback'));
  assert.equal(fallback.ok, true);
  assert.match(fallback.preview, /#EXTM3U/);
});

test('secrets are reported as set/unset and never echoed, even by upstream', async () => {
  mode = 'ok'; // upstream now returns user_info containing the password verbatim
  const d = await diag();
  const body = JSON.stringify(d);
  assert.doesNotMatch(body, new RegExp(PASSWORD), 'the password must never appear');
  assert.match(JSON.stringify(d.checks), /\*\*\*/, 'it should be redacted, not merely absent');
  assert.deepEqual(d.env, {
    XTREAM_SERVER: true,
    XTREAM_USERNAME: true,
    XTREAM_PASSWORD: true,
    M3U_URL: true,
    UPSTREAM_PROXY: true,
    XTREAM_PROXY_URL: false,
    ACCESS_KEY: true,
  });
});

test('a healthy upstream reports ok, with timings', async () => {
  const d = await diag();
  const login = d.checks.find((c) => c.name === 'player_api login');
  assert.equal(login.ok, true);
  assert.equal(login.status, 200);
  assert.ok(typeof login.ms === 'number' && login.ms >= 0);
  assert.ok(login.bytes > 0);
});

test.after(() => {
  app.close();
  upstream.close();
});
