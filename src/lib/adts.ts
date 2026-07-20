// Audio elementary-stream parsing for the WebCodecs player. Pure, no Web Audio.
//
// An audio PES payload from MPEG-TS is a raw elementary stream: for AAC that is
// a run of ADTS frames, for AC-3 a run of syncframes, for MPEG-1/2 Layer II/III
// a run of MPEG audio frames. WebCodecs can decode AAC (and MP3) natively;
// AC-3 / Layer II need a WASM decoder (later phase), so sniffing the codec here
// is what lets the audio engine route correctly instead of playing noise.

export type AudioCodec = 'aac' | 'mpeg' | 'ac3' | 'eac3' | 'unknown';

/** ADTS sampling_frequency_index table (ISO 14496-3). */
export const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Every AAC frame carries 1024 PCM samples per channel. */
export const AAC_SAMPLES_PER_FRAME = 1024;

export interface AdtsFrame {
  /** Raw AAC payload with the ADTS header removed (pairs with `AudioSpecificConfig`). */
  data: Uint8Array;
  sampleRate: number;
  channels: number;
  /** AAC profile from the header (0=Main, 1=LC, 2=SSR). */
  profile: number;
  sampleRateIndex: number;
}

/**
 * Identify the audio codec from the first bytes of an audio elementary stream.
 * Order matters: ADTS and MPEG audio share the 0xFFF sync pattern and are only
 * told apart by the 2-bit layer field (0 => ADTS/AAC, non-zero => MPEG audio).
 */
export function sniffAudioCodec(data: Uint8Array): AudioCodec {
  for (let i = 0; i + 1 < data.length && i < 64; i++) {
    // AC-3 / E-AC-3 syncword 0x0B77.
    if (data[i] === 0x0b && data[i + 1] === 0x77) {
      // bsid lives in the last 5 bits of byte 5; >10 means E-AC-3.
      const bsid = data.length > i + 5 ? data[i + 5] >> 3 : 8;
      return bsid > 10 ? 'eac3' : 'ac3';
    }
    // 12-bit sync 0xFFF (allow 0xFFE for MPEG-2.5 style streams).
    if (data[i] === 0xff && (data[i + 1] & 0xe0) === 0xe0) {
      const layer = (data[i + 1] >> 1) & 0x03;
      return layer === 0 ? 'aac' : 'mpeg';
    }
  }
  return 'unknown';
}

/**
 * Split an ADTS elementary stream into frames, stripping each 7/9-byte header.
 * Returns only whole frames; a trailing partial frame is ignored (the next PES
 * carries it — live TS gives us complete frames per PES in practice).
 */
export function parseAdtsFrames(data: Uint8Array): AdtsFrame[] {
  return parseAdtsFramesWithRemainder(data).frames;
}

/**
 * Like `parseAdtsFrames` but also reports how many bytes were consumed, so a
 * caller streaming PES payloads can carry the unparsed tail into the next call
 * instead of dropping a frame at every PES boundary.
 */
export function parseAdtsFramesWithRemainder(data: Uint8Array): {
  frames: AdtsFrame[];
  consumed: number;
} {
  const frames: AdtsFrame[] = [];
  let i = 0;
  while (i + 7 <= data.length) {
    // Resync if needed.
    if (!(data[i] === 0xff && (data[i + 1] & 0xf0) === 0xf0 && ((data[i + 1] >> 1) & 0x03) === 0)) {
      i++;
      continue;
    }
    const protectionAbsent = data[i + 1] & 0x01;
    const profile = (data[i + 2] >> 6) & 0x03;
    const sampleRateIndex = (data[i + 2] >> 2) & 0x0f;
    const channels = ((data[i + 2] & 0x01) << 2) | ((data[i + 3] >> 6) & 0x03);
    const frameLength =
      ((data[i + 3] & 0x03) << 11) | (data[i + 4] << 3) | ((data[i + 5] & 0xe0) >> 5);

    if (frameLength < 7) {
      i++; // bogus length — treat as a false sync and keep scanning
      continue;
    }
    if (i + frameLength > data.length) break; // partial frame → caller carries it forward
    const headerLen = protectionAbsent ? 7 : 9;
    if (frameLength > headerLen) {
      frames.push({
        data: data.subarray(i + headerLen, i + frameLength),
        sampleRate: AAC_SAMPLE_RATES[sampleRateIndex] ?? 48000,
        channels: channels || 2,
        profile,
        sampleRateIndex,
      });
    }
    i += frameLength;
  }
  return { frames, consumed: i };
}

/**
 * AudioSpecificConfig (2 bytes) for WebCodecs `AudioDecoder.configure({ description })`.
 * Pairing this with header-stripped raw AAC is unambiguous across implementations.
 */
export function audioSpecificConfig(
  profile: number,
  sampleRateIndex: number,
  channels: number,
): Uint8Array {
  const audioObjectType = profile + 1; // ADTS profile 1 (LC) => AOT 2
  return new Uint8Array([
    (audioObjectType << 3) | (sampleRateIndex >> 1),
    ((sampleRateIndex & 0x01) << 7) | (channels << 3),
  ]);
}
