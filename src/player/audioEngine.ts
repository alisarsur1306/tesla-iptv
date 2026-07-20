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
import { MpegAudioDecoder } from './wasmAudio';

/**
 * How far ahead of `currentTime` the first buffer is scheduled. This doubles as
 * the player's PRE-BUFFER: audio is the master clock, so delaying the anchor
 * delays video presentation by the same amount, and the frame queue fills during
 * the lead — while A/V stay aligned because both hang off the same media
 * timeline. With a short lead the queue sat at ~4 frames and any delivery jitter
 * froze the picture (this panel delivers only slightly faster than realtime).
 */
const START_LEAD_SEC = 1.5;
/** Drop audio scheduled more than this far in the past. */
const LATE_TOLERANCE_SEC = 0.25;
/** Re-anchor if the scheduling clock drifts beyond this. */
const RESYNC_THRESHOLD_SEC = 1.0;
/** How far past the start lead audio may legitimately be scheduled ahead. */
const MAX_LOOKAHEAD_SEC = 30.0;

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
  private gain: GainNode | null = null;
  /** Output volume 0..1, kept across channel changes. */
  private volume = 1;
  private decoder: AudioDecoder | null = null;
  private cb: AudioEngineCallbacks;
  private codec: AudioCodec | null = null;
  private configured = false;
  private unsupportedReported = false;
  /** Tail of the previous PES holding a partial ADTS frame. */
  private residual: Uint8Array | null = null;
  /** Sources scheduled but not yet finished — needed to silence them on reset. */
  private scheduled = new Set<AudioBufferSourceNode>();
  /** WASM decoder for MPEG audio (created only for MP2/MP3 channels). */
  private mpeg: MpegAudioDecoder | null = null;
  /** Monotonic media clock (ms) for MP2, advanced by decoded sample duration. */
  private mpegClockMs: number | null = null;

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

  /** Single output stage every buffer routes through, so volume is one knob. */
  private ensureGain(): GainNode {
    const ctx = this.ensureContext();
    if (!this.gain) {
      this.gain = ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(ctx.destination);
    }
    return this.gain;
  }

  /** Current output volume, 0..1. */
  getVolume(): number {
    return this.volume;
  }

  /**
   * Set output volume (0..1). Ramped rather than stepped: assigning gain.value
   * mid-playback produces an audible click.
   */
  setVolume(v: number): number {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015);
    }
    return this.volume;
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
    this.mpegClockMs = null;
    try {
      this.mpeg?.destroy();
    } catch {
      /* ignore */
    }
    this.mpeg = null;
    this.stopScheduled();
  }

  /**
   * Silence everything already queued on the AudioContext. Scheduled buffers
   * play regardless of decoder state, so any timeline change (channel switch,
   * PTS discontinuity, re-anchor) must stop them or the old audio keeps
   * playing under the new one.
   */
  private stopScheduled(): void {
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
    this.gain = null;
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
    }

    // MPEG-1/2 audio (Layer II ~30% of this panel) can't go through WebCodecs —
    // route it to the lazily-loaded WASM decoder instead.
    if (this.codec === 'mpeg') {
      this.pushMpeg(bytes, ptsMs);
      return;
    }
    if (this.codec !== 'aac') {
      // AC-3 / unknown — no decoder wired; tell the UI rather than fail silently.
      if (!this.unsupportedReported) {
        this.unsupportedReported = true;
        this.cb.onUnsupported?.(this.codec);
      }
      return;
    }

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

  /** Decode & schedule an MPEG (Layer II) audio PES via the WASM decoder. */
  private pushMpeg(bytes: Uint8Array, ptsMs: number): void {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') return; // wait for the sound-unlock gesture

    if (!this.mpeg) {
      this.mpeg = new MpegAudioDecoder();
      void this.mpeg.init().catch((e) => {
        if (!this.unsupportedReported) {
          this.unsupportedReported = true;
          this.cb.onError?.('MP2 decoder load failed: ' + (e as Error).message);
        }
      });
    }
    if (!this.mpeg.ready) return; // still loading WASM — drop a few frames at startup

    const out = this.mpeg.decode(bytes);
    if (!out || !out.samplesDecoded) return;

    // Anchor the MP2 clock to the stream PTS once, then advance it by the exact
    // decoded duration. Re-sync if the incoming PTS diverges (discontinuity):
    // the WASM decoder gives us no per-frame timestamps, so we keep our own.
    if (this.mpegClockMs === null || Math.abs(ptsMs - this.mpegClockMs) > 700) {
      this.mpegClockMs = ptsMs;
      this.anchored = false; // rebuild the ctx-time mapping from here
    }

    const ctx2 = ctx;
    const buf = ctx2.createBuffer(out.channelData.length, out.samplesDecoded, out.sampleRate);
    for (let ch = 0; ch < out.channelData.length; ch++) {
      buf.copyToChannel(out.channelData[ch], ch);
    }
    this.scheduleBuffer(buf, this.mpegClockMs);
    this.mpegClockMs += (out.samplesDecoded / out.sampleRate) * 1000;
  }

  private onDecoded(data: AudioData): void {
    const ctx = this.ensureContext();
    try {
      const channels = data.numberOfChannels;
      const frames = data.numberOfFrames;
      const buf = ctx.createBuffer(channels, frames, data.sampleRate);
      const tmp = new Float32Array(frames);
      for (let ch = 0; ch < channels; ch++) {
        data.copyTo(tmp, { planeIndex: ch, format: 'f32-planar' });
        buf.copyToChannel(tmp, ch);
      }
      this.scheduleBuffer(buf, data.timestamp / 1000);
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

  /**
   * Schedule a decoded PCM buffer on the shared media timeline. Both the AAC
   * (WebCodecs) and MP2 (WASM) paths funnel through here so anchoring, drift
   * re-anchoring and the master-clock hand-off to the worker stay in one place.
   */
  private scheduleBuffer(buf: AudioBuffer, mediaMs: number): void {
    const ctx = this.ensureContext();

    if (!this.anchored) {
      this.ctxAnchor = ctx.currentTime + START_LEAD_SEC;
      this.mediaAnchorMs = mediaMs;
      this.anchored = true;
      this.nextTime = this.ctxAnchor;
      const epochMs = nowEpochMs() + (this.ctxAnchor - ctx.currentTime) * 1000;
      this.cb.onAnchor?.(this.mediaAnchorMs, epochMs);
    }

    let when = this.ctxAnchor + (mediaMs - this.mediaAnchorMs) / 1000;

    const ahead = when - ctx.currentTime;

    // BEHIND by more than the threshold means the timeline really is wrong
    // (discontinuity / stall). Only then is a re-anchor justified, and only then
    // must the queue be dropped — what is queued belongs to the old timeline and
    // would otherwise play underneath the new one as two overlapping sounds.
    if (-ahead > RESYNC_THRESHOLD_SEC) {
      this.stopScheduled();
      this.anchored = false; // re-anchor next buffer
      return;
    }

    // AHEAD is not an error — it is the buffer. The continuous stream front-loads
    // a backlog, so audio legitimately schedules seconds ahead and those buffers
    // are correctly timed. Treating that as desync (stopping the queue and
    // re-anchoring) silenced ~33% of all buffers: sound cut out and came back
    // every few seconds. Past the bound we simply stop adding more and let
    // playback drain — never cancel what is already correctly scheduled.
    if (ahead > START_LEAD_SEC + MAX_LOOKAHEAD_SEC) return;
    if (when < ctx.currentTime - LATE_TOLERANCE_SEC) return; // too late to matter
    if (when < ctx.currentTime) when = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ensureGain());
    src.onended = () => this.scheduled.delete(src);
    src.start(when);
    this.scheduled.add(src);
    this.nextTime = Math.max(this.nextTime, when + buf.duration);
  }
}
