/**
 * The in-memory dataset the views work from: normalized shards plus the lookups every
 * screen needs. Normalization is `@atlas/core` — the same code the web app runs.
 */

import type {
  CoverageMap,
  Hardware,
  IndexRow,
  Manifest,
  Quant,
  Registry,
  RegistryModel,
  SiteConfig,
  Workload,
} from '@atlas/core';
import { normalizeCoverage, normalizeIndex, normalizeRegistry } from '@atlas/core';
import type { DataSource, SyncResult } from './source.js';

/** A minimal site fallback for when the registry shard is missing its `site` block. */
const SITE_FALLBACK: SiteConfig = {
  schema_version: 1,
  repo: { owner: '0xBakeer', name: 'inference-atlas', default_branch: 'main' },
  site: {
    title: 'Inference Atlas',
    tagline: '',
    description: '',
    base_path: '/inference-atlas/',
    url: 'https://0xbakeer.github.io/inference-atlas/',
    theme_default: 'system',
  },
} as unknown as SiteConfig;

export interface AtlasData {
  manifest: Manifest | null;
  registry: Registry;
  index: IndexRow[];
  coverage: CoverageMap;
  sync: SyncResult;
  hardwareById: Map<string, Hardware>;
  workloadById: Map<string, Workload>;
  modelById: Map<string, RegistryModel>;
  quantById: (modelId: string, quantId: string) => Quant | null;
  engineById: (id: string) => Registry['engines'][number] | null;
}

export async function loadAtlas(source: DataSource): Promise<AtlasData> {
  const sync = await source.sync();
  const registry = normalizeRegistry(source.shard('registry.json'), SITE_FALLBACK);
  const index = normalizeIndex(source.shard('index.json'));
  const coverage = normalizeCoverage(source.shard('coverage.json'));

  const hardwareById = new Map(registry.hardware.map((h) => [h.id, h]));
  const workloadById = new Map(registry.workloads.map((w) => [w.id, w]));
  const modelById = new Map(registry.models.map((m) => [m.model.id, m]));

  return {
    manifest: sync.manifest ?? source.shard('manifest.json'),
    registry,
    index,
    coverage,
    sync,
    hardwareById,
    workloadById,
    modelById,
    quantById: (modelId, quantId) =>
      modelById.get(modelId)?.quants.find((q) => q.id === quantId) ?? null,
    engineById: (id) => registry.engines.find((e) => e.meta.id === id) ?? null,
  };
}
