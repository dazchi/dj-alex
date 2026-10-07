// Shapes shared between the server and the web UI (the web app imports this file as types only).
// Keep this file free of runtime imports.

export type TrackSource = 'local' | 'url';

export interface Track {
  id: string;
  source: TrackSource;
  title: string;
  artist: string;
  album: string;
  year?: number;
  trackNo?: number;
  /** Seconds. 0 when unknown. */
  duration: number;
  hasCover: boolean;
  /** Local tracks: path relative to the music directory. */
  relPath?: string;
  /** URL tracks: the original URL. */
  url?: string;
  addedAt?: number;
}

export type QueueItemStatus = 'ready' | 'downloading' | 'error';

/** Someone who performed an action (a Discord user, or the bot itself). */
export interface Actor {
  name: string;
  /** Discord user ID. */
  id?: string;
  avatar?: string | null;
}

/** The logged-in web user. */
export interface WebUser {
  id: string;
  username: string;
  /** Server nickname / display name. */
  name: string;
  avatar: string | null;
}

export interface QueueItem {
  id: string;
  track: Track;
  addedBy: string;
  addedById?: string;
  addedByAvatar?: string | null;
  addedAt: number;
  status: QueueItemStatus;
  /** Download progress 0..1 (only while downloading and the size is known). */
  progress?: number;
  error?: string;
}

export type RepeatMode = 'off' | 'all' | 'one';

/**
 * idle      – nothing loaded
 * loading   – current item still downloading / ffmpeg spinning up
 * playing   – audio is flowing to Discord
 * paused    – paused by a user
 * waiting   – ready to play but nobody to play to (bot not in a voice channel)
 */
export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'waiting';

export type InsertPosition = 'end' | 'next' | 'now';

export interface VoiceMember {
  id: string;
  name: string;
  avatar: string;
}

export interface VoiceChannelInfo {
  id: string;
  name: string;
  memberCount: number;
}

export interface VoiceState {
  /** Discord client logged in and ready. */
  botReady: boolean;
  botName: string | null;
  botAvatar: string | null;
  guildName: string | null;
  connected: boolean;
  /** Voice connection is being established. */
  connecting: boolean;
  channelId: string | null;
  channelName: string | null;
  listeners: VoiceMember[];
  channels: VoiceChannelInfo[];
}

export interface PlayerState {
  status: PlaybackStatus;
  current: QueueItem | null;
  queue: QueueItem[];
  /** Most recent first. */
  history: QueueItem[];
  /** Seconds into the current track, measured at `positionAt`. */
  position: number;
  /** Server epoch ms when `position` was sampled. Clients interpolate while `status === 'playing'`. */
  positionAt: number;
  /** 0..100 */
  volume: number;
  repeat: RepeatMode;
  voice: VoiceState;
}

export interface ActivityEvent {
  id: string;
  at: number;
  user: string;
  userId?: string;
  avatar?: string | null;
  message: string;
  /** Coalescing key, e.g. 'volume' or 'seek' (absent for one-off events). */
  kind?: string;
}

export interface LibraryStats {
  tracks: number;
  albums: number;
  artists: number;
  scanning: boolean;
  musicDir: string;
  lastScan: number | null;
}

export type SongSort = 'title' | 'artist' | 'album' | 'recent' | 'duration';

export interface SongPage {
  items: Track[];
  total: number;
  offset: number;
}

export interface Album {
  key: string;
  name: string;
  artist: string;
  year?: number;
  trackCount: number;
  duration: number;
  coverTrackId: string | null;
}

export interface AckResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** Events the web client may emit (all acknowledged with AckResult). */
export interface ClientActions {
  'queue:add': { trackIds: string[]; position: InsertPosition };
  'queue:addUrl': { url: string; position: InsertPosition };
  'queue:remove': { itemId: string };
  'queue:move': { itemId: string; toIndex: number };
  'queue:jump': { itemId: string };
  'queue:clear': Record<string, never>;
  'queue:shuffle': Record<string, never>;
  'player:toggle': Record<string, never>;
  'player:next': Record<string, never>;
  'player:prev': Record<string, never>;
  'player:stop': Record<string, never>;
  'player:seek': { position: number };
  'player:volume': { volume: number };
  'player:repeat': { mode: RepeatMode };
  'voice:join': { channelId: string };
  'voice:leave': Record<string, never>;
}
