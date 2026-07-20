# WebCodecs Canvas Player Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hls.js + `<video>` in `PlayerOverlay` with a media-element-free player (MPEG-TS demux → WebCodecs H.264 decode → OffscreenCanvas in a Worker; audio via Web Audio, with WASM decode for AC-3/MP2/MP3), so Tesla's driving-block — which only targets `<video>`/`<audio>`/MSE — has nothing to catch.

**Architecture:** A Web Worker owns the heavy path: fetch the proxied `.ts` byte stream, demux MPEG-TS packets (PAT/PMT-free heuristic PID discovery via PES stream_id), feed H.264 access units to a WebCodecs `VideoDecoder`, and draw `VideoFrame`s onto an `OffscreenCanvas` transferred from React. Presentation uses a wall-clock anchored at the first frame's PTS with `setTimeout` (survives Drive throttling; `requestAnimationFrame` does not). Audio PES payloads are posted to the main thread, decoded (native for AAC, WASM for AC-3/MP2/MP3), and scheduled on an `AudioContext` synced to the same PTS clock. No `<video>`, `<audio>`, or `MediaSource` anywhere.

**Tech Stack:** TypeScript, React 19, WebCodecs (`VideoDecoder`, `EncodedVideoChunk`), `OffscreenCanvas`, Web Worker, Web Audio (`AudioContext`), a WASM audio decoder for AC-3/MP2/MP3. Existing `/api/proxy` (serves raw `.ts` + rewrites m3u8) is unchanged.

**Reference:** teslaplay.net's `ts-worker.js` (studied, not copied) is the proof this pipeline plays live TV while driving in a Tesla. Its audio path is AAC-only; Phase 3 (WASM AC-3/MP2/MP3) is net-new beyond it.

---

## Why phased this way

The whole bet rests on one unproven assumption: **does TS→WebCodecs→canvas actually decode and paint a real IPTV channel, and does the Worker/OffscreenCanvas path keep running when the surrounding tab is throttled?** Phase 1 proves exactly that with H.264 video and no audio. Everything expensive (WASM audio, A/V sync) comes only after the slice is green. If Phase 1 fails in the car, we've spent the least.

Codec reality (verified against the WebCodecs spec + Tesla Chromium ~v128):
- **Video:** H.264/`avc1` decodes reliably. HEVC/`hev1` is unsupported → Phase 4 detects it and shows "channel not supported" rather than a black screen.
- **Audio:** AAC decodes natively. AC-3, MP2 (MPEG-1/2 Layer II), MP3 do **not** decode via WebCodecs → Phase 3 WASM.

---

## Task 1: m3u8 → live segment stream (data layer)

The proxy rewrites the media playlist so every segment is `/api/proxy?u=...`. The worker needs a single continuous byte stream of TS. Simplest correct approach: a small live-playlist poller that yields new segment URLs in order, and the worker concatenates their bodies. Build the poller as a pure, testable module first.

**Files:**
- Create: `src/lib/hlsPlaylist.ts`
- Test: `src/lib/hlsPlaylist.test.ts`

**Step 1: Write the failing test**

```ts
import { parseMediaPlaylist, diffNewSegments } from './hlsPlaylist';

const M3U8 = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:2.0,
/api/proxy?u=seg10.ts
#EXTINF:2.0,
/api/proxy?u=seg11.ts`;

test('parses media-sequence and segment URLs', () => {
  const p = parseMediaPlaylist(M3U8);
  expect(p.mediaSequence).toBe(10);
  expect(p.segments).toEqual([
    { seq: 10, url: '/api/proxy?u=seg10.ts', duration: 2 },
    { seq: 11, url: '/api/proxy?u=seg11.ts', duration: 2 },
  ]);
});

test('diffNewSegments returns only unseen sequences', () => {
  const p = parseMediaPlaylist(M3U8);
  expect(diffNewSegments(p, 10).map((s) => s.seq)).toEqual([11]);
});
```

**Step 2: Run test to verify it fails** — Run: `node --test` (see Task 8 for runner). Expected: FAIL, module not found.

**Step 3: Implement** `parseMediaPlaylist` (read `#EXT-X-MEDIA-SEQUENCE`, pair `#EXTINF` durations with the following non-`#` line, assign `seq = mediaSequence + index`) and `diffNewSegments(playlist, lastSeq)` (return segments with `seq > lastSeq`). If the source is a MASTER playlist (`#EXT-X-STREAM-INF`), expose `variantUrls` so the caller picks the first (or lowest-bitrate) variant. Pure functions, no I/O.

**Step 4: Run test — Expected: PASS.**

**Step 5: Commit** — `feat(player): HLS media-playlist parser + segment diff`

---

## Task 2: MPEG-TS demuxer (pure, the core risk-reducer)

Standalone, fully unit-tested demux. Given TS bytes, discover the video/audio PID from the first PES with a video (`0xE0–0xEF`) / audio (`0xC0–0xDF`) stream_id, reassemble PES, extract PTS (33-bit, /90 → ms) and payload. This is the piece most likely to have subtle bugs, so it is isolated and tested against a synthetic packet.

**Files:**
- Create: `src/lib/tsDemux.ts`
- Test: `src/lib/tsDemux.test.ts`

**Step 1: Write the failing test** (synthetic single-PES video packet)

```ts
import { TsDemuxer } from './tsDemux';

test('extracts a video PES with PTS and payload', () => {
  // Build one 188-byte TS packet: sync 0x47, PUSI set, PID 0x100,
  // payload = PES(video stream_id 0xE0, PTS flag, PTS=90000 → 1000ms, body [0xAA,0xBB]).
  const pkt = buildVideoTsPacket({ pid: 0x100, ptsTicks: 90000, body: [0xaa, 0xbb] });
  const out: Array<{ type: string; pts: number; bytes: number[] }> = [];
  const d = new TsDemuxer((e) => out.push({ type: e.type, pts: e.pts, bytes: [...e.data] }));
  d.push(pkt);
  d.flush();
  expect(out).toEqual([{ type: 'video', pts: 1000, bytes: [0xaa, 0xbb] }]);
});
```

(Include `buildVideoTsPacket` as a test helper in the test file — it makes the byte layout explicit and doubles as documentation of the format.)

**Step 2: Run — Expected: FAIL.**

**Step 3: Implement `TsDemuxer`** — algorithm (ISO 13818-1):
- Buffer bytes; find `0x47` sync; process fixed 188-byte packets.
- Parse `pid`, `payload_unit_start_indicator`, `adaptation_field_control`; skip adaptation field.
- On PUSI with PES start code `00 00 01`, read stream_id → assign `videoPID`/`audioPID` once.
- Reassemble PES per PID; on the next PUSI for that PID, finalize the previous PES: verify `00 00 01`, read `PES_header_data_length` at byte 8, parse PTS from bytes 9–13 when the PTS flag (`data[7] & 0x80`) is set, slice payload after the header, emit `{ type, pts /* ms */, data }`.
- `flush()` finalizes any pending PES.
- Emit a `codecHint` for audio stream_type when discoverable, else let Task 5 sniff the payload.

**Step 4: Run — Expected: PASS.** Add tests for: split packet across two `push` calls, audio PID discovery, missing-PTS packet (fall back to synthetic timestamp handled downstream).

**Step 5: Commit** — `feat(player): MPEG-TS demuxer with PES/PTS extraction`

---

## Task 3: H.264 helpers (NAL split + avcC description)

Pure functions the worker needs: Annex-B NAL extraction, and building the `avcC` `description` for `VideoDecoder.configure` from SPS/PPS. Unit-testable without WebCodecs.

**Files:**
- Create: `src/lib/h264.ts`
- Test: `src/lib/h264.test.ts`

**Step 1: Failing test** — `extractNALs(annexB)` splits on `00 00 01` / `00 00 00 01`; `avccDescription(sps, pps)` returns the standard `[0x01, sps[1], sps[2], sps[3], 0xFF, 0xE1, len16, ...sps, 0x01, len16, ...pps]`; `codecString(sps)` returns `avc1.<hex hex hex>`.

**Step 2–4:** Implement per the AVCDecoderConfigurationRecord layout; verify against a known SPS byte vector. Expected: PASS.

**Step 5: Commit** — `feat(player): H.264 NAL + avcC helpers`

---

## Task 4: The decode Worker — Phase 1 vertical slice (video only)

Wire Tasks 2–3 into a Worker that owns an `OffscreenCanvas`, runs a `VideoDecoder`, and presents frames with a `setTimeout` wall clock. **No audio yet.** This is the make-or-break slice, verified in the browser against a real channel.

**Files:**
- Create: `src/player/decoderWorker.ts` (worker entry)
- Create: `src/player/playerClient.ts` (main-thread handle: creates the worker, transfers the canvas, exposes `play(url)/stop()` and status callbacks)
- Modify: `vite.config.ts` only if worker bundling needs `worker.format: 'es'` (Vite supports `new Worker(new URL('./decoderWorker.ts', import.meta.url), { type: 'module' })` natively — prefer that, no config).

**Worker responsibilities:**
- `init`: receive transferred `OffscreenCanvas`, `getContext('2d', { alpha: false })`.
- `play(url)`: fetch the segment stream (Task 1 poller drives which URLs; for the slice, accept a single already-concatenating URL or loop the poller), read via `resp.body.getReader()`, chunk large reads (48 KB) with `await sleep(0)` so the present loop never starves, apply read-backpressure when `decodeQueueSize`/queue is deep (never drop *encoded* frames — that corrupts decode).
- Demux (Task 2) → on video PES, extract NALs (Task 3); gate on first IDR + SPS/PPS, then `configure` with `optimizeForLatency: true, hardwareAcceleration: 'no-preference'`; feed `EncodedVideoChunk` (key on IDR = `[sps, pps, ...idrSlices]`, else delta slices).
- `output`: push `{ frame, pts }`; cap the queue (~30), drop oldest on overflow.
- Presentation: `presentTick()` on `setTimeout`; wall clock anchored at first presented PTS; live-edge drop of frames > ~120 ms stale; `drawImage(frame,…)`; resize canvas to `displayWidth/Height` and post `canvasResize`.
- On SPS change → reset decoder only. On decode error mentioning key/closed → re-arm `gotFirstIDR`.
- Post `stats`/`log`/`error`/`ready` messages to the main thread.

**Main-thread `playerClient.ts`:**
- `create(canvas: HTMLCanvasElement)` → `const off = canvas.transferControlToOffscreen()`, spawn worker, post `{ t:'init', canvas: off }` (transfer list).
- `play(url)`, `stop()`, `onStatus(cb)`, `onError(cb)`, `destroy()`.

**Verification (not a unit test — this needs a real stream):**
- Add a temporary dev route/harness that mounts a canvas + `playerClient` and plays one known H.264 channel through the proxy.
- Run the dev server; in the browser confirm: `document.querySelectorAll('video').length === 0`, canvas resizes to the stream resolution, `stats.frames` climbs, picture is visible. Screenshot it.
- **Throttle check:** background the tab / emulate `cpuThrottlingRate` and confirm frames keep advancing (proves the setTimeout/worker path survives what rAF wouldn't).

**Commit** — `feat(player): WebCodecs H.264 worker rendering to OffscreenCanvas (video-only slice)`

**Gate:** Do not proceed to audio until this slice paints a live channel with zero `<video>` elements.

---

## Task 5: Audio path — AAC (native), synced

Audio PES payloads posted to main thread with PTS. AAC is the common IPTV codec and decodes without WASM. Implement AAC first to get the sync architecture right before adding WASM codecs.

**Files:**
- Create: `src/player/audioEngine.ts`
- Test: `src/player/audioEngine.test.ts` (pure parts only: ADTS frame splitting, PTS→AudioContext-time mapping)

**Approach:**
- Main thread owns one `AudioContext`. Maintain `audioClockOffset = ctx.currentTime - firstAudioPtsSec` so audio and the worker's video clock share the same PTS origin (post the video `firstPTS` to main).
- AAC arrives as ADTS frames in the PES payload. Decode via `AudioDecoder` (WebCodecs audio — AAC *is* supported) → `AudioData` → copy into an `AudioBuffer` → `BufferSource.start(atTime)` where `atTime = audioClockOffset + ptsSec`. Drop audio > ~250 ms late; this is the sync master-ish reference for the video clock in live mode.
- Expose `reset()` (on channel change / `audioReset` message), `pushEncoded(bytes, ptsMs, codec)`.

**Unit-test** the ADTS splitter and the PTS→time math. Full audio is verified in-browser in Task 7.

**Commit** — `feat(player): AAC audio decode + PTS-synced Web Audio scheduling`

---

## Task 6: Audio path — WASM for AC-3 / MP2 / MP3 (the "all channels" requirement)

WebCodecs cannot decode AC-3/MP2/MP3. Add a compact WASM decoder so no channel is silent.

**Decision to make during execution (spike first, ~30 min):** pick the lightest option that covers AC-3 + MP2 + MP3:
- Candidate A: separate tiny decoders (e.g. an MP2/MP3 decoder + an AC-3 decoder compiled to WASM). Smallest payload, most integration work.
- Candidate B: a single small libav/ffmpeg-derived WASM build limited to those audio codecs. One integration, larger payload.
- **Prefer A if a maintained, <150 KB AC-3 WASM exists; else B.** Log the choice and payload size in the commit body. `// ponytail:` mark the codec set; upgrade path = add codecs to the same WASM boundary.

**Files:**
- Create: `src/player/wasmAudio.ts` (loads the WASM lazily only when a non-AAC codec is detected — most channels never pay the download)
- Modify: `src/player/audioEngine.ts` (route by codec: AAC → native; AC-3/MP2/MP3 → WASM → PCM → same `AudioBuffer` scheduling path)
- Test: `src/player/wasmAudio.test.ts` (codec sniff from PES payload: AC-3 syncword `0x0B77`, MPEG-audio syncword `0xFFEx`)

**Steps:** codec sniff (unit-tested) → lazy-load WASM → decode to PCM Float32 → reuse Task 5's scheduling. Verify each codec in-browser against a real channel of that type in Task 7.

**Commit** — `feat(player): WASM AC-3/MP2/MP3 audio decode (audio on all channels)`

---

## Task 7: Integrate into PlayerOverlay + codec detection + reconnect

Replace hls.js with `playerClient`; keep the existing UX (tap-to-play, status, fatal error, Back, retry). Detect HEVC and unsupported audio and message the user.

**Files:**
- Modify: `src/components/PlayerOverlay.tsx` — remove hls.js + the detached `<video>`; render only the `<canvas>`; drive it with `playerClient`; map worker `error`/`log` to the existing `status`/`fatalError` UI; reconnect on stream error with the current `MAX_NETWORK_RETRIES` budget; on channel change call `playerClient.play(newUrl)`.
- Modify: `package.json` — remove `hls.js` dependency once nothing imports it.
- Delete: the freeze-watchdog block (obsolete — no `<video>`/decoder-stall to babysit; the worker owns liveness).

**Codec detection:**
- Video: if the first PES video stream_type / NAL profile indicates HEVC (`hev1`/`hvc1`), post `unsupportedVideo` → PlayerOverlay shows "This channel uses HEVC, not supported in the car browser." (no black screen).
- Audio: if WASM+native both can't handle it, keep video, show a small "audio unavailable for this channel" chip.

**Verification (in-browser, real channels):**
- H.264 + AAC channel: picture + sound, `video` count 0.
- H.264 + AC-3 (or MP2) channel: picture + sound via WASM.
- (If available) an HEVC channel: "not supported" message, not a black screen.
- Channel switch: clean teardown (`stop()`, worker frames closed) and restart.
- `npx tsc --noEmit` clean; `npm run lint` clean.

**Commit** — `feat(player): replace hls.js with WebCodecs canvas player in PlayerOverlay`

---

## Task 8: Test runner + CI wire-up

The repo currently tests via `node proxy/hlsProxy.test.mjs`. Add the new unit tests to the same lightweight path (Node's built-in `node:test`, no framework — matches YAGNI and the existing style).

**Files:**
- Modify: `package.json` `scripts.test` → run `node --test` across `src/**/*.test.ts` via `tsx`/`ts-node`, plus the existing proxy test. If TS-in-node friction is high, compile the pure libs with `tsc` to a temp dir and `node --test` the JS. Keep it boring.

**Commit** — `test(player): wire pure-module tests into npm test`

---

## Out of scope (YAGNI unless asked)
- HEVC decode, subtitles, multi-audio-track selection, adaptive bitrate switching (pick one variant), VOD/movies (worker has an `isLive` seam but PlayerOverlay is live-only), DVR/seek.

## Risks / kill-switches
- **In-car block still triggers** (worst case): if Tesla throttles Workers too, the whole approach dies. Task 4's throttle check is the early warning on desktop; the real proof is the car. Mitigation surfaced, not coded around.
- **WASM audio too heavy for the car CPU**: if AC-3 WASM can't keep realtime on the car, fall back to "video + audio-unavailable chip" for those codecs (Task 7 already has that UI).
- **A/V drift in live mode**: audio is the reference clock; video drops to the live edge. If drift shows in-browser, tune the ±ms windows in Task 4/5.
