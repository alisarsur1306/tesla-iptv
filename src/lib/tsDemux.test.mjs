// Run: node --test src/lib/tsDemux.test.mjs  (Node 24 strips TS types natively)
// Tests the pure MPEG-TS demuxer against synthetic 188-byte packets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TsDemuxer } from './tsDemux.ts';

// Build one 188-byte TS packet carrying a complete PES.
// pid: 13-bit PID. streamId: 0xE0 video / 0xC0 audio. ptsTicks: 90kHz PTS. body: ES bytes.
function buildTsPacket({ pid, streamId, ptsTicks, body }) {
  const pkt = new Uint8Array(188).fill(0xff);
  pkt[0] = 0x47;
  pkt[1] = 0x40 | ((pid >> 8) & 0x1f); // PUSI + PID high
  pkt[2] = pid & 0xff; // PID low
  pkt[3] = 0x10; // adaptation=01 (payload only), continuity 0
  // PES header at offset 4.
  const pes = [];
  pes.push(0x00, 0x00, 0x01, streamId); // start code + stream_id
  const pesBody = [];
  // PES packet length (0 allowed for video); we set it to the remaining length.
  const optional = [0x80, 0x80, 0x05]; // '10' marker, PTS flag, header_data_length=5
  // PTS is 33 bits — wider than JS bitwise ops (32-bit), so slice it with
  // division/modulo, otherwise any value >= 2^32 silently truncates.
  const p = ptsTicks;
  const bits = (hi, lo) => Math.floor(p / 2 ** lo) % 2 ** (hi - lo + 1);
  const pts = [
    0x21 | (bits(32, 30) << 1),
    bits(29, 22),
    0x01 | (bits(21, 15) << 1),
    bits(14, 7),
    0x01 | (bits(6, 0) << 1),
  ];
  pesBody.push(...optional, ...pts, ...body);
  const pesLen = pesBody.length; // stream_id-relative length
  pes.push((pesLen >> 8) & 0xff, pesLen & 0xff, ...pesBody);
  pkt.set(pes, 4);
  return pkt;
}

test('extracts a video PES with PTS and payload', () => {
  const pkt = buildTsPacket({ pid: 0x100, streamId: 0xe0, ptsTicks: 90000, body: [0xaa, 0xbb] });
  const out = [];
  const d = new TsDemuxer((e) => out.push({ type: e.type, pts: e.pts, bytes: [...e.data] }));
  d.push(pkt);
  d.flush();
  assert.deepEqual(out, [{ type: 'video', pts: 1000, bytes: [0xaa, 0xbb] }]);
});

test('discovers audio PID and extracts audio PES', () => {
  const v = buildTsPacket({ pid: 0x100, streamId: 0xe0, ptsTicks: 0, body: [0x01] });
  const a = buildTsPacket({ pid: 0x101, streamId: 0xc0, ptsTicks: 180000, body: [0x0b, 0x77] });
  const out = [];
  const d = new TsDemuxer((e) => out.push({ type: e.type, pts: e.pts, streamId: e.streamId }));
  d.push(v);
  d.push(a);
  d.flush();
  const audio = out.find((o) => o.type === 'audio');
  assert.ok(audio, 'audio PES emitted');
  assert.equal(audio.pts, 2000);
  assert.equal(audio.streamId, 0xc0);
});

test('unwraps a 33-bit PTS rollover into a continuous timeline', () => {
  const MOD = 8589934592; // 2**33
  const nearMax = MOD - 90000; // 1s before wrap
  const afterWrap = 90000; // 1s past wrap
  const out = [];
  const d = new TsDemuxer((e) => out.push({ pts: e.pts, disc: e.discontinuity }));
  d.push(buildTsPacket({ pid: 0x100, streamId: 0xe0, ptsTicks: nearMax, body: [1] }));
  d.push(buildTsPacket({ pid: 0x100, streamId: 0xe0, ptsTicks: afterWrap, body: [2] }));
  d.flush();
  assert.equal(out.length, 2);
  // Timeline must keep increasing across the wrap, by ~2s, and not be flagged.
  assert.ok(out[1].pts > out[0].pts, 'pts continues increasing across wrap');
  assert.ok(Math.abs(out[1].pts - out[0].pts - 2000) < 1, 'wrap gap is ~2000ms');
  assert.equal(out[1].disc, false);
});

test('flags a real discontinuity (encoder restart) rather than treating it as a wrap', () => {
  const out = [];
  const d = new TsDemuxer((e) => out.push({ pts: e.pts, disc: e.discontinuity }));
  d.push(buildTsPacket({ pid: 0x100, streamId: 0xe0, ptsTicks: 90000 * 100, body: [1] })); // t=100s
  d.push(buildTsPacket({ pid: 0x100, streamId: 0xe0, ptsTicks: 90000 * 5, body: [2] })); // jumps to 5s
  d.flush();
  assert.equal(out.length, 2);
  assert.equal(out[1].disc, true);
});

test('discovers AC-3 audio on private_stream_1 (0xBD)', () => {
  const out = [];
  const d = new TsDemuxer((e) => out.push({ type: e.type, streamId: e.streamId }));
  d.push(buildTsPacket({ pid: 0x100, streamId: 0xe0, ptsTicks: 0, body: [1] }));
  d.push(buildTsPacket({ pid: 0x102, streamId: 0xbd, ptsTicks: 90000, body: [0x0b, 0x77] }));
  d.flush();
  const audio = out.find((o) => o.type === 'audio');
  assert.ok(audio, 'private_stream_1 is demuxed as audio');
  assert.equal(audio.streamId, 0xbd);
});

test('reassembles a PES split across two pushes', () => {
  const pkt = buildTsPacket({ pid: 0x100, streamId: 0xe0, ptsTicks: 90000, body: [0xaa, 0xbb] });
  const out = [];
  const d = new TsDemuxer((e) => out.push([...e.data]));
  d.push(pkt.subarray(0, 100));
  d.push(pkt.subarray(100));
  d.flush();
  assert.deepEqual(out, [[0xaa, 0xbb]]);
});
