import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike } from './source.js';
import { LocalSource, RemoteSource } from './source.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-tui-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Route {
  status: number;
  body?: string;
  etag?: string;
}

function fakeFetch(routes: Record<string, Route>, log: string[] = []): FetchLike {
  return async (url, init) => {
    log.push(`${init?.headers?.['If-None-Match'] ? '304?' : 'GET'} ${url}`);
    const route = routes[url] ?? { status: 404 };
    const etagMatches = route.etag !== undefined && init?.headers?.['If-None-Match'] === route.etag;
    const status = etagMatches ? 304 : route.status;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? (route.etag ?? null) : null) },
      text: async () => route.body ?? '',
    };
  };
}

const BASE = 'https://example.test/atlas';
const manifest = (sha: string) =>
  JSON.stringify({
    schema_version: 1,
    commit_short: 'abc1234',
    shards: { 'index.json': { sha256: sha, bytes: 2 } },
  });

describe('RemoteSource.sync', () => {
  it('fetches manifest and changed shards on first run', async () => {
    const src = new RemoteSource(
      BASE,
      dir,
      fakeFetch({
        [`${BASE}/data/manifest.json`]: { status: 200, body: manifest('aa'), etag: '"e1"' },
        [`${BASE}/data/index.json`]: { status: 200, body: '[]' },
      }),
    );
    const res = await src.sync();
    expect(res.status).toBe('updated');
    expect(res.fetched).toContain('index.json');
    expect(src.shard('index.json')).toEqual([]);
  });

  it('is fresh on 304 and does not refetch shards', async () => {
    const log: string[] = [];
    const routes = {
      [`${BASE}/data/manifest.json`]: { status: 200, body: manifest('aa'), etag: '"e1"' },
      [`${BASE}/data/index.json`]: { status: 200, body: '[]' },
    };
    const src = new RemoteSource(BASE, dir, fakeFetch(routes, log));
    await src.sync();
    const second = await src.sync();
    expect(second.status).toBe('fresh');
    expect(second.fetched).toEqual([]);
    // Second pass touched only the manifest URL.
    expect(log.filter((l) => l.includes('index.json'))).toHaveLength(1);
  });

  it('refetches only shards whose sha changed', async () => {
    const routes: Record<string, Route> = {
      [`${BASE}/data/manifest.json`]: { status: 200, body: manifest('aa'), etag: '"e1"' },
      [`${BASE}/data/index.json`]: { status: 200, body: '[]' },
    };
    const log: string[] = [];
    const src = new RemoteSource(BASE, dir, fakeFetch(routes, log));
    await src.sync();
    routes[`${BASE}/data/manifest.json`] = { status: 200, body: manifest('bb'), etag: '"e2"' };
    routes[`${BASE}/data/index.json`] = { status: 200, body: '[1]' };
    const res = await src.sync();
    expect(res.status).toBe('updated');
    expect(res.fetched).toEqual(['index.json']);
    expect(src.shard('index.json')).toEqual([1]);
  });

  it('degrades to the cache when the network is gone', async () => {
    const routes = {
      [`${BASE}/data/manifest.json`]: { status: 200, body: manifest('aa'), etag: '"e1"' },
      [`${BASE}/data/index.json`]: { status: 200, body: '[]' },
    };
    const src = new RemoteSource(BASE, dir, fakeFetch(routes));
    await src.sync();
    const dead = new RemoteSource(BASE, dir, async () => {
      throw new Error('offline');
    });
    const res = await dead.sync();
    expect(res.status).toBe('offline');
    expect(res.manifest?.commit_short).toBe('abc1234');
    expect(dead.shard('index.json')).toEqual([]);
  });

  it('caches immutable run shards forever', async () => {
    const log: string[] = [];
    const runUrl = `${BASE}/data/runs/vllm/o/m/hw/r1.json`;
    const src = new RemoteSource(
      BASE,
      dir,
      fakeFetch({ [runUrl]: { status: 200, body: '{"run_id":"r1"}' } }, log),
    );
    expect(await src.run('results/vllm/o/m/hw/r1.json')).toEqual({ run_id: 'r1' });
    expect(await src.run('results/vllm/o/m/hw/r1.json')).toEqual({ run_id: 'r1' });
    expect(log.filter((l) => l.includes('r1.json'))).toHaveLength(1);
  });
});

describe('LocalSource', () => {
  it('reports a missing build with instructions', async () => {
    const src = new LocalSource(dir);
    const res = await src.sync();
    expect(res.status).toBe('offline');
    expect(res.error).toContain('pnpm build:data');
  });

  it('reads shards, raw results and engine version files from the checkout', async () => {
    const dataDir = path.join(dir, 'app', 'public', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'manifest.json'), '{"schema_version":1}');
    fs.writeFileSync(path.join(dataDir, 'index.json'), '[]');
    const resultsDir = path.join(dir, 'results', 'vllm', 'o', 'm', 'hw');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, 'r1.json'), '{"run_id":"r1"}');
    const versDir = path.join(dir, 'engines', 'vllm', 'versions');
    fs.mkdirSync(versDir, { recursive: true });
    fs.writeFileSync(path.join(versDir, '0.27.1.json'), '{"version":"0.27.1"}');

    const src = new LocalSource(dir);
    expect((await src.sync()).status).toBe('fresh');
    expect(src.shard('index.json')).toEqual([]);
    expect(await src.run('results/vllm/o/m/hw/r1.json')).toEqual({ run_id: 'r1' });
    expect(await src.engineVersion('vllm', '0.27.1')).toEqual({ version: '0.27.1' });
  });
});
