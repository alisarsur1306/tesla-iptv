// Xtream Codes API helpers. EVERY upstream request goes through the
// same-origin /api/proxy endpoint — the IPTV server sends no CORS headers,
// so the browser can never talk to it directly.
//
// Access key: on public deployments the backend requires ?key=... on
// /api/proxy and /config.json. The key arrives once via the page URL
// (https://app/?key=...) and is persisted to localStorage.

const KEY_STORAGE = 'tesla-iptv:accessKey';
let cachedKey: string | null = null;

/** Thrown when the backend rejects a request with 403 (key missing/invalid). */
export class AccessKeyError extends Error {
  constructor(message = 'Access key required or invalid') {
    super(message);
    this.name = 'AccessKeyError';
  }
}

/** Read `key` from the page URL once, persist it, and strip it from the address bar. */
export function initAccessKeyFromUrl(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('key');
    if (fromUrl) {
      cachedKey = fromUrl;
      try { localStorage.setItem(KEY_STORAGE, fromUrl); } catch { /* Keep the in-memory key. */ }
      params.delete('key');
      const qs = params.toString();
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
      );
    } else {
      cachedKey = localStorage.getItem(KEY_STORAGE);
    }
  } catch {
    /* private mode etc. — fall back to in-memory key */
  }
}

export function getAccessKey(): string {
  if (cachedKey === null) {
    try {
      cachedKey = localStorage.getItem(KEY_STORAGE);
    } catch {
      cachedKey = null;
    }
  }
  return cachedKey || '';
}

export function setAccessKey(key: string): void {
  cachedKey = key || null;
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

/** Append the stored access key (if any) to a same-origin URL. */
export function withKey(url: string): string {
  const key = getAccessKey();
  if (!key) return url;
  return `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
}

/** URL for the app config endpoint/static file, with key attached. */
export function configUrl(): string {
  return withKey('./config.json');
}

export interface XtreamCreds {
  server: string;
  username: string;
  password: string;
}

export interface XtreamUserInfo {
  username: string;
  status: string;
  exp_date?: string;
  is_trial?: string;
  max_connections?: string;
}

export interface XtreamLoginResponse {
  user_info?: XtreamUserInfo & { auth?: number };
}

export interface XtreamCategory {
  category_id: string;
  category_name: string;
}

export interface XtreamLiveStream {
  stream_id: number;
  name: string;
  stream_icon: string;
  category_id: string;
  epg_channel_id?: string;
}

/** Strip trailing slashes so URL building is predictable. */
export function normalizeServer(server: string): string {
  return server.trim().replace(/\/+$/, '');
}

/** Wrap any absolute URL in the same-origin proxy endpoint (key attached). */
export function proxied(absoluteUrl: string): string {
  return withKey(`/api/proxy?u=${encodeURIComponent(absoluteUrl)}`);
}

// The IPTV account lives ONLY on the server. The client talks to opaque
// same-origin endpoints — /api/xt for metadata, /api/stream?id=N for playback —
// so credentials never reach the browser (DevTools / reverse engineering). The
// `creds` params below are vestigial (kept so the component tree is unchanged)
// and are NOT used to build any URL.

/** URL for a server-side player_api action (login = no action). */
function xtApiUrl(action?: string): string {
  return withKey(`/api/xt${action ? `?action=${action}` : ''}`);
}

// The backend allows itself up to LIST_TIMEOUT_MS (90s) for a channel list before it gives
// up and falls back to its stale cache or the M3U playlist. This budget has to sit ABOVE
// that, or we abandon a request the server was about to answer. It also has to exist at all:
// a bare `await fetch` never settles if the response stalls, and the caller's `loading` state
// then stays true forever — which is exactly the spinner that never stops.
const LIST_BUDGET_MS = 105_000;
const DEFAULT_BUDGET_MS = 30_000;

export class TimeoutError extends Error {
  readonly ms: number;

  constructor(ms: number) {
    super(
      `The server did not answer within ${Math.round(ms / 1000)}s. It may still be fetching a ` +
        `large channel list, or the IPTV source is unreachable. Check /api/diag for details.`,
    );
    this.name = 'TimeoutError';
    this.ms = ms;
  }
}

const LIST_ACTIONS = new Set(['get_live_streams', 'get_live_categories']);

class CatalogueChangedError extends Error {}

async function fetchXtJson<T>(action?: string, options: { params?: URLSearchParams; onHeaders?: (headers: Headers) => void; signal?: AbortSignal } = {}): Promise<T> {
  const budget = action && LIST_ACTIONS.has(action) ? LIST_BUDGET_MS : DEFAULT_BUDGET_MS;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    let res: Response;
    try {
      const url = xtApiUrl(action);
      res = await fetch(options.params ? `${url}${url.includes('?') ? '&' : '?'}${options.params}` : url, { signal: controller.signal });
    } catch (err) {
      throw new Error(
        `Could not reach the server${action ? ` for ${action}` : ''}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 403) throw new AccessKeyError();
    if (res.status === 409 && options.params) throw new CatalogueChangedError('Catalogue changed during loading');
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: string };
        if (body && typeof body.error === 'string') detail = ` — ${body.error}`;
      } catch {
        // Non-JSON error pages still report the status. A stalled body reports timeout.
        if (controller.signal.aborted) throw new TimeoutError(budget);
      }
      throw new Error(`Request failed (${res.status})${detail}`);
    }
    // fetch resolves at the headers; keep the deadline through body consumption too.
    options.onHeaders?.(res.headers);
    return (await res.json()) as T;
  } catch (err) {
    if (controller.signal.aborted) throw new TimeoutError(budget);
    throw err;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** Validate against the server-side account. Throws on bad auth. */
export async function login(_creds: XtreamCreds): Promise<XtreamUserInfo> {
  const data = await fetchXtJson<XtreamLoginResponse>();
  const info = data?.user_info;
  if (!info || info.auth !== 1 || info.status !== 'Active') {
    throw new Error('The server account is not active.');
  }
  return info;
}

export async function getLiveCategories(_creds: XtreamCreds): Promise<XtreamCategory[]> {
  const data = await fetchXtJson<XtreamCategory[]>('get_live_categories');
  return Array.isArray(data) ? data : [];
}

export async function getLiveStreams(_creds: XtreamCreds): Promise<XtreamLiveStream[]> {
  const data = await fetchXtJson<XtreamLiveStream[]>('get_live_streams');
  if (!Array.isArray(data) || !data.length) throw new Error('Channel list is empty; keeping the last saved list.');
  return data;
}

/**
 * Direct (pre-proxy) URL for a live stream. Pass through proxied() before use.
 *
 * `.ts` (one continuous MPEG-TS response), not `.m3u8`. HLS meant polling the
 * playlist and fetching segments one at a time, which delivered data in bursts
 * with multi-second gaps and left the decoder starved — the picture froze and
 * flickered. A single long-lived response streams continuously and even
 * front-loads a backlog, so the buffer fills immediately.
 */
export function liveStreamUrl(_creds: XtreamCreds, streamId: number): string {
  return withKey(`/api/stream?id=${streamId}`);
}

// ---------------------------------------------------------------------------
// Browser-side channel list cache.
//
// The backend caches lists in memory, which is exactly what a free Render instance throws away
// when it idles down after ~15 minutes. So every visit paid full price: a cold container
// pulling megabytes of JSON from the Xtream host through the Tailscale exit node, while the
// screen showed a spinner.
//
// Keeping the last list in the browser makes a repeat visit instant, and it survives the
// server being cold, asleep, or unreachable. The fresh list is fetched underneath and swapped
// in when it arrives.
const LIST_CACHE_KEY = 'tesla-iptv:channelCache';
const LIST_CACHE_VERSION = 2;
const MANAGED_CACHE_KEY = 'tesla-iptv:managedSession';

export function rememberManagedSession(managed: boolean): void {
  try { localStorage.setItem(MANAGED_CACHE_KEY, JSON.stringify({ managed, key: getAccessKey() })); } catch { /* Cache is optional. */ }
}

export async function getLiveCatalogue(_creds: XtreamCreds, options: {
  cached?: ChannelCache | null;
  onPage?: (streams: XtreamLiveStream[]) => void;
  signal?: AbortSignal;
} = {}): Promise<{ streams: XtreamLiveStream[]; revision?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const streams: XtreamLiveStream[] = [];
    let revision: string | undefined;
    let total: number | undefined;
    try {
      do {
        const params = new URLSearchParams({ offset: String(streams.length), limit: '200' });
        if (revision) params.set('revision', revision);
        else if (options.cached?.revision) params.set('if_revision', options.cached.revision);
        let headers = new Headers();
        const page = await fetchXtJson<XtreamLiveStream[]>('get_live_streams', { params, signal: options.signal, onHeaders: value => { headers = value; } });
        if (headers.get('x-catalogue-unchanged') === 'true' && options.cached?.revision === headers.get('x-catalogue-revision')) return { streams: options.cached.streams, revision: options.cached.revision };
        if (!Array.isArray(page) || !page.length) throw new Error('Incomplete or empty channel catalogue');
        const currentRevision = headers.get('x-catalogue-revision');
        if (!currentRevision) return { streams: page }; // Older servers return the full list.
        const currentTotal = Number(headers.get('x-catalogue-total'));
        if (!Number.isInteger(currentTotal) || currentTotal < 1 || currentTotal > 10000 || (revision && (currentRevision !== revision || total !== currentTotal))) throw new CatalogueChangedError('Catalogue changed during loading');
        revision = currentRevision;
        total = currentTotal;
        streams.push(...page);
        if (streams.length > total || new Set(streams.map(s => s.stream_id)).size !== streams.length) throw new Error('Invalid catalogue page');
        options.onPage?.([...streams]);
      } while (streams.length < (total || 0));
      return { streams, revision };
    } catch (error) {
      if (error instanceof CatalogueChangedError && attempt === 0) continue;
      throw error;
    }
  }
  throw new Error('Catalogue changed repeatedly; keeping the saved list');
}

export function hasCachedManagedSession(): boolean {
  try {
    const session = JSON.parse(localStorage.getItem(MANAGED_CACHE_KEY) || 'null');
    return session?.managed === true && session.key === getAccessKey() && readChannelCache() !== null;
  } catch { return false; }
}

export interface ChannelCache {
  categories: XtreamCategory[];
  streams: XtreamLiveStream[];
  at: number;
  revision?: string;
}

/** Only the fields the UI reads — a full Xtream row is several times larger, and localStorage
 *  gives us a handful of megabytes at most. */
function trim(streams: XtreamLiveStream[]): XtreamLiveStream[] {
  return streams.map((s) => ({
    stream_id: s.stream_id,
    name: s.name,
    stream_icon: s.stream_icon,
    category_id: s.category_id,
    epg_channel_id: s.epg_channel_id,
  }));
}

export function readChannelCache(): ChannelCache | null {
  try {
    const raw = localStorage.getItem(LIST_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChannelCache & { v?: number; key?: string };
    if (parsed.v !== LIST_CACHE_VERSION || parsed.key !== getAccessKey()) return null;
    if (!Array.isArray(parsed.categories) || !Array.isArray(parsed.streams)) return null;
    if (!parsed.streams.length) return null;
    if (parsed.streams.some(s => !s || !Number.isFinite(s.stream_id) || typeof s.name !== 'string' || typeof s.category_id !== 'string')) return null;
    if (parsed.categories.some(c => !c || typeof c.category_id !== 'string' || typeof c.category_name !== 'string')) return null;
    return { categories: parsed.categories, streams: parsed.streams, at: parsed.at || 0, ...(typeof parsed.revision === 'string' ? { revision: parsed.revision } : {}) };
  } catch {
    return null;
  }
}

export function writeChannelCache(categories: XtreamCategory[], streams: XtreamLiveStream[], revision?: string): void {
  if (!streams.length) return;
  try {
    const compact = trim(streams);
    const previous = readChannelCache();
    if (previous && previous.revision === revision && JSON.stringify(previous.categories) === JSON.stringify(categories) && JSON.stringify(previous.streams) === JSON.stringify(compact)) return;
    localStorage.setItem(
      LIST_CACHE_KEY,
      JSON.stringify({ v: LIST_CACHE_VERSION, key: getAccessKey(), categories, streams: compact, at: Date.now(), revision }),
    );
  } catch {
    // localStorage.setItem is atomic. On quota failure retain the previous list.
  }
}

/** Stream ids the provider has refused for this line. A 5,000-channel catalogue is not 5,000
 *  watchable channels — the provider authorises a subset and answers 403 for the rest — so the
 *  list is worth marking rather than rediscovering by trial. Never throws: this is a hint. */
export async function getUnavailableIds(): Promise<Set<number>> {
  try {
    const res = await fetch(withKey('/api/unavailable'));
    if (!res.ok) return new Set();
    const body = (await res.json()) as { ids?: number[] };
    return new Set(Array.isArray(body.ids) ? body.ids : []);
  } catch {
    return new Set();
  }
}

/** Proxied URL for a channel icon (safe for <img src>). Empty when no icon. */
export function proxiedIcon(icon: string | undefined): string | null {
  if (!icon) return null;
  try {
    const u = new URL(icon);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return proxied(icon);
  } catch {
    return null;
  }
}
