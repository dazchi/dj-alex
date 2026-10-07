import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { WebUser } from './types.js';
import { errorMessage, log } from './util.js';

const SESSION_COOKIE = 'djalex_session';
const STATE_COOKIE = 'djalex_oauth';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

interface Session {
  token: string;
  user: WebUser;
  createdAt: number;
  expiresAt: number;
}

/** null = not a member, undefined = unknown (bot offline). */
export type MemberLookup = (userId: string) => Promise<{ name: string; avatar: string } | null | undefined>;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* malformed cookie */
    }
  }
  return out;
}

function cookie(name: string, value: string, opts: { maxAge: number; secure: boolean; path?: string }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? '/'}`,
    `Max-Age=${Math.floor(opts.maxAge)}`,
    'HttpOnly',
    'SameSite=Lax',
    opts.secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function defaultAvatar(userId: string) {
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`;
}

/**
 * Discord OAuth2 login ("identify" scope) with server-side sessions stored in DATA_DIR/sessions.json.
 */
export class Auth {
  private sessions = new Map<string, Session>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly lookupMember: MemberLookup,
  ) {}

  get configured() {
    return !!(this.config.clientId && this.config.clientSecret);
  }

  private get file() {
    return path.join(this.config.dataDir, 'sessions.json');
  }

  async init() {
    try {
      const list = JSON.parse(await fs.readFile(this.file, 'utf8')) as Session[];
      const now = Date.now();
      for (const s of list) if (s.expiresAt > now) this.sessions.set(s.token, s);
    } catch {
      /* no sessions yet */
    }
    if (!this.configured) {
      log.warn('auth', 'DISCORD_CLIENT_SECRET (and a client ID / bot token) must be set for web login to work.');
    }
  }

  /** The logged-in user for a Cookie header, if any. */
  userFromCookie(header: string | undefined): Session | null {
    const token = parseCookies(header)[SESSION_COOKIE];
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(token);
      this.scheduleSave();
      return null;
    }
    return s;
  }

  /**
   * Re-checks server membership and refreshes the display name/avatar.
   * Returns false if the user is no longer allowed in (their session is revoked).
   */
  async refresh(session: Session): Promise<boolean> {
    const member = await this.lookupMember(session.user.id);
    if (member === null && this.config.requireGuildMember) {
      this.sessions.delete(session.token);
      this.scheduleSave();
      return false;
    }
    if (member && (member.name !== session.user.name || member.avatar !== session.user.avatar)) {
      session.user = { ...session.user, name: member.name, avatar: member.avatar };
      this.scheduleSave();
    }
    return true;
  }

  private redirectUri(req: FastifyRequest) {
    const base = this.config.publicUrl ? this.config.publicUrl.replace(/\/+$/, '') : `${req.protocol}://${req.host}`;
    return `${base}/auth/callback`;
  }

  register(app: FastifyInstance) {
    const secure = (req: FastifyRequest) => req.protocol === 'https';
    const fail = (reply: FastifyReply, message: string) => reply.redirect(`/?authError=${encodeURIComponent(message)}`);

    app.get('/auth/login', async (req, reply) => {
      if (!this.configured) return fail(reply, 'Discord login is not configured on the server (DISCORD_CLIENT_SECRET).');
      const state = crypto.randomBytes(16).toString('hex');
      const params = new URLSearchParams({
        client_id: this.config.clientId,
        response_type: 'code',
        redirect_uri: this.redirectUri(req),
        scope: 'identify',
        state,
        prompt: 'none',
      });
      reply.header('set-cookie', cookie(STATE_COOKIE, state, { maxAge: 600, secure: secure(req), path: '/auth' }));
      return reply.redirect(`${AUTHORIZE_URL}?${params}`);
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
      '/auth/callback',
      async (req, reply) => {
        const { code, state, error, error_description } = req.query;
        const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
        reply.header('set-cookie', cookie(STATE_COOKIE, '', { maxAge: 0, secure: secure(req), path: '/auth' }));
        if (error) return fail(reply, error === 'access_denied' ? 'Login was cancelled.' : error_description || error);
        if (!code || !state || !expected || state !== expected) return fail(reply, 'Login expired or was tampered with. Please try again.');

        try {
          const user = await this.exchange(code, this.redirectUri(req));
          const member = await this.lookupMember(user.id);
          if (this.config.requireGuildMember) {
            if (member === undefined) return fail(reply, 'The Discord bot is offline, so your server membership can’t be checked. Try again in a moment.');
            if (member === null) return fail(reply, `Sorry ${user.name}, you need to be a member of the bot’s Discord server to use DJ Alex.`);
          }
          if (member) Object.assign(user, { name: member.name, avatar: member.avatar });

          const token = crypto.randomBytes(32).toString('base64url');
          const now = Date.now();
          const maxAge = this.config.sessionDays * 86400;
          this.sessions.set(token, { token, user, createdAt: now, expiresAt: now + maxAge * 1000 });
          this.scheduleSave();
          log.info('auth', `${user.name} (@${user.username}) logged in`);
          reply.header('set-cookie', cookie(SESSION_COOKIE, token, { maxAge, secure: secure(req) }));
          return reply.redirect('/');
        } catch (err) {
          log.warn('auth', `Login failed: ${errorMessage(err)}`);
          return fail(reply, `Discord login failed: ${errorMessage(err)}`);
        }
      },
    );

    app.post('/auth/logout', async (req, reply) => {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token && this.sessions.delete(token)) this.scheduleSave();
      reply.header('set-cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure: secure(req) }));
      return { ok: true };
    });

    app.get('/api/me', async (req, reply) => {
      const session = this.userFromCookie(req.headers.cookie);
      if (!session) return reply.code(401).send({ error: 'Not logged in', loginConfigured: this.configured });
      return session.user;
    });

    // Everything else under /api requires a session.
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/') || req.url.startsWith('/api/me')) return;
      if (!this.userFromCookie(req.headers.cookie)) return reply.code(401).send({ error: 'Not logged in' });
    });
  }

  /** Trades an OAuth code for the user's Discord profile. */
  private async exchange(code: string, redirectUri: string): Promise<WebUser> {
    const tokenRes = await fetch(`${this.config.discordApi}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenJson = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
    if (!tokenRes.ok || !tokenJson.access_token) {
      throw new Error(tokenJson.error_description || tokenJson.error || `token endpoint returned ${tokenRes.status}`);
    }

    const meRes = await fetch(`${this.config.discordApi}/users/@me`, {
      headers: { authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (!meRes.ok) throw new Error(`could not read your Discord profile (${meRes.status})`);
    const me = (await meRes.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };

    // We only needed the profile once; revoke the access token (best effort).
    void fetch(`${this.config.discordApi}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        token: tokenJson.access_token,
      }),
    }).catch(() => {});

    return {
      id: me.id,
      username: me.username,
      name: me.global_name || me.username,
      avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : defaultAvatar(me.id),
    };
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 1000);
  }

  async save() {
    try {
      await fs.mkdir(this.config.dataDir, { recursive: true });
      const tmp = this.file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify([...this.sessions.values()]));
      await fs.rename(tmp, this.file);
    } catch (err) {
      log.warn('auth', `Could not save sessions: ${errorMessage(err)}`);
    }
  }
}
