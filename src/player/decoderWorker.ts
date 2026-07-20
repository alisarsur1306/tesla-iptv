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
import { splitNALs, toAVCC, nalType, avccDescription, codecString, isValidSps, NAL_SPS, NAL_PPS, NAL_IDR, NAL_NON_IDR } from '../lib/h264';

type InMsg =
  | { t: 'init'; canvas: OffscreenCanvas }
  | { t: 'play'; url: string }
  | { t: 'stop' }
  // Audio is the master clock: `mediaMs` reaches the speakers at `epochMs`
  // (absolute epoch — a Worker's performance.now() origin differs from the page's).
  | { t: 'anchor'; mediaMs: number; epochMs: number };

/** Video PES to inspect before declaring the codec unsupported. */
const UNSUPPORTED_PES_THRESHOLD = 120;
/** Segments back from the live edge when falling back to HLS segment mode. */
const HLS_EDGE_SEGMENTS = 3;
/** Reconnect attempts before giving up on a dropped continuous stream. */
const MAX_RECONNECTS = 5;
/** Pause before reconnecting a dropped stream. */
const RECONNECT_DELAY_MS = 800;
/**
 * How long presentation may go without drawing a frame before we conclude the
 * clock itself is wrong (rather than the head frame simply being early).
 * Being AHEAD is normal buffering; being unable to draw anything is not.
 * Must clear normal startup comfortably: playback waits out the audio start
 * lead before the first draw, and at 2500ms that legitimate wait tripped the
 * guard and fast-forwarded away the cushion built from the stream's backlog.
 */
const PRESENT_STALL_MS = 5000;
/** Hard cap on buffered decoded frames (~2.5s at 25fps). Frames hold GPU memory,
 *  so this is the ceiling the car has to live with. */
const MAX_QUEUE_FRAMES = 60;
/** Only trim for live-edge once we are comfortably buffered... */
const LIVE_TRIM_MIN_FRAMES = 40;
/** ...and only frames genuinely far behind the clock. */
const LIVE_TRIM_MS = 2000;
/** Keep roughly this many frames DECODED. The rest of the reserve is held as
 *  cheap encoded bytes, so this stays low to bound GPU memory in the car. */
const DECODE_TARGET_FRAMES = 24;
/** Reader pauses once the encoded reserve reaches this many bytes (~10-15s of
 *  video). This is the real jitter cushion; bytes are cheap so it can be large. */
const MAX_ENCODED_BYTES = 8 * 1024 * 1024;
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

// Encoded-byte reserve between the network and the decoder. The reader fills it
// as fast as bytes arrive (capturing the stream's front-loaded backlog); the
// feeder drains it into the demuxer only enough to keep a small decoded-frame
// target. A network stall then drains this cheap byte reserve instead of
// freezing the picture — decoded frames hold GPU memory, encoded bytes are ~free.
let encodedChunks: Uint8Array[] = [];
let encodedBytes = 0;

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
/** Epoch ms of the last drawn frame — 0 until playback starts. Wedge detection
 *  keys off this: frames being early is fine, drawing nothing is not. */
let lastPresentAt = 0;

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
  lastPresentAt = 0;
  encodedChunks = [];
  encodedBytes = 0;
  demux = new TsDemuxer(onPes);
}

async function play(streamUrl: string) {
  stop();
  reset();
  playing = true;
  // Start the stall clock now: if the very first frames are already misaligned,
  // "nothing presented yet" must still be able to trigger a re-anchor rather
  // than waiting forever. PRESENT_STALL_MS is comfortably above the audio
  // start lead, so normal startup buffering never trips it.
  lastPresentAt = nowEpochMs();
  abort = new AbortController();
  post({ t: 'audioReset' });
  schedulePresent();
  void feedLoop(); // drains the encoded reserve into the decoder for the session
  try {
    await runStream(streamUrl);
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

/**
 * Continuous MPEG-TS source: ONE long-lived response, read until it ends.
 *
 * This replaces HLS playlist polling. Fetching segment-by-segment delivered
 * data in bursts separated by multi-second gaps, so the decoder starved and the
 * picture froze/flickered. A single response streams steadily (and front-loads
 * a backlog), which is also what a single-concurrent-connection account wants:
 * one connection held open instead of a new request per segment.
 *
 * The connection can still drop (upstream restart, network blip), so a drop is
 * treated as normal and reconnected. The demuxer resyncs on the next PES and a
 * PTS discontinuity rebases the timeline, so a reconnect is not user-visible
 * beyond a brief pause.
 */
async function runStream(url: string) {
  let attempt = 0;
  while (playing) {
    try {
      await streamOnce(url);
      if (!playing) return;
      // Ended cleanly but we still want to play → upstream closed the stream.
      attempt++;
      log(`stream ended — reconnecting (${attempt}/${MAX_RECONNECTS})`, 'warn');
    } catch (e) {
      if (!playing || (e as Error)?.name === 'AbortError') return;
      attempt++;
      log(`stream error: ${(e as Error).message} — reconnecting (${attempt}/${MAX_RECONNECTS})`, 'warn');
    }
    if (attempt >= MAX_RECONNECTS) throw new Error('stream lost');
    await sleep(RECONNECT_DELAY_MS);
  }
}

/** Is this response an HLS playlist rather than raw MPEG-TS? */
function looksLikePlaylist(contentType: string | null, first: Uint8Array): boolean {
  if (contentType && /mpegurl/i.test(contentType)) return true;
  // Real TS starts with the 0x47 sync byte; a playlist starts with #EXTM3U.
  if (first[0] === 0x47) return false;
  const head = new TextDecoder().decode(first.subarray(0, 16));
  return head.startsWith('#EXTM3U');
}

/**
 * Segment mode: poll the media playlist and stream each new segment. Only used
 * for channels whose upstream is an external HLS source (they return a playlist
 * even from the .ts URL). Continuous TS remains the default because it buffers
 * far better; this exists so those channels work at all.
 */
async function runHlsSegments(playlistUrl: string) {
  let mediaUrl = playlistUrl;
  const parsed = parsePlaylist(await fetchText(playlistUrl));
  if (parsed.kind === 'master') {
    if (!parsed.variants.length) throw new Error('empty master playlist');
    mediaUrl = parsed.variants[0].url;
  }
  let media: MediaPlaylist =
    parsed.kind === 'media' ? parsed : parseMediaPlaylist(await fetchText(mediaUrl));

  // Join a little back from the live edge so there is something to buffer.
  let lastSeq = -1;
  if (media.segments.length > HLS_EDGE_SEGMENTS) {
    lastSeq = media.segments[media.segments.length - 1 - HLS_EDGE_SEGMENTS].seq;
  }
  let emptyPolls = 0;

  while (playing) {
    for (const seg of diffNewSegments(media, lastSeq)) {
      if (!playing) return;
      try {
        await streamSegmentInto(seg.url);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        log(`segment failed: ${(e as Error).message}`, 'warn');
      }
      lastSeq = seg.seq;
    }
    if (!media.live) return;
    await sleep(Math.min(2000, Math.max(500, (media.targetDuration || 4) * 500)));
    if (!playing) return;
    try {
      const next = parseMediaPlaylist(await fetchText(mediaUrl));
      // An encoder restart rewinds media-sequence; rejoin instead of stalling.
      if (next.segments.length && next.mediaSequence < media.mediaSequence) lastSeq = -1;
      emptyPolls = diffNewSegments(next, lastSeq).length ? 0 : emptyPolls + 1;
      if (emptyPolls >= 10) throw new Error('playlist stopped updating');
      media = next;
    } catch (e) {
      if ((e as Error)?.message === 'playlist stopped updating') throw e;
      /* transient playlist error — retry next poll */
    }
  }
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { signal: abort!.signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

/** Read one segment fully into the demuxer, with the same backpressure rules. */
async function streamSegmentInto(url: string) {
  const r = await fetch(url, { signal: abort!.signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const reader = r.body!.getReader();
  while (playing) {
    const { value, done } = await reader.read();
    if (done) return;
    pushEncoded(value);
    let waited = 0;
    while (playing && encodedBytes >= MAX_ENCODED_BYTES && waited < MAX_BACKPRESSURE_MS) {
      await sleep(15);
      waited += 15;
    }
  }
}

async function streamOnce(url: string) {
  const r = await fetch(url, { signal: abort!.signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (!r.body) throw new Error('no response body');
  post({ t: 'ready' });

  const reader = r.body.getReader();
  let sniffed = false;
  try {
    while (playing) {
      const { value, done } = await reader.read();
      if (done) return; // upstream closed → caller reconnects

      // Some channels ignore the .ts extension and serve an HLS PLAYLIST anyway
      // (their upstream is an external HLS CDN that the panel just relays).
      // Feeding playlist text to the TS demuxer yields nothing, so detect it on
      // the first bytes and switch to segment mode for this channel.
      if (!sniffed) {
        sniffed = true;
        if (looksLikePlaylist(r.headers.get('content-type'), value)) {
          log('server returned an HLS playlist — switching to segment mode', 'warn');
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          await runHlsSegments(url);
          return;
        }
      }
      pushEncoded(value);
      // Read-side backpressure keys off the ENCODED reserve now, not decoded
      // frames: keep pulling bytes off the network (grabbing the front-loaded
      // backlog) until the reserve is deep, then pause. The feeder decodes at
      // its own pace, so a network stall drains the reserve rather than freezing.
      let waited = 0;
      while (playing && encodedBytes >= MAX_ENCODED_BYTES && waited < MAX_BACKPRESSURE_MS) {
        await sleep(15);
        waited += 15;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** Append network bytes to the encoded reserve. */
function pushEncoded(chunk: Uint8Array): void {
  encodedChunks.push(chunk);
  encodedBytes += chunk.length;
}

/**
 * Feeder: drain the encoded reserve into the demuxer, but only enough to keep
 * ~DECODE_TARGET_FRAMES decoded. Surplus stays as cheap encoded bytes. Runs for
 * the whole session alongside the reader.
 */
async function feedLoop(): Promise<void> {
  const CH = 48 * 1024;
  while (playing) {
    const wantMore = queue.length < DECODE_TARGET_FRAMES && (!dec || dec.decodeQueueSize < 16);
    if (wantMore && encodedChunks.length) {
      const chunk = encodedChunks.shift()!;
      encodedBytes -= chunk.length;
      // Split a large chunk so a single push never blocks the loop for long.
      if (chunk.length > CH) {
        for (let p = 0; p < chunk.length && playing; p += CH) {
          demux!.push(chunk.subarray(p, Math.min(chunk.length, p + CH)));
          await sleep(0);
        }
      } else {
        demux!.push(chunk);
      }
    } else {
      // Either the decoder is satisfied or the reserve is empty (network stall).
      await sleep(wantMore ? 20 : 8);
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

  // Codec check. Testing "does any NAL have type 1/5/7/8" is NOT enough: when a
  // non-H.264 stream (HEVC, or scrambled payload) is parsed with H.264 rules the
  // types come out uniformly spread over 0-31, so those values appear by chance
  // and the stream looks decodable while producing nothing but a black canvas.
  // A *valid SPS* is the reliable signal, so require one.
  if (!gotIDR && !unsupportedVideoReported) {
    videoPesSeen++;
    if (videoPesSeen > UNSUPPORTED_PES_THRESHOLD) {
      unsupportedVideoReported = true;
      post({ t: 'unsupportedVideo' });
      log('no valid H.264 SPS found — channel is HEVC or scrambled', 'error');
      return;
    }
  }

  for (const n of nals) {
    const t = nalType(n);
    if (t === NAL_SPS) {
      // Ignore "type 7" NALs that are not real SPS — otherwise we configure the
      // decoder with nonsense (observed: avc1.2b7caf, profile 43, 1030 bytes)
      // and it decodes nothing.
      if (!isValidSps(n)) continue;
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
      if ((frameCount & 15) === 0)
        post({ t: 'stats', frames: frameCount, buffer: queue.length, reserveKB: Math.round(encodedBytes / 1024) });
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
  // A frame ahead of the clock just needs to wait for its moment — that IS the
  // buffer, and being ahead is not evidence of anything wrong. Using "how far
  // ahead" as the trigger fast-forwarded the clock onto the head frame during
  // normal pre-buffering, collapsing the cushion to ~6 frames every time it
  // fired. The real symptom of a broken clock is that NOTHING gets presented,
  // so wedge detection is based on how long we have gone without drawing.
  if (diff > 60) {
    const stalledMs = nowEpochMs() - lastPresentAt;
    if (stalledMs < PRESENT_STALL_MS) {
      return false; // healthy: still presenting, this frame is simply early
    }
    // Nothing drawn for PRESENT_STALL_MS while frames sit in the future → the
    // clock is wrong (audio/video PTS bases differ). Re-anchor onto this frame.
    if (audioAnchorMediaMs !== null) {
      audioAnchorEpochMs = nowEpochMs();
      audioAnchorMediaMs = f.pts;
    } else {
      clockCalibrated = true;
      wallStart = performance.now();
      ptsStart = f.pts;
    }
    log(`presentation stalled ${Math.round(stalledMs)}ms — clock re-anchored`, 'warn');
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
  lastPresentAt = nowEpochMs();
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
