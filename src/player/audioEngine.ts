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

    // Gapless scheduling paces MP2 by buffer duration, so the old monotonic
    // clock + 700ms re-sync (which cut audio ~29% of the time) is gone. Pass the
    // PES PTS straight through — it only seeds the video-sync anchor now.
    const buf = ctx.createBuffer(out.channelData.length, out.samplesDecoded, out.sampleRate);
    for (let ch = 0; ch < out.channelData.length; ch++) {
      buf.copyToChannel(out.channelData[ch], ch);
    }
    this.scheduleBuffer(buf, ptsMs);
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
   * Schedule a decoded PCM buffer GAPLESSLY. Both the AAC (WebCodecs) and MP2
   * (WASM) paths funnel through here.
   *
   * Buffers are placed back-to-back on a running playhead (`nextTime`) rather
   * than mapped from each frame's PTS. Live audio is contiguous, so this plays
   * it continuously; PTS is used only to establish the initial video-sync anchor
   * and to detect a real discontinuity. Crucially, routine drift NEVER stops
   * audio that is already scheduled — the previous PTS-mapped version re-anchored
   * on every small drift and called stopScheduled(), which cut ~29% of buffers
   * on the MP2 path (audible as sound cutting in and out). Only reset() (channel
   * change / worker-signalled discontinuity) clears the queue now.
   */
  private scheduleBuffer(buf: AudioBuffer, mediaMs: number): void {
    const ctx = this.ensureContext();

    // (Re)establish the playhead + the media→ctx-time anchor that video follows.
    const anchor = (whenSec: number) => {
      this.nextTime = whenSec;
      this.ctxAnchor = whenSec;
      this.mediaAnchorMs = mediaMs;
      this.anchored = true;
      const epochMs = nowEpochMs() + (whenSec - ctx.currentTime) * 1000;
      this.cb.onAnchor?.(this.mediaAnchorMs, epochMs);
    };

    if (!this.anchored) anchor(ctx.currentTime + START_LEAD_SEC);

    let when = this.nextTime;

    // Underrun: the playhead fell behind real time because data arrived late.
    // Nudge it forward (a brief gap) and re-anchor so video re-syncs — but do
    // NOT cut what is already playing.
    if (when < ctx.currentTime + 0.01) {
      anchor(ctx.currentTime + 0.05);
      when = this.nextTime;
    }

    // A large forward jump in media time is a real discontinuity — re-anchor so
    // latency doesn't creep, again without cutting existing audio.
    if (mediaMs - this.mediaAnchorMs - (when - this.ctxAnchor) * 1000 > 1500) {
      anchor(ctx.currentTime + START_LEAD_SEC);
      when = this.nextTime;
    }

    // Runaway lookahead (a big decoded burst) — hold off adding more; the queued
    // buffers keep playing and realtime catches up. nextTime is unchanged so the
    // next call retries at the same slot.
    if (when - ctx.currentTime > START_LEAD_SEC + MAX_LOOKAHEAD_SEC) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ensureGain());
    src.onended = () => this.scheduled.delete(src);
    src.start(when);
    this.scheduled.add(src);
    this.nextTime = when + buf.duration;
  }
}
