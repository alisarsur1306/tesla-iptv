// Run: node --test proxy/m3u.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u } from './hlsProxy.mjs';

test('parseM3u extracts name, logo, group and stream URL', () => {
  const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="aljazeera" tvg-logo="http://logos/aj.png" group-title="News",Al Jazeera HD
http://server/live/user/pass/123.ts
#EXTINF:-1 tvg-logo="http://logos/bbc.png" group-title="News",BBC World
http://server/live/user/pass/124.ts`;
  const ch = parseM3u(m3u);
  assert.equal(ch.length, 2);
  assert.deepEqual(ch[0], {
    name: 'Al Jazeera HD',
    logo: 'http://logos/aj.png',
    group: 'News',
    url: 'http://server/live/user/pass/123.ts',
  });
  assert.equal(ch[1].name, 'BBC World');
  assert.equal(ch[1].url, 'http://server/live/user/pass/124.ts');
});

test('parseM3u defaults a missing group and tolerates blank lines/CRLF', () => {
  const m3u = '#EXTM3U\r\n#EXTINF:-1,Plain Channel\r\n\r\nhttp://x/y.m3u8\r\n';
  const ch = parseM3u(m3u);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].name, 'Plain Channel');
  assert.equal(ch[0].group, 'Uncategorized');
  assert.equal(ch[0].logo, '');
  assert.equal(ch[0].url, 'http://x/y.m3u8');
});

test('parseM3u ignores comments/headers and keeps only channel URLs', () => {
  const m3u = `#EXTM3U
#PLAYLIST:My List
#EXTINF:-1,One
http://a/1.ts
#EXTVLCOPT:http-user-agent=Mozilla
#EXTINF:-1,Two
http://a/2.ts`;
  const ch = parseM3u(m3u);
  // The #EXTVLCOPT line between INF and URL must not be treated as a URL.
  assert.equal(ch.length, 2);
  assert.deepEqual(ch.map((c) => c.url), ['http://a/1.ts', 'http://a/2.ts']);
});
