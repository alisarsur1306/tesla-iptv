import type { XtreamCreds } from './xtream';
const STORAGE_KEY = 'tesla-iptv:creds';
export function loadStoredCreds(): XtreamCreds | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as XtreamCreds | null;
    return parsed && typeof parsed.server === 'string' && typeof parsed.username === 'string' && typeof parsed.password === 'string' && parsed.server && parsed.username && parsed.password ? parsed : null;
  } catch { return null; }
}
export function storeCreds(creds: XtreamCreds): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(creds)); } catch { /* Login can continue for this session. */ }
}
export function clearStoredCreds(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* Clear the in-memory session regardless. */ }
}
