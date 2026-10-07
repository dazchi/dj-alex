import { useEffect, useRef, useState } from 'react';
import {
  Loader2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  SkipBack,
  SkipForward,
  Square,
  Volume,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { RepeatMode } from '../types';
import { act } from '../lib/socket';
import { set, useStore } from '../lib/store';
import { cn, formatTime, usePosition } from '../lib/util';
import { Cover, IconButton, Slider } from './ui';

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };
const REPEAT_LABEL: Record<RepeatMode, string> = { off: 'Repeat: off', all: 'Repeat: queue', one: 'Repeat: track' };

export function PlayerBar() {
  const player = useStore((s) => s.player);
  const position = usePosition();
  const [seekPreview, setSeekPreview] = useState<number | null>(null);

  if (!player) return null;
  const { current, status, repeat, queue, history } = player;
  const duration = current?.track.duration ?? 0;
  const shownPos = seekPreview ?? position;
  const busy = status === 'loading';
  const canPlay = !!current || queue.length > 0;

  return (
    <footer className="relative z-20 border-t border-white/6 bg-ink-900/85 backdrop-blur-xl">
      {/* Mobile: thin progress line */}
      <div className="absolute inset-x-0 top-0 h-0.5 bg-white/5 lg:hidden">
        <div className="h-full bg-brand" style={{ width: duration ? `${(shownPos / duration) * 100}%` : 0 }} />
      </div>

      <div className="mx-auto grid h-[72px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 lg:h-[88px] lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] lg:px-5">
        {/* Track info */}
        <div className="flex min-w-0 items-center gap-3">
          {current ? (
            <>
              <Cover
                coverId={current.track.hasCover ? current.track.id : null}
                seed={current.track.album || current.track.title}
                className="size-12 rounded-lg shadow-lg shadow-black/40 lg:size-14"
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold lg:text-[15px]">{current.track.title}</div>
                <div className="truncate text-xs text-zinc-400 lg:text-[13px]">{current.track.artist}</div>
                <StatusLine />
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3 text-sm text-zinc-500">
              <div className="grid size-12 place-items-center rounded-lg bg-white/5 lg:size-14">
                <Play size={18} />
              </div>
              <span>{queue.length ? `${queue.length} tracks queued` : 'Nothing playing'}</span>
            </div>
          )}
        </div>

        {/* Transport */}
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-1 lg:gap-3">
            <IconButton label="Stop" className="hidden size-9 lg:grid" disabled={!current} onClick={() => act('player:stop')}>
              <Square size={15} fill="currentColor" />
            </IconButton>
            <IconButton label="Previous" className="hidden size-9 sm:grid" disabled={!current && history.length === 0} onClick={() => act('player:prev')}>
              <SkipBack size={20} fill="currentColor" />
            </IconButton>
            <button
              type="button"
              aria-label={status === 'playing' || busy ? 'Pause' : 'Play'}
              title={status === 'playing' ? 'Pause (Space)' : 'Play (Space)'}
              disabled={!canPlay}
              onClick={() => act('player:toggle')}
              className="focus-ring grid size-11 place-items-center rounded-full bg-white text-ink-950 shadow-lg transition hover:scale-105 active:scale-95 disabled:opacity-30 lg:size-10"
            >
              {busy ? (
                <Loader2 size={20} className="animate-spin" />
              ) : status === 'playing' || status === 'waiting' ? (
                <Pause size={20} fill="currentColor" />
              ) : (
                <Play size={20} fill="currentColor" className="ml-0.5" />
              )}
            </button>
            <IconButton label="Next" className="size-9" disabled={!current && queue.length === 0} onClick={() => act('player:next')}>
              <SkipForward size={20} fill="currentColor" />
            </IconButton>
            <IconButton
              label={REPEAT_LABEL[repeat]}
              active={repeat !== 'off'}
              className="relative hidden size-9 lg:grid"
              onClick={() => act('player:repeat', { mode: NEXT_REPEAT[repeat] })}
            >
              {repeat === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}
              {repeat !== 'off' && <span className="absolute bottom-0.5 size-1 rounded-full bg-accent" />}
            </IconButton>
          </div>
          <div className="hidden w-full max-w-xl items-center gap-2 text-[11px] tabular-nums text-zinc-400 lg:flex">
            <span className="w-10 text-right">{formatTime(shownPos)}</span>
            <Slider
              label="Seek"
              value={shownPos}
              max={duration}
              disabled={!current || current.status !== 'ready' || !duration}
              step={5}
              onChange={setSeekPreview}
              onCommit={(v) => {
                setSeekPreview(null);
                void act('player:seek', { position: v });
              }}
              className="flex-1"
            />
            <span className="w-10">{duration ? formatTime(duration) : '--:--'}</span>
          </div>
        </div>

        {/* Volume */}
        <div className="hidden items-center justify-end gap-2 lg:flex">
          <VolumeControl volume={player.volume} />
        </div>
      </div>
    </footer>
  );
}

function StatusLine() {
  const player = useStore((s) => s.player);
  if (!player?.current) return null;
  const { status, current, voice } = player;
  if (status === 'waiting' || (!voice.connected && status !== 'paused')) {
    return (
      <button
        type="button"
        onClick={() => set({ drawerOpen: true })}
        className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-amber-300 hover:underline"
      >
        <span className="size-1.5 animate-pulse rounded-full bg-amber-300" />
        {voice.botReady ? 'Bot is not in a voice channel' : 'Discord bot offline'}
      </button>
    );
  }
  if (current.status === 'downloading') {
    return (
      <div className="mt-0.5 text-[11px] text-sky-300">Downloading… {current.progress !== undefined ? `${Math.round(current.progress * 100)}%` : ''}</div>
    );
  }
  return <div className="mt-0.5 hidden truncate text-[11px] text-zinc-500 lg:block">Added by {current.addedBy}</div>;
}

function VolumeControl({ volume }: { volume: number }) {
  const [local, setLocal] = useState<number | null>(null);
  const lastSent = useRef(0);
  const beforeMute = useRef(60);
  const shown = local ?? volume;
  useEffect(() => {
    if (volume > 0) beforeMute.current = volume;
  }, [volume]);

  const send = (v: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastSent.current < 120) return;
    lastSent.current = now;
    void act('player:volume', { volume: Math.round(v) });
  };

  const Icon = shown === 0 ? VolumeX : shown < 34 ? Volume : shown < 67 ? Volume1 : Volume2;
  return (
    <>
      <IconButton
        label={shown === 0 ? 'Unmute' : 'Mute'}
        className="size-8"
        onClick={() => send(shown === 0 ? beforeMute.current || 60 : 0, true)}
      >
        <Icon size={18} />
      </IconButton>
      <Slider
        label="Volume"
        value={shown}
        max={100}
        step={5}
        className={cn('w-32')}
        onChange={(v) => {
          setLocal(v);
          send(v);
        }}
        onCommit={(v) => {
          setLocal(null);
          send(v, true);
        }}
      />
      <span className="w-8 text-right text-xs tabular-nums text-zinc-500">{Math.round(shown)}</span>
    </>
  );
}

/** Seek / repeat / volume controls for small screens (shown above the queue). */
export function MobileControls() {
  const player = useStore((s) => s.player);
  const position = usePosition();
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  if (!player?.current) return null;
  const { current, repeat } = player;
  const duration = current.track.duration;
  const shown = seekPreview ?? position;
  return (
    <div className="flex flex-col gap-3 border-b border-white/5 px-4 pb-4 pt-3">
      <div className="flex items-center gap-2 text-[11px] tabular-nums text-zinc-400">
        <span className="w-9 text-right">{formatTime(shown)}</span>
        <Slider
          label="Seek"
          value={shown}
          max={duration}
          disabled={current.status !== 'ready' || !duration}
          onChange={setSeekPreview}
          onCommit={(v) => {
            setSeekPreview(null);
            void act('player:seek', { position: v });
          }}
          className="flex-1"
        />
        <span className="w-9">{duration ? formatTime(duration) : '--:--'}</span>
      </div>
      <div className="flex items-center gap-2">
        <IconButton label="Previous" className="size-9" onClick={() => act('player:prev')}>
          <SkipBack size={18} fill="currentColor" />
        </IconButton>
        <IconButton label="Stop" className="size-9" onClick={() => act('player:stop')}>
          <Square size={14} fill="currentColor" />
        </IconButton>
        <IconButton label={REPEAT_LABEL[repeat]} active={repeat !== 'off'} className="size-9" onClick={() => act('player:repeat', { mode: NEXT_REPEAT[repeat] })}>
          {repeat === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}
        </IconButton>
        <div className="ml-auto flex items-center gap-1">
          <VolumeControl volume={player.volume} />
        </div>
      </div>
    </div>
  );
}
