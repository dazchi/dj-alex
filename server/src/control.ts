import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Controller } from './controller.js';
import type { Actor, InsertPosition, QueueItem, RepeatMode, SongSort, Track } from './types.js';
import { errorMessage } from './util.js';

const POSITIONS: InsertPosition[] = ['end', 'next', 'now'];
const REPEATS: RepeatMode[] = ['off', 'all', 'one'];
const UP_NEXT = 10;
const DEFAULT_DUCK_LEVEL = 30;
const MAX_DUCK_SECONDS = 120;
const MAX_SEARCH_RESULTS = 20;
const MAX_LATEST = 20;

interface ControlBody {
  /** Shown in the activity feed and on queued songs, e.g. "Alex (for Darren)". */
  actor?: string;
  /** Voice channel to join if the bot is not in one yet (the requester's channel). */
  channelId?: string;
  query?: string;
  /** play: queue the N most recently added songs, newest first (instead of query). */
  latest?: number;
  name?: string;
  position?: string;
  volume?: number;
  mode?: string;
  /** duck: music level while ducked, in percent of the volume (100 = back to normal). */
  level?: number;
  /** duck: fade back up after this many seconds unless renewed (0 = now). */
  seconds?: number;
}

type Action = (body: ControlBody, actor: Actor) => Promise<unknown> | unknown;

/** Title, artist and album exactly as tagged in the library. */
const trackInfo = (t: Track) => ({ title: t.title, artist: t.artist, album: t.album });

/** trackInfo plus the day the song was added to the library (YYYY-MM-DD), when known. */
const songInfo = (t: Track) => ({ ...trackInfo(t), ...(t.addedAt ? { added: new Date(t.addedAt).toISOString().slice(0, 10) } : {}) });

/**
 * Lets another program (such as a voice assistant bot) control playback with a shared secret:
 * `Authorization: Bearer <CONTROL_TOKEN>`. Not registered when CONTROL_TOKEN is empty.
 */
export function registerControl(app: FastifyInstance, controller: Controller, token: string) {
  const expected = crypto.createHash('sha256').update(token).digest();
  const authorized = (req: FastifyRequest) => {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), expected);
  };

  const lib = controller.library;
  const player = controller.player;
  const position = (v: unknown): InsertPosition => (POSITIONS.includes(v as InsertPosition) ? (v as InsertPosition) : 'end');
  const required = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Missing ${what}`);
    return v.trim();
  };
  const placement = (item: QueueItem) => {
    if (player.current === item) return 'now playing';
    const index = player.queue.indexOf(item);
    return index >= 0 ? `queued at #${index + 1}` : 'queued';
  };

  /** Joins the requester's channel first, so the bot doesn't pick another channel on its own. */
  const joinRequester = async (body: ControlBody, actor: Actor) => {
    if (controller.voice?.isConnected() || !body.channelId) return;
    await controller.join(actor, body.channelId);
  };

  const status = () => {
    const state = controller.getState();
    const current = state.current;
    const position = state.status === 'playing' ? state.position + (Date.now() - state.positionAt) / 1000 : state.position;
    return {
      status: state.status,
      current: current && {
        title: current.track.title,
        artist: current.track.artist,
        album: current.track.album,
        position: Math.round(position),
        duration: Math.round(current.track.duration),
        addedBy: current.addedBy,
      },
      upNext: state.queue.slice(0, UP_NEXT).map((item) => trackInfo(item.track)),
      queueLength: state.queue.length,
      volume: state.volume,
      repeat: state.repeat,
      voiceChannel: state.voice.channelName,
      listeners: state.voice.listeners.map((m) => m.name),
    };
  };

  const actions: Record<string, Action> = {
    play: async (body, actor) => {
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      const where = position(body.position);
      if (body.latest !== undefined) {
        const count = Math.min(MAX_LATEST, Math.max(1, Math.floor(Number(body.latest)) || 1));
        const tracks = lib.search('', { sort: 'recent', limit: count }).items;
        if (tracks.length === 0) throw new Error('The music library is empty');
        await joinRequester(body, actor);
        const [item] = await controller.addTracks(actor, tracks.map((t) => t.id), where);
        return { track: trackInfo(tracks[0]), placement: placement(item), picked: 'latest', songs: tracks.map(songInfo) };
      }
      if (!query) {
        // No song named ("play some music"): a random song from the library, other than the one playing.
        const total = lib.search('', { limit: 1 }).total;
        if (total === 0) throw new Error('The music library is empty');
        const pick = crypto.randomInt(total);
        let track = lib.search('', { offset: pick, limit: 1 }).items[0];
        if (total > 1 && track.id === player.current?.track.id) {
          track = lib.search('', { offset: (pick + 1) % total, limit: 1 }).items[0];
        }
        await joinRequester(body, actor);
        const [item] = await controller.addTracks(actor, [track.id], where);
        return { track: trackInfo(track), placement: placement(item), picked: 'random' };
      }
      await joinRequester(body, actor);
      if (/^https?:\/\//i.test(query)) {
        const { item } = await controller.addUrl(actor, query, where);
        return { track: trackInfo(item.track), placement: placement(item) };
      }
      const track = lib.get(query)?.track ?? lib.findBest(query);
      if (!track) throw new Error(`No songs in the library match "${query}"`);
      const [item] = await controller.addTracks(actor, [track.id], where);
      return { track: trackInfo(track), placement: placement(item) };
    },
    album: async (body, actor) => {
      const name = required(body.name, 'album name').toLowerCase();
      const albums = lib.albums();
      const album =
        albums.find((a) => a.key === name || a.name.toLowerCase() === name) ??
        albums.find((a) => a.name.toLowerCase().includes(name) || `${a.artist} ${a.name}`.toLowerCase().includes(name));
      if (!album) throw new Error(`No album matches "${body.name}"`);
      await joinRequester(body, actor);
      const tracks = lib.albumTracks(album.key);
      await controller.addTracks(actor, tracks.map((t) => t.id), position(body.position));
      return { album: { name: album.name, artist: album.artist }, tracks: tracks.length };
    },
    pause: (_body, actor) => controller.pause(actor),
    resume: async (body, actor) => {
      await joinRequester(body, actor);
      await controller.resume(actor);
    },
    skip: (_body, actor) => controller.next(actor),
    previous: (_body, actor) => controller.previous(actor),
    stop: (_body, actor) => controller.stop(actor),
    shuffle: (_body, actor) => controller.shuffle(actor),
    clear: (_body, actor) => controller.clear(actor),
    volume: (body, actor) => {
      const volume = Number(body.volume);
      if (!Number.isFinite(volume)) throw new Error('Missing volume (0-100)');
      controller.setVolume(actor, volume);
    },
    repeat: (body, actor) => {
      if (!REPEATS.includes(body.mode as RepeatMode)) throw new Error('Repeat mode must be off, one or all');
      controller.setRepeat(actor, body.mode as RepeatMode);
    },
    join: (body, actor) => controller.join(actor, required(body.channelId, 'channelId')),
    leave: (_body, actor) => controller.leave(actor),
  };

  /**
   * Lowers the music while the caller speaks, without touching the volume setting or the activity feed.
   * With channelId, only when the music plays in that channel.
   */
  const duck = (body: ControlBody) => {
    const level = body.level === undefined ? DEFAULT_DUCK_LEVEL : Number(body.level);
    const seconds = body.seconds === undefined ? 30 : Number(body.seconds);
    if (!Number.isFinite(level) || !Number.isFinite(seconds)) throw new Error('level and seconds must be numbers');
    const release = level >= 100 || seconds <= 0;
    const channel = controller.getState().voice.channelId;
    if (!release && body.channelId && channel !== body.channelId) return { ducked: false };
    player.duck(level / 100, Math.min(seconds, MAX_DUCK_SECONDS));
    return { ducked: !release };
  };

  const deny = (reply: FastifyReply) => reply.code(401).send({ ok: false, error: 'Unauthorized' });

  app.get('/api/control/status', async (req, reply) => (authorized(req) ? { ok: true, ...status() } : deny(reply)));

  app.get<{ Querystring: { q?: string; limit?: string; sort?: string } }>('/api/control/search', async (req, reply) => {
    if (!authorized(req)) return deny(reply);
    const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(req.query.limit) || 8));
    // sort=recent: newest additions first (with no q, the latest songs in the library).
    const sort = req.query.sort === 'recent' ? ('recent' as SongSort) : undefined;
    const page = lib.search(req.query.q ?? '', { limit, sort });
    return { ok: true, total: page.total, songs: page.items.map(songInfo) };
  });

  app.post<{ Params: { action: string }; Body: ControlBody | undefined }>('/api/control/:action', async (req, reply) => {
    if (!authorized(req)) return deny(reply);
    if (req.params.action === 'duck') {
      try {
        return { ok: true, ...duck(req.body ?? {}) };
      } catch (err) {
        return reply.code(400).send({ ok: false, error: errorMessage(err) });
      }
    }
    const action = Object.hasOwn(actions, req.params.action) ? actions[req.params.action] : undefined;
    if (!action) return reply.code(404).send({ ok: false, error: `Unknown action "${req.params.action}"` });
    const body = req.body ?? {};
    const actor: Actor = { name: (typeof body.actor === 'string' && body.actor.trim().slice(0, 64)) || 'Voice assistant' };
    try {
      const result = await action(body, actor);
      return { ok: true, ...(result && typeof result === 'object' ? result : {}), ...status() };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: errorMessage(err) });
    }
  });
}
