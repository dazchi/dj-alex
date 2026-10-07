import { EventEmitter } from 'node:events';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  OAuth2Scopes,
  PermissionFlagsBits,
  type Guild,
  type VoiceBasedChannel,
} from 'discord.js';
import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Config } from './config.js';
import type { Controller, VoiceProvider } from './controller.js';
import { SYSTEM_ACTOR } from './controller.js';
import type { Player } from './player.js';
import type { VoiceState } from './types.js';
import { commandData, handleAutocomplete, handleCommand, handleComponent } from './commands.js';
import { errorMessage, log } from './util.js';

const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];

export class Bot extends EventEmitter implements VoiceProvider {
  readonly client: Client;
  guild: Guild | null = null;
  private connection: VoiceConnection | null = null;
  private wired = new WeakSet<VoiceConnection>();
  private leaveTimer: NodeJS.Timeout | null = null;
  private controller!: Controller;

  constructor(
    private readonly config: Config,
    private readonly player: Player,
  ) {
    super();
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  }

  async start(controller: Controller) {
    this.controller = controller;
    const c = this.client;

    c.once(Events.ClientReady, async (client) => {
      log.info('bot', `Logged in as ${client.user.tag}`);
      const invite = client.generateInvite({
        scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
        permissions: REQUIRED_PERMISSIONS,
      });
      log.info('bot', `Invite link: ${invite}`);
      try {
        if (this.config.guildId) this.guild = await client.guilds.fetch(this.config.guildId);
        else this.guild = client.guilds.cache.first() ?? null;
      } catch (err) {
        log.error('bot', `Cannot access guild ${this.config.guildId}: ${errorMessage(err)}`);
      }
      if (this.guild) await this.setupGuild(this.guild);
      else log.warn('bot', 'The bot is not in any server yet — open the invite link above to add it.');
      this.changed();
    });

    c.on(Events.GuildCreate, async (guild) => {
      if (this.guild) return;
      if (this.config.guildId && guild.id !== this.config.guildId) return;
      this.guild = guild;
      await this.setupGuild(guild);
      this.changed();
    });

    c.on(Events.InteractionCreate, async (interaction) => {
      if (!this.guild || interaction.guildId !== this.guild.id) return;
      const ctx = { controller: this.controller, bot: this, config: this.config };
      if (interaction.isChatInputCommand()) await handleCommand(interaction, ctx);
      else if (interaction.isAutocomplete()) await handleAutocomplete(interaction, ctx);
      else if (interaction.isMessageComponent()) await handleComponent(interaction, ctx);
    });

    c.on(Events.VoiceStateUpdate, (oldState, newState) => {
      if (newState.guild.id !== this.guild?.id) return;
      this.checkAutoLeave();
      this.changed();
      if (newState.id === c.user?.id && oldState.channelId && !newState.channelId) {
        // Bot was disconnected by someone (or kicked from the channel).
        this.connection?.destroy();
      }
    });

    for (const ev of [Events.ChannelCreate, Events.ChannelDelete, Events.ChannelUpdate] as const) {
      c.on(ev, () => this.changed());
    }

    c.on(Events.Error, (err) => log.error('bot', err));
    c.on(Events.Warn, (msg) => log.warn('bot', msg));

    await c.login(this.config.token);
  }

  private async setupGuild(guild: Guild) {
    log.info('bot', `Serving guild “${guild.name}” (${guild.id})`);
    try {
      await guild.commands.set(commandData);
      log.info('bot', `Registered ${commandData.length} slash commands`);
    } catch (err) {
      log.error('bot', `Failed to register slash commands: ${errorMessage(err)}`);
    }
    // Reattach to a connection that survived a hot reload.
    const existing = getVoiceConnection(guild.id);
    if (existing) this.adopt(existing);
  }

  private changed() {
    this.controller?.queueState();
  }

  // ---------------------------------------------------------------- VoiceProvider

  isConnected(): boolean {
    return this.connection?.state.status === VoiceConnectionStatus.Ready;
  }

  voiceState(): VoiceState {
    const guild = this.guild;
    const me = guild?.members.me;
    const user = this.client.user;
    const channel = me?.voice.channel ?? null;
    const humans = (ch: VoiceBasedChannel) => ch.members.filter((m) => !m.user.bot);
    const status = this.connection?.state.status;
    return {
      botReady: this.client.isReady(),
      botName: user?.displayName ?? null,
      botAvatar: user?.displayAvatarURL({ size: 64 }) ?? null,
      guildName: guild?.name ?? null,
      connected: status === VoiceConnectionStatus.Ready,
      connecting: !!status && status !== VoiceConnectionStatus.Ready && status !== VoiceConnectionStatus.Destroyed,
      channelId: channel?.id ?? null,
      channelName: channel?.name ?? null,
      listeners: channel
        ? humans(channel).map((m) => ({ id: m.id, name: m.displayName, avatar: m.displayAvatarURL({ size: 64 }) }))
        : [],
      channels: guild
        ? guild.channels.cache
            .filter((ch): ch is VoiceBasedChannel => ch.type === ChannelType.GuildVoice)
            .filter((ch) => !me || ch.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]))
            .sort((a, b) => a.rawPosition - b.rawPosition)
            .map((ch) => ({ id: ch.id, name: ch.name, memberCount: humans(ch).size }))
        : [],
    };
  }

  async join(channelId: string): Promise<string> {
    const guild = this.guild;
    if (!guild || !this.client.isReady()) throw new Error('The Discord bot is not connected yet');
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('That voice channel does not exist');
    const me = guild.members.me;
    if (me && !channel.permissionsFor(me).has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new Error(`I don't have permission to connect and speak in 🔊 ${channel.name}`);
    }
    if (!channel.joinable) throw new Error(`🔊 ${channel.name} is full or not joinable`);
    if (this.isConnected() && me?.voice.channelId === channel.id) return channel.name;

    const conn = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    this.adopt(conn);
    this.changed();
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      conn.destroy();
      throw new Error(`Timed out connecting to 🔊 ${channel.name}`);
    }
    this.checkAutoLeave();
    return channel.name;
  }

  leave(): boolean {
    if (!this.connection) return false;
    this.connection.destroy();
    this.connection = null;
    this.changed();
    return true;
  }

  async autoJoin(): Promise<string | null> {
    if (!this.guild || !this.client.isReady()) return null;
    let target = this.config.defaultVoiceChannelId;
    if (!target) {
      // Pick the voice channel with the most people in it.
      const best = this.voiceState().channels.reduce<{ id: string; memberCount: number } | null>(
        (acc, ch) => (ch.memberCount > (acc?.memberCount ?? 0) ? ch : acc),
        null,
      );
      target = best?.id ?? '';
    }
    if (!target) return null;
    return this.join(target);
  }

  /**
   * Looks up a user in the bot's server.
   * Returns null if they are not a member, undefined if that can't be determined right now.
   */
  async lookupMember(userId: string): Promise<{ name: string; avatar: string } | null | undefined> {
    if (!this.guild || !this.client.isReady()) return undefined;
    try {
      const m = await this.guild.members.fetch(userId);
      return { name: m.displayName, avatar: m.displayAvatarURL({ size: 64 }) };
    } catch (err) {
      const code = (err as { code?: number }).code;
      return code === 10007 || code === 10013 ? null : undefined; // Unknown Member / Unknown User
    }
  }

  // ---------------------------------------------------------------- internals

  private adopt(conn: VoiceConnection) {
    this.connection = conn;
    if (this.wired.has(conn)) return;
    this.wired.add(conn);
    conn.subscribe(this.player.audio);

    conn.on('stateChange', (_old, state) => {
      log.info('voice', `Connection ${state.status}`);
      this.changed();
    });
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Moving between channels / region changes reconnect on their own.
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
      }
    });
    conn.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.connection === conn) this.connection = null;
      this.changed();
    });
    conn.on('error', (err) => log.error('voice', err));
  }

  private checkAutoLeave() {
    const minutes = this.config.autoLeaveMinutes;
    const channel = this.guild?.members.me?.voice.channel;
    const empty = channel && channel.members.filter((m) => !m.user.bot).size === 0;
    if (!minutes || !empty) {
      if (this.leaveTimer) clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
      return;
    }
    if (this.leaveTimer) return;
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      const ch = this.guild?.members.me?.voice.channel;
      if (ch && ch.members.filter((m) => !m.user.bot).size === 0 && this.leave()) {
        this.controller.log(SYSTEM_ACTOR, `left 🔊 ${ch.name} because everyone left`);
      }
    }, minutes * 60_000);
  }

  async destroy() {
    this.connection?.destroy();
    await this.client.destroy();
  }
}
