import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { Library } from './library.js';
import { Downloader } from './downloader.js';
import { Player } from './player.js';
import { Controller } from './controller.js';
import { Bot } from './bot.js';
import { startWeb } from './web.js';
import { Auth } from './auth.js';
import { errorMessage, lanAddress, log } from './util.js';

async function main() {
  const ffmpeg = spawnSync(config.ffmpegPath, ['-version'], { windowsHide: true });
  if (ffmpeg.error) {
    log.error('boot', `ffmpeg not found ("${config.ffmpegPath}"). Install it or set FFMPEG_PATH in .env.`);
    process.exit(1);
  }

  await fs.mkdir(config.dataDir, { recursive: true });
  const library = new Library(config.musicDir, config.dataDir);
  await library.init(config.watchLibrary, config.watchPolling);

  const downloader = new Downloader(path.join(config.dataDir, 'downloads'), library, config.maxDownloadMb * 1024 * 1024);
  await downloader.init();

  const player = new Player(library, config.ffmpegPath, config.defaultVolume);
  const controller = new Controller(library, player, downloader, config.dataDir);
  await controller.restore();

  const bot: Bot | null = config.token ? new Bot(config, player) : null;
  const auth = new Auth(config, async (userId) => (bot ? bot.lookupMember(userId) : undefined));
  await auth.init();

  const { app } = await startWeb(config, controller, auth);
  const lan = lanAddress();
  if (lan) log.info('web', `On your network: http://${lan}:${config.port}`);

  if (bot) {
    controller.voice = bot;
    bot.start(controller).catch((err) => log.error('bot', `Discord login failed: ${errorMessage(err)}`));
  } else {
    log.warn('bot', 'DISCORD_TOKEN is not set — running the web UI without the Discord bot.');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('boot', `${signal} received, shutting down…`);
    await controller.save().catch(() => {});
    await auth.save();
    player.destroy();
    await bot?.destroy().catch(() => {});
    await library.close().catch(() => {});
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (err) => log.error('process', 'Unhandled rejection:', err));

main().catch((err) => {
  log.error('boot', err);
  process.exit(1);
});
