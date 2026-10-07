import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Disc3, ListEnd, ListStart, Loader2, Play, Search } from 'lucide-react';
import type { Album, Track } from '../types';
import { navigate, useStore } from '../lib/store';
import { api, formatDuration, useDebounced } from '../lib/util';
import { Button, Cover, EmptyState } from './ui';
import { TrackListHeader, TrackRow, queueTracks } from './TrackRow';

export function AlbumsView() {
  const albumKey = useStore((s) => s.albumKey);
  return albumKey ? <AlbumDetail albumKey={albumKey} /> : <AlbumGrid />;
}

function AlbumGrid() {
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim().toLowerCase(), 120);
  const libraryVersion = useStore((s) => s.libraryVersion);

  useEffect(() => {
    api.albums().then(setAlbums).catch(() => setAlbums([]));
  }, [libraryVersion]);

  const shown = useMemo(
    () => (albums ?? []).filter((a) => !q || `${a.name} ${a.artist}`.toLowerCase().includes(q)),
    [albums, q],
  );

  const playAlbum = async (album: Album, position: 'now' | 'end') => {
    const { tracks } = await api.album(album.key);
    await queueTracks(tracks, position);
  };

  return (
    <div className="px-4 pb-10 pt-6 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Albums</h1>
          <p className="mt-1 text-sm text-zinc-400">{albums ? `${albums.length} albums` : 'Loading…'}</p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter albums"
            className="h-10 w-full rounded-full border border-white/8 bg-white/[0.05] pl-10 pr-4 text-sm outline-none placeholder:text-zinc-500 focus:border-accent/60"
          />
        </div>
      </div>

      {albums === null ? (
        <div className="flex justify-center py-20 text-zinc-500">
          <Loader2 className="animate-spin" />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState icon={<Disc3 size={26} />} title={q ? 'No matching albums' : 'No albums yet'} />
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {shown.map((a) => (
            <div
              key={a.key}
              role="button"
              tabIndex={0}
              onClick={() => navigate('albums', a.key)}
              onKeyDown={(e) => e.key === 'Enter' && navigate('albums', a.key)}
              className="focus-ring group cursor-pointer rounded-2xl p-3 transition hover:bg-white/[0.06]"
            >
              <div className="relative">
                <Cover coverId={a.coverTrackId} seed={a.name} className="aspect-square w-full rounded-xl shadow-lg shadow-black/40" iconSize={36} />
                <div className="absolute bottom-2 right-2 flex translate-y-2 gap-2 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100">
                  <button
                    type="button"
                    title="Add album to queue"
                    onClick={(e) => {
                      e.stopPropagation();
                      void playAlbum(a, 'end');
                    }}
                    className="grid size-10 place-items-center rounded-full bg-ink-900/90 text-white shadow-xl backdrop-blur hover:scale-105"
                  >
                    <ListEnd size={18} />
                  </button>
                  <button
                    type="button"
                    title="Play album now"
                    onClick={(e) => {
                      e.stopPropagation();
                      void playAlbum(a, 'now');
                    }}
                    className="grid size-10 place-items-center rounded-full bg-brand text-white shadow-xl hover:scale-105"
                  >
                    <Play size={18} fill="currentColor" className="ml-0.5" />
                  </button>
                </div>
              </div>
              <div className="mt-3 truncate font-medium">{a.name}</div>
              <div className="truncate text-sm text-zinc-400">
                {a.artist}
                {a.year ? ` · ${a.year}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AlbumDetail({ albumKey }: { albumKey: string }) {
  const [data, setData] = useState<{ album: Album; tracks: Track[] } | null>(null);
  const [missing, setMissing] = useState(false);
  const libraryVersion = useStore((s) => s.libraryVersion);

  useEffect(() => {
    setMissing(false);
    api
      .album(albumKey)
      .then(setData)
      .catch(() => setMissing(true));
  }, [albumKey, libraryVersion]);

  if (missing)
    return (
      <div className="p-8">
        <Button onClick={() => navigate('albums')}>
          <ArrowLeft size={16} /> Albums
        </Button>
        <EmptyState icon={<Disc3 size={26} />} title="Album not found" />
      </div>
    );
  if (!data || data.album.key !== albumKey)
    return (
      <div className="flex justify-center py-20 text-zinc-500">
        <Loader2 className="animate-spin" />
      </div>
    );

  const { album, tracks } = data;
  return (
    <div className="pb-10">
      <div className="relative overflow-hidden">
        {album.coverTrackId && (
          <img src={`/api/cover/${album.coverTrackId}`} alt="" className="absolute inset-0 size-full scale-125 object-cover opacity-40 blur-3xl" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-ink-900" />
        <div className="relative px-4 pb-6 pt-4 md:px-8 md:pt-6">
          <Button className="-ml-3 mb-4" onClick={() => navigate('albums')}>
            <ArrowLeft size={16} /> Albums
          </Button>
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end">
            <Cover coverId={album.coverTrackId} seed={album.name} className="size-44 rounded-2xl shadow-2xl shadow-black/60 md:size-52" iconSize={48} />
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-widest text-zinc-300">Album</div>
              <h1 className="mt-1 text-3xl font-extrabold tracking-tight md:text-5xl">{album.name}</h1>
              <p className="mt-3 text-sm text-zinc-300">
                <span className="font-semibold text-white">{album.artist}</span>
                {album.year ? ` · ${album.year}` : ''} · {album.trackCount} song{album.trackCount === 1 ? '' : 's'} · {formatDuration(album.duration)}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => queueTracks(tracks, 'now')}>
                  <Play size={16} fill="currentColor" /> Play now
                </Button>
                <Button variant="subtle" onClick={() => queueTracks(tracks, 'next')}>
                  <ListStart size={16} /> Play next
                </Button>
                <Button variant="subtle" onClick={() => queueTracks(tracks, 'end')}>
                  <ListEnd size={16} /> Add to queue
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="px-2 md:px-6">
        <TrackListHeader albumLabel="" />
        {tracks.map((t, i) => (
          <TrackRow key={t.id} track={t} index={i} showAlbum={false} showCover={false} />
        ))}
      </div>
    </div>
  );
}
