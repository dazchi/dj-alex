import { useCallback, useEffect, useRef, useState } from 'react';
import { ListEnd, Loader2, Search, SearchX, Shuffle, X } from 'lucide-react';
import type { SongSort, Track } from '../types';
import { useStore } from '../lib/store';
import { api, useDebounced } from '../lib/util';
import { Button, EmptyState } from './ui';
import { TrackListHeader, TrackRow, queueTracks } from './TrackRow';

const SORTS: { value: SongSort | ''; label: string }[] = [
  { value: '', label: 'Best match' },
  { value: 'artist', label: 'Artist' },
  { value: 'title', label: 'Title' },
  { value: 'album', label: 'Album' },
  { value: 'recent', label: 'Recently added' },
  { value: 'duration', label: 'Length' },
];

const PAGE = 100;

export function SongsView() {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SongSort | ''>('');
  const q = useDebounced(query, 180);
  const [items, setItems] = useState<Track[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [queueingAll, setQueueingAll] = useState(false);
  const libraryVersion = useStore((s) => s.libraryVersion);
  const stats = useStore((s) => s.library);
  const reqId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (offset: number) => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const page = await api.songs(q, sort, offset, PAGE);
        if (id !== reqId.current) return;
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setTotal(page.total);
      } catch {
        /* network hiccup; keep what we have */
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [q, sort],
  );

  useEffect(() => {
    void load(0);
  }, [load, libraryVersion]);

  // Infinite scroll
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loading && items.length < total) void load(items.length);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [items.length, total, loading, load]);

  // "/" focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const queueAll = async (shuffle: boolean) => {
    setQueueingAll(true);
    try {
      const all = total > items.length ? (await api.songs(q, sort, 0, Math.min(total, 500))).items : items;
      const list = shuffle ? [...all].sort(() => Math.random() - 0.5) : all;
      await queueTracks(list, 'end');
    } finally {
      setQueueingAll(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="px-4 pb-4 pt-6 md:px-8">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Songs</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {stats ? `${stats.tracks.toLocaleString()} tracks · ${stats.albums.toLocaleString()} albums · ${stats.artists.toLocaleString()} artists` : 'Loading library…'}
          {stats?.scanning && <span className="ml-2 inline-flex items-center gap-1 text-accent"><Loader2 size={12} className="animate-spin" /> scanning</span>}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-64">
            <Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              placeholder="Search songs, artists, albums…   ( / )"
              className="h-12 w-full rounded-full border border-white/8 bg-white/[0.05] pl-11 pr-10 text-[15px] text-white placeholder:text-zinc-500 outline-none transition focus:border-accent/60 focus:bg-white/[0.08] focus:ring-4 focus:ring-accent/10"
            />
            {query && (
              <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-zinc-400 hover:text-white" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={16} />
              </button>
            )}
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SongSort | '')}
            className="focus-ring h-12 rounded-full border border-white/8 bg-white/[0.05] px-4 text-sm text-zinc-200 outline-none"
            aria-label="Sort by"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value} className="bg-ink-800">
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {total > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-2 text-sm text-zinc-400">
              {q ? `${total.toLocaleString()} result${total === 1 ? '' : 's'}` : `${total.toLocaleString()} songs`}
            </span>
            <Button variant="subtle" className="h-8 px-3 text-xs" disabled={queueingAll} onClick={() => queueAll(false)}>
              <ListEnd size={14} /> Queue {total > 500 ? 'first 500' : 'all'}
            </Button>
            <Button variant="subtle" className="h-8 px-3 text-xs" disabled={queueingAll} onClick={() => queueAll(true)}>
              <Shuffle size={14} /> Shuffle {total > 500 ? 'first 500' : 'all'}
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 px-2 pb-8 md:px-6">
        {items.length > 0 && <TrackListHeader />}
        {items.map((t, i) => (
          <TrackRow key={t.id} track={t} index={i} />
        ))}
        {!loading && items.length === 0 && (
          q ? (
            <EmptyState icon={<SearchX size={26} />} title={`No results for “${q}”`}>Try a different spelling, or fewer words.</EmptyState>
          ) : (
            <EmptyState icon={<Search size={26} />} title="Your library is empty">
              Drop audio files into <code className="rounded bg-white/10 px-1 text-zinc-300">{stats?.musicDir ?? 'the music folder'}</code> and they will appear here automatically.
            </EmptyState>
          )
        )}
        <div ref={sentinel} className="h-8" />
        {loading && (
          <div className="flex justify-center py-4 text-zinc-500">
            <Loader2 className="animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}
