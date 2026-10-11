import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Library } from '../src/library.js';
import { Player } from '../src/player.js';

/** A player with a fake stream, recording the gain it is given. */
function playerWithStream(volume = 80) {
  const gains: number[] = [];
  const player = new Player({} as Library, 'ffmpeg', volume);
  (player as unknown as { resource: unknown }).resource = { volume: { setVolumeLogarithmic: (g: number) => gains.push(g) } };
  return { player, gains, last: () => gains.at(-1) };
}

test('duck fades the music down, then back up when its time runs out', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    const { player, gains, last } = playerWithStream(80);
    player.duck(0.25, 10);
    assert.equal(player.ducked, true);
    mock.timers.tick(100);
    assert.ok(last()! < 0.8 && last()! > 0.2, 'fading, not jumping');
    mock.timers.tick(200);
    assert.equal(last(), 0.2);
    assert.equal(player.volume, 80); // the volume setting is untouched

    player.setVolume(40); // a volume change while ducked keeps the duck
    assert.equal(last(), 0.1);

    mock.timers.tick(10_000); // expired: fade back up
    mock.timers.tick(1_000);
    assert.equal(player.ducked, false);
    assert.equal(last(), 0.4);
    assert.ok(gains.length > 10);
  } finally {
    mock.timers.reset();
  }
});

test('renewing keeps the music down, and level 1 brings it back now', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    const { player, last } = playerWithStream(100);
    player.duck(0.3, 10);
    mock.timers.tick(8_000);
    player.duck(0.3, 10);
    mock.timers.tick(8_000);
    assert.equal(last(), 0.3);
    player.duck(1, 0);
    mock.timers.tick(1_000);
    assert.equal(last(), 1);
  } finally {
    mock.timers.reset();
  }
});
