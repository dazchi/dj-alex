import { History } from 'lucide-react';
import { useStore } from '../lib/store';
import { timeAgo, useNow } from '../lib/util';
import { EmptyState } from './ui';
import { TrackListHeader, TrackRow } from './TrackRow';

export function HistoryView() {
  const history = useStore((s) => s.player?.history ?? []);
  const now = useNow();
  return (
    <div className="px-2 pb-10 pt-6 md:px-6">
      <div className="px-2 pb-4 md:px-2">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Recently played</h1>
        <p className="mt-1 text-sm text-zinc-400">The last {history.length} tracks played on the server.</p>
      </div>
      {history.length === 0 ? (
        <EmptyState icon={<History size={26} />} title="Nothing played yet" />
      ) : (
        <>
          <TrackListHeader albumLabel="Added by" />
          {history.map((item, i) => (
            <TrackRow key={`${item.id}-${i}`} track={item.track} index={i} meta={`${item.addedBy} · ${timeAgo(item.addedAt, now)}`} />
          ))}
        </>
      )}
    </div>
  );
}
