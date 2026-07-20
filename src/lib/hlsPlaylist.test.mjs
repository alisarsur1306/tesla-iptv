// Run: node --test src/lib/hlsPlaylist.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, parseMediaPlaylist, diffNewSegments } from './hlsPlaylist.ts';

const MEDIA = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-TARGETDURATION:2
#EXTINF:2.0,
/api/proxy?u=seg10.ts
#EXTINF:2.0,
/api/proxy?u=seg11.ts`;

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720
/api/proxy?u=720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000
/api/proxy?u=360.m3u8`;

test('parses media-sequence and segments with seq numbers', () => {
  const p = parseMediaPlaylist(MEDIA);
  assert.equal(p.mediaSequence, 10);
  assert.equal(p.live, true);
  assert.deepEqual(p.segments, [
    { seq: 10, url: '/api/proxy?u=seg10.ts', duration: 2 },
    { seq: 11, url: '/api/proxy?u=seg11.ts', duration: 2 },
  ]);
});

test('diffNewSegments returns only unseen sequences', () => {
  const p = parseMediaPlaylist(MEDIA);
  assert.deepEqual(diffNewSegments(p, 10).map((s) => s.seq), [11]);
  assert.deepEqual(diffNewSegments(p, 11).map((s) => s.seq), []);
});

test('parsePlaylist detects master and lists variants by bandwidth', () => {
  const p = parsePlaylist(MASTER);
  assert.equal(p.kind, 'master');
  assert.deepEqual(p.variants, [
    { url: '/api/proxy?u=720.m3u8', bandwidth: 1200000 },
    { url: '/api/proxy?u=360.m3u8', bandwidth: 400000 },
  ]);
});

test('parsePlaylist detects media playlist', () => {
  assert.equal(parsePlaylist(MEDIA).kind, 'media');
});
