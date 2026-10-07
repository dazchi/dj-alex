import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import type { Track } from './types.js';
import { AUDIO_EXTENSIONS, type Library } from './library.js';
import { errorMessage, hashId, log } from './util.js';

const CONTENT_TYPE_EXT: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/webm': '.webm',
  'audio/x-ms-wma': '.wma',
};

interface StoredDownload {
  track: Track;
  file: string;
}

export type ProgressFn = (fraction: number | undefined) => void;

export class Downloader {
  private inflight = new Map<string, Promise<Track>>();

  constructor(
    private readonly dir: string,
    private readonly library: Library,
    private readonly maxBytes: number,
  ) {}

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    let count = 0;
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const stored = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')) as StoredDownload;
        const filePath = path.join(this.dir, stored.file);
        await fs.access(filePath);
        this.library.registerRemote(stored.track, filePath);
        count++;
      } catch {
        /* stale metadata */
      }
    }
    if (count) log.info('download', `${count} cached downloads available`);
  }

  static validateUrl(input: string): URL {
    let url: URL;
    try {
      url = new URL(input.trim());
    } catch {
      throw new Error('That is not a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are supported');
    return url;
  }

  /** Downloads (or reuses a cached copy of) an audio file and returns its track. */
  get(input: string, onProgress?: ProgressFn): Promise<Track> {
    const url = Downloader.validateUrl(input).toString();
    const id = 'u' + hashId(url);
    const cached = this.library.get(id);
    if (cached) return Promise.resolve(cached.track);
    let p = this.inflight.get(id);
    if (!p) {
      p = this.download(url, id, onProgress).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  /** Builds a placeholder track to show in the queue while downloading. */
  static placeholder(input: string): Track {
    const url = Downloader.validateUrl(input);
    return {
      id: 'u' + hashId(url.toString()),
      source: 'url',
      title: titleFromUrl(url),
      artist: url.hostname,
      album: '',
      duration: 0,
      hasCover: false,
      url: url.toString(),
    };
  }

  private async download(url: string, id: string, onProgress?: ProgressFn): Promise<Track> {
    const ctrl = new AbortController();
    let idle: NodeJS.Timeout | undefined;
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(new Error('Download stalled')), 30_000);
    };
    bump();
    const tmpPath = path.join(this.dir, `${id}.part`);
    try {
      const { res, finalUrl } = await openUrl(new URL(url), ctrl.signal);
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        throw new Error(`Server responded ${status} ${res.statusMessage ?? ''}`.trim());
      }
      const type = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type.startsWith('text/') || type.includes('json') || type.includes('xml')) {
        res.resume();
        throw new Error(`URL does not point to an audio file (content-type: ${type})`);
      }
      const total = Number(res.headers['content-length']) || 0;
      if (total > this.maxBytes) {
        res.resume();
        throw new Error(`File is too large (${Math.round(total / 1e6)} MB)`);
      }

      const urlExt = path.extname(finalUrl.pathname).toLowerCase();
      const ext = AUDIO_EXTENSIONS.has(urlExt) ? urlExt : CONTENT_TYPE_EXT[type] ?? '.audio';

      const fh = await fs.open(tmpPath, 'w');
      let received = 0;
      let lastReport = 0;
      try {
        for await (const chunk of res as AsyncIterable<Buffer>) {
          bump();
          received += chunk.length;
          if (received > this.maxBytes) throw new Error(`File is larger than ${Math.round(this.maxBytes / 1e6)} MB`);
          await fh.write(chunk);
          const now = Date.now();
          if (onProgress && now - lastReport > 300) {
            lastReport = now;
            onProgress(total ? received / total : undefined);
          }
        }
      } finally {
        res.destroy();
        await fh.close();
      }
      if (total && received < total) throw new Error('Connection closed before the download finished');
      if (received === 0) throw new Error('Downloaded file is empty');

      const file = `${id}${ext}`;
      const filePath = path.join(this.dir, file);
      await fs.rename(tmpPath, filePath);

      const track = Downloader.placeholder(url);
      track.addedAt = Date.now();
      try {
        const meta = await parseFile(filePath, { skipPostHeaders: true });
        track.title = meta.common.title?.trim() || track.title;
        track.artist = meta.common.artists?.join(', ') || meta.common.artist?.trim() || track.artist;
        track.album = meta.common.album?.trim() || '';
        track.year = meta.common.year || undefined;
        track.duration = meta.format.duration ?? 0;
        track.hasCover = !!meta.common.picture?.length;
      } catch (err) {
        log.warn('download', `Could not read tags of ${url}: ${errorMessage(err)}`);
      }
      await fs.writeFile(path.join(this.dir, `${id}.json`), JSON.stringify({ track, file } satisfies StoredDownload));
      this.library.registerRemote(track, filePath);
      log.info('download', `Downloaded ${url} (${(received / 1e6).toFixed(1)} MB)`);
      return track;
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      const reason = ctrl.signal.aborted ? ctrl.signal.reason : err;
      throw new Error(`Download failed: ${errorMessage(reason)}`);
    } finally {
      clearTimeout(idle);
    }
  }
}

function titleFromUrl(url: URL): string {
  const base = decodeURIComponent(path.posix.basename(url.pathname) || '');
  const name = base.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_+]/g, ' ').trim();
  return name || url.hostname;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** GET with redirect following, using node:http(s) (streams large bodies reliably). */
async function openUrl(url: URL, signal: AbortSignal, redirectsLeft = 5): Promise<{ res: http.IncomingMessage; finalUrl: URL }> {
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { signal, headers: { 'user-agent': 'dj-alex/1.0', accept: 'audio/*, */*' } }, resolve);
    req.on('error', reject);
  });
  const location = res.headers.location;
  if (REDIRECTS.has(res.statusCode ?? 0) && location) {
    res.resume();
    if (redirectsLeft <= 0) throw new Error('Too many redirects');
    const next = new URL(location, url);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('Redirected to an unsupported URL');
    return openUrl(next, signal, redirectsLeft - 1);
  }
  return { res, finalUrl: url };
}
