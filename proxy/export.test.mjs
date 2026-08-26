// GET /api/export.m3u — the offline backup, built server-side from the live list.
// Run: node --test proxy/export.test.mjs
//
// This endpoint hands out the account in the clear (every line carries the
// credentialed stream URL), so the gate matters as much as the output: it must
// refuse entirely when the deployment has no ACCESS_KEY, and the M3U it emits
// must survive a round-trip through parseM3u — that is what M3U_URL reads back.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const XT_HOST = 'mhd.snapmediatoghater.site:8080';

const STREAMS = [
  { stream_id: 77, name: 'Al Jazeera, HD', stream_icon: 'http://logo/aj.png', category_id: '3' },
  { stream_id: 78, name: 'BBC World', stream_icon: '', category_id: '9' },
];
const CATEGORIES = [{ category_id: '3', category_name: 'News' }];

const upstream = http.createServer((req, res) => {
  const action = new URL(req.url, 'http://x').searchParams.get('action');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(action === 'get_live_categories' ? CATEGORIES : STREAMS));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
process.env.UPSTREAM_PROXY = `127.0.0.1:${upstream.address().port}`;
process.env.XTREAM_SERVER = `http://${XT_HOST}`;
process.env.XTREAM_USERNAME = 'u';
process.env.XTREAM_PASSWORD = 'p';
delete process.env.M3U_URL;
delete process.env.XTREAM_PROXY_URL;
delete process.env.ACCESS_KEY;

const { handleExportM3u, parseM3u } = await import('./hlsProxy.mjs');
const app = http.createServer(handleExportM3u);
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${app.address().port}`;

test('export is refused outright when the deployment has no ACCESS_KEY', async () => {
  const res = await fetch(`${origin}/api/export.m3u`);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /requires ACCESS_KEY/);
});

test('a wrong key is refused once ACCESS_KEY is set', async () => {
  process.env.ACCESS_KEY = 'sekret';
  assert.equal((await fetch(`${origin}/api/export.m3u?key=nope`)).status, 403);
  assert.equal((await fetch(`${origin}/api/export.m3u`)).status, 403);
});

test('the exported M3U carries names, logos, category names and stream URLs', async () => {
  const res = await fetch(`${origin}/api/export.m3u?key=sekret`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /filename="playlist\.m3u"/);
  const text = await res.text();
  assert.match(text, /^#EXTM3U/);
  assert.match(text, /tvg-logo="http:\/\/logo\/aj\.png"/);
  assert.match(text, /group-title="News"/);
  // The category with no entry in get_live_categories falls back, not blank.
  assert.match(text, /group-title="Uncategorized"/);
  assert.match(text, new RegExp(`http://${XT_HOST.replace(/\./g, '\\.')}/live/u/p/77\\.ts`));
});

test('the export round-trips through parseM3u — what M3U_URL will read back', async () => {
  const text = await (await fetch(`${origin}/api/export.m3u?key=sekret`)).text();
  const parsed = parseM3u(text);
  assert.equal(parsed.length, 2);
  // A comma in the channel name would otherwise split the entry on the way
  // back in, since parseM3u takes the name after the LAST comma.
  assert.equal(parsed[0].name, 'Al Jazeera HD');
  assert.equal(parsed[0].group, 'News');
  assert.equal(parsed[0].logo, 'http://logo/aj.png');
  assert.equal(parsed[1].name, 'BBC World');
  assert.equal(parsed[1].group, 'Uncategorized');
  assert.match(parsed[1].url, /\/live\/u\/p\/78\.ts$/);
});

test.after(() => {
  app.close();
  upstream.close();
});
