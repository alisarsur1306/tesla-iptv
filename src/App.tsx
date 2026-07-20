import { useCallback, useEffect, useState } from 'react';
import LoginScreen, { clearStoredCreds, loadStoredCreds } from '@/components/LoginScreen';
import ChannelBrowser from '@/components/ChannelBrowser';
import PlayerOverlay from '@/components/PlayerOverlay';
import KeyPrompt from '@/components/KeyPrompt';
import { configUrl, initAccessKeyFromUrl, setAccessKey, type XtreamCreds, type XtreamLiveStream } from '@/lib/xtream';
import { Loader2 } from 'lucide-react';

type View = 'checking' | 'login' | 'browse' | 'play';

// Managed mode: the IPTV account lives on the server, so the client never has
// (or needs) real credentials. This sentinel flows through the component tree
// exactly like a logged-in account would, but is never used to build any URL.
const MANAGED_CREDS: XtreamCreds = { server: 'managed', username: 'managed', password: 'managed' };

export default function App() {
  const [creds, setCreds] = useState<XtreamCreds | null>(() => loadStoredCreds());
  const [channel, setChannel] = useState<XtreamLiveStream | null>(null);
  // The list the user was browsing when they hit play, so Next/Prev in the
  // player follows the same order (and the same search/category filter).
  const [playlist, setPlaylist] = useState<XtreamLiveStream[]>([]);
  const [keyPromptOpen, setKeyPromptOpen] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  // Have we resolved whether the server is managed? Until then, show a spinner
  // rather than flashing the (usually unnecessary) login screen.
  const [managedChecked, setManagedChecked] = useState(false);

  // Pick up ?key=... from the page URL once on load (persisted to localStorage).
  useEffect(() => {
    initAccessKeyFromUrl();
  }, []);

  const requestKey = useCallback(() => setKeyPromptOpen(true), []);

  // Ask the server whether it holds the account. If it does, connect straight
  // through — no login screen. A 403 means we need the access key first.
  useEffect(() => {
    if (creds) {
      setManagedChecked(true);
      return;
    }
    let cancelled = false;
    fetch(configUrl())
      .then((r) => {
        if (r.status === 403) {
          requestKey();
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((cfg) => {
        if (cancelled) return;
        if (cfg && cfg.managed) setCreds(MANAGED_CREDS);
        setManagedChecked(true);
      })
      .catch(() => {
        if (!cancelled) setManagedChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [creds, retryToken, requestKey]);

  function handleKeySave(key: string) {
    setAccessKey(key);
    setKeyPromptOpen(false);
    setManagedChecked(false); // re-probe managed mode with the new key
    setRetryToken((t) => t + 1);
  }

  function handleLogout() {
    clearStoredCreds();
    setChannel(null);
    setCreds(null);
    setManagedChecked(false);
    setRetryToken((t) => t + 1);
  }

  const view: View = creds ? (channel ? 'play' : 'browse') : managedChecked ? 'login' : 'checking';

  return (
    <div className="min-h-dvh bg-zinc-950">
      {view === 'checking' && (
        <div className="flex h-dvh items-center justify-center">
          <Loader2 className="size-16 animate-spin text-red-500" />
        </div>
      )}

      {view === 'login' && (
        <LoginScreen onConnected={setCreds} onNeedKey={requestKey} retryToken={retryToken} />
      )}

      {(view === 'browse' || view === 'play') && creds && (
        <>
          <ChannelBrowser
            creds={creds}
            onPlay={(ch, list) => {
              setPlaylist(list);
              setChannel(ch);
            }}
            onLogout={handleLogout}
            onNeedKey={requestKey}
            retryToken={retryToken}
          />
          {view === 'play' && channel && (
            <PlayerOverlay
              creds={creds}
              channel={channel}
              playlist={playlist}
              onSelect={setChannel}
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
