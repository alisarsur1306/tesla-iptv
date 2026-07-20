import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AccessKeyError,
  getLiveCategories,
  getLiveStreams,
  proxiedIcon,
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
  const [categories, setCategories] = useState<XtreamCategory[]>([]);
  const [streams, setStreams] = useState<XtreamLiveStream[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>(FAVORITES_ID);
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [favorites, setFavorites] = useState<Set<number>>(() => loadFavorites());
  const [brokenIcons, setBrokenIcons] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getLiveCategories(creds), getLiveStreams(creds)])
      .then(([cats, chans]) => {
        if (cancelled) return;
        setCategories(cats);
        setStreams(chans);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AccessKeyError) {
          setError(null);
          onNeedKey(); // ask for the key; saving it bumps retryToken and refires this effect
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load channels.');
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [creds, retryToken, onNeedKey]);

  function toggleFavorite(id: number) {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const filtered = useMemo(() => {
    let list = streams;
    if (activeCategory === FAVORITES_ID) {
      list = list.filter((s) => favorites.has(s.stream_id));
    } else if (activeCategory !== ALL_ID) {
      list = list.filter((s) => String(s.category_id) === activeCategory);
    }
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((s) => (s.name || '').toLowerCase().includes(q));
    return list;
  }, [streams, activeCategory, search, favorites]);

  const visible = filtered.slice(0, visibleCount);

  function selectCategory(id: string) {
    setActiveCategory(id);
    setVisibleCount(PAGE_SIZE);
  }

  if (loading) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-zinc-950 text-zinc-100">
        <Loader2 className="size-16 animate-spin text-red-500" />
        <p className="text-2xl text-zinc-400">Loading channels…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-zinc-950 p-8 text-zinc-100">
        <p className="max-w-xl text-pretty text-center text-2xl text-red-400">{error}</p>
        <Button onClick={onLogout} className="h-16 min-w-56 bg-zinc-800 text-xl hover:bg-zinc-700">
          <LogOut className="mr-2 size-6" /> Back to login
        </Button>
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
              placeholder="Search channels…"
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
            <div className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-4">
              {visible.map((ch) => {
                const icon = brokenIcons.has(ch.stream_id) ? null : proxiedIcon(ch.stream_icon);
                const isFav = favorites.has(ch.stream_id);
                return (
                  <div
                    key={ch.stream_id}
                    className="group relative flex min-h-32 items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 transition-colors hover:border-red-600/60 hover:bg-zinc-800 active:bg-zinc-800"
                  >
                    <button
                      onClick={() => onPlay(ch, filtered)}
                      aria-label={`Play ${ch.name}`}
                      className="flex min-w-0 flex-1 items-center gap-4 text-left"
                    >
                      {icon ? (
                        <img
                          src={icon}
                          alt=""
                          loading="lazy"
                          onError={() =>
                            setBrokenIcons((prev) => new Set(prev).add(ch.stream_id))
                          }
                          className="size-20 shrink-0 rounded-xl bg-zinc-800 object-contain p-1"
                        />
                      ) : (
                        <div className="flex size-20 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-3xl font-bold text-zinc-500">
                          {(ch.name || '?').trim().charAt(0)}
                        </div>
                      )}
                      <span dir="auto" className="line-clamp-2 text-pretty text-xl font-medium leading-snug">
                        {ch.name}
                      </span>
                    </button>
                    <button
                      onClick={() => toggleFavorite(ch.stream_id)}
                      aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                      className="flex size-16 shrink-0 items-center justify-center rounded-full hover:bg-zinc-700 active:bg-zinc-700"
                    >
                      <Star
                        className={`size-8 ${isFav ? 'fill-amber-400 text-amber-400' : 'text-zinc-600'}`}
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
