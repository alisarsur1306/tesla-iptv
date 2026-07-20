import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { liveStreamUrl, type XtreamCreds, type XtreamLiveStream } from '@/lib/xtream';
import { CanvasPlayer } from '@/player/playerClient';
import { AudioEngine } from '@/player/audioEngine';
import { ArrowLeft, TriangleAlert, Volume2, VolumeX, Volume1, Play, Pause, SkipBack, SkipForward, Loader2 } from 'lucide-react';

const MAX_NETWORK_RETRIES = 3;

interface PlayerOverlayProps {
  creds: XtreamCreds;
  channel: XtreamLiveStream;
  /** Channels in the order the user was browsing, for Next/Prev. */
  playlist?: XtreamLiveStream[];
  onSelect?: (channel: XtreamLiveStream) => void;
  onBack: () => void;
}

/** Volume step per press — 10 presses covers silent..full. */
const VOLUME_STEP = 0.1;

export default function PlayerOverlay({ creds, channel, playlist = [], onSelect, onBack }: PlayerOverlayProps) {
  // The canvas is created imperatively per effect run and appended here. A
  // transferred OffscreenCanvas can't be reused, so we never reuse the element
  // (survives React StrictMode double-mount and channel changes).
  const containerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading…');
  const [needsAudioTap, setNeedsAudioTap] = useState(false);
  const [audioUnsupported, setAudioUnsupported] = useState<string | null>(null);
  const [videoUnsupported, setVideoUnsupported] = useState(false);
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [firstFrame, setFirstFrame] = useState(false);
  const [volume, setVolume] = useState(1);
  const playerRef = useRef<CanvasPlayer | null>(null);
  const sourceRef = useRef<string>('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Without WebCodecs there is no fallback path any more (hls.js is gone), so
    // say so plainly instead of showing a black canvas forever.
    if (typeof VideoDecoder === 'undefined' || !('transferControlToOffscreen' in HTMLCanvasElement.prototype)) {
      setFatalError('This browser is too old for the player (needs WebCodecs).');
      return;
    }

    const source = liveStreamUrl(creds, channel.stream_id); // already same-origin /api/stream
    setFatalError(null);
    setStatus('Loading…');
    setAudioUnsupported(null);
    setVideoUnsupported(false);
    setBuffering(false);
    setFirstFrame(false);

    const canvas = document.createElement('canvas');
    canvas.className = 'h-full w-full object-contain';
    container.appendChild(canvas);

    let retries = 0;
    let destroyed = false;

    const audio = new AudioEngine({
      onAnchor: (mediaMs, epochMs) => player.setAudioAnchor(mediaMs, epochMs),
      onUnsupported: (codec) => setAudioUnsupported(codec),
    });
    audioRef.current = audio;

    const player = new CanvasPlayer(canvas, {
      onReady: () => setStatus('Ready'),
      onStats: () => {
        setStatus('Ready');
        setFirstFrame(true); // frames are being drawn — hide the preloader
        retries = 0; // frames are flowing again — a later blip starts a fresh budget
      },
      onAudio: (data, pts) => audio.push(data, pts),
      onAudioReset: () => audio.reset(),
      onUnsupportedVideo: () => setVideoUnsupported(true),
      onBuffering: (active) => setBuffering(active),
      onError: (msg) => {
        if (destroyed) return;
        // `retries` counts CONSECUTIVE failures (reset by onStats above), so a
        // long session isn't killed by three unrelated blips hours apart.
        if (retries < MAX_NETWORK_RETRIES) {
          retries += 1;
          setStatus(`Stream error — retrying (${retries}/${MAX_NETWORK_RETRIES})…`);
          audio.reset();
          player.play(source);
        } else {
          setFatalError(`Playback failed: ${msg}`);
        }
      },
    });

    // Sound needs a user gesture (autoplay policy); video does not, so it starts
    // immediately and we only prompt for audio.
    void audio.unlock().then((ok) => {
      if (!destroyed) setNeedsAudioTap(!ok);
    });

    playerRef.current = player;
    sourceRef.current = source;
    audio.setVolume(volume);
    setPaused(false);
    player.play(source);

    return () => {
      destroyed = true;
      player.destroy();
      audio.destroy();
      audioRef.current = null;
      playerRef.current = null;
      canvas.remove();
    };
  }, [creds, channel]);

  const index = playlist.findIndex((c) => c.stream_id === channel.stream_id);

  function step(delta: number) {
    if (!playlist.length || index < 0 || !onSelect) return;
    // Wrap around so Next never dead-ends at the last channel.
    const next = playlist[(index + delta + playlist.length) % playlist.length];
    if (next) onSelect(next);
  }

  /**
   * Live TV has nothing to resume into, so "pause" stops the stream and "play"
   * rejoins at the live edge — which is what a viewer expects from live.
   */
  function togglePause() {
    const player = playerRef.current;
    if (!player) return;
    if (paused) {
      audioRef.current?.reset();
      player.play(sourceRef.current);
      setStatus('Loading…');
      setPaused(false);
    } else {
      player.stop();
      audioRef.current?.reset();
      setPaused(true);
    }
  }

  function nudgeVolume(delta: number) {
    // Read the CURRENT value from the engine rather than React state: several
    // taps in one tick all see the same stale state, so three presses would
    // move the volume by one step instead of three.
    const engine = audioRef.current;
    const current = engine?.getVolume() ?? volume;
    const v = engine?.setVolume(current + delta) ?? Math.max(0, Math.min(1, current + delta));
    setVolume(v);
  }

  async function enableSound() {
    const ok = await audioRef.current?.unlock();
    if (ok) setNeedsAudioTap(false);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <div ref={containerRef} className="h-full w-full" />

      {/* Top bar */}
      <div className="pointer-events-none absolute left-0 right-0 top-0 flex items-center gap-4 bg-gradient-to-b from-black/80 to-transparent p-4">
        <Button
          onClick={onBack}
          className="pointer-events-auto h-14 min-w-14 bg-zinc-900/80 px-5 text-xl text-white hover:bg-zinc-800"
        >
          <ArrowLeft className="mr-2 h-7 w-7" /> Back
        </Button>
        <span dir="auto" className="truncate text-2xl font-semibold text-white drop-shadow">
          {channel.name}
        </span>
        {status && status !== 'Ready' && !fatalError && (
          <span className="ml-auto rounded-full bg-zinc-900/80 px-4 py-2 text-base text-zinc-300">
            {status}
          </span>
        )}
      </div>


      {/* Controls — large hit targets for a car touchscreen (min 64px) */}
      {!fatalError && !videoUnsupported && (
        <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-3 bg-gradient-to-t from-black/85 to-transparent p-4 sm:gap-5 sm:p-6">
          <Button
            onClick={() => step(-1)}
            disabled={playlist.length < 2}
            aria-label="Previous channel"
            className="h-16 w-16 rounded-full bg-zinc-900/85 text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            <SkipBack className="h-7 w-7" />
          </Button>

          <Button
            onClick={togglePause}
            aria-label={paused ? 'Play' : 'Pause'}
            className="h-20 w-20 rounded-full bg-red-600 text-white hover:bg-red-500"
          >
            {paused ? <Play className="ml-1 h-9 w-9 fill-white" /> : <Pause className="h-9 w-9 fill-white" />}
          </Button>

          <Button
            onClick={() => step(1)}
            disabled={playlist.length < 2}
            aria-label="Next channel"
            className="h-16 w-16 rounded-full bg-zinc-900/85 text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            <SkipForward className="h-7 w-7" />
          </Button>

          <div className="ml-2 flex items-center gap-2 rounded-full bg-zinc-900/85 px-3 py-2 sm:ml-6">
            <Button
              onClick={() => nudgeVolume(-VOLUME_STEP)}
              aria-label="Volume down"
              className="h-14 w-14 rounded-full bg-transparent text-white hover:bg-zinc-800"
            >
              <Volume1 className="h-6 w-6" />
            </Button>
            <span
              aria-live="polite"
              className="w-14 text-center text-lg font-semibold tabular-nums text-zinc-200"
            >
              {volume === 0 ? 'Mute' : `${Math.round(volume * 100)}%`}
            </span>
            <Button
              onClick={() => nudgeVolume(VOLUME_STEP)}
              aria-label="Volume up"
              className="h-14 w-14 rounded-full bg-transparent text-white hover:bg-zinc-800"
            >
              <Volume2 className="h-6 w-6" />
            </Button>
          </div>
        </div>
      )}

      {/* Initial preloader — until the first frame is drawn, so a black canvas
          never looks like a failure while the channel is starting up. */}
      {!firstFrame && !fatalError && !videoUnsupported && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-6">
          <Loader2 className="size-14 animate-spin text-red-500" />
          <span dir="auto" className="text-2xl font-medium text-zinc-200">
            Loading {channel.name}…
          </span>
        </div>
      )}

      {/* Rebuffering — the stream ran dry; we pause to rebuild a cushion */}
      {firstFrame && buffering && !fatalError && !videoUnsupported && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex items-center gap-4 rounded-2xl bg-black/70 px-8 py-5">
            <Loader2 className="size-9 animate-spin text-white" />
            <span className="text-2xl font-medium text-white">Buffering…</span>
          </span>
        </div>
      )}

      {/* Video codec we can't decode (HEVC) — better than a permanent black screen */}
      {videoUnsupported && !fatalError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/90 p-8">
          <TriangleAlert className="h-16 w-16 text-amber-500" />
          <p className="max-w-xl text-center text-2xl text-zinc-200">
            This channel isn’t H.264 (likely HEVC) and can’t be played in the car browser.
          </p>
          <Button onClick={onBack} className="h-16 min-w-64 bg-red-600 text-2xl font-bold hover:bg-red-500">
            <ArrowLeft className="mr-3 h-7 w-7" /> Back to channels
          </Button>
        </div>
      )}

      {/* Audio codec we can't decode yet (AC-3 / MPEG Layer II) */}
      {audioUnsupported && !fatalError && !videoUnsupported && (
        <div className="pointer-events-none absolute bottom-32 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-900/85 px-5 py-3 text-base text-zinc-300">
          <VolumeX className="h-5 w-5" /> Audio not supported on this channel ({audioUnsupported})
        </div>
      )}

      {/* Tap to enable sound (browser autoplay policy) */}
      {needsAudioTap && !fatalError && !audioUnsupported && (
        <button
          onClick={enableSound}
          className="absolute bottom-32 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full bg-red-600/90 px-7 py-4 text-xl font-semibold text-white shadow-2xl"
        >
          <Volume2 className="h-7 w-7" /> Tap for sound
        </button>
      )}

      {/* Fatal error */}
      {fatalError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-8 bg-black/90 p-8">
          <TriangleAlert className="h-20 w-20 text-red-500" />
          <p className="max-w-xl text-center text-2xl text-zinc-200">{fatalError}</p>
          <Button
            onClick={onBack}
            className="h-16 min-w-64 bg-red-600 text-2xl font-bold hover:bg-red-500"
          >
            <ArrowLeft className="mr-3 h-7 w-7" /> Back to channels
          </Button>
        </div>
      )}
    </div>
  );
}
