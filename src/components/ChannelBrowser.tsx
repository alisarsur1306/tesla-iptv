import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AccessKeyError,
  getLiveCategories,
  getLiveStreams,
  proxiedIcon,
  readChannelCache,
  writeChannelCache,
  type XtreamCategory,
  type XtreamCreds,
  type XtreamLiveStream,
} from '@/lib/xtream';
import { Loader2, LogOut, Search, Star, Tv } from 'lucide-react';

const FAVORITES_KEY = 'tesla-iptv:favorites';
const PAGE_SIZE = 120;
const FAVORITES_ID = '__favorites__';
const ALL_ID = '__all__';

function loadFavorites(): Set<number> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as number[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

interface ChannelBrowserProps {
  creds: XtreamCreds;
  /** `list` is the currently filtered set, so the player can offer Next/Prev. */
  onPlay: (channel: XtreamLiveStream, list: XtreamLiveStream[]) => void;
  onLogout: () => void;
  onNeedKey: () => void;
  retryToken: number;
}

export default function ChannelBrowser({ creds, onPlay, onLogout, onNeedKey, retryToken }: ChannelBrowserProps) {
  // Seeded from the browser cache so a repeat visit renders immediately instead of waiting on
  // a cold server. Lazy initialisers, so this costs one read and no extra effect.
  const seed = useState(() => readChannelCache())[0];
  const [categories, setCategories] = useState<XtreamCategory[]>(() => seed?.categories ?? []);
  const [streams, setStreams] = useState<XtreamLiveStream[]>(() => seed?.streams ?? []);
  const [loading, setLoading] = useState(() => !seed);
  const [error, setError] = useState<string | null>(null);
  // Favourites is the right landing tab once there are some, and the wrong one before that:
  // a first run opened on an empty screen saying "No favorites yet" instead of channels.
  const [activeCategory, setActiveCategory] = useState<string>(() =>
    loadFavorites().size > 0 ? FAVORITES_ID : ALL_ID,
  );
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [favorites, setFavorites] = useState<Set<number>>(() => loadFavorites());
  const [brokenIcons, setBrokenIcons] = useState<Set<number>>(new Set());
  // A bare spinner cannot be told apart from a hung one. Counting proves the app is alive and
  // makes "it is stuck" a number we can actually act on.
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!loading) return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 250);
    return () => clearInterval(id);
  }, [loading, retryToken]);

  const hasCache = Boolean(seed);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([getLiveCategories(creds), getLiveStreams(creds)])
      .then(([cats, chans]) => {
        if (cancelled) return;
        setCategories(cats);
        setStreams(chans);
        writeChannelCache(cats, chans);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AccessKeyError) {
          setError(null);
          onNeedKey(); // ask for the key; saving it bumps retryToken and refires this effect
        } else if (!hasCache) {
          setError(err instanceof Error ? err.message : 'Failed to load channels.');
        }
        // With a cached list on screen, a failed refresh is not worth replacing it with an
        // error page — the channels shown are still the real ones, just older.
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [creds, retryToken, onNeedKey, hasCache]);

  function toggleFavorite(id: number) {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const categoryName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(String(c.category_id), c.category_name || '');
    return m;
  }, [categories]);

  const filtered = useMemo(() => {
    let list = streams;
    if (activeCategory === FAVORITES_ID) {
      list = list.filter((s) => favorites.has(s.stream_id));
    } else if (activeCategory !== ALL_ID) {
      list = list.filter((s) => String(s.category_id) === activeCategory);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      // Match the group as well as the channel: with 5,000 channels, "sport" is far more often
      // "show me the sports groups" than "channels with sport in the name". Searching only names
      // made whole categories unreachable without knowing a channel in them by name.
      list = list.filter(
        (s) =>
          (s.name || '').toLowerCase().includes(q) ||
          (categoryName.get(String(s.category_id)) || '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [streams, activeCategory, search, favorites, categoryName]);

  const visible = filtered.slice(0, visibleCount);

  function selectCategory(id: string) {
    setActiveCategory(id);
    setVisibleCount(PAGE_SIZE);
  }

  if (loading) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-zinc-950 p-8 text-zinc-100">
        <Loader2 className="size-16 animate-spin text-red-500" />
        <p className="text-2xl text-zinc-400">Loading channels… {elapsed}s</p>
        {/* The channel list is megabytes of JSON pulled through the upstream proxy, so a slow
            first load is normal. Say so before it reads as a hang. */}
        {elapsed >= 10 && (
          <p className="max-w-xl text-pretty text-center text-lg text-zinc-500">
            The full channel list can take up to a minute on a cold start.
          </p>
        )}
        {elapsed >= 45 && (
          <p className="max-w-xl text-pretty text-center text-lg text-amber-500">
            Still waiting on the IPTV source. If this fails, open{' '}
            <span className="font-mono">/api/diag</span> to see which step is failing.
          </p>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-zinc-950 p-8 text-zinc-100">
        <p className="max-w-xl text-pretty text-center text-2xl text-red-400">{error}</p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <Button
            onClick={() => window.location.reload()}
            className="h-16 min-w-56 bg-red-600 text-xl hover:bg-red-500"
          >
            Try again
          </Button>
          <Button onClick={onLogout} className="h-16 min-w-56 bg-zinc-800 text-xl hover:bg-zinc-700">
            <LogOut className="mr-2 size-6" /> Back to login
          </Button>
        </div>
        <a
          href="/api/diag"
          className="text-lg text-zinc-500 underline underline-offset-4 hover:text-zinc-300"
        >
          Open /api/diag
        </a>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-zinc-800 px-6 py-5">
        <Tv className="size-10 shrink-0 text-red-500" />
        <h1 className="text-3xl font-bold tracking-tight">Tesla IPTV</h1>
        <span className="hidden rounded-full bg-zinc-800 px-4 py-1.5 text-base tabular-nums text-zinc-300 sm:inline">
          {filtered.length.toLocaleString()} / {streams.length.toLocaleString()}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 size-6 -translate-y-1/2 text-zinc-500" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              placeholder="Search channels or groups…"
              className="h-16 w-56 border-zinc-700 bg-zinc-900 pl-14 text-xl md:w-[28rem]"
            />
          </div>
          <Button
            onClick={onLogout}
            variant="outline"
            aria-label="Log out"
            className="size-16 shrink-0 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <LogOut className="size-7" />
          </Button>
        </div>
      </header>

      {/* Category chips */}
      <div className="flex gap-3 overflow-x-auto border-b border-zinc-800 px-6 py-4 [scrollbar-width:thin]">
        <CategoryChip
          active={activeCategory === FAVORITES_ID}
          onClick={() => selectCategory(FAVORITES_ID)}
        >
          ★ Favorites ({favorites.size})
        </CategoryChip>
        <CategoryChip active={activeCategory === ALL_ID} onClick={() => selectCategory(ALL_ID)}>
          All
        </CategoryChip>
        {categories.map((c) => (
          <CategoryChip
            key={c.category_id}
            active={activeCategory === String(c.category_id)}
            onClick={() => selectCategory(String(c.category_id))}
          >
            <span dir="auto">{c.category_name}</span>
          </CategoryChip>
        ))}
      </div>

      {/* Channel grid */}
      <main className="flex-1 overflow-y-auto p-6">
        {visible.length === 0 ? (
          <div className="mt-24 flex flex-col items-center gap-6 text-center">
            <p className="text-pretty text-2xl text-zinc-500">
              {activeCategory === FAVORITES_ID
                ? 'No favorites yet — star a channel to pin it here.'
                : 'No channels found.'}
            </p>
            {activeCategory === FAVORITES_ID && (
              <Button
                onClick={() => selectCategory(ALL_ID)}
                className="h-16 min-w-64 bg-red-600 text-xl font-semibold hover:bg-red-500"
              >
                Browse all channels
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {visible.map((ch) => {
                const icon = brokenIcons.has(ch.stream_id) ? null : proxiedIcon(ch.stream_icon);
                const isFav = favorites.has(ch.stream_id);
                return (
                  <div
                    key={ch.stream_id}
                    className="group relative flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-3 transition-colors hover:border-red-600/60 hover:bg-zinc-800 active:bg-zinc-800"
                  >
                    <button
                      onClick={() => onPlay(ch, filtered)}
                      aria-label={`Play ${ch.name}`}
                      title={ch.name}
                      className="flex min-h-16 min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      {icon ? (
                        <img
                          src={icon}
                          alt=""
                          loading="lazy"
                          onError={() =>
                            setBrokenIcons((prev) => new Set(prev).add(ch.stream_id))
                          }
                          className="size-12 shrink-0 rounded-lg bg-zinc-800 object-contain p-0.5"
                        />
                      ) : (
                        <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-xl font-bold text-zinc-500">
                          {(ch.name || '?').trim().charAt(0)}
                        </div>
                      )}
                      {/* The logo was 80px and the name was clamped to two lines, so a long name
                          lost its end — exactly the part that distinguishes one feed of a channel
                          from another. The logo is decoration; the name is the thing being picked. */}
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span
                          dir="auto"
                          className="line-clamp-3 text-pretty text-lg font-medium leading-tight"
                        >
                          {ch.name}
                        </span>
                        {categoryName.get(String(ch.category_id)) && (
                          <span dir="auto" className="truncate text-sm text-zinc-400">
                            {categoryName.get(String(ch.category_id))}
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      onClick={() => toggleFavorite(ch.stream_id)}
                      aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                      className="flex size-14 shrink-0 items-center justify-center rounded-full hover:bg-zinc-700 active:bg-zinc-700"
                    >
                      <Star
                        className={`size-7 ${isFav ? 'fill-amber-400 text-amber-400' : 'text-zinc-400'}`}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
            {filtered.length > visibleCount && (
              <div className="mt-8 flex justify-center pb-8">
                <Button
                  onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                  className="h-16 min-w-72 bg-zinc-800 text-xl tabular-nums hover:bg-zinc-700"
                >
                  Show more ({(filtered.length - visibleCount).toLocaleString()} left)
                </Button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`h-16 shrink-0 whitespace-nowrap rounded-full px-7 text-xl font-medium transition-colors ${
        active
          ? 'bg-red-600 text-white'
          : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}
