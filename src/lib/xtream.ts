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
      localStorage.setItem(KEY_STORAGE, fromUrl);
      params.delete('key');
      const qs = params.toString();
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
      );
    }
    cachedKey = localStorage.getItem(KEY_STORAGE);
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

async function fetchXtJson<T>(action?: string): Promise<T> {
  const budget = action && LIST_ACTIONS.has(action) ? LIST_BUDGET_MS : DEFAULT_BUDGET_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  let res: Response;
  try {
    res = await fetch(xtApiUrl(action), { signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new TimeoutError(budget);
    throw new Error(
      `Could not reach the server${action ? ` for ${action}` : ''}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 403) {
    throw new AccessKeyError();
  }
  if (!res.ok) {
    // The backend sends {error: "..."} on failure; surfacing it beats a bare status code,
    // since it already says whether the source was unreachable, slow, or misconfigured.
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === 'string') detail = ` — ${body.error}`;
    } catch {
      /* not JSON; the status alone will have to do */
    }
    throw new Error(`Request failed (${res.status})${detail}`);
  }
  return (await res.json()) as T;
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
  return Array.isArray(data) ? data : [];
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
const LIST_CACHE_VERSION = 1;

export interface ChannelCache {
  categories: XtreamCategory[];
  streams: XtreamLiveStream[];
  at: number;
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
    const parsed = JSON.parse(raw) as ChannelCache & { v?: number };
    if (parsed.v !== LIST_CACHE_VERSION) return null;
    if (!Array.isArray(parsed.categories) || !Array.isArray(parsed.streams)) return null;
    if (!parsed.streams.length) return null;
    return { categories: parsed.categories, streams: parsed.streams, at: parsed.at || 0 };
  } catch {
    return null;
  }
}

export function writeChannelCache(categories: XtreamCategory[], streams: XtreamLiveStream[]): void {
  try {
    localStorage.setItem(
      LIST_CACHE_KEY,
      JSON.stringify({ v: LIST_CACHE_VERSION, categories, streams: trim(streams), at: Date.now() }),
    );
  } catch {
    // Over quota, or private mode. A missing cache only costs speed, so drop any half-written
    // entry and carry on rather than failing the load.
    try {
      localStorage.removeItem(LIST_CACHE_KEY);
    } catch {
      /* nothing more to do */
    }
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
