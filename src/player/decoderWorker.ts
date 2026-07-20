/// <reference lib="webworker" />
// Decode worker: fetch proxied HLS → MPEG-TS demux → WebCodecs H.264 decode →
// draw onto a transferred OffscreenCanvas. Runs entirely off the main thread.
// Presentation uses setTimeout on a wall clock anchored at the first frame's
// PTS — this is what survives Tesla's Drive throttling (rAF does not, and there
// is no <video>/<audio>/MediaSource for the car's media block to catch).
//
// Phase 1 slice: VIDEO ONLY. Audio PES are demuxed but forwarded to the main
// thread (for the audio engine in a later phase); firstPTS is posted so audio
// can share this clock.

import { TsDemuxer } from '../lib/tsDemux';
import { parsePlaylist, parseMediaPlaylist, diffNewSegments, type MediaPlaylist } from '../lib/hlsPlaylist';
import { splitNALs, toAVCC, nalType, avccDescription, codecString, NAL_SPS, NAL_PPS, NAL_IDR, NAL_NON_IDR } from '../lib/h264';

type InMsg =
  | { t: 'init'; canvas: OffscreenCanvas }
  | { t: 'play'; url: string }
  | { t: 'stop' }
  // Audio is the master clock: `mediaMs` reaches the speakers at `epochMs`
  // (absolute epoch — a Worker's performance.now() origin differs from the page's).
  | { t: 'anchor'; mediaMs: number; epochMs: number };

/**
 * How many segments back from the live edge to join. This IS the buffer: the
 * intake pauses on backpressure with the rest of the segment still unread, so
 * cushion is held cheaply as encoded bytes. Too small (2) and the playlist
 * window drains, leaving the decoder starved between publishes — seen as the
 * picture freezing for seconds at a time.
 */
const LIVE_EDGE_SEGMENTS = 4;
/** Upper bound on the playlist poll interval, so new segments are picked up promptly. */
const MAX_POLL_MS = 2000;
/** Consecutive segment fetch failures before giving up on the stream. */
const MAX_SEGMENT_FAILURES = 3;
/** Consecutive polls with no new segment before declaring the stream dead. */
const MAX_EMPTY_POLLS = 10;
/** A head frame further ahead than this means the clock is wrong, not early. */
const MAX_FUTURE_MS = 1000;
/** Hard cap on buffered decoded frames (~2.5s at 25fps). Frames hold GPU memory,
 *  so this is the ceiling the car has to live with. */
const MAX_QUEUE_FRAMES = 60;
/** Only trim for live-edge once we are comfortably buffered... */
const LIVE_TRIM_MIN_FRAMES = 40;
/** ...and only frames genuinely far behind the clock. */
const LIVE_TRIM_MS = 2000;
/** Pause intake once this many decoded frames are buffered. Must sit below
 *  MAX_QUEUE_FRAMES so backpressure (not frame-dropping) is what limits us. */
const BACKPRESSURE_FRAMES = 45;
/**
 * Cap on how long intake may block on backpressure. Generous on purpose:
 * pausing the read IS the buffer — the rest of the segment stays unread and
 * cheap, and decoding it early would only overflow the frame queue and throw
 * the cushion away. The cap exists solely so a stalled presentation can never
 * wedge intake forever (the re-anchor in tryPresentOne is the real guard).
 */
const MAX_BACKPRESSURE_MS = 30_000;

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

let playing = false;
let abort: AbortController | null = null;

// demux + decode state
let demux: TsDemuxer | null = null;
let dec: VideoDecoder | null = null;
let sps: Uint8Array | null = null;
let pps: Uint8Array | null = null;
let ready = false;
let gotIDR = false;
let firstPTS: number | null = null;
/** Last relative timestamp (ms) — carries PES that have no PTS of their own. */
let lastRel = 0;
/** Video PES seen without ever finding an H.264 NAL — used to flag HEVC etc. */
let videoPesSeen = 0;
let unsupportedVideoReported = false;

// presentation
interface Q { frame: VideoFrame; pts: number }
let queue: Q[] = [];
let frameCount = 0;
let clockCalibrated = false;
let wallStart = 0;
let ptsStart = 0;
// Audio-master clock (set by the 'anchor' message). When present it wins over
// the local wall clock, so video is presented against what the speakers play.
let audioAnchorMediaMs: number | null = null;
let audioAnchorEpochMs = 0;
let presentPending = false;
let presentTimer: ReturnType<typeof setTimeout> | null = null;

function post(m: unknown, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(m, transfer || []);
}
function log(msg: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') {
  post({ t: 'log', msg, level });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

self.onmessage = (e: MessageEvent<InMsg>) => {
  const d = e.data;
  if (d.t === 'init') {
    canvas = d.canvas;
    ctx = canvas.getContext('2d', { alpha: false });
  } else if (d.t === 'play') {
    void play(d.url);
  } else if (d.t === 'stop') {
    stop();
  } else if (d.t === 'anchor') {
    audioAnchorMediaMs = d.mediaMs;
    audioAnchorEpochMs = d.epochMs;
  }
};

/** Absolute epoch ms — comparable with the main thread despite separate time origins. */
function nowEpochMs(): number {
  return performance.timeOrigin + performance.now();
}

function reset() {
  try {
    dec?.close();
  } catch {
    /* ignore */
  }
  dec = null;
  sps = null;
  pps = null;
  ready = false;
  gotIDR = false;
  firstPTS = null;
  lastRel = 0;
  videoPesSeen = 0;
  unsupportedVideoReported = false;
  for (const q of queue) {
    try {
      q.frame.close();
    } catch {
      /* ignore */
    }
  }
  queue = [];
  frameCount = 0;
  clockCalibrated = false;
  audioAnchorMediaMs = null;
  audioAnchorEpochMs = 0;
  demux = new TsDemuxer(onPes);
}

async function play(m3u8Url: string) {
  stop();
  reset();
  playing = true;
  abort = new AbortController();
  post({ t: 'audioReset' });
  schedulePresent();
  try {
    await runSegments(m3u8Url);
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') post({ t: 'error', msg: (e as Error)?.message || 'stream error' });
  }
}

function stop() {
  playing = false;
  if (presentTimer) {
    clearTimeout(presentTimer);
    presentTimer = null;
  }
  presentPending = false;
  try {
    abort?.abort();
  } catch {
    /* ignore */
  }
  try {
    dec?.close();
  } catch {
    /* ignore */
  }
  dec = null;
  for (const q of queue) {
    try {
      q.frame.close();
    } catch {
      /* ignore */
    }
  }
  queue = [];
}

// --- segment sourcing: poll the media playlist, stream each new segment ---
async function runSegments(m3u8Url: string) {
  // Resolve a master playlist to its first variant.
  let mediaUrl = m3u8Url;
  const first = await fetchText(m3u8Url);
  const parsed = parsePlaylist(first);
  if (parsed.kind === 'master') {
    if (!parsed.variants.length) throw new Error('empty master playlist');
    mediaUrl = parsed.variants[0].url;
  }

  post({ t: 'ready' });
  let media: MediaPlaylist =
    parsed.kind === 'media' ? parsed : parseMediaPlaylist(await fetchText(mediaUrl));

  // Join near the LIVE EDGE. Starting at the oldest segment in the window would
  // put playback a whole window (often 30s+) behind live for the whole session.
  let lastSeq = -1;
  if (media.live && media.segments.length > LIVE_EDGE_SEGMENTS) {
    lastSeq = media.segments[media.segments.length - 1 - LIVE_EDGE_SEGMENTS].seq;
  }

  let segmentFailures = 0;
  let emptyPolls = 0;

  while (playing) {
    const fresh = diffNewSegments(media, lastSeq);
    for (const seg of fresh) {
      if (!playing) return;
      try {
        await streamSegment(seg.url);
        segmentFailures = 0;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        // One bad segment must not kill a live stream — skip it and continue.
        segmentFailures++;
        log(`segment failed (${segmentFailures}/${MAX_SEGMENT_FAILURES}): ${(e as Error).message}`, 'warn');
        if (segmentFailures >= MAX_SEGMENT_FAILURES) throw e;
      }
      lastSeq = seg.seq;
    }
    if (!media.live) break; // VOD ended

    const waitMs = Math.min(MAX_POLL_MS, Math.max(500, (media.targetDuration || 4) * 500));
    await sleep(waitMs);
    if (!playing) return;

    try {
      const next = parseMediaPlaylist(await fetchText(mediaUrl));
      // An encoder restart rewinds media-sequence; without this the stream
      // stalls forever because every new segment looks "already seen".
      if (next.segments.length && next.mediaSequence < media.mediaSequence) {
        log('playlist media-sequence reset — rejoining live edge', 'warn');
        lastSeq = next.segments.length > LIVE_EDGE_SEGMENTS
          ? next.segments[next.segments.length - 1 - LIVE_EDGE_SEGMENTS].seq
          : -1;
      }
      // Detect a playlist that has stopped advancing entirely.
      emptyPolls = diffNewSegments(next, lastSeq).length ? 0 : emptyPolls + 1;
      if (emptyPolls >= MAX_EMPTY_POLLS) {
        throw new Error('playlist stopped updating');
      }
      media = next;
    } catch (e) {
      if ((e as Error)?.message === 'playlist stopped updating') throw e;
      /* transient playlist fetch error — retry next loop */
    }
  }
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { signal: abort!.signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

async function streamSegment(url: string) {
  const r = await fetch(url, { signal: abort!.signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const reader = r.body!.getReader();
  const CH = 48 * 1024;
  while (playing) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value.length > CH) {
      for (let p = 0; p < value.length && playing; p += CH) {
        demux!.push(value.subarray(p, Math.min(value.length, p + CH)));
        await sleep(0);
      }
    } else {
      demux!.push(value);
    }
    // Read-side backpressure: never drop encoded frames; pace intake instead.
    // Bounded, because if presentation stalls this loop would otherwise block
    // forever and the stream would wedge with no way back.
    let waited = 0;
    while (
      playing &&
      (queue.length >= BACKPRESSURE_FRAMES || (dec && dec.decodeQueueSize > 12)) &&
      waited < MAX_BACKPRESSURE_MS
    ) {
      await sleep(15);
      waited += 15;
    }
  }
}

// --- demux callback: route PES to video decode / audio forward ---
function onPes(e: {
  type: 'video' | 'audio';
  pts: number;
  hasPts: boolean;
  discontinuity: boolean;
  data: Uint8Array;
}) {
  if (e.hasPts) {
    if (firstPTS === null) {
      firstPTS = e.pts;
      post({ t: 'firstPTS', pts: firstPTS });
    } else if (e.discontinuity) {
      // Encoder restart / ad splice: rebase so the relative timeline continues
      // from where we are instead of jumping (or going negative, which used to
      // clamp to 0 and freeze video permanently). Audio must re-anchor too.
      firstPTS = e.pts - lastRel;
      post({ t: 'audioReset' });
      clockCalibrated = false;
      audioAnchorMediaMs = null;
      log('PTS discontinuity — rebased timeline', 'warn');
    }
    lastRel = e.pts - firstPTS;
  }
  // A PES without a PTS continues at the last known time rather than pretending
  // to be at -firstPTS (which is what `pts - firstPTS` would give with pts = 0).
  const rel = lastRel;
  if (e.type === 'video') handleVideo(e.data, rel);
  else {
    const copy = e.data.slice();
    post({ t: 'audio', data: copy.buffer, pts: rel }, [copy.buffer]);
  }
}

function handleVideo(data: Uint8Array, pts: number) {
  const nals = splitNALs(data);
  if (!nals.length) return;

  // Codec check: H.264 access units always carry SPS(7)/PPS(8)/IDR(5)/slice(1)
  // in the low 5 bits. HEVC uses a 6-bit type field (VPS/SPS/PPS = 32/33/34),
  // so those bytes never look like H.264 slices. Without this the pipeline
  // silently no-ops and the user stares at a permanently black canvas.
  if (!gotIDR && !unsupportedVideoReported) {
    videoPesSeen++;
    const looksH264 = nals.some((n) => {
      const t = nalType(n);
      return t === NAL_SPS || t === NAL_PPS || t === NAL_IDR || t === NAL_NON_IDR;
    });
    if (!looksH264 && videoPesSeen > 60) {
      unsupportedVideoReported = true;
      post({ t: 'unsupportedVideo' });
      log('no H.264 NAL units found — channel is probably HEVC', 'error');
      return;
    }
  }

  for (const n of nals) {
    const t = nalType(n);
    if (t === NAL_SPS) {
      if (sps && ready) {
        const changed = sps.length !== n.length || !sps.every((v, i) => v === n[i]);
        if (changed) {
          log('SPS changed — reset decoder', 'warn');
          resetDecoderOnly();
        }
      }
      sps = n;
    } else if (t === NAL_PPS) {
      pps = n;
    }
  }

  const types = nals.map(nalType);
  const hasIDR = types.includes(NAL_IDR);
  const hasSlice = hasIDR || types.includes(NAL_NON_IDR);

  if (!gotIDR) {
    if (hasIDR && sps && pps) {
      log('First IDR keyframe', 'success');
      gotIDR = true;
      initDecoder();
    } else {
      return; // wait for a clean start point
    }
  }
  if (!ready || !dec || dec.state !== 'configured' || !hasSlice) return;

  // Key access unit = SPS + PPS + IDR slices; delta = non-IDR slices.
  const slices = hasIDR
    ? [sps!, pps!, ...nals.filter((n) => nalType(n) === NAL_IDR)]
    : nals.filter((n) => nalType(n) === NAL_NON_IDR);
  if (!slices.length) return;

  try {
    dec.decode(
      new EncodedVideoChunk({
        type: hasIDR ? 'key' : 'delta',
        timestamp: Math.max(0, pts) * 1000, // µs
        data: toAVCC(slices),
      }),
    );
  } catch (err) {
    const msg = (err as Error)?.message || '';
    log('decode error: ' + msg, 'error');
    if (msg.includes('key') || msg.includes('closed')) gotIDR = false;
  }
}

function resetDecoderOnly() {
  try {
    dec?.close();
  } catch {
    /* ignore */
  }
  dec = null;
  ready = false;
  gotIDR = false;
  for (const q of queue) {
    try {
      q.frame.close();
    } catch {
      /* ignore */
    }
  }
  queue = [];
}

function initDecoder() {
  try {
    dec?.close();
  } catch {
    /* ignore */
  }
  const codec = codecString(sps!);
  const description = avccDescription(sps!, pps!);
  dec = new VideoDecoder({
    output: (frame) => {
      frameCount++;
      queue.push({ frame, pts: frame.timestamp / 1000 });
      while (queue.length > MAX_QUEUE_FRAMES) {
        try {
          queue.shift()!.frame.close();
        } catch {
          /* ignore */
        }
      }
      if (!presentPending) schedulePresent();
      if ((frameCount & 15) === 0) post({ t: 'stats', frames: frameCount, buffer: queue.length });
    },
    error: (e) => {
      log('VideoDecoder error: ' + e.message, 'error');
      gotIDR = false;
      ready = false;
    },
  });
  try {
    dec.configure({ codec, description, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
    ready = true;
    log('video decoder ready: ' + codec, 'success');
  } catch (e) {
    log('video configure failed: ' + (e as Error).message, 'error');
    ready = false;
  }
}

// --- presentation (wall clock anchored at first frame; setTimeout paced) ---
function presentationClock(): number {
  // Audio is the master clock when it is running.
  if (audioAnchorMediaMs !== null) {
    return nowEpochMs() - audioAnchorEpochMs + audioAnchorMediaMs;
  }
  if (clockCalibrated) return performance.now() - wallStart + ptsStart;
  return queue.length ? queue[0].pts : 0;
}
function calibrate(p: number) {
  if (clockCalibrated) return;
  clockCalibrated = true;
  wallStart = performance.now();
  ptsStart = p;
}
function schedulePresent() {
  if (!playing || presentPending) return;
  presentPending = true;
  presentTick();
}
function presentTick() {
  if (!playing) {
    presentPending = false;
    return;
  }
  const presented = tryPresentOne();
  if (!presented && !queue.length) {
    presentPending = false;
    return;
  }
  presentTimer = setTimeout(presentTick, nextDelay());
}
function nextDelay(): number {
  if (!queue.length) return 20;
  const diff = queue[0].pts - presentationClock();
  // Never return 0: a setTimeout(0) loop spins the worker at max rate and
  // starves the fetch/demux path (and burns battery in the car). 4ms still
  // drains a backlog far faster than realtime when we are behind.
  if (diff <= 0) return 4;
  return Math.max(4, Math.min(diff, 33));
}
function tryPresentOne(): boolean {
  const now = presentationClock();
  // Live-edge trim. This must NOT double as a buffer cap: trimming to ~5 frames
  // whenever the head was 120ms old kept the queue at 0-9 frames, so any jitter
  // in segment delivery starved presentation — visible as the picture freezing
  // for seconds and flickering. Only trim when we are BOTH deeply buffered and
  // genuinely far behind, so latency still can't grow without bound.
  while (queue.length > LIVE_TRIM_MIN_FRAMES && now - queue[0].pts > LIVE_TRIM_MS) {
    try {
      queue.shift()!.frame.close();
    } catch {
      /* ignore */
    }
  }
  while (queue.length > MAX_QUEUE_FRAMES) {
    try {
      queue.shift()!.frame.close();
    } catch {
      /* ignore */
    }
  }
  if (!queue.length) return false;
  const f = queue[0];
  const diff = f.pts - now;
  // A frame a little ahead just needs to wait for its moment.
  // But a frame FAR ahead means the clock itself is wrong — typically because
  // audio and video PTS have different bases, so the audio-master clock reads
  // permanently behind the video. Previously such a frame was never presented
  // AND never dropped: the queue filled, fetch backpressure wedged, and video
  // froze for good while audio kept playing. Re-anchor onto this frame instead.
  if (diff > MAX_FUTURE_MS) {
    if (audioAnchorMediaMs !== null) {
      audioAnchorEpochMs = nowEpochMs();
      audioAnchorMediaMs = f.pts;
    } else {
      clockCalibrated = true;
      wallStart = performance.now();
      ptsStart = f.pts;
    }
    log(`presentation clock re-anchored (frame ${Math.round(diff)}ms in the future)`, 'warn');
  } else if (diff > 60) {
    return false; // future frame → wait
  }
  if (diff < -250) {
    try {
      queue.shift()!.frame.close();
    } catch {
      /* ignore */
    }
    return tryPresentOne();
  }
  calibrate(f.pts);
  queue.shift();
  draw(f.frame);
  try {
    f.frame.close();
  } catch {
    /* ignore */
  }
  return true;
}
function draw(frame: VideoFrame) {
  if (!canvas || !ctx) return;
  const w = frame.displayWidth || frame.codedWidth;
  const h = frame.displayHeight || frame.codedHeight;
  if (w && h && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
    post({ t: 'canvasResize', width: w, height: h });
  }
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
}
