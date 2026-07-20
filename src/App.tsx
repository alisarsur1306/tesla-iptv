import { useCallback, useEffect, useState } from 'react';
import LoginScreen, { clearStoredCreds, loadStoredCreds } from '@/components/LoginScreen';
import ChannelBrowser from '@/components/ChannelBrowser';
import PlayerOverlay from '@/components/PlayerOverlay';
import KeyPrompt from '@/components/KeyPrompt';
import { initAccessKeyFromUrl, setAccessKey, type XtreamCreds, type XtreamLiveStream } from '@/lib/xtream';

type View = 'login' | 'browse' | 'play';

export default function App() {
  const [creds, setCreds] = useState<XtreamCreds | null>(() => loadStoredCreds());
  const [channel, setChannel] = useState<XtreamLiveStream | null>(null);
  // The list the user was browsing when they hit play, so Next/Prev in the
  // player follows the same order (and the same search/category filter).
  const [playlist, setPlaylist] = useState<XtreamLiveStream[]>([]);
  const [keyPromptOpen, setKeyPromptOpen] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  // Pick up ?key=... from the page URL once on load (persisted to localStorage).
  useEffect(() => {
    initAccessKeyFromUrl();
  }, []);

  const requestKey = useCallback(() => setKeyPromptOpen(true), []);

  function handleKeySave(key: string) {
    setAccessKey(key);
    setKeyPromptOpen(false);
    setRetryToken((t) => t + 1); // make screens retry their failed requests
  }

  const view: View = !creds ? 'login' : channel ? 'play' : 'browse';

  function handleLogout() {
    clearStoredCreds();
    setChannel(null);
    setCreds(null);
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      {view === 'login' || !creds ? (
        <LoginScreen onConnected={setCreds} onNeedKey={requestKey} retryToken={retryToken} />
      ) : (
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
