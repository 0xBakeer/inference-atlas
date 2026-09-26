/**
 * The compiled data is produced by `tools/build` (SPEC §6). These helpers accept the shapes
 * the spec describes plus the obvious variants, so the app keeps working while the build
 * evolves, and so the mock dataset and the real one are interchangeable.
 */
import type {
  CompiledIndexRow,
  Contributor,
  CoverageCell,
  Dataset,
  EngineMeta,
  EngineOverlay,
  Gap,
  Hardware,
  Model,
  Quant,
  SiteConfig,
  Workload,
} from './types.js';
import type {
  ContributorRow,
  CoverageMap,
  IndexRow,
  Registry,
  RegistryEngine,
  RegistryModel,
  Stats,
} from './shards.js';

type AnyRec = Record<string, unknown>;

function isRec(v: unknown): v is AnyRec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeEngine(raw: unknown): RegistryEngine | null {
  if (!isRec(raw)) return null;
  let meta: EngineMeta;
  let overlay: EngineOverlay | null = null;
  if (isRec(raw.meta)) {
    meta = raw.meta as unknown as EngineMeta;
    overlay = isRec(raw.overlay) ? (raw.overlay as unknown as EngineOverlay) : null;
  } else {
    const { overlay: ov, versions: _v, ...rest } = raw;
    meta = rest as unknown as EngineMeta;
    overlay = isRec(ov) ? (ov as unknown as EngineOverlay) : null;
  }
  let versions: string[] = [];
  const param_counts: Record<string, number> = {};
  const rv = raw.versions;
  if (Array.isArray(rv)) {
    versions = rv
      .map((v) => {
        if (typeof v === 'string') return v;
        if (isRec(v) && typeof v.version === 'string') {
          if (typeof v.param_count === 'number') param_counts[v.version] = v.param_count;
          else if (Array.isArray(v.params)) param_counts[v.version] = v.params.length;
          return v.version;
        }
        return null;
      })
      .filter((v): v is string => !!v);
  } else if (isRec(rv)) {
    versions = Object.keys(rv);
    for (const [ver, info] of Object.entries(rv)) {
      if (isRec(info) && typeof info.param_count === 'number') param_counts[ver] = info.param_count;
    }
  }
  if (versions.length === 0 && Array.isArray(meta.versions_available))
    versions = [...meta.versions_available];
  if (!meta || typeof meta.id !== 'string') return null;
  return { meta, overlay, versions, param_counts };
}

function normalizeModel(raw: unknown): RegistryModel | null {
  if (!isRec(raw)) return null;
  let model: Model;
  let quants: Quant[] = [];
  if (isRec(raw.model)) {
    model = raw.model as unknown as Model;
    quants = Array.isArray(raw.quants) ? (raw.quants as Quant[]) : [];
  } else {
    const { quants: q, ...rest } = raw;
    model = rest as unknown as Model;
    quants = Array.isArray(q) ? (q as Quant[]) : [];
  }
  if (!model || typeof model.id !== 'string') return null;
  return { model, quants };
}

export function normalizeRegistry(raw: unknown, fallbackSite: SiteConfig): Registry {
  const r = isRec(raw) ? raw : {};
  const hardware = (Array.isArray(r.hardware) ? r.hardware : []) as Hardware[];
  const engines = (Array.isArray(r.engines) ? r.engines : [])
    .map(normalizeEngine)
    .filter((e): e is RegistryEngine => !!e);
  const models = (Array.isArray(r.models) ? r.models : [])
    .map(normalizeModel)
    .filter((m): m is RegistryModel => !!m);
  const workloads = (Array.isArray(r.workloads) ? r.workloads : []) as Workload[];
  const datasets = (Array.isArray(r.datasets) ? r.datasets : []) as Dataset[];
  const site = isRec(r.site)
    ? ({ ...fallbackSite, ...(r.site as object) } as SiteConfig)
    : fallbackSite;
  hardware.sort((a, b) => a.id.localeCompare(b.id));
  engines.sort((a, b) => a.meta.id.localeCompare(b.meta.id));
  models.sort((a, b) => a.model.id.localeCompare(b.model.id));
  workloads.sort((a, b) => a.id.localeCompare(b.id));
  return { hardware, engines, models, workloads, datasets, site };
}

export function normalizeIndex(raw: unknown): IndexRow[] {
  const arr = Array.isArray(raw)
    ? raw
    : isRec(raw) && Array.isArray(raw.rows)
      ? raw.rows
      : isRec(raw) && Array.isArray(raw.runs)
        ? raw.runs
        : [];
  return (arr as CompiledIndexRow[])
    .filter((r) => isRec(r) && typeof r.run_id === 'string')
    .map((r) => {
      const prov = (isRec(r.provenance) ? r.provenance : {}) as IndexRow['provenance'];
      const engine = { ...r.engine } as CompiledIndexRow['engine'];
      if (!engine.minor && engine.version) {
        const m = /^v?(\d+)\.(\d+)/.exec(engine.version.toLowerCase());
        engine.minor = m ? `${m[1]}.${m[2]}` : engine.version.toLowerCase();
      }
      return {
        ...r,
        engine,
        metrics: isRec(r.metrics) ? r.metrics : {},
        provenance: prov,
        verification_level: r.verification_level ?? 'self-reported',
      } as IndexRow;
    });
}

export function normalizeCoverage(raw: unknown): CoverageMap {
  if (isRec(raw) && isRec(raw.cells)) return raw.cells as CoverageMap;
  if (isRec(raw)) return raw as CoverageMap;
  if (Array.isArray(raw)) {
    const out: CoverageMap = {};
    for (const c of raw as CoverageCell[]) if (c && c.cell_id) out[c.cell_id] = c;
    return out;
  }
  return {};
}

export function normalizeGaps(raw: unknown): Gap[] {
  const arr = Array.isArray(raw) ? raw : isRec(raw) && Array.isArray(raw.gaps) ? raw.gaps : [];
  return (arr as Gap[]).filter((g) => isRec(g) && typeof g.model_id === 'string');
}

export function normalizeContributors(raw: unknown): ContributorRow[] {
  const arr = Array.isArray(raw)
    ? raw
    : isRec(raw) && Array.isArray(raw.contributors)
      ? raw.contributors
      : [];
  return (arr as Contributor[])
    .filter((c) => isRec(c) && typeof c.login === 'string')
    .map((c) => ({
      ...c,
      runs: c.runs ?? 0,
      cells_filled: c.cells_filled ?? 0,
      reproductions: c.reproductions ?? 0,
      hardware_ids: c.hardware_ids ?? [],
      points: c.points ?? 0,
    }));
}

export function normalizeStats(raw: unknown): Partial<Stats> {
  if (!isRec(raw)) return {};
  const n = (k: string[]): number | undefined => {
    for (const key of k) {
      const v = raw[key];
      if (typeof v === 'number') return v;
    }
    return undefined;
  };
  const s = (k: string[]): string | undefined => {
    for (const key of k) {
      const v = raw[key];
      if (typeof v === 'string') return v;
    }
    return undefined;
  };
  const out: Partial<Stats> = {};
  const runs = n(['runs', 'run_count', 'results']);
  if (runs !== undefined) out.runs = runs;
  const cc = n(['cells_covered', 'covered_cells', 'cells_with_runs']);
  if (cc !== undefined) out.cells_covered = cc;
  const cp = n(['cells_possible', 'possible_cells', 'cells_total']);
  if (cp !== undefined) out.cells_possible = cp;
  const c = n(['contributors', 'contributor_count']);
  if (c !== undefined) out.contributors = c;
  const e = n(['engines', 'engine_count']);
  if (e !== undefined) out.engines = e;
  const m = n(['models', 'model_count']);
  if (m !== undefined) out.models = m;
  const h = n(['hardware', 'hardware_count']);
  if (h !== undefined) out.hardware = h;
  const w = n(['workloads', 'workload_count']);
  if (w !== undefined) out.workloads = w;
  // deliberately NOT falling back to `built_at`: last_updated means "last result",
  // and with zero runs the build time would masquerade as one
  const lu = s(['last_updated', 'last_submitted_at', 'updated_at']);
  if (lu !== undefined) out.last_updated = lu;
  return out;
}
