import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { liveStreamUrl, proxied, type XtreamCreds, type XtreamLiveStream } from '@/lib/xtream';
import { CanvasPlayer } from '@/player/playerClient';
import { AudioEngine } from '@/player/audioEngine';
import { ArrowLeft, TriangleAlert, Volume2, VolumeX } from 'lucide-react';

const MAX_NETWORK_RETRIES = 3;

interface PlayerOverlayProps {
  creds: XtreamCreds;
  channel: XtreamLiveStream;
  onBack: () => void;
}

export default function PlayerOverlay({ creds, channel, onBack }: PlayerOverlayProps) {
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Without WebCodecs there is no fallback path any more (hls.js is gone), so
    // say so plainly instead of showing a black canvas forever.
    if (typeof VideoDecoder === 'undefined' || !('transferControlToOffscreen' in HTMLCanvasElement.prototype)) {
      setFatalError('This browser is too old for the player (needs WebCodecs).');
      return;
    }

    const source = proxied(liveStreamUrl(creds, channel.stream_id));
    setFatalError(null);
    setStatus('Loading…');
    setAudioUnsupported(null);
    setVideoUnsupported(false);

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
        retries = 0; // frames are flowing again — a later blip starts a fresh budget
      },
      onAudio: (data, pts) => audio.push(data, pts),
      onUnsupportedVideo: () => setVideoUnsupported(true),
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

    player.play(source);

    return () => {
      destroyed = true;
      player.destroy();
      audio.destroy();
      audioRef.current = null;
      canvas.remove();
    };
  }, [creds, channel]);

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
        <div className="pointer-events-none absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-900/85 px-5 py-3 text-base text-zinc-300">
          <VolumeX className="h-5 w-5" /> Audio not supported on this channel ({audioUnsupported})
        </div>
      )}

      {/* Tap to enable sound (browser autoplay policy) */}
      {needsAudioTap && !fatalError && !audioUnsupported && (
        <button
          onClick={enableSound}
          className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full bg-red-600/90 px-7 py-4 text-xl font-semibold text-white shadow-2xl"
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
