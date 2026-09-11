import { useEffect, useRef, useState } from 'react';
import { Radio, Loader2 } from 'lucide-react';
import { useLocale } from '@/lib/locale';
import { appStrings } from '@/lib/appStrings';
import { requestJson, HttpError, RequestTimeout } from '@/lib/request';
import { withKey } from '@/lib/xtream';

type HealthStatus = keyof typeof appStrings.en.health;
export default function ConnectionStatus({ onNeedKey }: { onNeedKey: () => void }) {
  const { locale } = useLocale();
  const copy = appStrings[locale];
  const [status, setStatus] = useState<HealthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function check() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setStatus(null);
    try {
      const result = await requestJson<{ status: HealthStatus }>(withKey('/api/health'), { timeoutMs: 15_000, signal: controller.signal });
      if (!controller.signal.aborted) setStatus(Object.hasOwn(copy.health, result.status) ? result.status : 'unknown');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof HttpError && error.status === 403) onNeedKey();
      else setStatus(error instanceof RequestTimeout ? 'timeout' : 'unknown');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      active.current = null;
    }
  }
  return <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 px-4 py-1.5 text-zinc-300">
    <button onClick={() => void check()} disabled={busy} className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-base hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400 disabled:opacity-70">
      {busy ? <Loader2 className="size-5 animate-spin" /> : <Radio className="size-5" />}
      {busy ? copy.checkingConnection : copy.check}
    </button>
    {status && <div role="status" className="min-w-0 flex-1 basis-64 py-1">
      <p className={status === 'ok' ? 'text-emerald-400' : 'text-amber-300'}>{copy.health[status]}</p>
      {status === 'ok' && <p className="text-sm text-zinc-400">{copy.healthNote}</p>}
    </div>}
  </div>;
}
