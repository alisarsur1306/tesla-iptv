// Run: node --test src/lib/hevc.test.mjs
// Validated against real HEVC parameter sets captured from NL: NPO 3 4K.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hevcNalType, isHevcKeySlice, isHevcSlice, looksLikeHevc, toAnnexB } from './hevc.ts';

// Real SPS captured from the stream (NAL header 0x42 0x01 => type 33).
const REAL_SPS = new Uint8Array([0x42, 0x01, 0x01, 0x21, 0x40, 0x00, 0x00, 0x03]);
const REAL_VPS = new Uint8Array([0x40, 0x01]); // type 32
const REAL_PPS = new Uint8Array([0x44, 0x01]); // type 34

test('hevcNalType reads the 6-bit type from the 2-byte header', () => {
  assert.equal(hevcNalType(REAL_SPS), 33); // SPS
  assert.equal(hevcNalType(REAL_VPS), 32); // VPS
  assert.equal(hevcNalType(REAL_PPS), 34); // PPS
  assert.equal(hevcNalType(new Uint8Array([0x26, 0x01])), 19); // IDR_W_RADL (0x26>>1 = 19)
});

test('slice classifiers', () => {
  assert.equal(isHevcKeySlice(19), true); // IDR
  assert.equal(isHevcKeySlice(21), true); // CRA
  assert.equal(isHevcKeySlice(0), false); // TRAIL_N
  assert.equal(isHevcSlice(0), true);
  assert.equal(isHevcSlice(9), true);
  assert.equal(isHevcSlice(19), true);
  assert.equal(isHevcSlice(32), false); // VPS is not a slice
});

test('looksLikeHevc needs SPS+PPS (types H.264 can never produce)', () => {
  assert.equal(looksLikeHevc([REAL_VPS, REAL_SPS, REAL_PPS]), true);
  assert.equal(looksLikeHevc([REAL_SPS]), false); // no PPS
  // H.264 NALs (type 7 SPS = 0x67, type 8 PPS = 0x68) must NOT look like HEVC:
  // under HEVC interpretation 0x67>>1=51, 0x68>>1=52 — not 32/33/34.
  assert.equal(looksLikeHevc([new Uint8Array([0x67, 0]), new Uint8Array([0x68, 0])]), false);
});

test('toAnnexB prefixes each NAL with a 4-byte start code', () => {
  const out = toAnnexB([new Uint8Array([0xaa]), new Uint8Array([0xbb, 0xcc])]);
  assert.deepEqual([...out], [0, 0, 0, 1, 0xaa, 0, 0, 0, 1, 0xbb, 0xcc]);
});
