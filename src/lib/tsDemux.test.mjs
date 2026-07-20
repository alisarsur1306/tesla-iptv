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
  const p = ptsTicks;
  const pts = [
    0x21 | ((p >>> 29) & 0x0e),
    (p >>> 22) & 0xff,
    0x01 | ((p >>> 14) & 0xfe),
    (p >>> 7) & 0xff,
    0x01 | ((p << 1) & 0xfe),
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

test('reassembles a PES split across two pushes', () => {
  const pkt = buildTsPacket({ pid: 0x100, streamId: 0xe0, ptsTicks: 90000, body: [0xaa, 0xbb] });
  const out = [];
  const d = new TsDemuxer((e) => out.push([...e.data]));
  d.push(pkt.subarray(0, 100));
  d.push(pkt.subarray(100));
  d.flush();
  assert.deepEqual(out, [[0xaa, 0xbb]]);
});
