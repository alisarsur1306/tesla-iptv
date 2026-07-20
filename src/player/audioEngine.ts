// Main-thread audio for the WebCodecs player. Web Audio is main-thread only, so
// the worker forwards raw audio PES payloads here.
//
// Audio is the MASTER CLOCK: video frames in the worker are presented against
// the timeline established here (see `onAnchor`). Anchors are exchanged as
// absolute epoch ms (performance.timeOrigin + performance.now()) because a
// Worker has its OWN performance time origin — raw performance.now() values are
// not comparable across threads.
//
// Phase 2 decodes AAC (native WebCodecs). AC-3 / MPEG Layer II report
// `onUnsupported` so the UI can say so instead of playing silence forever;
// a WASM decoder for those lands in Phase 3.

import {
  sniffAudioCodec,
  parseAdtsFramesWithRemainder,
  audioSpecificConfig,
  AAC_SAMPLES_PER_FRAME,
  type AudioCodec,
} from '../lib/adts';

/** How far ahead of `currentTime` the first buffer is scheduled, to absorb jitter. */
const START_LEAD_SEC = 0.2;
/** Drop audio scheduled more than this far in the past. */
const LATE_TOLERANCE_SEC = 0.25;
/** Re-anchor if the scheduling clock drifts beyond this. */
const RESYNC_THRESHOLD_SEC = 1.0;

export interface AudioEngineCallbacks {
  /** Fired once when the media timeline is established, so video can sync to it. */
  onAnchor?: (mediaMs: number, epochMs: number) => void;
  /** Fired when the stream's audio codec can't be decoded natively. */
  onUnsupported?: (codec: AudioCodec) => void;
  onError?: (msg: string) => void;
}

function nowEpochMs(): number {
  return performance.timeOrigin + performance.now();
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private decoder: AudioDecoder | null = null;
  private cb: AudioEngineCallbacks;
  private codec: AudioCodec | null = null;
  private configured = false;
  private unsupportedReported = false;
  /** Tail of the previous PES holding a partial ADTS frame. */
  private residual: Uint8Array | null = null;
  /** Sources scheduled but not yet finished — needed to silence them on reset. */
  private scheduled = new Set<AudioBufferSourceNode>();

  /** AudioContext time that `mediaAnchorMs` corresponds to. */
  private ctxAnchor = 0;
  private mediaAnchorMs = 0;
  private anchored = false;
  /** Next free scheduling slot, in AudioContext time. */
  private nextTime = 0;

  constructor(cb: AudioEngineCallbacks = {}) {
    this.cb = cb;
  }

  /** Must be called from a user gesture the first time (autoplay policy). */
  async unlock(): Promise<boolean> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }
    return ctx.state === 'running';
  }

  get needsUnlock(): boolean {
    return !!this.ctx && this.ctx.state === 'suspended';
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  /** Drop all timing state (channel change / stream restart). */
  reset(): void {
    try {
      this.decoder?.close();
    } catch {
      /* ignore */
    }
    this.decoder = null;
    this.configured = false;
    this.codec = null;
    this.unsupportedReported = false;
    this.anchored = false;
    this.ctxAnchor = 0;
    this.mediaAnchorMs = 0;
    this.nextTime = 0;
    this.residual = null;
    // Already-scheduled buffers keep playing otherwise — the old channel's audio
    // would overlap the new one after a switch or a discontinuity.
    for (const src of this.scheduled) {
      try {
        src.stop();
      } catch {
        /* already finished */
      }
    }
    this.scheduled.clear();
  }

  destroy(): void {
    this.reset();
    try {
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
  }

  /** Feed one audio PES payload with its stream-relative PTS (ms). */
  push(payload: ArrayBuffer, ptsMs: number): void {
    const bytes = new Uint8Array(payload);
    if (!bytes.length) return;

    if (!this.codec) {
      this.codec = sniffAudioCodec(bytes);
      if (this.codec !== 'aac') {
        // MP3 could go through WebCodecs too, but live TS 'mpeg' is nearly always
        // Layer II, which WebCodecs cannot decode — treat as unsupported for now.
        if (!this.unsupportedReported) {
          this.unsupportedReported = true;
          this.cb.onUnsupported?.(this.codec);
        }
        return;
      }
    }
    if (this.codec !== 'aac') return;

    // An ADTS frame can straddle a PES boundary. Without carrying the remainder
    // forward, one 1024-sample frame is destroyed at every boundary — an audible
    // periodic click for the whole session.
    let input = bytes;
    if (this.residual && this.residual.length) {
      input = new Uint8Array(this.residual.length + bytes.length);
      input.set(this.residual);
      input.set(bytes, this.residual.length);
    }
    const { frames, consumed } = parseAdtsFramesWithRemainder(input);
    this.residual =
      consumed < input.length ? input.slice(consumed, Math.min(input.length, consumed + 4096)) : null;
    if (!frames.length) return;

    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') return; // wait for unlock; don't queue stale audio

    if (!this.configured) {
      const f = frames[0];
      try {
        this.decoder = new AudioDecoder({
          output: (data) => this.onDecoded(data),
          error: (e) => this.cb.onError?.(e.message),
        });
        this.decoder.configure({
          codec: 'mp4a.40.' + (f.profile + 1), // LC => mp4a.40.2
          sampleRate: f.sampleRate,
          numberOfChannels: f.channels,
          description: audioSpecificConfig(f.profile, f.sampleRateIndex, f.channels),
        });
        this.configured = true;
      } catch (e) {
        // Don't leak a decoder per PES, and don't retry forever on a stream we
        // simply cannot configure — report once and stay quiet.
        try {
          this.decoder?.close();
        } catch {
          /* ignore */
        }
        this.decoder = null;
        if (!this.unsupportedReported) {
          this.unsupportedReported = true;
          this.cb.onError?.('audio configure failed: ' + (e as Error).message);
        }
        this.codec = 'unknown';
        return;
      }
    }
    if (!this.decoder || this.decoder.state !== 'configured') return;

    // Each ADTS frame is 1024 samples; derive per-frame timestamps from the PES PTS.
    frames.forEach((f, i) => {
      const tsUs = Math.max(0, ptsMs * 1000 + (i * AAC_SAMPLES_PER_FRAME * 1e6) / f.sampleRate);
      try {
        this.decoder!.decode(
          new EncodedAudioChunk({ type: 'key', timestamp: tsUs, data: f.data }),
        );
      } catch {
        /* transient decode error — skip this frame */
      }
    });
  }

  private onDecoded(data: AudioData): void {
    const ctx = this.ensureContext();
    try {
      const channels = data.numberOfChannels;
      const frames = data.numberOfFrames;
      const rate = data.sampleRate;
      const buf = ctx.createBuffer(channels, frames, rate);
      const tmp = new Float32Array(frames);
      for (let ch = 0; ch < channels; ch++) {
        data.copyTo(tmp, { planeIndex: ch, format: 'f32-planar' });
        buf.copyToChannel(tmp, ch);
      }

      const mediaMs = data.timestamp / 1000;

      // Establish (or re-establish) the media timeline.
      if (!this.anchored) {
        this.ctxAnchor = ctx.currentTime + START_LEAD_SEC;
        this.mediaAnchorMs = mediaMs;
        this.anchored = true;
        this.nextTime = this.ctxAnchor;
        // Tell the worker when this media time actually reaches the speakers.
        const epochMs = nowEpochMs() + (this.ctxAnchor - ctx.currentTime) * 1000;
        this.cb.onAnchor?.(this.mediaAnchorMs, epochMs);
      }

      let when = this.ctxAnchor + (mediaMs - this.mediaAnchorMs) / 1000;

      // Re-anchor on large drift in EITHER direction. A forward PTS jump used to
      // fall through this guard and schedule audio minutes into the future
      // (silence forever); a backward jump used to sit in the dead band between
      // "too late to play" and "far enough to resync" and drop every buffer.
      if (Math.abs(when - ctx.currentTime) > RESYNC_THRESHOLD_SEC) {
        this.anchored = false;
        data.close();
        return;
      }
      if (when < ctx.currentTime - LATE_TOLERANCE_SEC) {
        data.close();
        return; // too late to matter
      }
      if (when < ctx.currentTime) when = ctx.currentTime;

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => this.scheduled.delete(src);
      src.start(when);
      this.scheduled.add(src);
      this.nextTime = Math.max(this.nextTime, when + buf.duration);
    } catch (e) {
      this.cb.onError?.('audio render failed: ' + (e as Error).message);
    } finally {
      try {
        data.close();
      } catch {
        /* ignore */
      }
    }
  }
}
