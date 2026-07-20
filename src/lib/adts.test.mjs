// Run: node --test src/lib/adts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffAudioCodec, parseAdtsFrames, audioSpecificConfig, AAC_SAMPLE_RATES } from './adts.ts';

// Build one ADTS frame: profile=1 (LC), sfIndex=4 (44100), channels=2, payload bytes.
function buildAdtsFrame(payload, { profile = 1, sfIndex = 4, channels = 2 } = {}) {
  const frameLength = 7 + payload.length;
  const h = new Uint8Array(frameLength);
  h[0] = 0xff;
  h[1] = 0xf1; // sync + MPEG-4, layer 00, protection_absent=1
  h[2] = (profile << 6) | (sfIndex << 2) | ((channels >> 2) & 0x01);
  h[3] = ((channels & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  h[4] = (frameLength >> 3) & 0xff;
  h[5] = ((frameLength & 0x07) << 5) | 0x1f;
  h[6] = 0xfc;
  h.set(payload, 7);
  return h;
}

test('sniffAudioCodec detects AAC (ADTS, layer bits 0)', () => {
  const f = buildAdtsFrame([1, 2, 3]);
  assert.equal(sniffAudioCodec(f), 'aac');
});

test('sniffAudioCodec distinguishes MPEG audio from AAC by layer field', () => {
  // 0xFF 0xFD => layer bits = 10 (Layer II) => MPEG audio, not AAC.
  const mpeg = new Uint8Array([0xff, 0xfd, 0x00, 0x00]);
  assert.equal(sniffAudioCodec(mpeg), 'mpeg');
});

test('sniffAudioCodec detects AC-3 syncword 0x0B77', () => {
  const ac3 = new Uint8Array([0x0b, 0x77, 0x00, 0x00, 0x00, 0x40]); // bsid 8 => ac3
  assert.equal(sniffAudioCodec(ac3), 'ac3');
});

test('parseAdtsFrames strips headers and reports rate/channels', () => {
  const a = buildAdtsFrame([0xaa, 0xbb]);
  const b = buildAdtsFrame([0xcc, 0xdd, 0xee]);
  const stream = new Uint8Array(a.length + b.length);
  stream.set(a);
  stream.set(b, a.length);

  const frames = parseAdtsFrames(stream);
  assert.equal(frames.length, 2);
  assert.deepEqual([...frames[0].data], [0xaa, 0xbb]);
  assert.deepEqual([...frames[1].data], [0xcc, 0xdd, 0xee]);
  assert.equal(frames[0].sampleRate, AAC_SAMPLE_RATES[4]); // 44100
  assert.equal(frames[0].channels, 2);
});

test('parseAdtsFrames ignores a trailing partial frame', () => {
  const a = buildAdtsFrame([0xaa, 0xbb]);
  const stream = new Uint8Array(a.length + 3);
  stream.set(a);
  stream.set([0xff, 0xf1, 0x50], a.length); // truncated header/frame
  assert.equal(parseAdtsFrames(stream).length, 1);
});

test('audioSpecificConfig encodes AOT, rate index and channels', () => {
  // profile 1 (LC) => AOT 2; sfIndex 4; channels 2
  const asc = audioSpecificConfig(1, 4, 2);
  assert.equal(asc.length, 2);
  assert.equal(asc[0], (2 << 3) | (4 >> 1)); // 0x12
  assert.equal(asc[1], ((4 & 1) << 7) | (2 << 3)); // 0x10
});
