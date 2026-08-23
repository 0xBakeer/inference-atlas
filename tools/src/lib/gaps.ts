/**
 * The wanted queue (SPEC §6, `gaps.json`).
 *
 * Colour on the atlas means *evidence*, so the interesting output of this project is not
 * the fastest square, it is the grey one. This module enumerates every cell the registry
 * says is physically possible, subtracts the ones somebody has already measured, and ranks
 * what is left by the weights in `site.wanted.weights`.
 *
 * Cells that *do* exist but whose evidence has gone off — stale (the engine has moved on
 * two minors) or disputed (two contributors disagree) — are ranked into the same queue with
 * their own weights and their `level` set accordingly, because "this number is probably
 * wrong" is a better use of an hour of GPU time than a square nobody cares about. A gap's
 * `workload_ids` lists exactly which of the wanted workloads that cell is missing.
 */
import { cellId, engineMinor } from '@atlas/core';
import type { CoverageCell, Gap, SiteConfig } from '@atlas/core';
import { engineFitsHardware } from './compat.js';
import type { Repo } from './repo.js';

const DEFAULT_MAX = 500;

export interface WantedRequest {
  /** As filled in by the `request-config` issue form; any field may be absent. */
  engine_id?: string | null;
  model_id?: string | null;
  quant_id?: string | null;
  hardware_id?: string | null;
  workload_id?: string | null;
  reactions?: number;
  issue?: number;
  title?: string;
}

export interface GapsInput {
  repo: Repo;
  cells: Record<string, CoverageCell>;
  /** `site/wanted-requests.json`, when `wanted-snapshot.yml` has written one. */
  requests?: WantedRequest[];
}

export interface MissingWorkloads {
  cell_id: string;
  model_id: string;
  quant_id: string;
  hardware_id: string;
  hw_count: number;
  engine_id: string;
  engine_minor: string;
  level: CoverageCell['level'];
  have: string[];
  missing: string[];
}

export interface GapsOutput {
  /** Which workloads a cell is expected to carry — `site.wanted.workloads`, else featured. */
  wanted_workload_ids: string[];
  max: number;
  gaps: Gap[];
  missing_workloads: MissingWorkloads[];
  /** How many candidate cells the registry cross product produced before ranking. */
  considered: number;
}

/**
 * Which workloads a filled cell is expected to carry.
 *
 * `site.wanted.workloads` declares it; `featured.workloads` stands in when absent and the
 * whole registry is the last resort. Ranking against *every* workload would make the queue meaningless — a cell is
 * not a gap because nobody ran the 32k prefill on it.
 */
export function wantedWorkloadIds(repo: Repo): string[] {
  const site = repo.site as SiteConfig | null;
  const declared = site?.wanted?.workloads ?? site?.featured?.workloads ?? null;
  const ids = (declared ?? [...repo.workloads.keys()]).filter(
    (id) => repo.workloads.size === 0 || repo.workloads.has(id),
  );
  return [...new Set(ids)].sort();
}

function weight(site: SiteConfig | null, key: string, fallback = 0): number {
  const value = site?.wanted?.weights?.[key];
  return typeof value === 'number' ? value : fallback;
}

/** Newest registered minor per engine, so "is this the current minor" is answerable. */
function newestMinors(repo: Repo): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, entry] of repo.engines) {
    const minors = [...new Set((entry.meta.versions_available ?? []).map(engineMinor))];
    if (minors.length === 0) continue;
    minors.sort(compareMinor);
    out.set(id, minors[minors.length - 1]!);
  }
  return out;
}

function compareMinor(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)$/.exec(a);
  const pb = /^(\d+)\.(\d+)$/.exec(b);
  if (pa && pb) return Number(pa[1]) - Number(pb[1]) || Number(pa[2]) - Number(pb[2]);
  if (pa) return -1;
  if (pb) return 1;
  const na = /^[a-z]*(\d+)$/.exec(a);
  const nb = /^[a-z]*(\d+)$/.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Newest registered version within each minor — what the packet should pin. */
function versionForMinor(versions: string[], minor: string): string {
  const inMinor = versions.filter((v) => engineMinor(v) === minor);
  inMinor.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return inMinor[inMinor.length - 1] ?? minor;
}

function matchesRequest(request: WantedRequest, gap: Omit<Gap, 'score' | 'reasons'>): boolean {
  const fields: Array<[string | null | undefined, string]> = [
    [request.engine_id, gap.engine_id],
    [request.model_id, gap.model_id],
    [request.quant_id, gap.quant_id],
    [request.hardware_id, gap.hardware_id],
  ];
  let named = 0;
  for (const [wanted, actual] of fields) {
    if (!wanted) continue;
    named += 1;
    if (wanted !== actual) return false;
  }
  return named > 0;
}

export function computeGaps(input: GapsInput): GapsOutput {
  const { repo, cells } = input;
  const site = repo.site;
  const max = site?.wanted?.max_gaps ?? DEFAULT_MAX;
  const wanted = wantedWorkloadIds(repo);
  const requests = input.requests ?? [];

  const featuredModels = new Set(site?.featured?.models ?? []);
  const featuredHardware = new Set(site?.featured?.hardware ?? []);
  const featuredEngines = new Set(site?.featured?.engines ?? []);
  const newest = newestMinors(repo);

  /* What has been measured at all — the "never measured" bonuses read these. */
  const measuredModels = new Set<string>();
  const measuredHardware = new Set<string>();
  const measuredEngines = new Set<string>();
  const measuredQuants = new Set<string>();
  const measuredModelQuantEngine = new Set<string>();
  const measuredHardwareEngine = new Set<string>();
  for (const cell of Object.values(cells)) {
    measuredModels.add(cell.model_id);
    measuredHardware.add(cell.hardware_id);
    measuredEngines.add(cell.engine_id);
    measuredQuants.add(`${cell.model_id}/${cell.quant_id}`);
    measuredModelQuantEngine.add(`${cell.model_id}/${cell.quant_id}|${cell.engine_id}`);
    measuredHardwareEngine.add(`${cell.hardware_id}|${cell.engine_id}`);
  }

  const gaps: Gap[] = [];
  const missing: MissingWorkloads[] = [];
  let considered = 0;

  for (const modelEntry of repo.models.values()) {
    const model = modelEntry.model;
    for (const quant of modelEntry.quants.values()) {
      for (const engineId of quant.engines) {
        const engine = repo.engines.get(engineId);
        if (!engine) continue;
        if (!engine.meta.quant_formats.includes(quant.format)) continue;

        const minors = [...new Set((engine.meta.versions_available ?? []).map(engineMinor))].sort(
          compareMinor,
        );
        if (minors.length === 0) continue;

        for (const hardware of repo.hardware.values()) {
          if (!engineFitsHardware(engine.meta, hardware)) continue;

          for (const minor of minors) {
            considered += 1;
            const id = cellId({
              model_id: model.id,
              quant_id: quant.id,
              hardware_id: hardware.id,
              hw_count: 1,
              engine_id: engineId,
              engine_minor: minor,
            });
            const existing = cells[id] ?? null;

            const facts = {
              cell_id: id,
              model_id: model.id,
              quant_id: quant.id,
              hardware_id: hardware.id,
              hw_count: 1,
              engine_id: engineId,
              engine_version: versionForMinor(engine.meta.versions_available ?? [], minor),
              engine_minor: minor,
              workload_ids: [] as string[],
              level: (existing?.level ?? 'none') as Gap['level'],
            };

            if (existing) {
              const have = [...existing.workloads].sort();
              const lacks = wanted.filter((w) => !have.includes(w));
              if (lacks.length > 0) {
                missing.push({
                  cell_id: id,
                  model_id: model.id,
                  quant_id: quant.id,
                  hardware_id: hardware.id,
                  hw_count: 1,
                  engine_id: engineId,
                  engine_minor: minor,
                  level: existing.level,
                  have,
                  missing: lacks,
                });
              }
              // Only stale or disputed evidence earns a place in the queue; a healthy cell
              // that is merely missing one workload is in `missing_workloads` instead.
              if (existing.level !== 'stale' && existing.level !== 'disputed') continue;
              facts.workload_ids = lacks.length > 0 ? lacks : have;
            } else {
              facts.workload_ids = wanted;
            }

            const reasons: string[] = [];
            let score = 0;
            const add = (key: string, reason: string, fallback = 0) => {
              const w = weight(site, key, fallback);
              if (w === 0) return;
              score += w;
              reasons.push(reason);
            };

            if (featuredModels.has(model.id)) add('featured_model', `featured model ${model.id}`);
            if (featuredHardware.has(hardware.id)) {
              add('featured_hardware', `featured hardware ${hardware.id}`);
            }
            if (featuredEngines.has(engineId))
              add('featured_engine', `featured engine ${engineId}`);
            if (newest.get(engineId) === minor) {
              add('newest_engine_minor', `newest ${engineId} minor (${minor})`);
            }
            if (!measuredModels.has(model.id)) {
              add('model_never_measured', `${model.id} has never been measured`);
            }
            if (!measuredHardware.has(hardware.id)) {
              add('hardware_never_measured', `${hardware.id} has never been measured`);
            }
            if (!measuredEngines.has(engineId)) {
              add('engine_never_measured', `${engineId} has never been measured`);
            }
            if (!measuredQuants.has(`${model.id}/${quant.id}`)) {
              add('quant_never_measured', `${model.id}/${quant.id} has never been measured`);
            }
            if (
              measuredModelQuantEngine.has(`${model.id}/${quant.id}|${engineId}`) ||
              measuredHardwareEngine.has(`${hardware.id}|${engineId}`)
            ) {
              add('completes_axis', 'completes a row that is already partly filled');
            }
            if (existing?.level === 'stale') {
              add(
                'stale_refresh',
                `only evidence is ${existing.minors_behind ?? 0} engine minor(s) behind`,
              );
            }
            if (existing?.level === 'disputed') {
              add('disputed_tiebreak', 'contributors disagree — a third run would settle it');
            }

            let reactions = 0;
            for (const request of requests) {
              if (!matchesRequest(request, facts)) continue;
              reactions += request.reactions ?? 0;
              if (!reasons.some((r) => r.startsWith('requested'))) {
                add('requested', `requested in issue #${request.issue ?? '?'}`);
              }
            }
            // Reactions break ties between requested cells without letting a brigading
            // thread outrank a whole class of never-measured hardware.
            score += Math.min(reactions, 20) * 0.5;
            if (reactions > 0) reasons.push(`${reactions} reaction(s)`);

            if (score <= 0) continue;
            gaps.push({ ...facts, score: Math.round(score * 100) / 100, reasons });
          }
        }
      }
    }
  }

  gaps.sort((a, b) => b.score - a.score || (a.cell_id < b.cell_id ? -1 : 1));
  missing.sort((a, b) => (a.cell_id < b.cell_id ? -1 : a.cell_id > b.cell_id ? 1 : 0));

  return {
    wanted_workload_ids: wanted,
    max,
    gaps: gaps.slice(0, max),
    missing_workloads: missing,
    considered,
  };
}

/** How many cells the registry says are possible — the denominator of the coverage figure. */
export function possibleCells(repo: Repo): number {
  let n = 0;
  for (const modelEntry of repo.models.values()) {
    for (const quant of modelEntry.quants.values()) {
      for (const engineId of quant.engines) {
        const engine = repo.engines.get(engineId);
        if (!engine) continue;
        if (!engine.meta.quant_formats.includes(quant.format)) continue;
        const minors = new Set((engine.meta.versions_available ?? []).map(engineMinor));
        if (minors.size === 0) continue;
        for (const hardware of repo.hardware.values()) {
          if (!engineFitsHardware(engine.meta, hardware)) continue;
          n += minors.size;
        }
      }
    }
  }
  return n;
}
