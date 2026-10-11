import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Auth } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { registerControl } from '../src/control.js';
import type { Controller } from '../src/controller.js';
import type { Actor, InsertPosition, QueueItem, Track } from '../src/types.js';

const TOKEN = 'secret-token';
const auth = { authorization: `Bearer ${TOKEN}` };

const song = (id: string, title: string, artist: string, album = 'Album'): Track => ({
  id,
  source: 'local',
  title,
  artist,
  album,
  duration: 200,
  hasCover: false,
});

const SONGS = [song('t1', '晴天', '周杰倫', '葉惠美'), song('t2', '七里香', '周杰倫', '七里香')];

/** Just enough of Controller for the control API, recording what was called. */
function fakeController() {
  const calls: { action: string; actor: string; args: unknown[] }[] = [];
  const queue: QueueItem[] = [];
  let current: QueueItem | null = null;
  let connected = false;
  const ducks: [number, number][] = [];
  const record = (action: string) => (actor: Actor, ...args: unknown[]) => {
    calls.push({ action, actor: actor.name, args });
  };
  const controller = {
    library: {
      get: (id: string) => SONGS.find((t) => t.id === id) && { track: SONGS.find((t) => t.id === id)! },
      findBest: (q: string) => SONGS.find((t) => `${t.title} ${t.artist}`.includes(q)) ?? null,
      albums: () => [{ key: 'k7', name: '七里香', artist: '周杰倫', trackCount: 1, duration: 200, coverTrackId: null }],
      albumTracks: () => [SONGS[1]],
      search: (q: string, { limit, offset = 0 }: { limit: number; offset?: number }) => {
        const items = SONGS.filter((t) => `${t.title} ${t.artist}`.includes(q));
        return { items: items.slice(offset, offset + limit), total: items.length, offset };
      },
    },
    player: {
      get current() {
        return current;
      },
      queue,
      duck: (level: number, seconds: number) => ducks.push([level, seconds]),
    },
    voice: { isConnected: () => connected },
    async addTracks(actor: Actor, ids: string[], position: InsertPosition) {
      calls.push({ action: 'addTracks', actor: actor.name, args: [ids, position] });
      const items = ids.map((id) => ({ id: `q-${id}`, track: SONGS.find((t) => t.id === id)!, addedBy: actor.name, addedAt: 0, status: 'ready' as const }));
      if (position === 'now') current = items[0];
      else queue.push(...items);
      return items;
    },
    async join(actor: Actor, channelId: string) {
      calls.push({ action: 'join', actor: actor.name, args: [channelId] });
      connected = true;
      return 'Lounge';
    },
    pause: record('pause'),
    next: record('next'),
    setVolume: record('setVolume'),
    setRepeat: record('setRepeat'),
    shuffle() {
      throw new Error('Not enough tracks in the queue to shuffle');
    },
    getState: () => ({
      status: current ? 'playing' : 'idle',
      current,
      queue,
      history: [],
      position: 30,
      positionAt: Date.now(),
      volume: 60,
      repeat: 'off',
      voice: { channelId: connected ? '42' : null, channelName: connected ? 'Lounge' : null, listeners: [{ id: '1', name: 'Darren', avatar: '' }] },
    }),
  };
  return { controller: controller as unknown as Controller, calls, ducks };
}

/** Like startWeb: the web login guard is registered first, then the control API. */
async function setup() {
  const app = Fastify();
  const fake = fakeController();
  new Auth({} as Config, async () => undefined).register(app);
  app.get('/api/state', async () => ({}));
  registerControl(app, fake.controller, TOKEN);
  await app.ready();
  return { app, ...fake };
}

test('requests without the token are refused', async () => {
  const { app, calls } = await setup();
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }]) {
    const res = await app.inject({ method: 'POST', url: '/api/control/skip', headers });
    assert.equal(res.statusCode, 401);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/control/status' })).statusCode, 401);
  assert.deepEqual(calls, []);
});

test('play finds the song, joins the requester and reports the result', async () => {
  const { app, calls } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/api/control/play',
    headers: auth,
    payload: { query: '晴天', position: 'now', channelId: '42', actor: 'Alex (for Darren)' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.track, { title: '晴天', artist: '周杰倫', album: '葉惠美' });
  assert.equal(body.placement, 'now playing');
  assert.equal(body.current.title, '晴天');
  assert.equal(body.voiceChannel, 'Lounge');
  assert.deepEqual(
    calls.map((c) => [c.action, c.actor]),
    [
      ['join', 'Alex (for Darren)'],
      ['addTracks', 'Alex (for Darren)'],
    ],
  );
});

test('play does not move a bot that is already in a voice channel', async () => {
  const { app, calls } = await setup();
  await app.inject({ method: 'POST', url: '/api/control/join', headers: auth, payload: { channelId: '1' } });
  await app.inject({ method: 'POST', url: '/api/control/play', headers: auth, payload: { query: '七里香', channelId: '2' } });
  assert.deepEqual(
    calls.map((c) => c.action),
    ['join', 'addTracks'],
  );
  assert.equal(calls[1].actor, 'Voice assistant');
});

test('album queues every track of the matching album', async () => {
  const { app, calls } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/control/album', headers: auth, payload: { name: '七里' } });
  assert.deepEqual(res.json().album, { name: '七里香', artist: '周杰倫' });
  assert.deepEqual(calls.at(-1)?.args, [['t2'], 'end']);
});

test('errors are reported as 400 with a message', async () => {
  const { app } = await setup();
  const missing = await app.inject({ method: 'POST', url: '/api/control/play', headers: auth, payload: { query: '不存在' } });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error, /No songs in the library match/);
  const shuffle = await app.inject({ method: 'POST', url: '/api/control/shuffle', headers: auth });
  assert.equal(shuffle.json().error, 'Not enough tracks in the queue to shuffle');
  const repeat = await app.inject({ method: 'POST', url: '/api/control/repeat', headers: auth, payload: { mode: 'twice' } });
  assert.equal(repeat.statusCode, 400);
  const unknown = await app.inject({ method: 'POST', url: '/api/control/toString', headers: auth });
  assert.equal(unknown.statusCode, 404);
});

test('simple actions and status', async () => {
  const { app, calls } = await setup();
  await app.inject({ method: 'POST', url: '/api/control/volume', headers: auth, payload: { volume: 30 } });
  await app.inject({ method: 'POST', url: '/api/control/skip', headers: auth });
  assert.deepEqual(
    calls.map((c) => [c.action, c.args]),
    [
      ['setVolume', [30]],
      ['next', []],
    ],
  );
  const status = (await app.inject({ method: 'GET', url: '/api/control/status', headers: auth })).json();
  assert.equal(status.status, 'idle');
  assert.equal(status.current, null);
  assert.deepEqual(status.listeners, ['Darren']);
});

test('duck lowers the music only in the caller\'s channel and is not logged', async () => {
  const { app, calls, ducks } = await setup();
  const duck = (payload: object) => app.inject({ method: 'POST', url: '/api/control/duck', headers: auth, payload });
  assert.deepEqual((await duck({ channelId: '42' })).json(), { ok: true, ducked: false }); // not in a channel yet
  await app.inject({ method: 'POST', url: '/api/control/join', headers: auth, payload: { channelId: '42' } });
  assert.deepEqual((await duck({ channelId: '42', level: 25, seconds: 500 })).json(), { ok: true, ducked: true });
  assert.deepEqual((await duck({ channelId: '7' })).json(), { ok: true, ducked: false }); // music plays elsewhere
  assert.deepEqual((await duck({ channelId: '7', level: 100 })).json(), { ok: true, ducked: false }); // release always applies
  assert.deepEqual(ducks, [
    [0.25, 120],
    [1, 30],
  ]);
  assert.deepEqual(
    calls.map((c) => c.action),
    ['join'],
  );
  const unauthorized = await app.inject({ method: 'POST', url: '/api/control/duck', payload: {} });
  assert.equal(unauthorized.statusCode, 401);
});

test('the control API works without a web login, the rest of /api does not', async () => {
  const { app } = await setup();
  assert.equal((await app.inject({ method: 'GET', url: '/api/control/status', headers: auth })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/control/duck', headers: auth, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/state', headers: auth })).statusCode, 401);
});

test('search lists matching songs', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: `/api/control/search?q=${encodeURIComponent('周杰倫')}&limit=1`, headers: auth });
  assert.deepEqual(res.json(), { ok: true, total: 2, songs: [{ title: '晴天', artist: '周杰倫', album: '葉惠美' }] });
  assert.equal((await app.inject({ method: 'GET', url: '/api/control/search?q=x' })).statusCode, 401);
});

test('play without a song name picks a random library song other than the current one', async () => {
  const { app, calls } = await setup();
  const play = (payload: object) => app.inject({ method: 'POST', url: '/api/control/play', headers: auth, payload });
  const first = (await play({ position: 'now' })).json();
  assert.equal(first.picked, 'random');
  for (let i = 0; i < 10; i++) {
    const next = (await play({ query: '  ', position: 'now' })).json();
    assert.notDeepEqual(next.track, first.track); // never the song that is playing
    assert.equal(next.picked, 'random');
    first.track = next.track;
  }
  assert.equal(calls.filter((c) => c.action === 'addTracks').length, 11);
});
