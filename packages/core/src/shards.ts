/**
 * Shapes of the compiled data shards (`app/public/data/*`) — the contract between
 * `tools/build.ts` and every consumer: the web app, the TUI, and anything else that
 * reads the published data. Moved here from the app so all frontends share one definition.
 */
import type {
  CompiledIndexRow,
  Contributor,
  CoverageCell,
  Dataset,
  EngineMeta,
  EngineOverlay,
  EngineVersion,
  Hardware,
  Model,
  Quant,
  SiteConfig,
  Workload,
} from './types.js';

export interface Manifest {
  built_at?: string | null;
  commit?: string | null;
  commit_short?: string | null;
  counts?: Record<string, number>;
  shards?: Record<string, { sha256: string; bytes: number }>;
}

export interface RegistryEngine {
  meta: EngineMeta;
  overlay: EngineOverlay | null;
  /** Version strings, oldest → newest as listed in the registry. */
  versions: string[];
  /** Param counts per version when the build inlines them. */
  param_counts?: Record<string, number>;
}

export interface RegistryModel {
  model: Model;
  quants: Quant[];
}

export interface Registry {
  hardware: Hardware[];
  engines: RegistryEngine[];
  models: RegistryModel[];
  workloads: Workload[];
  datasets: Dataset[];
  site: SiteConfig;
}

export interface Stats {
  runs: number;
  cells_covered: number;
  cells_possible: number;
  contributors: number;
  engines: number;
  models: number;
  hardware: number;
  workloads: number;
  last_updated: string | null;
}

export interface IndexRow extends CompiledIndexRow {
  provenance: CompiledIndexRow['provenance'] & { avatar_url?: string | null };
}

export interface ContributorRow extends Contributor {
  avatar_url?: string | null;
}

export type CoverageMap = Record<string, CoverageCell>;

export type { EngineVersion };
