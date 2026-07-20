// H.264 (Annex-B) helpers for the WebCodecs pipeline. Pure, no WebCodecs.
// - splitNALs: split an Annex-B byte stream on 00 00 01 / 00 00 00 01 start codes.
// - avccDescription: build the AVCDecoderConfigurationRecord that
//   VideoDecoder.configure() wants as `description`, from SPS + PPS.
// - codecString: the "avc1.PPCCLL" codec string from the SPS profile bytes.

export const NAL_SPS = 7;
export const NAL_PPS = 8;
export const NAL_IDR = 5;
export const NAL_NON_IDR = 1;

/** nalType(nal) → the low 5 bits of the first byte. */
export function nalType(nal: Uint8Array): number {
  return nal[0] & 0x1f;
}

/** Split an Annex-B buffer into NAL units (start codes removed). */
export function splitNALs(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let i = 0;
  const n = data.length;
  while (i < n - 3) {
    if (data[i] === 0 && data[i + 1] === 0) {
      const sc = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
      if (sc) {
        const start = i + sc;
        let end = n;
        for (let j = start; j < n - 2; j++) {
          if (data[j] === 0 && data[j + 1] === 0 && (data[j + 2] === 1 || (data[j + 2] === 0 && data[j + 3] === 1))) {
            end = j;
            break;
          }
        }
        if (end > start) nals.push(data.subarray(start, end));
        i = end;
        continue;
      }
    }
    i++;
  }
  return nals;
}

/** Length-prefix NALs into the AVCC (mp4) sample format WebCodecs expects. */
export function toAVCC(nals: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const nal of nals) size += 4 + nal.length;
  const out = new Uint8Array(size);
  let o = 0;
  for (const nal of nals) {
    out[o++] = (nal.length >>> 24) & 0xff;
    out[o++] = (nal.length >>> 16) & 0xff;
    out[o++] = (nal.length >>> 8) & 0xff;
    out[o++] = nal.length & 0xff;
    out.set(nal, o);
    o += nal.length;
  }
  return out;
}

/** codec string, e.g. "avc1.42c01e", from SPS bytes [profile, constraints, level]. */
export function codecString(sps: Uint8Array): string {
  return (
    'avc1.' +
    [sps[1], sps[2], sps[3]].map((b) => b.toString(16).padStart(2, '0')).join('')
  );
}

/** Build the AVCDecoderConfigurationRecord (avcC) from one SPS + one PPS. */
export function avccDescription(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const desc = new Uint8Array(11 + sps.length + pps.length);
  let i = 0;
  desc[i++] = 1; // configurationVersion
  desc[i++] = sps[1]; // AVCProfileIndication
  desc[i++] = sps[2]; // profile_compatibility
  desc[i++] = sps[3]; // AVCLevelIndication
  desc[i++] = 0xff; // 6 reserved bits + lengthSizeMinusOne (3)
  desc[i++] = 0xe1; // 3 reserved bits + numOfSPS (1)
  desc[i++] = (sps.length >> 8) & 0xff;
  desc[i++] = sps.length & 0xff;
  desc.set(sps, i);
  i += sps.length;
  desc[i++] = 1; // numOfPPS
  desc[i++] = (pps.length >> 8) & 0xff;
  desc[i++] = pps.length & 0xff;
  desc.set(pps, i);
  return desc;
}
