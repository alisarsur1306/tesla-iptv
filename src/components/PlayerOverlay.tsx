import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { liveStreamUrl, proxied, type XtreamCreds, type XtreamLiveStream } from '@/lib/xtream';
import { CanvasPlayer } from '@/player/playerClient';
import { ArrowLeft, TriangleAlert } from 'lucide-react';

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
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading…');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const source = proxied(liveStreamUrl(creds, channel.stream_id));
    setFatalError(null);
    setStatus('Loading…');

    const canvas = document.createElement('canvas');
    canvas.className = 'h-full w-full object-contain';
    container.appendChild(canvas);

    let retries = 0;
    let destroyed = false;

    const player = new CanvasPlayer(canvas, {
      onReady: () => setStatus('Ready'),
      onStats: () => setStatus('Ready'),
      onError: (msg) => {
        if (destroyed) return;
        if (retries < MAX_NETWORK_RETRIES) {
          retries += 1;
          setStatus(`Stream error — retrying (${retries}/${MAX_NETWORK_RETRIES})…`);
          player.play(source);
        } else {
          setFatalError(`Playback failed: ${msg}`);
        }
      },
    });

    player.play(source);

    return () => {
      destroyed = true;
      player.destroy();
      canvas.remove();
    };
  }, [creds, channel]);

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
