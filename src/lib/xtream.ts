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

function apiUrl(creds: XtreamCreds, action?: string): string {
  const base = normalizeServer(creds.server);
  let url = `${base}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
  if (action) url += `&action=${action}`;
  return url;
}

async function fetchJsonThroughProxy<T>(absoluteUrl: string): Promise<T> {
  const res = await fetch(proxied(absoluteUrl));
  if (res.status === 403) {
    throw new AccessKeyError();
  }
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** Validate credentials against player_api.php. Throws on bad auth. */
export async function login(creds: XtreamCreds): Promise<XtreamUserInfo> {
  const data = await fetchJsonThroughProxy<XtreamLoginResponse>(apiUrl(creds));
  const info = data?.user_info;
  if (!info || info.auth !== 1 || info.status !== 'Active') {
    throw new Error('Login failed — check server, username and password.');
  }
  return info;
}

export async function getLiveCategories(creds: XtreamCreds): Promise<XtreamCategory[]> {
  const data = await fetchJsonThroughProxy<XtreamCategory[]>(apiUrl(creds, 'get_live_categories'));
  return Array.isArray(data) ? data : [];
}

export async function getLiveStreams(creds: XtreamCreds): Promise<XtreamLiveStream[]> {
  const data = await fetchJsonThroughProxy<XtreamLiveStream[]>(apiUrl(creds, 'get_live_streams'));
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
export function liveStreamUrl(creds: XtreamCreds, streamId: number): string {
  const base = normalizeServer(creds.server);
  return `${base}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}.ts`;
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
