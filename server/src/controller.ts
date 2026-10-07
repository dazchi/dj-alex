import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Library } from './library.js';
import type { Player, PersistedPlayer } from './player.js';
import { Downloader } from './downloader.js';
import type { ActivityEvent, Actor, InsertPosition, PlayerState, QueueItem, RepeatMode, Track, VoiceState } from './types.js';
import { errorMessage, formatTime, log, randomId } from './util.js';

/** Voice side of the bot, implemented by Bot. */
export interface VoiceProvider {
  voiceState(): VoiceState;
  join(channelId: string): Promise<string>;
  leave(): boolean;
  /** Joins a sensible channel if not connected. Returns the joined channel name, or null. */
  autoJoin(): Promise<string | null>;
  isConnected(): boolean;
}

const offlineVoice: VoiceState = {
  botReady: false,
  botName: null,
  botAvatar: null,
  guildName: null,
  connected: false,
  connecting: false,
  channelId: null,
  channelName: null,
  listeners: [],
  channels: [],
};

const ACTIVITY_LIMIT = 100;
export const SYSTEM_ACTOR: Actor = { name: 'DJ Alex' };

/**
 * Every user-facing action goes through here, whether it came from the web UI or a slash command.
 * Emits 'state' (coalesced) and 'activity'.
 */
export class Controller extends EventEmitter {
  voice: VoiceProvider | null = null;
  readonly activity: ActivityEvent[] = [];
  private lastActivityKey = '';
  private stateQueued = false;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly library: Library,
    readonly player: Player,
    readonly downloader: Downloader,
    private readonly dataDir: string,
  ) {
    super();
    player.on('change', () => {
      this.queueState();
      this.scheduleSave();
    });
    player.on('trackError', (item: QueueItem, reason: string) => {
      this.log(SYSTEM_ACTOR, `Couldn't play “${item.track.title}”: ${reason}`);
    });
  }

  private get statePath() {
    return path.join(this.dataDir, 'state.json');
  }

  // ---------------------------------------------------------------- state & activity

  getState(): PlayerState {
    const p = this.player;
    return {
      status: p.status,
      current: p.current,
      queue: p.queue,
      history: p.history,
      position: p.position,
      positionAt: Date.now(),
      volume: p.volume,
      repeat: p.repeat,
      voice: this.voice?.voiceState() ?? offlineVoice,
    };
  }

  /** Coalesces bursts of changes into one broadcast. */
  queueState() {
    if (this.stateQueued) return;
    this.stateQueued = true;
    setImmediate(() => {
      this.stateQueued = false;
      this.emit('state', this.getState());
    });
  }

  /**
   * Records an activity entry. Entries with the same `key` from the same user within a few seconds
   * replace each other (so dragging the volume slider doesn't flood the feed).
   */
  log(actor: Actor, message: string, key?: string) {
    const user = actor.name;
    const fullKey = key ? `${actor.id ?? user}|${key}` : '';
    const last = this.activity[0];
    let event: ActivityEvent;
    if (fullKey && fullKey === this.lastActivityKey && last && Date.now() - last.at < 5000) {
      last.message = message;
      last.at = Date.now();
      event = last;
    } else {
      event = { id: randomId(), at: Date.now(), user, userId: actor.id, avatar: actor.avatar, message, kind: key?.split(':')[0] };
      this.activity.unshift(event);
      if (this.activity.length > ACTIVITY_LIMIT) this.activity.length = ACTIVITY_LIMIT;
    }
    this.lastActivityKey = fullKey;
    log.info('activity', `${user}: ${message}`);
    this.emit('activity', event);
  }

  // ---------------------------------------------------------------- queue actions

  async addTracks(actor: Actor, trackIds: string[], position: InsertPosition): Promise<QueueItem[]> {
    const tracks = trackIds.map((id) => this.library.get(id)?.track).filter((t): t is Track => !!t);
    if (tracks.length === 0) throw new Error('Track not found in the library');
    const items = tracks.map((track) => this.makeItem(actor, track, 'ready'));
    await this.ensureVoice(actor);
    this.player.add(items, position);
    this.log(actor, `${verb(position)} ${describe(tracks)}`);
    return items;
  }

  /** Queues a URL immediately (as "downloading") and resolves `done` once it is playable. */
  async addUrl(actor: Actor, url: string, position: InsertPosition): Promise<{ item: QueueItem; done: Promise<QueueItem> }> {
    const placeholder = Downloader.placeholder(url);
    const cached = this.library.get(placeholder.id);
    const item = this.makeItem(actor, cached?.track ?? placeholder, cached ? 'ready' : 'downloading');
    await this.ensureVoice(actor);
    this.player.add([item], position);
    this.log(actor, `${verb(position)} “${item.track.title}” from ${placeholder.artist}`);
    if (cached) return { item, done: Promise.resolve(item) };

    const done = this.downloader
      .get(url, (progress) => {
        item.progress = progress;
        this.queueState();
      })
      .then((track) => {
        item.track = track;
        item.status = 'ready';
        item.progress = undefined;
        this.player.itemUpdated(item);
        return item;
      })
      .catch((err) => {
        item.status = 'error';
        item.error = errorMessage(err);
        item.progress = undefined;
        this.log(SYSTEM_ACTOR, `${item.error} (${placeholder.title})`);
        this.player.itemUpdated(item);
        throw err;
      });
    done.catch(() => {}); // callers may not await it
    return { item, done };
  }

  remove(actor: Actor, itemId: string) {
    const item = this.player.remove(itemId);
    if (!item) throw new Error('That item is no longer in the queue');
    this.log(actor, `removed “${item.track.title}”`);
    return item;
  }

  move(actor: Actor, itemId: string, toIndex: number) {
    const item = this.player.move(itemId, toIndex);
    if (!item) throw new Error('That item is no longer in the queue');
    this.log(actor, `moved “${item.track.title}” to #${this.player.queue.indexOf(item) + 1}`, `move:${item.id}`);
    return item;
  }

  jump(actor: Actor, itemId: string) {
    const item = this.player.jump(itemId);
    if (!item) throw new Error('That item is no longer in the queue');
    this.log(actor, `jumped to “${item.track.title}”`);
    return item;
  }

  clear(actor: Actor) {
    const n = this.player.queue.length;
    this.player.clear();
    this.log(actor, `cleared the queue (${n} track${n === 1 ? '' : 's'})`);
  }

  shuffle(actor: Actor) {
    if (this.player.queue.length < 2) throw new Error('Not enough tracks in the queue to shuffle');
    this.player.shuffle();
    this.log(actor, 'shuffled the queue');
  }

  // ---------------------------------------------------------------- transport

  async toggle(actor: Actor) {
    const wasPaused = this.player.isPaused || !this.player.current;
    if (wasPaused) await this.ensureVoice(actor);
    if (!this.player.togglePause()) throw new Error('The queue is empty');
    this.log(actor, wasPaused ? 'resumed playback' : 'paused playback', 'toggle');
  }

  pause(actor: Actor) {
    if (!this.player.current) throw new Error('Nothing is playing');
    if (this.player.isPaused) throw new Error('Already paused');
    this.player.pause();
    this.log(actor, 'paused playback', 'toggle');
  }

  async resume(actor: Actor) {
    await this.ensureVoice(actor);
    if (this.player.current && !this.player.isPaused) throw new Error('Already playing');
    if (!this.player.play()) throw new Error('The queue is empty');
    this.log(actor, 'resumed playback', 'toggle');
  }

  next(actor: Actor) {
    const skipped = this.player.current;
    if (!this.player.next()) throw new Error('Nothing to skip');
    this.log(actor, skipped ? `skipped “${skipped.track.title}”` : 'started the queue');
  }

  previous(actor: Actor) {
    if (!this.player.current && this.player.history.length === 0) throw new Error('Nothing to go back to');
    this.player.previous();
    this.log(actor, `went back to “${this.player.current?.track.title ?? '…'}”`, 'prev');
  }

  stop(actor: Actor) {
    if (!this.player.current) throw new Error('Nothing is playing');
    this.player.stop();
    this.log(actor, 'stopped playback');
  }

  seek(actor: Actor, seconds: number) {
    if (!this.player.current) throw new Error('Nothing is playing');
    if (this.player.current.status !== 'ready') throw new Error('The track is still loading');
    this.player.seek(seconds);
    this.log(actor, `seeked to ${formatTime(seconds)}`, 'seek');
  }

  setVolume(actor: Actor, volume: number) {
    this.player.setVolume(volume);
    this.log(actor, `set the volume to ${this.player.volume}%`, 'volume');
  }

  setRepeat(actor: Actor, mode: RepeatMode) {
    this.player.setRepeat(mode);
    this.log(actor, mode === 'off' ? 'turned repeat off' : mode === 'one' ? 'set repeat to the current track' : 'set repeat to the whole queue', 'repeat');
  }

  // ---------------------------------------------------------------- voice

  async join(actor: Actor, channelId: string) {
    if (!this.voice) throw new Error('The Discord bot is offline');
    const name = await this.voice.join(channelId);
    this.log(actor, `brought the bot to 🔊 ${name}`);
  }

  leave(actor: Actor) {
    if (!this.voice?.leave()) throw new Error('The bot is not in a voice channel');
    this.log(actor, 'disconnected the bot from voice');
  }

  /** Joins a voice channel automatically if the bot isn't in one (best effort). */
  private async ensureVoice(actor: Actor) {
    if (!this.voice || this.voice.isConnected()) return;
    try {
      const name = await this.voice.autoJoin();
      if (name) this.log(actor, `brought the bot to 🔊 ${name}`);
    } catch (err) {
      log.warn('voice', `Auto-join failed: ${errorMessage(err)}`);
    }
  }

  // ---------------------------------------------------------------- persistence

  private makeItem(actor: Actor, track: Track, status: QueueItem['status']): QueueItem {
    return { id: randomId(), track, addedBy: actor.name, addedById: actor.id, addedByAvatar: actor.avatar, addedAt: Date.now(), status };
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((err) => log.warn('state', `Could not save state: ${errorMessage(err)}`));
    }, 2000);
  }

  async save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmp = this.statePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.player.snapshot()));
    await fs.rename(tmp, this.statePath);
  }

  async restore() {
    try {
      const data = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as PersistedPlayer;
      this.player.restore(data);
      if (this.player.queue.length) log.info('state', `Restored ${this.player.queue.length} queued tracks`);
    } catch {
      /* first run */
    }
  }
}

function verb(position: InsertPosition) {
  return position === 'now' ? 'is now playing' : position === 'next' ? 'queued up next:' : 'added';
}

function describe(tracks: Track[]) {
  if (tracks.length === 1) return `“${tracks[0].title}” by ${tracks[0].artist}`;
  return `${tracks.length} tracks`;
}
