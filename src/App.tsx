import { useCallback, useEffect, useState } from 'react';
import LoginScreen from '@/components/LoginScreen';
import { clearStoredCreds, loadStoredCreds } from '@/lib/credentials';
import ChannelBrowser from '@/components/ChannelBrowser';
import PlayerOverlay from '@/components/PlayerOverlay';
import KeyPrompt from '@/components/KeyPrompt';
import { configUrl, setAccessKey, hasCachedManagedSession, rememberManagedSession, type XtreamCreds, type XtreamLiveStream } from '@/lib/xtream';
import { Loader2 } from 'lucide-react';
import { requestJson, HttpError, RequestTimeout } from '@/lib/request';
import { readRecentChannels, rememberChannel } from '@/lib/watchHistory';
import { useLocale } from '@/lib/locale';
import { appStrings } from '@/lib/appStrings';
import LanguageSelect from '@/components/LanguageSelect';
import { Button } from '@/components/ui/button';

type View = 'checking' | 'login' | 'browse' | 'play';

// Managed mode: the IPTV account lives on the server, so the client never has
// (or needs) real credentials. This sentinel flows through the component tree
// exactly like a logged-in account would, but is never used to build any URL.
const MANAGED_CREDS: XtreamCreds = { server: 'managed', username: 'managed', password: 'managed' };

export default function App() {
  const { locale } = useLocale();
  const copy = appStrings[locale];
  const [creds, setCreds] = useState<XtreamCreds | null>(() => loadStoredCreds() || (hasCachedManagedSession() ? MANAGED_CREDS : null));
  const [channel, setChannel] = useState<XtreamLiveStream | null>(null);
  // The list the user was browsing when they hit play, so Next/Prev in the
  // player follows the same order (and the same search/category filter).
  const [playlist, setPlaylist] = useState<XtreamLiveStream[]>([]);
  const [keyPromptOpen, setKeyPromptOpen] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [recentIds, setRecentIds] = useState(readRecentChannels);
  const [startupError, setStartupError] = useState<'timeout' | 'failed' | 'needsKey' | null>(null);
  // Have we resolved whether the server is managed? Until then, show a spinner
  // rather than flashing the (usually unnecessary) login screen.
  const [managedChecked, setManagedChecked] = useState(false);

  const requestKey = useCallback(() => setKeyPromptOpen(true), []);

  // Ask the server whether it holds the account. If it does, connect straight
  // through — no login screen. A 403 means we need the access key first.
  useEffect(() => {
    if (creds) return;
    const controller = new AbortController();
    requestJson<{ managed: boolean }>(configUrl(), { timeoutMs: 30_000, signal: controller.signal })
      .then((cfg) => {
        if (controller.signal.aborted) return;
        if (typeof cfg?.managed !== 'boolean') throw new Error('Invalid server configuration response');
        rememberManagedSession(cfg.managed);
        if (cfg.managed) setCreds(MANAGED_CREDS);
        setManagedChecked(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof HttpError && error.status === 403) {
          setStartupError('needsKey');
          requestKey();
        } else {
          setStartupError(error instanceof RequestTimeout ? 'timeout' : 'failed');
        }
      });
    return () => controller.abort();
  }, [creds, retryToken, requestKey]);

  function retryStartup() {
    setStartupError(null);
    setManagedChecked(false);
    setRetryToken(t => t + 1);
  }

  function selectChannel(next: XtreamLiveStream) {
    const ids = rememberChannel(recentIds, next.stream_id);
    setRecentIds(ids);
    setChannel(next);
  }

  function handleKeySave(key: string) {
    setAccessKey(key);
    setKeyPromptOpen(false);
    retryStartup();
  }

  function handleLogout() {
    rememberManagedSession(false);
    clearStoredCreds();
    setChannel(null);
    setCreds(null);
    retryStartup();
  }

  const view: View = creds ? (channel ? 'play' : 'browse') : managedChecked ? 'login' : 'checking';

  return (
    <div className="min-h-dvh bg-zinc-950">
      {view === 'checking' && (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center text-zinc-100">
          <LanguageSelect />
          {startupError ? <>
            <p role="alert" className="max-w-xl text-2xl">{copy[startupError]}</p>
            <Button onClick={retryStartup} className="h-14 min-w-48 bg-red-600 text-xl hover:bg-red-500">{copy.retry}</Button>
          </> : <>
            <Loader2 className="size-16 animate-spin text-red-500" />
            <p role="status" className="text-2xl">{copy.checking}</p>
            <p className="max-w-xl text-lg text-zinc-400">{copy.waiting}</p>
          </>}
        </div>
      )}

      {view === 'login' && (
        <LoginScreen key={retryToken} onConnected={setCreds} onNeedKey={requestKey} retryToken={retryToken} />
      )}

      {(view === 'browse' || view === 'play') && creds && (
        <>
          <ChannelBrowser
            creds={creds}
            onPlay={(ch, list) => {
              setPlaylist(list);
              selectChannel(ch);
            }}
            onLogout={handleLogout}
            onNeedKey={requestKey}
            retryToken={retryToken}
            recentIds={recentIds}
          />
          {view === 'play' && channel && (
            <PlayerOverlay
              creds={creds}
              channel={channel}
              playlist={playlist}
              onSelect={selectChannel}
              onBack={() => setChannel(null)}
            />
          )}
        </>
      )}

      {keyPromptOpen && (
        <KeyPrompt onSave={handleKeySave} onCancel={() => setKeyPromptOpen(false)} />
      )}
    </div>
  );
}
