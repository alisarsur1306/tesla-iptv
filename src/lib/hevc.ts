// H.265 / HEVC helpers for the WebCodecs pipeline. Pure, no WebCodecs.
//
// HEVC differs from H.264: the NAL header is 2 bytes and the type is 6 bits at
// bits 1-6 of the first byte (not the low 5 bits). We feed the decoder in the
// `hev1` Annex-B form (start-code-prefixed NALs, parameter sets in-band before
// each keyframe), which avoids building an hvcC configuration record.

/** HEVC NAL unit types (from the 6-bit type field). */
export const HEVC_VPS = 32;
export const HEVC_SPS = 33;
export const HEVC_PPS = 34;
/** IRAP (keyframe) slice types: BLA 16-18, IDR 19-20, CRA 21. */
export const HEVC_IRAP_LO = 16;
export const HEVC_IRAP_HI = 21;

/** HEVC NAL type = bits 1-6 of the first header byte. */
export function hevcNalType(nal: Uint8Array): number {
  return (nal[0] >> 1) & 0x3f;
}

/** A keyframe (IRAP) slice — carries a decodable-from-scratch picture. */
export function isHevcKeySlice(t: number): boolean {
  return t >= HEVC_IRAP_LO && t <= HEVC_IRAP_HI;
}

/** Any coded slice (VCL NAL): non-IRAP 0-9 or IRAP 16-21. */
export function isHevcSlice(t: number): boolean {
  return (t >= 0 && t <= 9) || (t >= HEVC_IRAP_LO && t <= HEVC_IRAP_HI);
}

/**
 * Do these NALs look like HEVC? H.264 never uses NAL types 32/33/34 (its type
 * field is 5 bits, max 31), so seeing VPS/SPS/PPS under the HEVC interpretation
 * is a reliable signal — and distinguishes real HEVC from MPEG-2/garbage, which
 * produces no consistent parameter-set types.
 */
export function looksLikeHevc(nals: Uint8Array[]): boolean {
  let vps = false;
  let sps = false;
  let pps = false;
  for (const n of nals) {
    const t = hevcNalType(n);
    if (t === HEVC_VPS) vps = true;
    else if (t === HEVC_SPS) sps = true;
    else if (t === HEVC_PPS) pps = true;
  }
  // SPS + PPS are mandatory; VPS is too in practice but keep the check lenient.
  return sps && pps && (vps || true);
}

const START_CODE = new Uint8Array([0, 0, 0, 1]);

/** Concatenate NALs into an Annex-B byte stream (4-byte start code before each). */
export function toAnnexB(nals: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const n of nals) size += START_CODE.length + n.length;
  const out = new Uint8Array(size);
  let o = 0;
  for (const n of nals) {
    out.set(START_CODE, o);
    o += START_CODE.length;
    out.set(n, o);
    o += n.length;
  }
  return out;
}

/**
 * A generic HEVC Main-profile codec string that covers broadcast/IPTV streams
 * (Main, up to level 5.1). WebCodecs matches the stream against this ceiling, so
 * an over-stated level accepts anything at or below it. Main10 (10-bit) streams
 * need `hev1.2.*`; the caller retries with the Main10 string if Main fails.
 */
export const HEVC_MAIN_CODEC = 'hev1.1.6.L153.B0';
export const HEVC_MAIN10_CODEC = 'hev1.2.4.L153.B0';
