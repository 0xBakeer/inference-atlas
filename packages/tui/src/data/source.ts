/**
 * Where the compiled data shards come from.
 *
 * Remote (the default): the GitHub Pages deployment publishes `data/manifest.json` with a
 * sha256 per shard, so a sync is one small conditional GET — shards are re-fetched only when
 * their hash changed, and everything lands in the cache directory so the TUI works offline
 * afterwards. Run shards are immutable (a run_id never changes content) and cache forever.
 *
 * Local (`--repo`): a checkout of the repository. Reads `app/public/data/*` when the build
 * exists, and always reads registries (`engines/<id>/versions/*.json`) straight from source.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Manifest } from '@atlas/core';

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface SyncResult {
  /** 'fresh' = 304 or unchanged hashes; 'updated' = at least one shard re-fetched. */
  status: 'fresh' | 'updated' | 'offline';
  fetched: string[];
  manifest: Manifest | null;
  error?: string;
}

export interface DataSource {
  /** Refresh the shard set. Never throws: offline degrades to the cache. */
  sync(): Promise<SyncResult>;
  /** Parsed shard by file name (`index.json`, `registry.json`, ...); null when absent. */
  shard<T>(name: string): T | null;
  /** Full run record by its result path (`results/<engine>/<owner>/<name>/<hw>/<id>.json`). */
  run<T>(resultPath: string): Promise<T | null>;
  /** Engine version param table (`engines/<id>/<version>.json` in the compiled data). */
  engineVersion<T>(engineId: string, version: string): Promise<T | null>;
  /** Where this source's data physically lives — shown in the UI. */
  describe(): string;
}

const SHARDS = [
  'manifest.json',
  'index.json',
  'registry.json',
  'coverage.json',
  'workloads.json',
  'datasets.json',
  'stats.json',
  'contributors.json',
  'gaps.json',
] as const;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** `results/vllm/Qwen/Qwen3-8B/hw/run.json` → `runs/vllm/Qwen/Qwen3-8B/hw/run.json`. */
function runShardPath(resultPath: string): string {
  return resultPath.replace(/^results\//, 'runs/');
}

export class RemoteSource implements DataSource {
  private readonly base: string;
  private readonly dir: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    cacheDataDir: string,
    fetchFn: FetchLike = fetch as unknown as FetchLike,
    timeoutMs = 15000,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.dir = cacheDataDir;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  describe(): string {
    return this.base;
  }

  private async get(url: string, headers: Record<string, string> = {}) {
    return this.fetchFn(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  async sync(): Promise<SyncResult> {
    const metaFile = path.join(this.dir, '.sync.json');
    const meta = readJson<{ etag?: string }>(metaFile) ?? {};
    const cachedManifest = readJson<Manifest>(path.join(this.dir, 'manifest.json'));
    try {
      const headers: Record<string, string> = {};
      if (meta.etag && cachedManifest) headers['If-None-Match'] = meta.etag;
      const res = await this.get(`${this.base}/data/manifest.json`, headers);
      if (res.status === 304) return { status: 'fresh', fetched: [], manifest: cachedManifest };
      if (!res.ok) {
        return {
          status: 'offline',
          fetched: [],
          manifest: cachedManifest,
          error: `manifest: HTTP ${res.status}`,
        };
      }
      const text = await res.text();
      const manifest = JSON.parse(text) as Manifest;
      const fetched: string[] = [];
      for (const name of SHARDS) {
        if (name === 'manifest.json') continue;
        const want = manifest.shards?.[name]?.sha256;
        const have = cachedManifest?.shards?.[name]?.sha256;
        const file = path.join(this.dir, name);
        if (want && want === have && fs.existsSync(file)) continue;
        const shardRes = await this.get(`${this.base}/data/${name}`);
        if (!shardRes.ok) continue; // a missing optional shard is not fatal
        writeFileAtomic(file, await shardRes.text());
        fetched.push(name);
      }
      // The manifest goes last: it asserts the shard set on disk is consistent.
      writeFileAtomic(path.join(this.dir, 'manifest.json'), text);
      writeFileAtomic(metaFile, JSON.stringify({ etag: res.headers.get('etag') ?? undefined }));
      return { status: fetched.length > 0 ? 'updated' : 'fresh', fetched, manifest };
    } catch (err) {
      return {
        status: 'offline',
        fetched: [],
        manifest: cachedManifest,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  shard<T>(name: string): T | null {
    return readJson<T>(path.join(this.dir, name));
  }

  async run<T>(resultPath: string): Promise<T | null> {
    const rel = runShardPath(resultPath);
    const file = path.join(this.dir, rel);
    const cached = readJson<T>(file);
    if (cached) return cached; // run shards are immutable — cache forever
    try {
      const res = await this.get(`${this.base}/data/${rel}`);
      if (!res.ok) return null;
      const text = await res.text();
      writeFileAtomic(file, text);
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async engineVersion<T>(engineId: string, version: string): Promise<T | null> {
    const rel = path.join('engines', engineId, `${version}.json`);
    const file = path.join(this.dir, rel);
    const cached = readJson<T>(file);
    if (cached) return cached;
    try {
      const res = await this.get(`${this.base}/data/engines/${engineId}/${version}.json`);
      if (!res.ok) return null;
      const text = await res.text();
      writeFileAtomic(file, text);
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
}

export class LocalSource implements DataSource {
  private readonly repo: string;
  private readonly dataDir: string;

  constructor(repoRoot: string) {
    this.repo = repoRoot;
    this.dataDir = path.join(repoRoot, 'app', 'public', 'data');
  }

  describe(): string {
    return this.repo;
  }

  /** Local mode never fetches; "sync" just checks the build exists. */
  async sync(): Promise<SyncResult> {
    const manifest = readJson<Manifest>(path.join(this.dataDir, 'manifest.json'));
    if (!manifest) {
      return {
        status: 'offline',
        fetched: [],
        manifest: null,
        error: `no compiled data at ${this.dataDir} — run \`pnpm build:data\` in the repo first`,
      };
    }
    return { status: 'fresh', fetched: [], manifest };
  }

  shard<T>(name: string): T | null {
    return readJson<T>(path.join(this.dataDir, name));
  }

  async run<T>(resultPath: string): Promise<T | null> {
    // Prefer the raw result file (it is the source of truth); fall back to the run shard.
    return (
      readJson<T>(path.join(this.repo, resultPath)) ??
      readJson<T>(path.join(this.dataDir, runShardPath(resultPath)))
    );
  }

  async engineVersion<T>(engineId: string, version: string): Promise<T | null> {
    return (
      readJson<T>(path.join(this.repo, 'engines', engineId, 'versions', `${version}.json`)) ??
      readJson<T>(path.join(this.dataDir, 'engines', engineId, `${version}.json`))
    );
  }
}
