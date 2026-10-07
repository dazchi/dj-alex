import { useEffect, useState } from 'react';
import type { Album, LibraryStats, SongPage, SongSort, Track } from '../types';
import { set, useStore } from './store';

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} hr ${m} min` : `${m} min`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 16777619);
  return h >>> 0;
}

const AVATAR_COLORS = ['#8b5cf6', '#ec4899', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#6366f1', '#14b8a6'];
export const colorFor = (name: string) => AVATAR_COLORS[hashString(name) % AVATAR_COLORS.length];

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

/** Interpolated playhead position in seconds. */
export function usePosition(): number {
  const player = useStore((s) => s.player);
  const receivedAt = useStore((s) => s.receivedAt);
  const [now, setNow] = useState(() => Date.now());
  const playing = player?.status === 'playing';
  useEffect(() => {
    if (!playing) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [playing, receivedAt]);
  if (!player?.current) return 0;
  let pos = player.position + (playing ? Math.max(0, now - receivedAt) / 1000 : 0);
  const d = player.current.track.duration;
  if (d) pos = Math.min(pos, d);
  return pos;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Re-renders periodically (for relative timestamps). */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (res.status === 401) set({ auth: 'anon', me: null });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  songs: (q: string, sort: SongSort | '', offset: number, limit = 100) =>
    getJson<SongPage>(`/api/library/songs?${new URLSearchParams({ q, sort, offset: String(offset), limit: String(limit) })}`),
  albums: (q = '') => getJson<Album[]>(`/api/library/albums?${new URLSearchParams({ q })}`),
  album: (key: string) => getJson<{ album: Album; tracks: Track[] }>(`/api/library/albums/${encodeURIComponent(key)}`),
  stats: () => getJson<LibraryStats>('/api/library/stats'),
  rescan: () => fetch('/api/library/rescan', { method: 'POST' }),
};
