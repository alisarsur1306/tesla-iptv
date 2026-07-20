// Run: node --test src/lib/h264.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitNALs, toAVCC, codecString, avccDescription, nalType } from './h264.ts';

test('splitNALs handles 3- and 4-byte start codes', () => {
  const data = new Uint8Array([0, 0, 1, 0x67, 0xaa, 0, 0, 0, 1, 0x68, 0xbb]);
  const nals = splitNALs(data);
  assert.equal(nals.length, 2);
  assert.deepEqual([...nals[0]], [0x67, 0xaa]);
  assert.deepEqual([...nals[1]], [0x68, 0xbb]);
  assert.equal(nalType(nals[0]), 7); // SPS
  assert.equal(nalType(nals[1]), 8); // PPS
});

test('codecString from SPS profile bytes', () => {
  const sps = new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0x00]);
  assert.equal(codecString(sps), 'avc1.42c01e');
});

test('toAVCC length-prefixes each NAL with 4 bytes', () => {
  const out = toAVCC([new Uint8Array([0xaa, 0xbb])]);
  assert.deepEqual([...out], [0, 0, 0, 2, 0xaa, 0xbb]);
});

test('avccDescription layout: version, profile bytes, SPS then PPS', () => {
  const sps = new Uint8Array([0x67, 0x42, 0xc0, 0x1e]);
  const pps = new Uint8Array([0x68, 0xce]);
  const d = avccDescription(sps, pps);
  assert.equal(d[0], 1); // configurationVersion
  assert.equal(d[1], 0x42); // profile
  assert.equal(d[2], 0xc0);
  assert.equal(d[3], 0x1e); // level
  assert.equal(d[4], 0xff);
  assert.equal(d[5], 0xe1);
  assert.equal((d[6] << 8) | d[7], sps.length);
  assert.deepEqual([...d.subarray(8, 8 + sps.length)], [...sps]);
  const ppsLenOff = 8 + sps.length + 1; // after numOfPPS byte
  assert.equal((d[ppsLenOff] << 8) | d[ppsLenOff + 1], pps.length);
});

test('isValidSps accepts a real SPS and rejects garbage that merely scored type 7', async () => {
  const { isValidSps } = await import('./h264.ts');
  // Real SPS: NAL header 0x67, profile_idc 100 (High), short.
  assert.equal(isValidSps(new Uint8Array([0x67, 100, 0x00, 0x28, 0x01, 0x02])), true);
  assert.equal(isValidSps(new Uint8Array([0x67, 66, 0xc0, 0x1e])), true); // Baseline
  // Observed on a scrambled/HEVC channel: profile 43, kilobyte-long "SPS".
  assert.equal(isValidSps(new Uint8Array([0x67, 43, 0x7c, 0xaf])), false);
  assert.equal(isValidSps(new Uint8Array(1030).fill(0x67)), false); // absurd length
  assert.equal(isValidSps(new Uint8Array([0x67])), false); // too short
});
