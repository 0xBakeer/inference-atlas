/**
 * Data store. Fetches the compiled shards (SPEC §6) relative to `BASE_URL + 'data/'`, keeps
 * them in memory, and exposes derived lookups. Initial load = manifest + registry + index +
 * coverage + stats; gaps, contributors, engine version files and full runs are lazy.
 */
import { computeCoverage, loginKey } from '@atlas/core';
import type { EngineVersion, Gap, ResultRecord, SiteConfig } from '@atlas/core';
import siteFallbackJson from '../../site/config.json';
import { atlasCells, buildLookups, type Lookups, type PossibleCell } from './data/derive.js';
import {
  normalizeContributors,
  normalizeCoverage,
  normalizeGaps,
  normalizeIndex,
  normalizeRegistry,
  normalizeStats,
} from './data/normalize.js';
import type {
  ContributorRow,
  CoverageMap,
  IndexRow,
  Manifest,
  Registry,
  Stats,
} from './data/types.js';
import { signal } from './signal.js';

export const siteFallback = siteFallbackJson as unknown as SiteConfig;

export const DATA_BASE = `${import.meta.env.BASE_URL}data/`;

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

async function fetchJson<T = unknown>(
  path: string,
  opts: { optional?: boolean } = {},
): Promise<T | null> {
  const url = DATA_BASE + path;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    if (opts.optional) return null;
    throw new Error(`${res.status} ${res.statusText} while fetching ${path}`);
  }
  return (await res.json()) as T;
}

class Store {
  readonly status = signal<LoadStatus>('idle');
  readonly error = signal<string | null>(null);
  readonly manifest = signal<Manifest | null>(null);
  readonly registry = signal<Registry | null>(null);
  readonly index = signal<IndexRow[]>([]);
  readonly coverage = signal<CoverageMap>({});
  readonly stats = signal<Stats | null>(null);
  readonly gaps = signal<Gap[] | null>(null);
  readonly contributors = signal<ContributorRow[] | null>(null);

  private lookupsCache: { reg: Registry; lookups: Lookups } | null = null;
  private possibleCache: { reg: Registry; coverage: CoverageMap; cells: PossibleCell[] } | null =
    null;
  private engineVersionCache = new Map<string, Promise<EngineVersion | null>>();
  private runCache = new Map<string, Promise<ResultRecord | null>>();
  private gapsPromise: Promise<Gap[]> | null = null;
  private contributorsPromise: Promise<ContributorRow[]> | null = null;
  private bootPromise: Promise<void> | null = null;

  get site(): SiteConfig {
    return this.registry.value?.site ?? siteFallback;
  }

  get lookups(): Lookups {
    const reg = this.registry.value;
    if (!reg)
      return buildLookups({
        hardware: [],
        engines: [],
        models: [],
        workloads: [],
        datasets: [],
        site: siteFallback,
      });
    if (!this.lookupsCache || this.lookupsCache.reg !== reg)
      this.lookupsCache = { reg, lookups: buildLookups(reg) };
    return this.lookupsCache.lookups;
  }

  get possible(): PossibleCell[] {
    const reg = this.registry.value;
    if (!reg) return [];
    const coverage = this.coverage.value;
    if (
      !this.possibleCache ||
      this.possibleCache.reg !== reg ||
      this.possibleCache.coverage !== coverage
    )
      this.possibleCache = { reg, coverage, cells: atlasCells(reg, coverage) };
    return this.possibleCache.cells;
  }

  boot(): Promise<void> {
    if (!this.bootPromise) this.bootPromise = this.doBoot();
    return this.bootPromise;
  }

  private async doBoot(): Promise<void> {
    this.status.value = 'loading';
    this.error.value = null;
    try {
      const manifest = (await fetchJson<Manifest>('manifest.json', { optional: true })) ?? {};
      this.manifest.value = manifest;
      const [registryRaw, indexRaw, coverageRaw, statsRaw] = await Promise.all([
        fetchJson('registry.json'),
        fetchJson('index.json'),
        fetchJson('coverage.json', { optional: true }),
        fetchJson('stats.json', { optional: true }),
      ]);
      const registry = normalizeRegistry(registryRaw, siteFallback);
      const index = normalizeIndex(indexRaw);
      let coverage = coverageRaw ? normalizeCoverage(coverageRaw) : {};
      if (Object.keys(coverage).length === 0 && index.length > 0) {
        const engineVersions: Record<string, string[]> = {};
        for (const e of registry.engines) engineVersions[e.meta.id] = e.versions;
        coverage = computeCoverage(index, { engineVersions }, { site: registry.site });
      }
      this.registry.value = registry;
      this.index.value = index;
      this.coverage.value = coverage;
      this.stats.value = this.deriveStats(
        normalizeStats(statsRaw),
        registry,
        index,
        coverage,
        manifest,
      );
      this.status.value = 'ready';
    } catch (e) {
      this.error.value = e instanceof Error ? e.message : String(e);
      this.status.value = 'error';
    }
  }

  private deriveStats(
    given: Partial<Stats>,
    reg: Registry,
    index: IndexRow[],
    coverage: CoverageMap,
    _manifest: Manifest,
  ): Stats {
    const logins = new Set(index.map((r) => loginKey(r.provenance.login)));
    let last: string | null = null;
    for (const r of index) {
      const t = r.provenance.submitted_at ?? r.provenance.started_at ?? null;
      if (t && (!last || t > last)) last = t;
    }
    return {
      runs: given.runs ?? index.length,
      cells_covered: given.cells_covered ?? Object.keys(coverage).length,
      cells_possible: given.cells_possible ?? this.possible.length,
      contributors: given.contributors ?? logins.size,
      engines: given.engines ?? reg.engines.length,
      models: given.models ?? reg.models.length,
      hardware: given.hardware ?? reg.hardware.length,
      workloads: given.workloads ?? reg.workloads.length,
      last_updated: given.last_updated ?? last ?? null,
    };
  }

  loadGaps(): Promise<Gap[]> {
    if (!this.gapsPromise) {
      this.gapsPromise = fetchJson('gaps.json', { optional: true })
        .then((raw) => {
          const gaps = normalizeGaps(raw);
          this.gaps.value = gaps;
          return gaps;
        })
        .catch(() => {
          this.gaps.value = [];
          return [];
        });
    }
    return this.gapsPromise;
  }

  loadContributors(): Promise<ContributorRow[]> {
    if (!this.contributorsPromise) {
      this.contributorsPromise = fetchJson('contributors.json', { optional: true })
        .then((raw) => {
          let list = normalizeContributors(raw);
          if (list.length === 0) list = this.contributorsFromIndex();
          this.contributors.value = list;
          return list;
        })
        .catch(() => {
          const list = this.contributorsFromIndex();
          this.contributors.value = list;
          return list;
        });
    }
    return this.contributorsPromise;
  }

  /** Fallback when contributors.json is absent: counts only, no points. */
  private contributorsFromIndex(): ContributorRow[] {
    const by = new Map<string, ContributorRow>();
    for (const r of this.index.value) {
      const login = r.provenance.login;
      const key = loginKey(login);
      let c = by.get(key);
      if (!c) {
        c = {
          login,
          user_id: r.provenance.user_id ?? null,
          runs: 0,
          cells_filled: 0,
          reproductions: 0,
          hardware_ids: [],
          first_seen: null,
          last_seen: null,
          points: 0,
          avatar_url: r.provenance.avatar_url ?? null,
          breakdown: {
            cells_filled: 0,
            reproductions: 0,
            additional_runs: 0,
            sweep_points: 0,
            eval_runs: 0,
            gotchas: 0,
            registry_hardware: 0,
            registry_models: 0,
            registry_engines: 0,
            registry_quants: 0,
            registry_workloads: 0,
          },
        };
        by.set(key, c);
      }
      c.runs += 1;
      if (!c.hardware_ids.includes(r.hardware.id)) c.hardware_ids.push(r.hardware.id);
      const t = r.provenance.submitted_at ?? r.provenance.started_at ?? null;
      if (t) {
        if (!c.first_seen || t < c.first_seen) c.first_seen = t;
        if (!c.last_seen || t > c.last_seen) c.last_seen = t;
      }
    }
    for (const c of by.values()) {
      const cells = new Set(
        this.index.value
          .filter((r) => loginKey(r.provenance.login) === loginKey(c.login))
          .map((r) => r.cell_id),
      );
      c.cells_filled = cells.size;
    }
    return [...by.values()].sort((a, b) => b.runs - a.runs);
  }

  engineVersion(engineId: string, version: string): Promise<EngineVersion | null> {
    const key = `${engineId}/${version}`;
    let p = this.engineVersionCache.get(key);
    if (!p) {
      p = fetchJson<EngineVersion>(
        `engines/${encodeURIComponent(engineId)}/${encodeURIComponent(version)}.json`,
        {
          optional: true,
        },
      ).catch(() => null);
      this.engineVersionCache.set(key, p);
    }
    return p;
  }

  run(row: IndexRow | { run_id: string; path?: string }): Promise<ResultRecord | null> {
    const id = row.run_id;
    let p = this.runCache.get(id);
    if (!p) {
      const path = this.runPath(row);
      p = fetchJson<ResultRecord>(path, { optional: true }).catch(() => null);
      this.runCache.set(id, p);
    }
    return p;
  }

  private runPath(row: { run_id: string; path?: string }): string {
    let path = row.path;
    if (!path) {
      const r = this.index.value.find((x) => x.run_id === row.run_id);
      path = r?.path;
      if (!path && r) path = `runs/${r.engine.id}/${r.model.id}/${r.hardware.id}/${r.run_id}.json`;
    }
    if (!path) path = `runs/${row.run_id}.json`;
    // The compiled index carries `results/...` (repo path) or `runs/...` (data path); both map onto data/runs.
    path = path.replace(/^\/?(data\/)?/, '').replace(/^results\//, 'runs/');
    if (!path.startsWith('runs/')) path = 'runs/' + path;
    return path;
  }

  rowById(runId: string): IndexRow | undefined {
    return this.index.value.find((r) => r.run_id === runId);
  }
}

export const store = new Store();
