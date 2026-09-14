import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { liveStreamUrl, type XtreamCreds, type XtreamLiveStream } from '@/lib/xtream';
import { useLocale } from '@/lib/locale';
import { CanvasPlayer } from '@/player/playerClient';
import { AudioEngine } from '@/player/audioEngine';
import { PlaybackRecovery, type RecoveryState } from '@/player/recovery';
import { playerStrings } from '@/player/playerStrings';
import { readVolume, saveVolume } from '@/player/preferences';
import { frameDeadlineExpired, FRAME_IDLE_TIMEOUT_MS } from '@/player/timing';
import { ArrowLeft, TriangleAlert, Volume2, VolumeX, Volume1, Play, Pause, SkipBack, SkipForward, Loader2, RotateCw } from 'lucide-react';

interface PlayerOverlayProps {
  creds: XtreamCreds;
  channel: XtreamLiveStream;
  playlist?: XtreamLiveStream[];
  onSelect?: (channel: XtreamLiveStream) => void;
  onBack: () => void;
}

/** Each channel gets fresh UI state and a separately owned worker session. */
export default function PlayerOverlay(props: PlayerOverlayProps) {
  return <PlayerSession key={props.channel.stream_id} {...props} />;
}

function PlayerSession({ creds, channel, playlist = [], onSelect, onBack }: PlayerOverlayProps) {
  const { locale } = useLocale();
  const t = playerStrings[locale];
  const containerRef = useRef<HTMLDivElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  const [playback, setPlayback] = useState<RecoveryState>({ phase: 'starting', attempt: 0 });
  const [unsupportedBrowser] = useState(() => typeof VideoDecoder === 'undefined' || !('transferControlToOffscreen' in HTMLCanvasElement.prototype));
  const [needsAudioTap, setNeedsAudioTap] = useState(false);
  const [audioUnsupported, setAudioUnsupported] = useState<string | null>(null);
  const [videoUnsupported, setVideoUnsupported] = useState(false);
  const [videoStalled, setVideoStalled] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [firstFrame, setFirstFrame] = useState(false);
  const [volume, setVolume] = useState(readVolume);
  const volumeRef = useRef(volume);
  const [controlsRequested, setControlsRequested] = useState(true);
  const [activity, setActivity] = useState(0);
  const [controlFocused, setControlFocused] = useState(false);
  const [offline, setOffline] = useState(() => !navigator.onLine);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || unsupportedBrowser) return;
    const source = liveStreamUrl(creds, channel.stream_id);
    const canvas = document.createElement('canvas');
    canvas.className = 'h-full w-full object-contain';
    container.appendChild(canvas);
    let destroyed = false;
    let startedAt = Date.now();
    let lastFrameAt: number | null = null;
    const audio = new AudioEngine({
      onAnchor: (mediaMs, epochMs) => player.setAudioAnchor(mediaMs, epochMs),
      onUnsupported: (codec) => { if (!destroyed) setAudioUnsupported(codec); },
    });
    const recovery = new PlaybackRecovery({
      restart: () => {
        startedAt = Date.now();
        lastFrameAt = null;
        setControlsRequested(true);
        setFirstFrame(false);
        setVideoStalled(false);
        setVideoUnsupported(false);
        setBuffering(false);
        setAudioUnsupported(null);
        audio.reset();
        player.play(source);
      },
      stop: () => { player.stop(); audio.reset(); },
      changed: (state) => { if (!destroyed) setPlayback(state); },
    });
    const player = new CanvasPlayer(canvas, {
      onStats: (stats) => {
        if (destroyed || stats.frames < 1) return;
        lastFrameAt = Date.now();
        setFirstFrame(true);
        setVideoStalled(false);
        recovery.progress();
      },
      onAudio: (data, pts) => audio.push(data, pts),
      onAudioReset: () => audio.reset(),
      onUnsupportedVideo: () => { recovery.pause(); setVideoUnsupported(true); },
      onVideoStalled: () => { recovery.pause(); setVideoStalled(true); },
      onBuffering: (active) => {
        setBuffering(active);
        recovery.setStalled(active);
        if (active) setControlsRequested(true);
      },
      onError: (msg, fatal) => recovery.error(msg, fatal),
    });
    audioRef.current = audio;
    recoveryRef.current = recovery;
    audio.setVolume(volumeRef.current);
    void audio.unlock().then((ok) => { if (!destroyed) setNeedsAudioTap(!ok); }).catch(() => { if (!destroyed) setNeedsAudioTap(true); });

    const recoverConnection = () => {
      if (!navigator.onLine) return;
      // Returning to a healthy stream must not create another provider session.
      if (lastFrameAt !== null && Date.now() - lastFrameAt >= FRAME_IDLE_TIMEOUT_MS) recovery.setStalled(true);
      recovery.recover();
    };
    const online = () => { setOffline(false); recoverConnection(); };
    const offline = () => { setOffline(true); setControlsRequested(true); recovery.error('OFFLINE'); };
    const visibility = () => { if (document.visibilityState === 'visible') recoverConnection(); };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visibility);
    // Imperative player setup reports its initial status through the controller.
    recovery.play();
    // Covers a decoder that accepted data but stops producing frames later on.
    const watchdog = window.setInterval(() => {
      if (document.visibilityState === 'visible' && frameDeadlineExpired(startedAt, lastFrameAt, Date.now())) recovery.error('STREAM_TIMEOUT');
    }, 5000);

    return () => {
      destroyed = true;
      window.clearInterval(watchdog);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visibility);
      recovery.destroy();
      player.destroy();
      audio.destroy();
      audioRef.current = null;
      recoveryRef.current = null;
      canvas.remove();
    };
  }, [creds, channel.stream_id, unsupportedBrowser]);

  const paused = playback.phase === 'paused';
  const fatal = playback.phase === 'failed' || unsupportedBrowser;
  const canHide = firstFrame && playback.phase === 'playing' && !buffering && !videoStalled && !videoUnsupported && !needsAudioTap && !controlFocused && !offline;
  const controlsVisible = !canHide || controlsRequested;
  useEffect(() => {
    if (!canHide) return;
    const timer = window.setTimeout(() => setControlsRequested(false), 4000);
    return () => window.clearTimeout(timer);
  }, [canHide, activity]);

  function showControls() {
    setControlsRequested(true);
    setActivity((value) => value + 1);
  }

  const index = playlist.findIndex((c) => c.stream_id === channel.stream_id);
  function step(delta: number) {
    if (!playlist.length || index < 0 || !onSelect) return;
    const next = playlist[(index + delta + playlist.length) % playlist.length];
    if (next) { recoveryRef.current?.pause(); onSelect(next); }
  }

  function back() {
    recoveryRef.current?.pause();
    onBack();
  }

  function retry() {
    showControls();
    recoveryRef.current?.play();
    void enableSound();
  }

  function togglePause() {
    if (paused) retry();
    else recoveryRef.current?.pause();
  }

  function nudgeVolume(delta: number) {
    const engine = audioRef.current;
    const current = engine?.getVolume() ?? volumeRef.current;
    const value = engine?.setVolume(current + delta) ?? Math.max(0, Math.min(1, current + delta));
    volumeRef.current = value;
    setVolume(value);
    saveVolume(value);
  }

  async function enableSound() {
    const audio = audioRef.current;
    try {
      const ok = await audio?.unlock();
      if (ok && audio === audioRef.current) setNeedsAudioTap(false);
    } catch {
      if (audio === audioRef.current) setNeedsAudioTap(true);
    }
  }

  const error = unsupportedBrowser ? t.unsupportedBrowser
    : offline ? t.offline
    : playback.error === 'STREAM_TIMEOUT' ? t.timeout
    : playback.error === 'STREAM_REJECTED' ? t.forbidden
    : playback.error === 'STREAM_NOT_CONFIGURED' ? t.notConfigured
    : playback.error === 'STREAM_INVALID_RESPONSE' ? t.invalidResponse
    : playback.error === 'STREAM_UNAVAILABLE' ? t.unavailable
    : playback.error === 'STREAM_PROXY_UNAVAILABLE' || playback.error === 'STREAM_ABORTED' ? t.connection
    : /HTTP_40[13]/.test(playback.error ?? '') ? t.forbidden
    : /HTTP_404|HTTP_410/.test(playback.error ?? '') ? t.unavailable
    : /HTTP_50[234]|fetch/i.test(playback.error ?? '') ? t.connection : t.failed;
  const status = offline ? t.offline : paused ? t.paused
    : playback.phase === 'retrying' ? `${t.retrying} (${playback.attempt}/3)…`
    : playback.phase === 'starting' ? `${t.loading}…` : '';
  const visibleStyle = { visibility: controlsVisible ? 'visible' as const : 'hidden' as const };

  return (
    <div
      className="fixed inset-0 z-50 bg-black"
      dir={locale === 'en' ? 'ltr' : 'rtl'}
      onPointerDownCapture={() => { setControlFocused(false); if (controlsVisible) showControls(); }}
      onPointerMove={(event) => { if (event.pointerType === 'mouse') showControls(); }}
      onFocusCapture={(event) => {
        const keyboardFocus = event.target.matches(':focus-visible');
        setControlFocused(keyboardFocus);
        if (keyboardFocus) showControls();
      }}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setControlFocused(false); showControls(); } }}
      onKeyDown={(event) => { if (event.key === 'Escape') back(); else showControls(); }}
    >
      <div ref={containerRef} className="h-full w-full" />
      {!controlsVisible && (
        <button
          className="absolute inset-0 z-20 cursor-default"
          aria-label={t.showControls}
          onClick={showControls}
          onFocus={(event) => {
            if (event.currentTarget.matches(':focus-visible')) requestAnimationFrame(() => backButtonRef.current?.focus());
          }}
        />
      )}
      <div style={visibleStyle} className="pointer-events-none absolute left-0 right-0 top-0 z-10 flex items-center gap-4 bg-gradient-to-b from-black/80 to-transparent p-4">
        <Button ref={backButtonRef} onClick={back} className="pointer-events-auto h-14 min-w-14 bg-zinc-900/80 px-5 text-xl text-white hover:bg-zinc-800">
          <ArrowLeft className="h-7 w-7 rtl:rotate-180" /> {t.back}
        </Button>
        <span dir="auto" className="truncate text-2xl font-semibold text-white drop-shadow">{channel.name}</span>
        {status && !fatal && <span role="status" className="ms-auto max-w-[45%] rounded-full bg-zinc-900/80 px-4 py-2 text-base text-zinc-300">{status}</span>}
      </div>
      {!fatal && !videoUnsupported && !videoStalled && (
        <div style={visibleStyle} dir="ltr" className="absolute bottom-0 left-0 right-0 z-10 flex flex-wrap items-center justify-center gap-3 bg-gradient-to-t from-black/85 to-transparent p-4 sm:gap-5 sm:p-6">
          <Button onClick={() => step(-1)} disabled={playlist.length < 2 || !onSelect} aria-label={t.previous} className="h-16 w-16 rounded-full bg-zinc-900/85 text-white hover:bg-zinc-800 disabled:opacity-40"><SkipBack className="h-7 w-7" /></Button>
          <Button onClick={togglePause} aria-label={paused ? t.play : t.pause} className="h-20 w-20 rounded-full bg-red-600 text-white hover:bg-red-500">
            {paused ? <Play className="ml-1 h-9 w-9 fill-white" /> : <Pause className="h-9 w-9 fill-white" />}
          </Button>
          <Button onClick={() => step(1)} disabled={playlist.length < 2 || !onSelect} aria-label={t.next} className="h-16 w-16 rounded-full bg-zinc-900/85 text-white hover:bg-zinc-800 disabled:opacity-40"><SkipForward className="h-7 w-7" /></Button>
          <div className="ml-2 flex items-center gap-2 rounded-full bg-zinc-900/85 px-3 py-2 sm:ml-6">
            <Button onClick={() => nudgeVolume(-0.1)} aria-label={t.volumeDown} className="h-14 w-14 rounded-full bg-transparent text-white hover:bg-zinc-800"><Volume1 className="h-6 w-6" /></Button>
            <span aria-live="polite" className="min-w-14 text-center text-lg font-semibold tabular-nums text-zinc-200">{volume === 0 ? t.mute : `${Math.round(volume * 100)}%`}</span>
            <Button onClick={() => nudgeVolume(0.1)} aria-label={t.volumeUp} className="h-14 w-14 rounded-full bg-transparent text-white hover:bg-zinc-800"><Volume2 className="h-6 w-6" /></Button>
          </div>
        </div>
      )}
      {!firstFrame && !fatal && !videoUnsupported && !videoStalled && !paused && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-6">
          <Loader2 className="size-14 animate-spin text-red-500" />
          <span dir="auto" className="text-center text-2xl font-medium text-zinc-200">{t.loading} {channel.name}…</span>
        </div>
      )}
      {firstFrame && buffering && !fatal && !paused && !videoUnsupported && !videoStalled && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex items-center gap-4 rounded-2xl bg-black/70 px-8 py-5"><Loader2 className="size-9 animate-spin text-white" /><span className="text-2xl font-medium text-white">{t.buffering}</span></span>
        </div>
      )}
      {(videoStalled || videoUnsupported || fatal) && (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-6 overflow-auto bg-black/90 p-8 pt-24">
          <TriangleAlert className="h-16 w-16 shrink-0 text-red-500" />
          <p className="max-w-2xl text-pretty text-center text-2xl text-zinc-200">{fatal ? error : videoUnsupported ? t.videoUnsupported : t.videoStalled}</p>
          <div className="flex flex-wrap justify-center gap-4">
            {!unsupportedBrowser && <Button onClick={retry} className="h-16 min-w-52 bg-red-600 text-xl font-bold hover:bg-red-500"><RotateCw className="h-7 w-7" />{t.retry}</Button>}
            <Button onClick={back} className="h-16 min-w-52 bg-zinc-800 text-xl font-bold hover:bg-zinc-700"><ArrowLeft className="h-7 w-7 rtl:rotate-180" />{t.backToChannels}</Button>
          </div>
        </div>
      )}
      {audioUnsupported && !fatal && !videoUnsupported && !videoStalled && (
        <div className="pointer-events-none absolute bottom-32 left-1/2 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-2xl bg-zinc-900/85 px-5 py-3 text-base text-zinc-300"><VolumeX className="h-5 w-5 shrink-0" />{t.audioUnsupported} ({audioUnsupported})</div>
      )}
      {needsAudioTap && !fatal && !audioUnsupported && !videoUnsupported && !videoStalled && (
        <button onClick={enableSound} className="absolute bottom-32 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full bg-red-600/90 px-7 py-4 text-xl font-semibold text-white shadow-2xl"><Volume2 className="h-7 w-7" />{t.sound}</button>
      )}
    </div>
  );
}
