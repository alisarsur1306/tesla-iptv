import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Button } from '@/components/ui/button';
import { liveStreamUrl, proxied, type XtreamCreds, type XtreamLiveStream } from '@/lib/xtream';
import { ArrowLeft, Play, TriangleAlert } from 'lucide-react';

const MAX_NETWORK_RETRIES = 3;

interface PlayerOverlayProps {
  creds: XtreamCreds;
  channel: XtreamLiveStream;
  onBack: () => void;
}

export default function PlayerOverlay({ creds, channel, onBack }: PlayerOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const retriesRef = useRef(0);
  const [needsTap, setNeedsTap] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading…');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const source = proxied(liveStreamUrl(creds, channel.stream_id));
    retriesRef.current = 0;
    setFatalError(null);
    setNeedsTap(true);
    setStatus('Loading…');

    function tryPlay() {
      video!
        .play()
        .then(() => setNeedsTap(false))
        .catch(() => setNeedsTap(true)); // autoplay blocked → wait for tap
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        // Live-TV friendly settings for a car browser.
        maxBufferLength: 20,
        liveSyncDurationCount: 3,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 2,
      });
      hlsRef.current = hls;
      hls.loadSource(source);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStatus('Ready');
        tryPlay();
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retriesRef.current < MAX_NETWORK_RETRIES) {
          retriesRef.current += 1;
          setStatus(`Network error — retrying (${retriesRef.current}/${MAX_NETWORK_RETRIES})…`);
          hls.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && retriesRef.current < MAX_NETWORK_RETRIES) {
          retriesRef.current += 1;
          setStatus('Media error — recovering…');
          hls.recoverMediaError();
          return;
        }
        setFatalError(`Playback failed: ${data.details || 'unknown error'}`);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS fallback (Safari-style).
      video.src = source;
      video.addEventListener('loadedmetadata', tryPlay, { once: true });
      video.addEventListener(
        'error',
        () => setFatalError('Playback failed (native HLS error).'),
        { once: true },
      );
    } else {
      setFatalError('This browser cannot play HLS streams.');
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [creds, channel]);

  function handleTapToPlay() {
    videoRef.current
      ?.play()
      .then(() => setNeedsTap(false))
      .catch(() => setNeedsTap(true));
  }

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <video
        ref={videoRef}
        playsInline
        controls
        className="h-full w-full"
        onClick={needsTap ? handleTapToPlay : undefined}
      />

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

      {/* Giant tap-to-play (autoplay blocked) */}
      {needsTap && !fatalError && (
        <button
          onClick={handleTapToPlay}
          className="absolute inset-0 flex items-center justify-center"
          aria-label="Tap to play"
        >
          <span className="flex h-32 w-32 items-center justify-center rounded-full bg-red-600/90 shadow-2xl">
            <Play className="ml-2 h-16 w-16 fill-white text-white" />
          </span>
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
