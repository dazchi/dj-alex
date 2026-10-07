import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type MessageComponentInteraction,
} from 'discord.js';
import type { Bot } from './bot.js';
import type { Config } from './config.js';
import type { Controller } from './controller.js';
import type { Actor, InsertPosition, QueueItem, RepeatMode, Track } from './types.js';
import { errorMessage, formatTime, lanAddress, log, parseTime, randomId } from './util.js';

export interface CommandContext {
  controller: Controller;
  bot: Bot;
  config: Config;
}

const ACCENT = 0x8b5cf6;
const POSITION_CHOICES = [
  { name: 'End of queue', value: 'end' },
  { name: 'Play next', value: 'next' },
  { name: 'Play now', value: 'now' },
] as const;

export const commandData = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a track from the library, or an audio file URL')
    .addStringOption((o) => o.setName('query').setDescription('Song title / artist, or an http(s) link to an audio file').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('position').setDescription('Where to put it in the queue').addChoices(...POSITION_CHOICES)),
  new SlashCommandBuilder()
    .setName('album')
    .setDescription('Queue a whole album from the library')
    .addStringOption((o) => o.setName('name').setDescription('Album name').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('position').setDescription('Where to put it in the queue').addChoices(...POSITION_CHOICES)),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search the library by keywords and pick songs to queue')
    .addStringOption((o) => o.setName('keywords').setDescription('Words from the title, artist, album or file name').setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip to the next track'),
  new SlashCommandBuilder().setName('previous').setDescription('Go back to the previous track'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback (the queue is kept)'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current track'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the queue')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue')
    .addIntegerOption((o) => o.setName('position').setDescription('Position in the queue (see /queue)').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move a track within the queue')
    .addIntegerOption((o) => o.setName('from').setDescription('Current position').setRequired(true).setMinValue(1))
    .addIntegerOption((o) => o.setName('to').setDescription('New position').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('jump')
    .setDescription('Play a queued track right now')
    .addIntegerOption((o) => o.setName('position').setDescription('Position in the queue').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the queue'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  new SlashCommandBuilder()
    .setName('repeat')
    .setDescription('Set the repeat mode')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Repeat mode')
        .setRequired(true)
        .addChoices({ name: 'Off', value: 'off' }, { name: 'Current track', value: 'one' }, { name: 'Whole queue', value: 'all' }),
    ),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Show or set the volume')
    .addIntegerOption((o) => o.setName('level').setDescription('0–100').setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Jump to a time in the current track')
    .addStringOption((o) => o.setName('time').setDescription('e.g. 1:30 or 90').setRequired(true)),
  new SlashCommandBuilder().setName('join').setDescription('Bring the bot to your voice channel'),
  new SlashCommandBuilder().setName('leave').setDescription('Disconnect the bot from voice'),
  new SlashCommandBuilder().setName('web').setDescription('Get the link to the web player'),
].map((c) => c.toJSON());

// ------------------------------------------------------------------ helpers

class UserError extends Error {}

type UserInteraction = ChatInputCommandInteraction | MessageComponentInteraction;

function actorOf(i: UserInteraction): Actor {
  const member = i.member as GuildMember | null;
  return {
    id: i.user.id,
    name: member?.displayName ?? i.user.globalName ?? i.user.username,
    avatar: (member ?? i.user).displayAvatarURL({ size: 64 }),
  };
}

function webUrl(config: Config) {
  return config.publicUrl || `http://${lanAddress() ?? 'localhost'}:${config.port}`;
}

function trackLine(item: QueueItem) {
  const t = item.track;
  const dur = t.duration ? ` \`${formatTime(t.duration)}\`` : '';
  const status = item.status === 'downloading' ? ' ⬇️' : item.status === 'error' ? ' ⚠️' : '';
  return `**${escape(t.title)}** — ${escape(t.artist)}${dur}${status}`;
}

function escape(text: string) {
  return text.replace(/([*_`~|\\>])/g, '\\$1');
}

function progressBar(position: number, duration: number, size = 18) {
  if (!duration) return `\`${formatTime(position)}\``;
  const filled = Math.min(size - 1, Math.round((position / duration) * (size - 1)));
  return `\`${formatTime(position)}\` ${'▬'.repeat(filled)}🔘${'▬'.repeat(size - 1 - filled)} \`${formatTime(duration)}\``;
}

/** Makes sure the bot is in a voice channel, preferring the caller's channel. */
async function ensureVoice(i: UserInteraction, ctx: CommandContext) {
  if (ctx.bot.isConnected()) return;
  const channelId = (i.member as GuildMember | null)?.voice.channelId;
  if (channelId) await ctx.controller.join(actorOf(i), channelId);
  else if (!ctx.config.defaultVoiceChannelId) throw new UserError('Join a voice channel first, then try again.');
}

function placementText(ctx: CommandContext, item: QueueItem) {
  if (ctx.controller.player.current === item) return 'Now playing';
  const idx = ctx.controller.player.queue.indexOf(item);
  return idx >= 0 ? `Queued at #${idx + 1}` : 'Queued';
}

// ------------------------------------------------------------------ /search results

const SEARCH_PAGE = 10;
const SEARCH_LIMIT = 500;
const SEARCH_TTL = 15 * 60_000;

interface SearchSession {
  query: string;
  tracks: Track[];
  total: number;
  page: number;
  position: 'end' | 'next';
  expires: number;
}

/** Open /search result messages, keyed by the id embedded in their component custom IDs. */
const searches = new Map<string, SearchSession>();

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function searchView(sid: string, s: SearchSession, notice = '') {
  const pages = Math.max(1, Math.ceil(s.tracks.length / SEARCH_PAGE));
  const start = s.page * SEARCH_PAGE;
  const slice = s.tracks.slice(start, start + SEARCH_PAGE);
  const more = s.total > s.tracks.length ? ` (showing first ${s.tracks.length})` : '';

  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(clip(`🔎 “${s.query}”`, 256))
    .setDescription(
      slice
        .map((t, n) => {
          const album = t.album ? ` · *${escape(t.album)}*` : '';
          const dur = t.duration ? ` \`${formatTime(t.duration)}\`` : '';
          return `\`${String(start + n + 1).padStart(2)}.\` **${escape(t.title)}** — ${escape(t.artist)}${album}${dur}`;
        })
        .join('\n'),
    )
    .setFooter({ text: `Page ${s.page + 1}/${pages} · ${s.total} result${s.total === 1 ? '' : 's'}${more}` });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`search:pick:${sid}`)
    .setPlaceholder(s.position === 'next' ? '⏭️ Select songs to play next…' : '➕ Select songs to add to the queue…')
    .setMinValues(1)
    .setMaxValues(slice.length)
    .addOptions(
      slice.map((t, n) => ({
        label: clip(`${start + n + 1}. ${t.title}`, 100),
        description: clip([t.artist, t.album, t.duration ? formatTime(t.duration) : ''].filter(Boolean).join(' · '), 100) || undefined,
        value: t.id,
      })),
    );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`search:prev:${sid}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(s.page === 0),
    new ButtonBuilder().setCustomId(`search:next:${sid}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(s.page >= pages - 1),
    new ButtonBuilder()
      .setCustomId(`search:mode:${sid}`)
      .setLabel(s.position === 'next' ? 'Adding: play next' : 'Adding: end of queue')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`search:page:${sid}`).setLabel('Queue this page').setStyle(ButtonStyle.Success),
  );

  return {
    content: notice,
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), buttons],
  };
}

/** Handles the select menu and buttons on /search results. */
export async function handleComponent(i: MessageComponentInteraction, ctx: CommandContext) {
  const [ns, action, sid] = i.customId.split(':');
  if (ns !== 'search' || !sid) return;
  const s = searches.get(sid);
  if (!s || s.expires < Date.now()) {
    searches.delete(sid ?? '');
    await i.update({ content: '⌛ This search expired. Run `/search` again.', embeds: [], components: [] }).catch(() => {});
    return;
  }
  s.expires = Date.now() + SEARCH_TTL;
  const pages = Math.max(1, Math.ceil(s.tracks.length / SEARCH_PAGE));

  try {
    switch (action) {
      case 'prev':
      case 'next':
        s.page = Math.min(pages - 1, Math.max(0, s.page + (action === 'next' ? 1 : -1)));
        await i.update(searchView(sid, s));
        return;
      case 'mode':
        s.position = s.position === 'end' ? 'next' : 'end';
        await i.update(searchView(sid, s));
        return;
      case 'pick':
      case 'page': {
        const ids =
          action === 'pick' && i.isStringSelectMenu()
            ? i.values
            : s.tracks.slice(s.page * SEARCH_PAGE, (s.page + 1) * SEARCH_PAGE).map((t) => t.id);
        await i.deferUpdate();
        await ensureVoice(i, ctx);
        const items = await ctx.controller.addTracks(actorOf(i), ids, s.position);
        const what = items.length === 1 ? `**${escape(items[0]!.track.title)}**` : `**${items.length} songs**`;
        await i.editReply(searchView(sid, s, `✅ Added ${what} ${s.position === 'next' ? 'to play next' : 'to the queue'}.`));
        return;
      }
    }
  } catch (err) {
    const notice = `❌ ${errorMessage(err)}`;
    if (i.deferred || i.replied) await i.editReply(searchView(sid, s, notice)).catch(() => {});
    else await i.reply({ content: notice, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

// ------------------------------------------------------------------ handlers

type Handler = (i: ChatInputCommandInteraction, ctx: CommandContext, actor: Actor) => Promise<void>;

const handlers: Record<string, Handler> = {
  async play(i, ctx, actor) {
    const query = i.options.getString('query', true).trim();
    const position = (i.options.getString('position') ?? 'end') as InsertPosition;
    await i.deferReply();
    await ensureVoice(i, ctx);

    if (/^https?:\/\//i.test(query)) {
      const { item, done } = await ctx.controller.addUrl(actor, query, position);
      if (item.status === 'downloading') {
        await i.editReply(`⬇️ Downloading **${escape(item.track.title)}**…`);
        try {
          await done;
        } catch (err) {
          await i.editReply(`❌ ${errorMessage(err)}`);
          return;
        }
      }
      await i.editReply({ content: '', embeds: [addedEmbed(ctx, item)] });
      return;
    }

    const lib = ctx.controller.library;
    const track = lib.get(query)?.track ?? lib.findBest(query);
    if (!track) throw new UserError(`No tracks in the library match **${escape(query)}**.`);
    const [item] = await ctx.controller.addTracks(actor, [track.id], position);
    await i.editReply({ embeds: [addedEmbed(ctx, item)] });
  },

  async album(i, ctx, actor) {
    const name = i.options.getString('name', true);
    const position = (i.options.getString('position') ?? 'end') as InsertPosition;
    const lib = ctx.controller.library;
    const album =
      lib.albums().find((a) => a.key === name) ?? lib.albums().find((a) => a.name.toLowerCase().includes(name.toLowerCase()));
    if (!album) throw new UserError(`No album matches **${escape(name)}**.`);
    await i.deferReply();
    await ensureVoice(i, ctx);
    const tracks = lib.albumTracks(album.key);
    await ctx.controller.addTracks(actor, tracks.map((t) => t.id), position);
    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(ACCENT)
          .setAuthor({ name: 'Album queued' })
          .setTitle(album.name)
          .setDescription(`${escape(album.artist)} · ${tracks.length} tracks · ${formatTime(album.duration)}`),
      ],
    });
  },

  async search(i, ctx) {
    const query = i.options.getString('keywords', true).trim();
    const { items, total } = ctx.controller.library.search(query, { limit: SEARCH_LIMIT });
    if (items.length === 0) throw new UserError(`No songs match **${escape(query)}**. Try fewer or different words.`);
    const now = Date.now();
    for (const [id, s] of searches) if (s.expires < now) searches.delete(id);
    const sid = randomId().slice(0, 8);
    const session: SearchSession = { query, tracks: items, total, page: 0, position: 'end', expires: now + SEARCH_TTL };
    searches.set(sid, session);
    await i.reply({ ...searchView(sid, session), flags: MessageFlags.Ephemeral });
  },

  async pause(i, ctx, actor) {
    ctx.controller.pause(actor);
    await i.reply('⏸️ Paused.');
  },

  async resume(i, ctx, actor) {
    await ensureVoice(i, ctx);
    await ctx.controller.resume(actor);
    await i.reply('▶️ Resumed.');
  },

  async skip(i, ctx, actor) {
    ctx.controller.next(actor);
    const cur = ctx.controller.player.current;
    await i.reply(cur ? `⏭️ Skipped. Now playing ${trackLine(cur)}` : '⏭️ Skipped. The queue is empty.');
  },

  async previous(i, ctx, actor) {
    ctx.controller.previous(actor);
    const cur = ctx.controller.player.current;
    await i.reply(cur ? `⏮️ Now playing ${trackLine(cur)}` : '⏮️ Went back.');
  },

  async stop(i, ctx, actor) {
    ctx.controller.stop(actor);
    await i.reply('⏹️ Stopped. The queue is still there — `/resume` to continue.');
  },

  async nowplaying(i, ctx) {
    const p = ctx.controller.player;
    const cur = p.current;
    if (!cur) throw new UserError('Nothing is playing. Queue something with `/play`!');
    const embed = new EmbedBuilder()
      .setColor(ACCENT)
      .setAuthor({ name: p.isPaused ? '⏸️ Paused' : '🎶 Now playing' })
      .setTitle(cur.track.title)
      .setDescription(`${escape(cur.track.artist)}${cur.track.album ? ` · *${escape(cur.track.album)}*` : ''}\n\n${progressBar(p.position, cur.track.duration)}`)
      .setFooter({ text: `Added by ${cur.addedBy} · Volume ${p.volume}% · Repeat ${p.repeat} · ${p.queue.length} up next` })
      .setURL(webUrl(ctx.config));
    const files: AttachmentBuilder[] = [];
    const cover = cur.track.hasCover ? await ctx.controller.library.cover(cur.track.id) : null;
    if (cover) {
      const ext = cover.mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';
      files.push(new AttachmentBuilder(cover.data, { name: `cover.${ext}` }));
      embed.setThumbnail(`attachment://cover.${ext}`);
    }
    await i.reply({ embeds: [embed], files });
  },

  async queue(i, ctx) {
    const p = ctx.controller.player;
    const perPage = 10;
    const pages = Math.max(1, Math.ceil(p.queue.length / perPage));
    const page = Math.min(pages, i.options.getInteger('page') ?? 1);
    const slice = p.queue.slice((page - 1) * perPage, page * perPage);
    const total = p.queue.reduce((s, it) => s + it.track.duration, 0);
    const lines = slice.map((it, idx) => `\`${String((page - 1) * perPage + idx + 1).padStart(2)}.\` ${trackLine(it)}`);
    const embed = new EmbedBuilder()
      .setColor(ACCENT)
      .setTitle('Queue')
      .setURL(webUrl(ctx.config))
      .setDescription(
        [
          p.current ? `**Now playing:** ${trackLine(p.current)}\n` : '*Nothing playing*\n',
          lines.length ? lines.join('\n') : '*The queue is empty.*',
        ].join('\n'),
      )
      .setFooter({ text: `Page ${page}/${pages} · ${p.queue.length} tracks · ${formatTime(total)} · Repeat ${p.repeat}` });
    await i.reply({ embeds: [embed] });
  },

  async remove(i, ctx, actor) {
    const item = queueAt(ctx, i.options.getInteger('position', true));
    ctx.controller.remove(actor, item.id);
    await i.reply(`🗑️ Removed ${trackLine(item)}`);
  },

  async move(i, ctx, actor) {
    const item = queueAt(ctx, i.options.getInteger('from', true));
    const to = i.options.getInteger('to', true);
    ctx.controller.move(actor, item.id, to - 1);
    await i.reply(`↕️ Moved ${trackLine(item)} to #${ctx.controller.player.queue.indexOf(item) + 1}`);
  },

  async jump(i, ctx, actor) {
    const item = queueAt(ctx, i.options.getInteger('position', true));
    await ensureVoice(i, ctx);
    ctx.controller.jump(actor, item.id);
    await i.reply(`⏩ Now playing ${trackLine(item)}`);
  },

  async clear(i, ctx, actor) {
    ctx.controller.clear(actor);
    await i.reply('🧹 Cleared the queue.');
  },

  async shuffle(i, ctx, actor) {
    ctx.controller.shuffle(actor);
    await i.reply('🔀 Shuffled the queue.');
  },

  async repeat(i, ctx, actor) {
    const mode = i.options.getString('mode', true) as RepeatMode;
    ctx.controller.setRepeat(actor, mode);
    await i.reply(mode === 'off' ? '➡️ Repeat is off.' : mode === 'one' ? '🔂 Repeating the current track.' : '🔁 Repeating the whole queue.');
  },

  async volume(i, ctx, actor) {
    const level = i.options.getInteger('level');
    if (level === null) {
      await i.reply(`🔊 Volume is **${ctx.controller.player.volume}%**.`);
      return;
    }
    ctx.controller.setVolume(actor, level);
    await i.reply(`🔊 Volume set to **${ctx.controller.player.volume}%**.`);
  },

  async seek(i, ctx, actor) {
    const seconds = parseTime(i.options.getString('time', true));
    if (seconds === null) throw new UserError('Use a time like `1:30` or `90`.');
    ctx.controller.seek(actor, seconds);
    await i.reply(`⏩ Seeked to \`${formatTime(seconds)}\`.`);
  },

  async join(i, ctx, actor) {
    const channelId = (i.member as GuildMember | null)?.voice.channelId;
    if (!channelId) throw new UserError('Join a voice channel first.');
    await i.deferReply();
    await ctx.controller.join(actor, channelId);
    await i.editReply(`🔊 Joined <#${channelId}>.`);
  },

  async leave(i, ctx, actor) {
    ctx.controller.leave(actor);
    await i.reply('👋 Left the voice channel.');
  },

  async web(i, ctx) {
    await i.reply({ content: `🎛️ Open the web player: ${webUrl(ctx.config)}`, flags: MessageFlags.Ephemeral });
  },
};

function queueAt(ctx: CommandContext, position: number): QueueItem {
  const item = ctx.controller.player.queue[position - 1];
  if (!item) throw new UserError(`There is no track at position ${position}. See \`/queue\`.`);
  return item;
}

function addedEmbed(ctx: CommandContext, item: QueueItem) {
  const t = item.track;
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: placementText(ctx, item) })
    .setTitle(t.title)
    .setDescription(`${escape(t.artist)}${t.album ? ` · *${escape(t.album)}*` : ''}${t.duration ? ` · \`${formatTime(t.duration)}\`` : ''}`);
}

export async function handleCommand(i: ChatInputCommandInteraction, ctx: CommandContext) {
  const handler = handlers[i.commandName];
  if (!handler) return;
  try {
    await handler(i, ctx, actorOf(i));
  } catch (err) {
    if (!(err instanceof UserError)) log.warn('bot', `/${i.commandName} failed: ${errorMessage(err)}`);
    const content = `❌ ${errorMessage(err)}`;
    try {
      if (i.deferred || i.replied) await i.editReply({ content, embeds: [] });
      else await i.reply({ content, flags: MessageFlags.Ephemeral });
    } catch {
      /* interaction expired */
    }
  }
}

export async function handleAutocomplete(i: AutocompleteInteraction, ctx: CommandContext) {
  const focused = i.options.getFocused(true);
  const q = String(focused.value ?? '');
  const lib = ctx.controller.library;
  const clip = (s: string) => (s.length > 100 ? s.slice(0, 99) + '…' : s);
  let choices: { name: string; value: string }[] = [];
  try {
    if (i.commandName === 'play') {
      // URLs: no suggestions, so Discord submits the full text as typed (choice values cap at 100 chars).
      if (!/^https?:\/\//i.test(q))
        choices = lib.search(q, { limit: 25 }).items.map((t) => ({
          name: clip(`${t.title} — ${t.artist}${t.duration ? ` (${formatTime(t.duration)})` : ''}`),
          value: t.id,
        }));
    } else if (i.commandName === 'album') {
      const lq = q.toLowerCase();
      choices = lib
        .albums()
        .filter((a) => !lq || `${a.name} ${a.artist}`.toLowerCase().includes(lq))
        .slice(0, 25)
        .map((a) => ({ name: clip(`${a.name} — ${a.artist} (${a.trackCount})`), value: a.key }));
    }
    await i.respond(choices);
  } catch {
    /* autocomplete is best-effort */
  }
}
