import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFile, selectCover } from 'music-metadata';
import Fuse from 'fuse.js';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Album, LibraryStats, SongPage, SongSort, Track } from './types.js';
import { hashId, log, mapLimit, errorMessage } from './util.js';

export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.wma', '.aif', '.aiff', '.alac', '.webm', '.mka', '.ape', '.wv',
]);
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall'];
const COVER_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const CACHE_VERSION = 2;

export interface LibraryEntry {
  track: Track;
  filePath: string;
  mtimeMs: number;
  size: number;
  albumKey: string;
  albumArtist: string;
  /** Lowercased searchable text. */
  hay: string;
}

interface CacheFile {
  version: number;
  entries: Record<string, Omit<LibraryEntry, 'filePath' | 'hay'>>;
}

interface Cover {
  data: Buffer;
  mime: string;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export class Library extends EventEmitter {
  private local = new Map<string, LibraryEntry>();
  private remote = new Map<string, LibraryEntry>();
  private sorted = new Map<SongSort, LibraryEntry[]>();
  private fuse: Fuse<LibraryEntry> | null = null;
  private albumIndex: { albums: Album[]; tracks: Map<string, LibraryEntry[]> } | null = null;
  private coverCache = new Map<string, Cover | null>();
  private folderCoverCache = new Map<string, string | null>();
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private scanPromise: Promise<void> | null = null;
  scanning = false;
  lastScan: number | null = null;

  constructor(
    readonly musicDir: string,
    private readonly dataDir: string,
  ) {
    super();
  }

  private get cachePath() {
    return path.join(this.dataDir, 'library-cache.json');
  }

  async init(watch: boolean, polling: boolean) {
    await fs.mkdir(this.musicDir, { recursive: true });
    await this.loadCache();
    // Serve the cached library immediately and refresh in the background (first run waits for the scan).
    const scan = this.scan().catch((err) => log.error('library', 'Scan failed:', err));
    if (this.local.size === 0) await scan;
    if (watch) this.watch(polling);
  }

  // ---------------------------------------------------------------- lookup

  get(id: string): LibraryEntry | undefined {
    return this.local.get(id) ?? this.remote.get(id);
  }

  registerRemote(track: Track, filePath: string) {
    this.remote.set(track.id, { track, filePath, mtimeMs: 0, size: 0, albumKey: '', albumArtist: track.artist, hay: '' });
  }

  stats(): LibraryStats {
    const artists = new Set<string>();
    for (const e of this.local.values()) artists.add(e.track.artist.toLowerCase());
    return {
      tracks: this.local.size,
      albums: this.albums().length,
      artists: artists.size,
      scanning: this.scanning,
      musicDir: this.musicDir,
      lastScan: this.lastScan,
    };
  }

  // ---------------------------------------------------------------- search

  search(query: string, opts: { sort?: SongSort; offset?: number; limit?: number } = {}): SongPage {
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const q = query.trim().toLowerCase();

    let results: LibraryEntry[];
    if (!q) {
      results = this.sortedBy(opts.sort ?? 'artist');
    } else {
      const tokens = q.split(/\s+/).filter(Boolean);
      results = this.sortedBy(opts.sort ?? 'artist').filter((e) => tokens.every((t) => e.hay.includes(t)));
      if (results.length === 0 && q.length >= 3) {
        results = this.getFuse().search(q, { limit: 200 }).map((r) => r.item);
      } else if (!opts.sort) {
        // Relevance: title prefix > title contains > anything else. Stable sort keeps artist order.
        const rank = (e: LibraryEntry) => {
          const t = e.track.title.toLowerCase();
          if (t.startsWith(q)) return 0;
          if (t.includes(q)) return 1;
          if (e.track.artist.toLowerCase().includes(q)) return 2;
          return 3;
        };
        results = [...results].sort((a, b) => rank(a) - rank(b));
      }
    }
    return { items: results.slice(offset, offset + limit).map((e) => e.track), total: results.length, offset };
  }

  /** First track matching a free-text query (used by /play). */
  findBest(query: string): Track | null {
    return this.search(query, { limit: 1 }).items[0] ?? null;
  }

  private sortedBy(sort: SongSort): LibraryEntry[] {
    let list = this.sorted.get(sort);
    if (list) return list;
    list = [...this.local.values()];
    const t = (e: LibraryEntry) => e.track;
    const byAlbum = (a: LibraryEntry, b: LibraryEntry) =>
      collator.compare(t(a).album, t(b).album) ||
      (t(a).trackNo ?? 0) - (t(b).trackNo ?? 0) ||
      collator.compare(t(a).title, t(b).title);
    switch (sort) {
      case 'title':
        list.sort((a, b) => collator.compare(t(a).title, t(b).title));
        break;
      case 'album':
        list.sort(byAlbum);
        break;
      case 'recent':
        list.sort((a, b) => (t(b).addedAt ?? 0) - (t(a).addedAt ?? 0));
        break;
      case 'duration':
        list.sort((a, b) => t(a).duration - t(b).duration);
        break;
      default:
        list.sort((a, b) => collator.compare(a.albumArtist, b.albumArtist) || byAlbum(a, b));
    }
    this.sorted.set(sort, list);
    return list;
  }

  private getFuse() {
    this.fuse ??= new Fuse([...this.local.values()], {
      keys: [
        { name: 'track.title', weight: 3 },
        { name: 'track.artist', weight: 2 },
        { name: 'track.album', weight: 1 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
    });
    return this.fuse;
  }

  // ---------------------------------------------------------------- albums

  albums(): Album[] {
    return this.getAlbumIndex().albums;
  }

  albumTracks(key: string): Track[] {
    return (this.getAlbumIndex().tracks.get(key) ?? []).map((e) => e.track);
  }

  private getAlbumIndex() {
    if (this.albumIndex) return this.albumIndex;
    const tracks = new Map<string, LibraryEntry[]>();
    for (const e of this.local.values()) {
      const list = tracks.get(e.albumKey);
      if (list) list.push(e);
      else tracks.set(e.albumKey, [e]);
    }
    const albums: Album[] = [];
    for (const [key, list] of tracks) {
      list.sort(
        (a, b) => (a.track.trackNo ?? 0) - (b.track.trackNo ?? 0) || collator.compare(a.track.relPath ?? '', b.track.relPath ?? ''),
      );
      const artists = new Set(list.map((e) => e.albumArtist));
      const first = list[0].track;
      albums.push({
        key,
        name: first.album || 'Unknown Album',
        artist: artists.size === 1 ? list[0].albumArtist : 'Various Artists',
        year: list.find((e) => e.track.year)?.track.year,
        trackCount: list.length,
        duration: list.reduce((s, e) => s + e.track.duration, 0),
        coverTrackId: list.find((e) => e.track.hasCover)?.track.id ?? null,
      });
    }
    albums.sort((a, b) => collator.compare(a.artist, b.artist) || (a.year ?? 0) - (b.year ?? 0) || collator.compare(a.name, b.name));
    this.albumIndex = { albums, tracks };
    return this.albumIndex;
  }

  // ---------------------------------------------------------------- covers

  async cover(id: string): Promise<Cover | null> {
    if (this.coverCache.has(id)) return this.coverCache.get(id)!;
    const entry = this.get(id);
    if (!entry) return null;
    let cover: Cover | null = null;
    try {
      const meta = await parseFile(entry.filePath, { skipPostHeaders: true, duration: false });
      const pic = selectCover(meta.common.picture);
      if (pic) cover = { data: Buffer.from(pic.data), mime: pic.format.includes('/') ? pic.format : `image/${pic.format}` };
    } catch {
      /* fall through to folder art */
    }
    if (!cover) {
      const folderArt = await this.folderCover(path.dirname(entry.filePath));
      if (folderArt) {
        const ext = path.extname(folderArt).toLowerCase();
        cover = { data: await fs.readFile(folderArt), mime: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
      }
    }
    this.coverCache.set(id, cover);
    if (this.coverCache.size > 300) this.coverCache.delete(this.coverCache.keys().next().value!);
    return cover;
  }

  private async folderCover(dir: string): Promise<string | null> {
    if (this.folderCoverCache.has(dir)) return this.folderCoverCache.get(dir)!;
    let found: string | null = null;
    try {
      const files = await fs.readdir(dir);
      found =
        files.find((f) => {
          const ext = path.extname(f).toLowerCase();
          return COVER_EXTS.includes(ext) && COVER_NAMES.includes(path.basename(f, path.extname(f)).toLowerCase());
        }) ?? null;
      if (found) found = path.join(dir, found);
    } catch {
      /* ignore */
    }
    this.folderCoverCache.set(dir, found);
    return found;
  }

  // ---------------------------------------------------------------- scanning

  scan(): Promise<void> {
    this.scanPromise ??= this.doScan().finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  private async doScan() {
    this.scanning = true;
    this.emit('stats');
    const started = Date.now();
    const files = await this.walk(this.musicDir);
    const next = new Map<string, LibraryEntry>();
    const byPath = new Map([...this.local.values()].map((e) => [e.filePath, e]));
    const toParse: { filePath: string; mtimeMs: number; size: number }[] = [];

    await mapLimit(files, 32, async (filePath) => {
      try {
        const st = await fs.stat(filePath);
        const prev = byPath.get(filePath);
        if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) next.set(prev.track.id, prev);
        else toParse.push({ filePath, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* file vanished */
      }
    });

    let parsed = 0;
    await mapLimit(toParse, 8, async (f) => {
      const entry = await this.readEntry(f.filePath, f.mtimeMs, f.size);
      next.set(entry.track.id, entry);
      if (++parsed % 250 === 0) {
        log.info('library', `Indexed ${parsed}/${toParse.length} new files…`);
      }
    });

    const changed = toParse.length > 0 || next.size !== this.local.size;
    this.local = next;
    this.scanning = false;
    this.lastScan = Date.now();
    if (changed) {
      this.invalidate();
      await this.saveCache();
    }
    log.info('library', `${next.size} tracks (${toParse.length} new/changed) in ${((Date.now() - started) / 1000).toFixed(1)}s — ${this.musicDir}`);
    this.emit('stats');
    if (changed) this.emit('changed');
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.warn('library', `Cannot read ${dir}: ${errorMessage(err)}`);
      return out;
    }
    await Promise.all(
      dirents.map(async (d) => {
        if (d.name.startsWith('.')) return;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) out.push(...(await this.walk(full)));
        else if (d.isFile() && AUDIO_EXTENSIONS.has(path.extname(d.name).toLowerCase())) out.push(full);
      }),
    );
    return out;
  }

  private async readEntry(filePath: string, mtimeMs: number, size: number): Promise<LibraryEntry> {
    const relPath = path.relative(this.musicDir, filePath).split(path.sep).join('/');
    const fileTitle = path.basename(filePath, path.extname(filePath));
    const folder = path.basename(path.dirname(filePath));
    let title = fileTitle;
    let artist = '';
    let albumArtist = '';
    let album = '';
    let year: number | undefined;
    let trackNo: number | undefined;
    let duration = 0;
    let embeddedCover = false;
    try {
      const meta = await parseFile(filePath, { skipPostHeaders: true });
      const c = meta.common;
      title = c.title?.trim() || fileTitle;
      artist = c.artists?.join(', ') || c.artist?.trim() || '';
      albumArtist = c.albumartist?.trim() || '';
      album = c.album?.trim() || '';
      year = c.year || undefined;
      trackNo = c.track?.no ?? undefined;
      duration = meta.format.duration ?? 0;
      embeddedCover = !!c.picture?.length;
    } catch (err) {
      log.warn('library', `Unreadable tags in ${relPath}: ${errorMessage(err)}`);
    }
    // "Artist - Title.mp3" with no tags
    if (!artist && title === fileTitle) {
      const m = fileTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (m) [, artist, title] = m;
    }
    artist ||= 'Unknown Artist';
    album ||= folder && relPath.includes('/') ? folder : '';
    albumArtist ||= artist;
    const hasCover = embeddedCover || !!(await this.folderCover(path.dirname(filePath)));
    const track: Track = {
      id: hashId('local:' + relPath),
      source: 'local',
      title,
      artist,
      album,
      year,
      trackNo,
      duration,
      hasCover,
      relPath,
      addedAt: Math.round(mtimeMs),
    };
    const albumKey = hashId(`${album.toLowerCase()}|${path.dirname(relPath).toLowerCase()}`, 12);
    return { track, filePath, mtimeMs, size, albumKey, albumArtist, hay: makeHay(track) };
  }

  private invalidate() {
    this.sorted.clear();
    this.fuse = null;
    this.albumIndex = null;
    this.coverCache.clear();
    this.folderCoverCache.clear();
  }

  private watch(polling: boolean) {
    this.watcher = chokidar.watch(this.musicDir, {
      ignoreInitial: true,
      usePolling: polling,
      interval: 5000,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
    });
    const schedule = () => {
      if (this.rescanTimer) clearTimeout(this.rescanTimer);
      this.rescanTimer = setTimeout(() => this.scan().catch((e) => log.error('library', e)), 2500);
    };
    this.watcher.on('all', (event, file) => {
      if (event.endsWith('Dir') || AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase())) schedule();
    });
    this.watcher.on('error', (err) => log.warn('library', 'Watcher error:', err));
  }

  async close() {
    await this.watcher?.close();
  }

  // ---------------------------------------------------------------- cache

  private async loadCache() {
    try {
      const raw = JSON.parse(await fs.readFile(this.cachePath, 'utf8')) as CacheFile;
      if (raw.version !== CACHE_VERSION) return;
      for (const [relPath, e] of Object.entries(raw.entries)) {
        const filePath = path.join(this.musicDir, ...relPath.split('/'));
        this.local.set(e.track.id, { ...e, filePath, hay: makeHay(e.track) });
      }
      log.info('library', `Loaded ${this.local.size} tracks from cache`);
    } catch {
      /* no cache yet */
    }
  }

  private async saveCache() {
    const entries: CacheFile['entries'] = {};
    for (const e of this.local.values()) {
      const { filePath: _f, hay: _h, ...rest } = e;
      entries[e.track.relPath!] = rest;
    }
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmp = this.cachePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, entries } satisfies CacheFile));
    await fs.rename(tmp, this.cachePath);
  }
}

function makeHay(t: Track) {
  return `${t.title} ${t.artist} ${t.album} ${t.relPath ?? ''}`.toLowerCase();
}
