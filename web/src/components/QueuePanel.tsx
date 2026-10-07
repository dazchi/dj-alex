import { memo } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, CloudDownload, GripVertical, ListMusic, Play, Shuffle, Trash2, X } from 'lucide-react';
import type { QueueItem } from '../types';
import { act } from '../lib/socket';
import { set, useStore } from '../lib/store';
import { cn, formatDuration, formatTime } from '../lib/util';
import { Avatar, Cover, EmptyState, Equalizer, IconButton } from './ui';

export function QueuePanel() {
  const player = useStore((s) => s.player);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  if (!player) return null;
  const { current, queue, status } = player;
  const total = queue.reduce((s, i) => s + i.track.duration, 0);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = queue.findIndex((i) => i.id === active.id);
    const to = queue.findIndex((i) => i.id === over.id);
    if (from < 0 || to < 0) return;
    // Optimistic reorder; the server broadcast will confirm it.
    set((s) => (s.player ? { player: { ...s.player, queue: arrayMove(s.player.queue, from, to) } } : {}));
    void act('queue:move', { itemId: String(active.id), toIndex: to });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {current && (
        <div className="px-4 pb-2">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Now playing</div>
          <div className="relative overflow-hidden rounded-2xl border border-white/8 p-3">
            {current.track.hasCover && (
              <img src={`/api/cover/${current.track.id}`} alt="" className="absolute inset-0 size-full scale-150 object-cover opacity-30 blur-2xl" />
            )}
            <div className="relative flex items-center gap-3">
              <Cover coverId={current.track.hasCover ? current.track.id : null} seed={current.track.album || current.track.title} className="size-14 rounded-xl shadow-lg shadow-black/40" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Equalizer playing={status === 'playing'} className="shrink-0" />
                  <div className="truncate font-semibold">{current.track.title}</div>
                </div>
                <div className="truncate text-sm text-zinc-300">{current.track.artist}</div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-400">
                  <Avatar name={current.addedBy} src={current.addedByAvatar} className="size-4 text-[8px]" /> {current.addedBy}
                </div>
              </div>
            </div>
            {current.status === 'downloading' && <DownloadBar item={current} />}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Up next</div>
          {queue.length > 0 && (
            <div className="text-xs text-zinc-500">
              {queue.length} track{queue.length === 1 ? '' : 's'} · {formatDuration(total)}
            </div>
          )}
        </div>
        <div className="flex gap-1">
          <IconButton label="Shuffle queue" className="size-8 hover:bg-white/8" disabled={queue.length < 2} onClick={() => act('queue:shuffle')}>
            <Shuffle size={16} />
          </IconButton>
          <IconButton
            label="Clear queue"
            className="size-8 hover:bg-white/8 hover:text-red-300"
            disabled={queue.length === 0}
            onClick={() => {
              if (confirm(`Remove all ${queue.length} tracks from the queue for everyone?`)) void act('queue:clear');
            }}
          >
            <Trash2 size={16} />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {queue.length === 0 ? (
          <EmptyState icon={<ListMusic size={24} />} title="The queue is empty">
            Search for songs and press <span className="text-zinc-300">+</span> to add them. Everyone sees the same queue.
          </EmptyState>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd}>
            <SortableContext items={queue.map((i) => i.id)} strategy={verticalListSortingStrategy}>
              <div className="relative">
                {queue.map((item, i) => (
                  <QueueRow key={item.id} item={item} index={i} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

const QueueRow = memo(function QueueRow({ item, index }: { item: QueueItem; index: number }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const t = item.track;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'group relative flex items-center gap-2 rounded-xl py-1.5 pl-1 pr-2 hover:bg-white/[0.06]',
        isDragging && 'z-10 bg-ink-700 shadow-2xl shadow-black/60 ring-1 ring-white/10',
        item.status === 'error' && 'opacity-60',
      )}
      onDoubleClick={() => act('queue:jump', { itemId: item.id })}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label={`Drag to reorder ${t.title}`}
        className="flex w-6 cursor-grab touch-none items-center justify-center text-zinc-600 hover:text-zinc-300 active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <span className="text-xs tabular-nums group-hover:hidden">{index + 1}</span>
        <GripVertical size={15} className="hidden group-hover:block" />
      </button>
      <Cover coverId={t.hasCover ? t.id : null} seed={t.album || t.title} className="size-10 rounded-lg" iconSize={15} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-100">{t.title}</div>
        <div className="flex items-center gap-1.5 truncate text-xs text-zinc-400">
          {item.status === 'downloading' && <CloudDownload size={12} className="shrink-0 text-sky-400" />}
          {item.status === 'error' && <AlertTriangle size={12} className="shrink-0 text-red-400" />}
          <span className="truncate">{item.status === 'error' ? item.error : t.artist}</span>
        </div>
        {item.status === 'downloading' && <DownloadBar item={item} />}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="hidden text-xs text-zinc-500 group-hover:hidden sm:inline pointer-coarse:hidden" title={`Added by ${item.addedBy}`}>
          <Avatar name={item.addedBy} src={item.addedByAvatar} className="size-5 text-[8px]" />
        </span>
        <span className="text-xs tabular-nums text-zinc-500 group-hover:hidden pointer-coarse:hidden">{t.duration ? formatTime(t.duration) : ''}</span>
        <div className="hidden items-center group-hover:flex pointer-coarse:flex">
          <IconButton label="Play now" className="size-7 hover:bg-white/10" onClick={() => act('queue:jump', { itemId: item.id })}>
            <Play size={14} fill="currentColor" />
          </IconButton>
          <IconButton label="Remove from queue" className="size-7 hover:bg-white/10 hover:text-red-300" onClick={() => act('queue:remove', { itemId: item.id })}>
            <X size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
});

function DownloadBar({ item }: { item: QueueItem }) {
  return (
    <div className="relative mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
      {item.progress !== undefined ? (
        <div className="h-full rounded-full bg-sky-400 transition-[width]" style={{ width: `${Math.round(item.progress * 100)}%` }} />
      ) : (
        <div className="absolute inset-y-0 w-1/3 animate-pulse rounded-full bg-sky-400" />
      )}
    </div>
  );
}
