import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { login, normalizeServer, configUrl, AccessKeyError, type XtreamCreds } from '@/lib/xtream';
import { Clapperboard, Loader2 } from 'lucide-react';

const STORAGE_KEY = 'tesla-iptv:creds';

export function loadStoredCreds(): XtreamCreds | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as XtreamCreds;
    if (parsed && parsed.server && parsed.username && parsed.password) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function storeCreds(creds: XtreamCreds): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

export function clearStoredCreds(): void {
  localStorage.removeItem(STORAGE_KEY);
}

interface LoginScreenProps {
  onConnected: (creds: XtreamCreds) => void;
  onNeedKey: () => void;
  retryToken: number;
}

export default function LoginScreen({ onConnected, onNeedKey, retryToken }: LoginScreenProps) {
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill: localStorage first, then /config.json (so nothing needs typing in the car).
  useEffect(() => {
    const stored = loadStoredCreds();
    if (stored) {
      setServer(stored.server);
      setUsername(stored.username);
      setPassword(stored.password);
      return;
    }
    fetch(configUrl())
      .then((r) => {
        if (r.status === 403) {
          onNeedKey();
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((cfg) => {
        if (cfg && cfg.server) {
          setServer(cfg.server);
          setUsername(cfg.username || '');
          setPassword(cfg.password || '');
        }
      })
      .catch(() => {
        /* config.json is optional */
      });
    // retryToken refires the prefill after the user enters an access key
  }, [retryToken, onNeedKey]);

  async function handleConnect() {
    if (!server || !username || !password) {
      setError('All three fields are required.');
      return;
    }
    setBusy(true);
    setError(null);
    const creds: XtreamCreds = { server: normalizeServer(server), username: username.trim(), password: password.trim() };
    try {
      await login(creds);
      storeCreds(creds);
      onConnected(creds);
    } catch (err) {
      if (err instanceof AccessKeyError) {
        setError('This deployment requires an access key.');
        onNeedKey();
      } else {
        setError(err instanceof Error ? err.message : 'Connection failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <Card className="w-full max-w-2xl border-zinc-800 bg-zinc-900 text-zinc-100">
        <CardHeader className="space-y-3">
          <div className="flex items-center gap-4">
            <Clapperboard className="h-12 w-12 text-red-500" />
            <CardTitle className="text-4xl font-bold">Tesla IPTV</CardTitle>
          </div>
          <CardDescription className="text-lg text-zinc-400">
            Connect your Xtream Codes account. Passenger use only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="server" className="text-lg">Server</Label>
            <Input
              id="server"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="http://example.com:8080"
              className="h-14 border-zinc-700 bg-zinc-800 text-lg"
              autoComplete="off"
              inputMode="url"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="username" className="text-lg">Username</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="h-14 border-zinc-700 bg-zinc-800 text-lg"
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-lg">Password</Label>
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
            <p className="rounded-lg bg-red-950/60 p-4 text-lg text-red-300">{error}</p>
          )}
          <Button
            onClick={handleConnect}
            disabled={busy}
            className="h-16 w-full bg-red-600 text-2xl font-bold hover:bg-red-500"
          >
            {busy ? <Loader2 className="mr-3 h-7 w-7 animate-spin" /> : null}
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
