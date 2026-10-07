import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  type AudioPlayer,
  type AudioResource,
} from '@discordjs/voice';
import type { Library } from './library.js';
import type { InsertPosition, PlaybackStatus, QueueItem, RepeatMode } from './types.js';
import { clamp, log, randomId, shuffleInPlace } from './util.js';

const HISTORY_LIMIT = 50;

interface ResourceMeta {
  gen: number;
}

export interface PersistedPlayer {
  volume: number;
  repeat: RepeatMode;
  queue: QueueItem[];
}

/**
 * Queue + audio engine. Decodes files with ffmpeg into raw PCM which @discordjs/voice
 * encodes to Opus. Emits 'change' whenever anything observable changes.
 */
export class Player extends EventEmitter {
  readonly audio: AudioPlayer;
  current: QueueItem | null = null;
  queue: QueueItem[] = [];
  history: QueueItem[] = [];
  volume: number;
  repeat: RepeatMode = 'off';

  private paused = false;
  /** Incremented every time the active stream is replaced, so stale Idle events are ignored. */
  private gen = 0;
  private seekOffset = 0;
  private resource: AudioResource<ResourceMeta> | null = null;
  private ffmpeg: ChildProcess | null = null;

  constructor(
    private readonly library: Library,
    private readonly ffmpegPath: string,
    volume: number,
  ) {
    super();
    this.volume = clamp(volume, 0, 100);
    this.audio = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 250 } });

    this.audio.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing && this.paused) this.audio.pause(true);
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        const meta = (oldState as { resource?: AudioResource<ResourceMeta> }).resource?.metadata;
        if (meta?.gen === this.gen) {
          this.resource = null;
          this.finishCurrent(false);
          return;
        }
      }
      this.changed();
    });

    this.audio.on('error', (err) => {
      const meta = (err.resource as AudioResource<ResourceMeta>).metadata;
      if (meta?.gen !== this.gen || !this.current) return;
      log.warn('player', `Playback error for "${this.current.track.title}": ${err.message}`);
      this.emit('trackError', this.current, err.message);
    });
  }

  // ---------------------------------------------------------------- state

  get status(): PlaybackStatus {
    if (!this.current) return 'idle';
    if (this.current.status !== 'ready' || !this.resource) return this.paused ? 'paused' : 'loading';
    switch (this.audio.state.status) {
      case AudioPlayerStatus.Playing:
        return 'playing';
      case AudioPlayerStatus.Paused:
        return 'paused';
      case AudioPlayerStatus.AutoPaused:
        return this.paused ? 'paused' : 'waiting';
      default:
        return this.paused ? 'paused' : 'loading';
    }
  }

  get position(): number {
    if (!this.current) return 0;
    return this.seekOffset + (this.resource?.playbackDuration ?? 0) / 1000;
  }

  private changed() {
    this.emit('change');
  }

  // ---------------------------------------------------------------- queue

  add(items: QueueItem[], position: InsertPosition) {
    if (items.length === 0) return;
    if (position === 'end') this.queue.push(...items);
    else this.queue.splice(0, 0, ...items);

    if (position === 'now') {
      this.paused = false;
      this.finishCurrent(true);
    }
    else if (!this.current) this.advance();
    else this.changed();
  }

  remove(itemId: string): QueueItem | null {
    if (this.current?.id === itemId) {
      const item = this.current;
      this.finishCurrent(true, { skipRepeat: true });
      return item;
    }
    const idx = this.queue.findIndex((i) => i.id === itemId);
    if (idx === -1) return null;
    const [item] = this.queue.splice(idx, 1);
    this.changed();
    return item;
  }

  move(itemId: string, toIndex: number): QueueItem | null {
    const from = this.queue.findIndex((i) => i.id === itemId);
    if (from === -1) return null;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(clamp(Math.round(toIndex), 0, this.queue.length), 0, item);
    this.changed();
    return item;
  }

  /** Plays a queued item right away, leaving the rest of the queue intact. */
  jump(itemId: string): QueueItem | null {
    const idx = this.queue.findIndex((i) => i.id === itemId);
    if (idx === -1) return null;
    const [item] = this.queue.splice(idx, 1);
    this.queue.unshift(item);
    this.paused = false;
    this.finishCurrent(true);
    return item;
  }

  clear() {
    this.queue = [];
    this.changed();
  }

  shuffle() {
    shuffleInPlace(this.queue);
    this.changed();
  }

  findItem(itemId: string): QueueItem | undefined {
    if (this.current?.id === itemId) return this.current;
    return this.queue.find((i) => i.id === itemId);
  }

  /** Called when a queued URL item finished downloading (or failed). */
  itemUpdated(item: QueueItem) {
    if (item === this.current) {
      if (item.status === 'ready' && !this.resource) this.startStream(0);
      else if (item.status === 'error') this.finishCurrent(true, { skipRepeat: true, noHistory: true });
    }
    this.changed();
  }

  // ---------------------------------------------------------------- transport

  play(): boolean {
    if (!this.current) {
      if (this.queue.length === 0) return false;
      this.paused = false;
      this.advance();
      return true;
    }
    this.resume();
    return true;
  }

  pause() {
    if (!this.current) return;
    this.paused = true;
    this.audio.pause(true);
    this.changed();
  }

  resume() {
    if (!this.current) return;
    this.paused = false;
    this.audio.unpause();
    this.changed();
  }

  togglePause(): boolean {
    if (!this.current) return this.play();
    if (this.paused) this.resume();
    else this.pause();
    return true;
  }

  get isPaused() {
    return this.paused;
  }

  next(): boolean {
    if (!this.current && this.queue.length === 0) return false;
    this.paused = false;
    this.finishCurrent(true);
    return true;
  }

  previous() {
    if (this.current && (this.position > 3 || this.history.length === 0)) {
      this.seek(0);
      return;
    }
    const prev = this.history.shift();
    if (!prev) return;
    if (this.current) this.queue.unshift(this.current);
    this.current = prev;
    this.paused = false;
    this.startStream(0);
  }

  stop() {
    if (this.current) this.pushHistory(this.current);
    this.current = null;
    this.paused = false;
    this.killStream();
    this.changed();
  }

  seek(seconds: number) {
    if (!this.current || this.current.status !== 'ready') return;
    const max = this.current.track.duration > 0 ? Math.max(0, this.current.track.duration - 1) : Infinity;
    this.startStream(clamp(seconds, 0, max));
  }

  setVolume(volume: number) {
    this.volume = clamp(Math.round(volume), 0, 100);
    this.resource?.volume?.setVolumeLogarithmic(this.volume / 100);
    this.changed();
  }

  setRepeat(mode: RepeatMode) {
    this.repeat = mode;
    this.changed();
  }

  // ---------------------------------------------------------------- internals

  private pushHistory(item: QueueItem) {
    this.history.unshift(item);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
  }

  /** Ends the current item (naturally or via skip) and moves on according to the repeat mode. */
  private finishCurrent(manual: boolean, opts: { skipRepeat?: boolean; noHistory?: boolean } = {}) {
    const cur = this.current;
    if (cur) {
      if (!manual && this.repeat === 'one' && cur.status === 'ready') {
        this.startStream(0);
        return;
      }
      if (!opts.noHistory) this.pushHistory(cur);
      if (this.repeat === 'all' && !opts.skipRepeat && cur.status === 'ready') {
        this.queue.push({ ...cur, id: randomId() });
      }
    }
    this.advance();
  }

  private advance() {
    this.killStream();
    const item = this.queue.shift() ?? null;
    this.current = item;
    this.seekOffset = 0;
    if (!item) {
      this.paused = false;
      this.changed();
      return;
    }
    if (item.status === 'error') {
      this.advance();
      return;
    }
    this.emit('trackStart', item);
    if (item.status === 'ready') this.startStream(0);
    else this.changed(); // downloading: itemUpdated() starts it later
  }

  private killStream() {
    this.gen++;
    this.resource = null;
    if (this.ffmpeg) {
      this.ffmpeg.kill();
      this.ffmpeg = null;
    }
    this.audio.stop(true);
  }

  private startStream(seek: number) {
    const item = this.current;
    if (!item) return;
    const entry = this.library.get(item.track.id);
    this.killStream();
    if (!entry) {
      item.status = 'error';
      item.error = 'File is no longer available';
      this.emit('trackError', item, item.error);
      this.finishCurrent(true, { skipRepeat: true });
      return;
    }

    const gen = this.gen;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (seek > 0) args.push('-ss', seek.toFixed(3));
    args.push('-i', entry.filePath, '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');
    const proc = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.ffmpeg = proc;
    let stderr = '';
    proc.stderr!.on('data', (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString();
    });
    proc.stdout!.on('error', () => {});
    proc.on('error', (err) => {
      log.error('player', `Failed to start ffmpeg (${this.ffmpegPath}): ${err.message}`);
      if (gen === this.gen) this.emit('trackError', item, 'ffmpeg is not available on the server');
    });
    proc.on('close', (code, signal) => {
      if (code && !signal && stderr.trim()) log.warn('player', `ffmpeg exited ${code}: ${stderr.trim()}`);
    });

    const resource = createAudioResource<ResourceMeta>(proc.stdout!, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: { gen },
    });
    resource.volume?.setVolumeLogarithmic(this.volume / 100);
    this.resource = resource;
    this.seekOffset = seek;
    this.audio.play(resource);
    this.changed();
  }

  // ---------------------------------------------------------------- persistence

  snapshot(): PersistedPlayer {
    const queue = [...(this.current ? [this.current] : []), ...this.queue].filter((i) => i.status === 'ready');
    return { volume: this.volume, repeat: this.repeat, queue };
  }

  restore(data: PersistedPlayer) {
    this.volume = clamp(data.volume ?? this.volume, 0, 100);
    this.repeat = data.repeat ?? 'off';
    this.queue = (data.queue ?? []).filter((i) => this.library.get(i.track.id));
    this.changed();
  }

  destroy() {
    this.killStream();
  }
}
