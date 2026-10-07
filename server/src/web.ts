import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Server as SocketServer } from 'socket.io';
import type { Config } from './config.js';
import type { Controller } from './controller.js';
import type { AckResult, Actor, ClientActions, InsertPosition, RepeatMode, SongSort, WebUser } from './types.js';
import type { Auth } from './auth.js';
import { errorMessage, log } from './util.js';

const POSITIONS: InsertPosition[] = ['end', 'next', 'now'];
const REPEATS: RepeatMode[] = ['off', 'all', 'one'];
const SORTS: SongSort[] = ['title', 'artist', 'album', 'recent', 'duration'];

type Handlers = {
  [K in keyof ClientActions]: (payload: ClientActions[K], actor: Actor) => unknown;
};

export async function startWeb(config: Config, controller: Controller, auth: Auth) {
  const app = Fastify({ logger: false, trustProxy: true });
  const lib = controller.library;
  auth.register(app);

  // ---------------------------------------------------------------- REST (read-only library access)

  app.get('/api/state', async () => controller.getState());

  app.get('/api/library/stats', async () => lib.stats());

  app.get<{ Querystring: { q?: string; sort?: string; offset?: string; limit?: string } }>('/api/library/songs', async (req) => {
    const sort = SORTS.includes(req.query.sort as SongSort) ? (req.query.sort as SongSort) : undefined;
    return lib.search(req.query.q ?? '', { sort, offset: Number(req.query.offset) || 0, limit: Number(req.query.limit) || 100 });
  });

  app.get<{ Querystring: { q?: string } }>('/api/library/albums', async (req) => {
    const q = (req.query.q ?? '').trim().toLowerCase();
    const albums = lib.albums();
    return q ? albums.filter((a) => `${a.name} ${a.artist}`.toLowerCase().includes(q)) : albums;
  });

  app.get<{ Params: { key: string } }>('/api/library/albums/:key', async (req, reply) => {
    const album = lib.albums().find((a) => a.key === req.params.key);
    if (!album) return reply.code(404).send({ error: 'Album not found' });
    return { album, tracks: lib.albumTracks(album.key) };
  });

  app.post('/api/library/rescan', async () => {
    void lib.scan();
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/cover/:id', async (req, reply) => {
    const cover = await lib.cover(req.params.id);
    if (!cover) return reply.code(404).send();
    return reply.header('content-type', cover.mime).header('cache-control', 'public, max-age=86400').send(cover.data);
  });

  // ---------------------------------------------------------------- static frontend

  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/socket.io')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send('<p>Web UI not built. Run <code>npm run build</code>, or use <code>npm run dev</code> and open http://localhost:5173.</p>'),
    );
  }

  // ---------------------------------------------------------------- realtime

  const io = new SocketServer(app.server, { cors: { origin: true } });

  const presence = () => {
    const users = new Map<string, Actor>();
    for (const s of io.sockets.sockets.values()) {
      const u = s.data.user as WebUser | undefined;
      if (u) users.set(u.id, { id: u.id, name: u.name, avatar: u.avatar });
    }
    return [...users.values()];
  };
  const broadcastPresence = () => io.emit('presence', presence());

  controller.on('state', (state) => io.emit('state', state));
  controller.on('activity', (event) => io.emit('activity', event));
  lib.on('stats', () => io.emit('library', lib.stats()));
  lib.on('changed', () => io.emit('library', lib.stats()));

  const requireText = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Missing ${what}`);
    return v;
  };
  const pos = (v: unknown): InsertPosition => (POSITIONS.includes(v as InsertPosition) ? (v as InsertPosition) : 'end');

  const handlers: Handlers = {
    'queue:add': ({ trackIds, position }, actor) => {
      if (!Array.isArray(trackIds) || trackIds.length === 0) throw new Error('No tracks given');
      return controller.addTracks(actor, trackIds.slice(0, 1000).map(String), pos(position)).then(() => undefined);
    },
    'queue:addUrl': ({ url, position }, actor) => controller.addUrl(actor, requireText(url, 'URL'), pos(position)).then(() => undefined),
    'queue:remove': ({ itemId }, actor) => controller.remove(actor, requireText(itemId, 'item')),
    'queue:move': ({ itemId, toIndex }, actor) => controller.move(actor, requireText(itemId, 'item'), Number(toIndex) || 0),
    'queue:jump': ({ itemId }, actor) => controller.jump(actor, requireText(itemId, 'item')),
    'queue:clear': (_p, actor) => controller.clear(actor),
    'queue:shuffle': (_p, actor) => controller.shuffle(actor),
    'player:toggle': (_p, actor) => controller.toggle(actor),
    'player:next': (_p, actor) => controller.next(actor),
    'player:prev': (_p, actor) => controller.previous(actor),
    'player:stop': (_p, actor) => controller.stop(actor),
    'player:seek': ({ position }, actor) => controller.seek(actor, Math.max(0, Number(position) || 0)),
    'player:volume': ({ volume }, actor) => controller.setVolume(actor, Number(volume) || 0),
    'player:repeat': ({ mode }, actor) => {
      if (!REPEATS.includes(mode)) throw new Error('Invalid repeat mode');
      controller.setRepeat(actor, mode);
    },
    'voice:join': ({ channelId }, actor) => controller.join(actor, requireText(channelId, 'channel')),
    'voice:leave': (_p, actor) => controller.leave(actor),
  };

  // Only logged-in users may connect; membership and display name are re-checked on every connect.
  io.use(async (socket, next) => {
    const session = auth.userFromCookie(socket.handshake.headers.cookie);
    if (!session || !(await auth.refresh(session).catch(() => true))) return next(new Error('unauthorized'));
    socket.data.user = session.user;
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as WebUser;
    const actor = (): Actor => ({ id: user.id, name: user.name, avatar: user.avatar });
    broadcastPresence();
    socket.emit('state', controller.getState());
    socket.emit('activity:init', controller.activity.slice(0, 50));
    socket.emit('library', lib.stats());
    socket.emit('presence', presence());

    for (const [event, handler] of Object.entries(handlers) as [keyof ClientActions, Handlers[keyof ClientActions]][]) {
      socket.on(event, async (payload: unknown, ack?: (res: AckResult) => void) => {
        try {
          await (handler as (p: unknown, a: Actor) => unknown)(payload ?? {}, actor());
          ack?.({ ok: true });
        } catch (err) {
          ack?.({ ok: false, error: errorMessage(err) });
        }
      });
    }
    socket.on('disconnect', broadcastPresence);
  });

  await app.listen({ host: config.host, port: config.port });
  log.info('web', `Web UI listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  return { app, io };
}
