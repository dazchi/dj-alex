# DJ Alex 🎧

A Discord music bot with a shared, real-time web player.

- Plays music from a **local folder**, or from any **HTTP(S) link to an audio file**. The file is downloaded to a cache first.
- A **web UI** where people **log in with Discord** and everyone sees the same queue live. Anyone can search the library, add songs to the end or play them next or now, drag to reorder, remove, skip, seek, change the volume and set repeat. An activity feed shows who did what.
- **Slash commands** in Discord, with autocomplete that searches your library.

| Layer        | Tech |
|--------------|------|
| Discord      | [discord.js](https://discord.js.org) v14 + [@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice) (with DAVE end-to-end voice encryption, which Discord requires) |
| Audio        | ffmpeg → raw PCM → Opus (`@discordjs/opus`, with `opusscript` as a fallback) |
| Server       | Node.js 22 + TypeScript, Fastify (REST + static files), Socket.IO (live state) |
| Library      | `music-metadata` for tags and cover art, `chokidar` to watch the music folder |
| Web UI       | React 19, Vite, Tailwind CSS v4, Zustand, dnd-kit |

---

## 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. Open **Bot** → **Reset Token**, and copy the token. You'll need it for `.env`.
   No privileged intents are needed.
3. Invite the bot. The easiest way is to start the server once (step 2); it prints an **invite link** in the console.
   Or go to **OAuth2 → URL Generator**, select the scopes `bot` and `applications.commands`, and the permissions
   *View Channels, Send Messages, Embed Links, Attach Files, Connect, Speak*.
4. **Web login:** open **OAuth2** and copy the **Client Secret** (click Reset Secret) into `DISCORD_CLIENT_SECRET`.
   Under **Redirects**, add one entry for every address people open the UI with, followed by `/auth/callback`, for example:
   - `http://localhost:3000/auth/callback` (production / Docker)
   - `http://localhost:5173/auth/callback` (`npm run dev`)
   - `http://192.168.1.20:3000/auth/callback` (other devices on your LAN, using your PC's IP)

   If you set `PUBLIC_URL`, only `<PUBLIC_URL>/auth/callback` is used.
5. *(Optional)* Turn on Developer Mode in Discord (Settings → Advanced), right-click your server and choose **Copy Server ID**. This gives you `DISCORD_GUILD_ID`.

## 2. Run it on Windows (or any machine with Node)

Requirements: **Node.js 22+** and **ffmpeg** on your `PATH` (`winget install Gyan.FFmpeg`).

```powershell
npm install
copy .env.example .env      # then edit .env: DISCORD_TOKEN, MUSIC_DIR, ...
```

Set `MUSIC_DIR` to your music folder, e.g. `MUSIC_DIR=D:/Music`. The folder is scanned recursively, and new files are picked up automatically.

**Development** (hot reload). The UI runs on <http://localhost:5173> and the API on port 3000:

```powershell
npm run dev
```

**Production-style**. Everything is served from one port, <http://localhost:3000>:

```powershell
npm run build
npm start
```

Other people on your network open `http://<your-PC-IP>:3000`. The server prints that address at startup.
Allow Node through Windows Firewall when it asks.

## 3. Run it with Docker

```bash
cp .env.example .env        # set DISCORD_TOKEN (MUSIC_DIR/DATA_DIR are set by compose)
# edit docker-compose.yml: change ./music to your music folder on the host
docker compose up -d --build
```

- Music is mounted read-only at `/music`. The cache, saved queue and downloads go to `./data`.
- Inside a container the bot can't detect your LAN IP, so set `PUBLIC_URL=http://<host-ip>:3000` to make `/web` link correctly.
- If file changes aren't detected (for example Docker Desktop with a Windows host folder), set `WATCH_POLLING=true`.

---

## Using it

### Web UI
- **Login**: users click **Log in with Discord**. Only `identify` is requested (username and avatar). The bot then checks that
  the person is a member of its server (turn this off with `REQUIRE_GUILD_MEMBER=false`). Inside the UI, people appear
  with their server nickname and Discord avatar on queue items, in the activity feed and in the online list.
  Sessions last 30 days (`SESSION_DAYS`) and are re-checked on each connect, so people who leave the server lose access.
- **Songs**: search (press `/` to focus it) and sort. Hover a song to choose **Play next** or **Add to queue**, click the cover to **Play now**, or double-click to add it.
  **Queue all** and **Shuffle all** add all the current results at once.
- **Albums**: a grid of covers. Open an album to play it, play it next or queue it.
- **Recently played**: the playback history, so you can re-add songs.
- **Add from URL**: paste a direct link to an mp3, flac, ogg, m4a, wav or other audio file. The download progress shows in the queue.
- **Queue** panel: drag to reorder, ▶ to jump to a song, ✕ to remove it, and shuffle or clear.
- **Voice** panel: pick a voice channel and choose Join, Move or Leave. It also shows who is listening.
- Keyboard: `Space` plays or pauses, `Shift+N` skips to the next track, `Shift+P` goes back, and media keys work too.

If the bot isn't in a voice channel when someone queues music, it joins on its own: either `DISCORD_VOICE_CHANNEL_ID`, or whichever voice channel has the most people in it.

### Slash commands

| Command | |
|---|---|
| `/play query [position]` | Play from the library (autocomplete) or from an `http(s)://` audio URL. `position`: end / next / now |
| `/album name [position]` | Queue a whole album |
| `/search keywords` | Search the library: every keyword must match the title, artist, album or file name (fuzzy fallback if nothing matches). Results are private to you, 10 per page; pick songs from the dropdown or press **Queue this page**, and toggle between *end of queue* and *play next* |
| `/pause` `/resume` `/skip` `/previous` `/stop` | Transport controls |
| `/nowplaying` | Current track with a progress bar and cover art |
| `/queue [page]` | Show the queue |
| `/remove position` `/move from to` `/jump position` | Edit the queue |
| `/clear` `/shuffle` | Clear or shuffle the queue |
| `/repeat off\|one\|all` | Repeat mode |
| `/volume [level]` | Show or set the volume (0–100) |
| `/seek time` | Jump to a time, e.g. `1:30` or `90` |
| `/join` `/leave` | Bring the bot to your voice channel, or disconnect it |
| `/web` | Link to the web player |

`/play` and `/join` move the bot into *your* voice channel if it isn't connected yet.

### Control API (for other bots)

Set `CONTROL_TOKEN` (for example `openssl rand -hex 32`) to let another program, such as a voice assistant bot, control
the player. Every request needs the header `Authorization: Bearer <CONTROL_TOKEN>`; without the token set, these routes don't exist.

| Request | Body (JSON) |
|---|---|
| `GET /api/control/status` | – (now playing, the next 10 songs, volume, repeat, voice channel and listeners) |
| `GET /api/control/search?q=…&limit=8` | – (songs whose title, artist or album match) |
| `POST /api/control/play` | `query` (library search or `http(s)://` URL; leave it out for a random song from the library), `position` (`end` / `next` / `now`) |
| `POST /api/control/album` | `name`, `position` |
| `POST /api/control/pause` `resume` `skip` `previous` `stop` `shuffle` `clear` `leave` | – |
| `POST /api/control/volume` | `volume` (0–100) |
| `POST /api/control/repeat` | `mode` (`off` / `one` / `all`) |
| `POST /api/control/join` | `channelId` |
| `POST /api/control/duck` | `level` (music volume in % while ducked, default 30; 100 = back to normal), `seconds` (back up after this long unless renewed, default 30). Fades only; not shown in the activity feed |

Any POST may also send `actor`, the name shown in the activity feed (for example `Alex (for Darren)`), and `channelId`,
the voice channel to join if the bot isn't in one yet. Replies are `{"ok": true, ...status}` or `{"ok": false, "error": "..."}`.

---

## Configuration

See [.env.example](.env.example) for every option. The main ones:

| Variable | Default | |
|---|---|---|
| `DISCORD_TOKEN` | – | Bot token. Without it, the web UI still runs, but nothing plays to Discord |
| `DISCORD_GUILD_ID` | first server | The server the bot operates in (slash commands are registered there instantly) |
| `DISCORD_VOICE_CHANNEL_ID` | – | Channel to join automatically from the web UI |
| `MUSIC_DIR` | `./music` | Your library |
| `DATA_DIR` | `./data` | Cache, saved queue, downloaded URL tracks |
| `DISCORD_CLIENT_SECRET` | – | OAuth2 secret for web login (required for the UI) |
| `REQUIRE_GUILD_MEMBER` | `true` | Only members of the bot's server can log in |
| `HTTP_PORT` | `3000` | Web UI / API port |
| `AUTO_LEAVE_MINUTES` | `5` | Leave the voice channel once it has been empty this long |
| `MAX_DOWNLOAD_MB` | `200` | Size limit for URL downloads |
| `CONTROL_TOKEN` | – | Turns on the control API for other bots (see above) |

## Security note

Web access requires a Discord login and, by default, membership of the bot's server. Every logged-in member
can control playback and make the server download URLs. If you expose the UI to the internet, put it behind HTTPS
(for example a reverse proxy) and set `PUBLIC_URL` to the https address, so login cookies are marked `Secure`.

## Project layout

```
server/src/
  index.ts        bootstraps everything
  config.ts       .env handling
  library.ts      scans MUSIC_DIR, tags, search, albums, cover art, file watching
  downloader.ts   HTTP(S) audio downloads with progress + cache
  player.ts       queue + audio engine (ffmpeg → @discordjs/voice)
  controller.ts   every user action (web or Discord), activity log, persistence
  bot.ts          Discord client, voice connection, auto-join/leave
  commands.ts     slash command definitions + handlers
  auth.ts         Discord OAuth2 login + sessions
  control.ts      token-protected control API for other bots
  web.ts          REST API, Socket.IO, static frontend
  types.ts        types shared with the web UI
web/src/
  App.tsx, components/*, lib/{store,socket,util}.ts
```
