export const BROWSER_VIEW_KEY = 'tesla-iptv:browser-view';
export const PAGE_SIZE = 120;
export const FAVORITES_ID = '__favorites__';
export const ALL_ID = '__all__';
export const RECENT_ID = '__recent__';

export interface BrowserView {
  category: string;
  search: string;
  visibleCount: number;
  scrollTop: number;
}

type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function normalizeBrowserView(value: unknown, defaultCategory = ALL_ID): BrowserView {
  const stored = value && typeof value === 'object' ? value as Partial<BrowserView> : {};
  return {
    category: typeof stored.category === 'string' && stored.category.length > 0 && stored.category.length <= 256
      ? stored.category : defaultCategory,
    search: typeof stored.search === 'string' ? stored.search.slice(0, 128) : '',
    visibleCount: typeof stored.visibleCount === 'number' && Number.isFinite(stored.visibleCount)
      ? Math.min(12_000, Math.max(PAGE_SIZE, Math.floor(stored.visibleCount))) : PAGE_SIZE,
    scrollTop: typeof stored.scrollTop === 'number' && Number.isFinite(stored.scrollTop)
      ? Math.min(10_000_000, Math.max(0, stored.scrollTop)) : 0,
  };
}

export function readBrowserView(defaultCategory = ALL_ID, storage?: ViewStorage): BrowserView {
  try {
    const raw = (storage ?? localStorage).getItem(BROWSER_VIEW_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    // Ignore future formats rather than interpreting them as the current version.
    if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1) {
      return normalizeBrowserView(null, defaultCategory);
    }
    return normalizeBrowserView(saved, defaultCategory);
  } catch {
    return normalizeBrowserView(null, defaultCategory);
  }
}

export function writeBrowserView(view: BrowserView, storage?: ViewStorage): void {
  try {
    (storage ?? localStorage).setItem(BROWSER_VIEW_KEY, JSON.stringify({ version: 1, ...normalizeBrowserView(view) }));
  } catch {
    // Full, disabled or private browser storage must not interrupt browsing.
  }
}

/** Validate only when a catalogue exists, so a slow first load cannot discard the saved group. */
export function resolveBrowserCategory(category: string, categoryIds: Iterable<string>, ready: boolean): string {
  if (!ready || [ALL_ID, FAVORITES_ID, RECENT_ID].includes(category)) return category;
  return new Set(categoryIds).has(category) ? category : ALL_ID;
}

/** Store only IDs elsewhere; always use today's catalogue for names and playable stream data. */
export function resolveRecentChannels<T extends { stream_id: number }>(ids: readonly number[], streams: readonly T[]): T[] {
  const byId = new Map(streams.map((stream) => [stream.stream_id, stream]));
  const seen = new Set<number>();
  const recent: T[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stream = byId.get(id);
    if (stream) recent.push(stream);
    if (recent.length >= 20) break;
  }
  return recent;
}
