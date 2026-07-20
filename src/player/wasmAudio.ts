// WASM decoding for audio codecs WebCodecs cannot handle.
//
// Measured against the actual panel (~140 channels sampled): AAC ~65%,
// MPEG-1 Layer II ~30%, AC-3 zero. So the only gap worth closing is MPEG
// audio, which mpg123 covers (Layer I/II/III) in ~190 KB.
//
// ponytail: MPEG audio only. If an AC-3 channel ever shows up, the sniffer
// already reports it as unsupported — add a decoder here at that point.

/** Raw PCM ready for Web Audio: one Float32Array per channel. */
export interface DecodedPcm {
  channelData: Float32Array[];
  sampleRate: number;
  samplesDecoded: number;
}

interface Mpeg123Decoder {
  ready: Promise<unknown>;
  decode(data: Uint8Array): { channelData: Float32Array[]; samplesDecoded: number; sampleRate: number };
  free(): void;
}

/**
 * Streaming MPEG (Layer I/II/III) decoder. The WASM module is imported lazily
 * on first use so channels that never need it don't download it.
 */
export class MpegAudioDecoder {
  private decoder: Mpeg123Decoder | null = null;
  private loading: Promise<void> | null = null;

  /** Load the WASM module. Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.decoder) return;
    if (!this.loading) {
      this.loading = (async () => {
        const mod = await import('mpg123-decoder');
        const dec = new mod.MPEGDecoder() as unknown as Mpeg123Decoder;
        await dec.ready;
        this.decoder = dec;
      })();
    }
    await this.loading;
  }

  get ready(): boolean {
    return this.decoder !== null;
  }

  /** Decode a chunk of an MPEG audio elementary stream. Null until ready. */
  decode(data: Uint8Array): DecodedPcm | null {
    if (!this.decoder) return null;
    const out = this.decoder.decode(data);
    if (!out || !out.samplesDecoded) return null;
    return {
      channelData: out.channelData,
      sampleRate: out.sampleRate,
      samplesDecoded: out.samplesDecoded,
    };
  }

  destroy(): void {
    try {
      this.decoder?.free();
    } catch {
      /* ignore */
    }
    this.decoder = null;
    this.loading = null;
  }
}
