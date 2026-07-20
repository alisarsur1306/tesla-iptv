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
  | { t: 'stop' };

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

// presentation
interface Q { frame: VideoFrame; pts: number }
let queue: Q[] = [];
let frameCount = 0;
let clockCalibrated = false;
let wallStart = 0;
let ptsStart = 0;
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
  }
};

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
  let lastSeq = -1;
  let media: MediaPlaylist =
    parsed.kind === 'media' ? parsed : parseMediaPlaylist(await fetchText(mediaUrl));

  while (playing) {
    const fresh = diffNewSegments(media, lastSeq);
    for (const seg of fresh) {
      if (!playing) return;
      await streamSegment(seg.url);
      lastSeq = seg.seq;
    }
    if (!media.live) break; // VOD ended
    // Poll again for new segments after ~half a target duration.
    const waitMs = Math.max(500, (media.targetDuration || 4) * 500);
    await sleep(waitMs);
    if (!playing) return;
    try {
      media = parseMediaPlaylist(await fetchText(mediaUrl));
    } catch {
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
    while (playing && (queue.length >= 18 || (dec && dec.decodeQueueSize > 12))) {
      await sleep(15);
    }
  }
}

// --- demux callback: route PES to video decode / audio forward ---
function onPes(e: { type: 'video' | 'audio'; pts: number; hasPts: boolean; data: Uint8Array }) {
  if (firstPTS === null && e.hasPts) {
    firstPTS = e.pts;
    post({ t: 'firstPTS', pts: firstPTS });
  }
  const rel = firstPTS === null ? 0 : e.pts - firstPTS;
  if (e.type === 'video') handleVideo(e.data, rel);
  else {
    const copy = e.data.slice();
    post({ t: 'audio', data: copy.buffer, pts: rel }, [copy.buffer]);
  }
}

function handleVideo(data: Uint8Array, pts: number) {
  const nals = splitNALs(data);
  if (!nals.length) return;

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
      while (queue.length > 30) {
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
  if (queue.length >= 3) return 0; // live: drain toward the edge
  const diff = queue[0].pts - presentationClock();
  return diff <= 0 ? 0 : Math.min(diff, 33);
}
function tryPresentOne(): boolean {
  const now = presentationClock();
  // Live-edge: drop stale head frames so we hug the live point.
  while (queue.length > 5) {
    if (now - queue[0].pts > 120) {
      try {
        queue.shift()!.frame.close();
      } catch {
        /* ignore */
      }
    } else break;
  }
  while (queue.length > 30) {
    try {
      queue.shift()!.frame.close();
    } catch {
      /* ignore */
    }
  }
  if (!queue.length) return false;
  const f = queue[0];
  const diff = f.pts - now;
  if (diff > 60) return false; // future frame → wait
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
