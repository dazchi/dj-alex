import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/** Repository root (server/src or server/dist → ../..). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const env = (key: string, fallback = '') => (process.env[key] ?? '').trim() || fallback;
const num = (key: string, fallback: number) => {
  const n = Number(env(key));
  return Number.isFinite(n) && env(key) !== '' ? n : fallback;
};

export const config = {
  token: env('DISCORD_TOKEN'),
  /** Server (guild) the bot operates in. Falls back to the first guild the bot is in. */
  guildId: env('DISCORD_GUILD_ID'),
  /** Voice channel joined automatically when music is queued from the web UI. Optional. */
  defaultVoiceChannelId: env('DISCORD_VOICE_CHANNEL_ID'),
  /** Leave the voice channel after it has been empty for this many minutes (0 = never). */
  autoLeaveMinutes: num('AUTO_LEAVE_MINUTES', 5),

  musicDir: path.resolve(ROOT, env('MUSIC_DIR', 'music')),
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
  watchLibrary: env('WATCH_LIBRARY', 'true') !== 'false',
  watchPolling: env('WATCH_POLLING', 'false') === 'true',

  host: env('HOST', '0.0.0.0'),
  port: num('HTTP_PORT', 3000),
  /** URL people use to open the web UI, shown by /web. Auto-detected from the LAN IP when empty. */
  publicUrl: env('PUBLIC_URL'),

  /** OAuth2 app for web login. The client ID defaults to the bot's application ID (read from the token). */
  clientId: env('DISCORD_CLIENT_ID') || clientIdFromToken(env('DISCORD_TOKEN')),
  clientSecret: env('DISCORD_CLIENT_SECRET'),
  /** Only members of the bot's server may log in to the web UI. */
  requireGuildMember: env('REQUIRE_GUILD_MEMBER', 'true') !== 'false',
  sessionDays: num('SESSION_DAYS', 30),
  /** Shared secret for the control API (/api/control/*). The API is off when empty. */
  controlToken: env('CONTROL_TOKEN'),
  discordApi: env('DISCORD_API_URL', 'https://discord.com/api/v10'),

  ffmpegPath: env('FFMPEG_PATH', 'ffmpeg'),
  maxDownloadMb: num('MAX_DOWNLOAD_MB', 200),
  defaultVolume: num('DEFAULT_VOLUME', 60),

  webDist: path.join(ROOT, 'web', 'dist'),
};

export type Config = typeof config;

/** A bot token's first segment is the base64-encoded bot user ID, which equals the application ID. */
function clientIdFromToken(token: string): string {
  try {
    const id = Buffer.from(token.split('.')[0] ?? '', 'base64').toString('utf8');
    return /^\d{15,25}$/.test(id) ? id : '';
  } catch {
    return '';
  }
}
