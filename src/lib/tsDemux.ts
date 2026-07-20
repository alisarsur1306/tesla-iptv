// MPEG-TS demuxer (ISO/IEC 13818-1). Pure, no I/O, no WebCodecs — feed it TS
// bytes, it emits reassembled PES payloads with PTS (ms). PID discovery is
// heuristic: the first PES stream_id in the video (0xE0-0xEF) / audio
// (0xC0-0xDF) range claims the video/audio PID. That is enough for the single
// program an IPTV live stream carries and avoids parsing PAT/PMT.
//
// ponytail: single-program heuristic; if a stream multiplexes programs, parse
// PMT instead. Not seen in Xtream live channels.

export type EsType = 'video' | 'audio';

export interface PesEvent {
  type: EsType;
  /** Presentation timestamp in milliseconds (from the 33-bit PTS / 90). 0 if absent. */
  pts: number;
  /** Whether this PES carried an explicit PTS (vs. defaulted to 0). */
  hasPts: boolean;
  /** Elementary-stream payload (the ES bytes after the PES header). */
  data: Uint8Array;
  /** PES stream_id, e.g. 0xE0 video, 0xC0 audio — lets the caller sniff codec. */
  streamId: number;
}

const TS_PACKET = 188;
const SYNC = 0x47;

export class TsDemuxer {
  private buffer = new Uint8Array(0);
  private videoPID: number | null = null;
  private audioPID: number | null = null;
  private pending: Partial<Record<EsType, Uint8Array[]>> = {};
  private readonly onPes: (e: PesEvent) => void;

  constructor(onPes: (e: PesEvent) => void) {
    this.onPes = onPes;
  }

  /** Feed a chunk of TS bytes. Complete 188-byte packets are processed; the tail is kept. */
  push(data: Uint8Array): void {
    // Append the new bytes to whatever partial tail we kept.
    const merged = new Uint8Array(this.buffer.length + data.length);
    merged.set(this.buffer);
    merged.set(data, this.buffer.length);
    this.buffer = merged;

    let off = 0;
    // Align to the first sync byte.
    while (off < this.buffer.length && this.buffer[off] !== SYNC) off++;
    while (off + TS_PACKET <= this.buffer.length) {
      if (this.buffer[off] !== SYNC) {
        off++;
        continue;
      }
      this.parsePacket(this.buffer.subarray(off, off + TS_PACKET));
      off += TS_PACKET;
    }
    this.buffer = this.buffer.slice(off);
  }

  /** Finalize any PES still being reassembled. Call at end of stream / before teardown. */
  flush(): void {
    (['video', 'audio'] as EsType[]).forEach((type) => {
      const parts = this.pending[type];
      if (parts && parts.length) this.emit(concat(parts), type);
      this.pending[type] = [];
    });
  }

  /** Reset all state (channel change). */
  reset(): void {
    this.buffer = new Uint8Array(0);
    this.videoPID = null;
    this.audioPID = null;
    this.pending = {};
  }

  private parsePacket(pkt: Uint8Array): void {
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    if (pid === 0 || pid === 0x1fff) return; // PAT / null packet — ignored

    const pusi = (pkt[1] & 0x40) !== 0; // payload_unit_start_indicator
    const adaptation = (pkt[3] >> 4) & 0x03;
    let off = 4;
    if (adaptation === 2) return; // adaptation only, no payload
    if (adaptation === 3) off = 5 + pkt[4]; // skip adaptation field
    if (off >= TS_PACKET) return;

    const payload = pkt.subarray(off);
    if (!payload.length) return;

    // Discover PIDs from the PES start code + stream_id.
    if (pusi && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
      const sid = payload[3];
      if (sid >= 0xe0 && sid <= 0xef && this.videoPID === null) this.videoPID = pid;
      else if (sid >= 0xc0 && sid <= 0xdf && this.audioPID === null) this.audioPID = pid;
    }

    if (pid === this.videoPID) this.assemble(payload, pusi, 'video');
    else if (pid === this.audioPID) this.assemble(payload, pusi, 'audio');
  }

  private assemble(payload: Uint8Array, pusi: boolean, type: EsType): void {
    if (!this.pending[type]) this.pending[type] = [];
    const parts = this.pending[type]!;
    // A new PES starts here; finalize the previous one.
    if (pusi && parts.length) {
      this.emit(concat(parts), type);
      this.pending[type] = [];
    }
    this.pending[type]!.push(payload);
  }

  private emit(pes: Uint8Array, type: EsType): void {
    if (pes.length < 9 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return;
    const streamId = pes[3];
    const ptsDtsFlags = pes[7] & 0xc0;
    const headerLen = pes[8];
    let pts = 0;
    let hasPts = false;
    if (ptsDtsFlags && pes.length >= 14) {
      // 33-bit PTS spread across bytes 9-13 with marker bits. The top 3 bits
      // (PTS[32:30]) would overflow a 32-bit `<<30`, so multiply instead:
      // (pes[9] & 0x0e) already equals PTS[32:30]*2, times 2^29 = PTS[32:30]<<30.
      const ticks =
        (pes[9] & 0x0e) * 536870912 + // (PTS[32:30]*2) * 2^29
        (pes[10] << 22) +
        ((pes[11] & 0xfe) << 14) +
        (pes[12] << 7) +
        (pes[13] >> 1);
      pts = ticks / 90; // 90 kHz → ms
      hasPts = true;
    }
    // PES_packet_length (bytes 4-5) counts the bytes after byte 6. Video PES
    // usually sets it to 0 (unbounded) — then the payload runs to the next PES,
    // and the H.264 parser finds NAL boundaries. When non-zero (typical for
    // audio), honor it so trailing stuffing/padding is excluded.
    const pesPacketLength = (pes[4] << 8) | pes[5];
    const start = 9 + headerLen;
    const end = pesPacketLength > 0 ? Math.min(pes.length, 6 + pesPacketLength) : pes.length;
    const data = pes.subarray(start, end);
    if (!data.length) return;
    this.onPes({ type, pts, hasPts, data, streamId });
  }
}

function concat(arrs: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
