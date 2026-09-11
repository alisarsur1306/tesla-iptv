import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { login, normalizeServer, configUrl, AccessKeyError, type XtreamCreds } from '@/lib/xtream';
import { loadStoredCreds, storeCreds } from '@/lib/credentials';
import { requestJson, HttpError } from '@/lib/request';
import { useLocale } from '@/lib/locale';
import { appStrings } from '@/lib/appStrings';
import LanguageSelect from '@/components/LanguageSelect';
import { Clapperboard, Loader2 } from 'lucide-react';

interface LoginScreenProps {
  onConnected: (creds: XtreamCreds) => void;
  onNeedKey: () => void;
  retryToken: number;
}

export default function LoginScreen({ onConnected, onNeedKey, retryToken }: LoginScreenProps) {
  const { locale } = useLocale();
  const copy = appStrings[locale];
  const [stored] = useState(loadStoredCreds);
  const [server, setServer] = useState(stored?.server ?? '');
  const [username, setUsername] = useState(stored?.username ?? '');
  const [password, setPassword] = useState(stored?.password ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'required' | 'needsKey' | 'failed' | null>(null);
  const activeLogin = useRef<symbol | null>(null);
  useEffect(() => () => { activeLogin.current = null; }, [retryToken]);

  // Prefill: localStorage first, then /config.json (so nothing needs typing in the car).
  useEffect(() => {
    if (stored) return;
    const controller = new AbortController();
    requestJson<Partial<XtreamCreds>>(configUrl(), { signal: controller.signal })
      .then((cfg) => {
        if (!controller.signal.aborted && cfg && cfg.server) {
          setServer(cfg.server);
          setUsername(cfg.username || '');
          setPassword(cfg.password || '');
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted && err instanceof HttpError && err.status === 403) onNeedKey();
      });
    return () => controller.abort();
    // retryToken refires the prefill after the user enters an access key
  }, [retryToken, onNeedKey, stored]);

  async function handleConnect() {
    if (!server || !username || !password) {
      setError('required');
      return;
    }
    setBusy(true);
    setError(null);
    const attempt = Symbol('login');
    activeLogin.current = attempt;
    const creds: XtreamCreds = { server: normalizeServer(server), username: username.trim(), password: password.trim() };
    try {
      await login(creds);
      if (activeLogin.current !== attempt) return;
      storeCreds(creds);
      onConnected(creds);
    } catch (err) {
      if (activeLogin.current !== attempt) return;
      if (err instanceof AccessKeyError) {
        setError('needsKey');
        onNeedKey();
      } else {
        setError('failed');
      }
    } finally {
      if (activeLogin.current === attempt) {
        activeLogin.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <Card className="w-full max-w-2xl border-zinc-800 bg-zinc-900 text-zinc-100">
        <CardHeader className="space-y-3">
          <div className="flex items-center gap-4">
            <Clapperboard className="h-12 w-12 text-red-500" />
            <CardTitle className="text-4xl font-bold">Tesla IPTV</CardTitle>
            <LanguageSelect />
          </div>
          <CardDescription className="text-lg text-zinc-400">
            {copy.title}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="server" className="text-lg">{copy.server}</Label>
            <Input
              id="server"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="http://example.com:8080"
              className="h-14 border-zinc-700 bg-zinc-800 text-lg"
              autoComplete="off"
              inputMode="url"
              dir="ltr"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="username" className="text-lg">{copy.username}</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="h-14 border-zinc-700 bg-zinc-800 text-lg"
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-lg">{copy.password}</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-14 border-zinc-700 bg-zinc-800 text-lg"
              autoComplete="off"
            />
          </div>
          {error && (
            <p className="rounded-lg bg-red-950/60 p-4 text-lg text-red-300">{copy[error]}</p>
          )}
          <Button
            onClick={handleConnect}
            disabled={busy}
            className="h-16 w-full bg-red-600 text-2xl font-bold hover:bg-red-500"
          >
            {busy ? <Loader2 className="mr-3 h-7 w-7 animate-spin" /> : null}
            {busy ? copy.connecting : copy.connect}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
