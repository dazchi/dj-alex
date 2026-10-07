import { ListEnd, ListStart, Play } from 'lucide-react';
import { toast } from 'sonner';
import type { InsertPosition, Track } from '../types';
import { act } from '../lib/socket';
import { useStore } from '../lib/store';
import { cn, formatTime } from '../lib/util';
import { Cover, Equalizer, IconButton } from './ui';

export async function queueTracks(tracks: Track[], position: InsertPosition) {
  if (tracks.length === 0) return;
  const ok = await act('queue:add', { trackIds: tracks.map((t) => t.id), position });
  if (!ok) return;
  const what = tracks.length === 1 ? `“${tracks[0]!.title}”` : `${tracks.length} tracks`;
  if (position === 'next') toast.success(`${what} will play next`);
  else if (position === 'end') toast.success(`Added ${what} to the queue`);
}

export function TrackRow({
  track,
  index,
  showAlbum = true,
  showCover = true,
  meta,
}: {
  track: Track;
  index?: number;
  showAlbum?: boolean;
  showCover?: boolean;
  /** Replaces the album column (e.g. "played 3m ago"). */
  meta?: string;
}) {
  const current = useStore((s) => s.player?.current?.track.id === track.id);
  const playing = useStore((s) => s.player?.status === 'playing');

  return (
    <div
      className={cn(
        'group grid cursor-default select-none items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-white/[0.06]',
        'grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_3.5rem_auto]',
        current && 'bg-white/[0.04]',
      )}
      onDoubleClick={() => queueTracks([track], 'end')}
    >
      <div className="hidden w-8 justify-center text-sm tabular-nums text-zinc-500 md:flex">
        {current ? <Equalizer playing={playing} /> : index !== undefined ? <span className="group-hover:hidden">{index + 1}</span> : null}
        {!current && (
          <button
            type="button"
            className={cn('focus-ring text-white', index !== undefined && 'hidden group-hover:block')}
            title="Play now"
            onClick={() => queueTracks([track], 'now')}
          >
            <Play size={15} fill="currentColor" />
          </button>
        )}
      </div>

      <div className="flex min-w-0 items-center gap-3">
        {showCover && (
          <button type="button" className="relative focus-ring rounded-lg md:pointer-events-none" onClick={() => queueTracks([track], 'now')} title="Play now">
            <Cover coverId={track.hasCover ? track.id : null} seed={track.album || track.title} className="size-10 rounded-lg" iconSize={16} />
          </button>
        )}
        <div className="min-w-0">
          <div className={cn('truncate text-[15px] font-medium', current ? 'text-accent' : 'text-zinc-100')}>{track.title}</div>
          <div className="truncate text-[13px] text-zinc-400">
            {track.source === 'url' && <span className="mr-1.5 rounded bg-sky-500/15 px-1 py-px text-[10px] font-semibold uppercase text-sky-300">URL</span>}
            {track.artist}
          </div>
        </div>
      </div>

      <div className="hidden truncate text-sm text-zinc-400 md:block">{meta ?? (showAlbum ? track.album : '')}</div>

      <div className="hidden text-right text-sm tabular-nums text-zinc-400 md:block">{track.duration ? formatTime(track.duration) : '–'}</div>

      <div className="flex items-center gap-1 opacity-100 transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 pointer-coarse:opacity-100">
        <IconButton label="Play next" className="size-8 hover:bg-white/10" onClick={() => queueTracks([track], 'next')}>
          <ListStart size={17} />
        </IconButton>
        <IconButton label="Add to queue" className="size-8 hover:bg-white/10" onClick={() => queueTracks([track], 'end')}>
          <ListEnd size={17} />
        </IconButton>
      </div>
    </div>
  );
}

export function TrackListHeader({ albumLabel = 'Album' }: { albumLabel?: string }) {
  return (
    <div className="sticky top-0 z-10 hidden grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_3.5rem_auto] gap-3 border-b border-white/5 bg-ink-900/90 px-3 py-2 text-xs font-medium uppercase tracking-wider text-zinc-500 backdrop-blur md:grid">
      <span className="text-center">#</span>
      <span>Title</span>
      <span>{albumLabel}</span>
      <span className="text-right">Time</span>
      <span className="w-[4.25rem]" />
    </div>
  );
}
