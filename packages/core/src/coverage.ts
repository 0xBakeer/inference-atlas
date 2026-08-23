import { engineMinor } from './ids.js';
import type { CompiledIndexRow, CoverageCell, CoverageLevel, SiteConfig } from './types.js';

/**
 * Coverage levels — how much evidence a square of the atlas carries.
 *
 * Colour on the map means *evidence*, not speed. That is the whole inversion this project
 * is built on: contributors should be pulled towards grey, not towards whatever is trending.
 *
 *   none        nobody has run this
 *   single      one contributor has run it
 *   reproduced  two or more independent logins agree on the same config + workload
 *   disputed    two or more independent logins disagree by more than the configured margin
 *   stale       the only evidence is on an engine minor N or more minors behind the newest
 *
 * Precedence when several apply: disputed > stale > reproduced > single. Disputed wins
 * because a wrong number is worse than an old one; stale beats reproduced because a cell
 * that was reproduced on vLLM 0.19 tells you nothing about 0.27.
 */

const DEFAULTS = {
  stale_minors_behind: 2,
  disputed_deviation_pct: 25,
  key_metrics: ['output_tok_s', 'decode_tok_s_per_request', 'accuracy', 'ttft_p50'],
  reproduced_min_logins: 2,
};

/** What coverage needs from the registry: which engine versions exist, so "behind" is defined. */
export interface CoverageRegistry {
  /** engine id → the versions registered for it (`engine.versions_available`). */
  engineVersions: Record<string, string[]>;
}

export interface CoverageOptions {
  /** Only `site.coverage` is read. */
  site?: Pick<SiteConfig, 'coverage'> | null;
}

/** The parts of a cell id that the compiled rows already carry, so we do not re-hash. */
function cellFacts(row: CompiledIndexRow) {
  return {
    cell_id: row.cell_id,
    model_id: row.model.id,
    quant_id: row.model.quant_id,
    hardware_id: row.hardware.id,
    hw_count: row.hardware.count,
    engine_id: row.engine.id,
    engine_minor: row.engine.minor || engineMinor(row.engine.version),
  };
}

function metricOf(row: CompiledIndexRow, key: string): number | null {
  const v = (row.metrics as Record<string, number | null | undefined>)[key];
  return typeof v === 'number' ? v : null;
}

/** First key metric this set of rows actually has, in the configured preference order. */
function pickKeyMetric(rows: CompiledIndexRow[], keys: string[]): string | null {
  for (const key of keys) {
    if (rows.some((r) => metricOf(r, key) !== null)) return key;
  }
  return null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * How many registered minors of this engine are newer than `minor`.
 *
 * Non-numeric version schemes (llama.cpp `b7000`) sort lexicographically after being
 * zero-padded, which is good enough because build numbers grow monotonically.
 */
export function minorsBehind(minor: string, registered: string[]): number {
  const known = new Set(registered.map(engineMinor));
  known.add(minor);
  const ordered = [...known].sort(compareMinor);
  const idx = ordered.indexOf(minor);
  return ordered.length - 1 - idx;
}

function compareMinor(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)$/.exec(a);
  const pb = /^(\d+)\.(\d+)$/.exec(b);
  if (pa && pb) {
    const majorDiff = Number(pa[1]) - Number(pb[1]);
    if (majorDiff !== 0) return majorDiff;
    return Number(pa[2]) - Number(pb[2]);
  }
  if (pa) return -1;
  if (pb) return 1;
  const na = /^[a-z]*(\d+)$/.exec(a);
  const nb = /^[a-z]*(\d+)$/.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** An empty square: what the app shows for a cell that has no runs at all. */
export function emptyCell(
  facts: Omit<CoverageCell, 'runs' | 'logins' | 'workloads' | 'configs' | 'level' | 'best'>,
): CoverageCell {
  return {
    ...facts,
    runs: 0,
    logins: [],
    workloads: [],
    configs: [],
    level: 'none',
    best: null,
  };
}

/**
 * Group compiled index rows into coverage cells.
 *
 * Only cells with at least one run are returned; a cell id that is absent is `none` by
 * definition, and materialising the full registry cross product would be millions of rows.
 */
export function computeCoverage(
  rows: CompiledIndexRow[],
  registry: CoverageRegistry,
  options: CoverageOptions = {},
): Record<string, CoverageCell> {
  const cfg = { ...DEFAULTS, ...(options.site?.coverage ?? {}) };

  const groups = new Map<string, CompiledIndexRow[]>();
  for (const row of rows) {
    const list = groups.get(row.cell_id);
    if (list) list.push(row);
    else groups.set(row.cell_id, [row]);
  }

  const cells: Record<string, CoverageCell> = {};
  for (const [cell_id, cellRows] of groups) {
    cells[cell_id] = buildCell(cell_id, cellRows, registry, cfg);
  }
  return cells;
}

function buildCell(
  cell_id: string,
  rows: CompiledIndexRow[],
  registry: CoverageRegistry,
  cfg: typeof DEFAULTS,
): CoverageCell {
  const facts = cellFacts(rows[0]!);
  const logins = [...new Set(rows.map((r) => r.provenance.login))].sort();
  const workloads = [...new Set(rows.map((r) => r.workload_id))].sort();
  const configs = [...new Set(rows.map((r) => r.config_id))].sort();

  // Disputes are only meaningful within one config + one workload: different flags are
  // supposed to give different numbers.
  const disputes: NonNullable<CoverageCell['disputes']> = [];
  const byConfigWorkload = new Map<string, CompiledIndexRow[]>();
  for (const row of rows) {
    const key = `${row.config_id}|${row.workload_id}`;
    const list = byConfigWorkload.get(key);
    if (list) list.push(row);
    else byConfigWorkload.set(key, [row]);
  }

  let reproduced = false;
  for (const [key, groupRows] of byConfigWorkload) {
    const groupLogins = new Set(groupRows.map((r) => r.provenance.login));
    if (groupLogins.size < (cfg.reproduced_min_logins ?? 2)) continue;

    const metric = pickKeyMetric(groupRows, cfg.key_metrics);
    if (metric === null) {
      reproduced = true;
      continue;
    }
    const withMetric = groupRows.filter((r) => metricOf(r, metric) !== null);
    const values = withMetric.map((r) => metricOf(r, metric)!);
    const mid = median(values);
    const maxDeviation =
      mid === 0 ? 0 : Math.max(...values.map((v) => (Math.abs(v - mid) / Math.abs(mid)) * 100));

    if (maxDeviation > cfg.disputed_deviation_pct) {
      const [config_id, workload_id] = key.split('|') as [string, string];
      disputes.push({
        config_id,
        workload_id,
        metric,
        median: mid,
        max_deviation_pct: Math.round(maxDeviation * 10) / 10,
        run_ids: withMetric.map((r) => r.run_id),
      });
    } else {
      reproduced = true;
    }
  }

  const registered = registry.engineVersions[facts.engine_id] ?? [];
  const behind = minorsBehind(facts.engine_minor, registered);

  let level: CoverageLevel;
  if (disputes.length > 0) level = 'disputed';
  else if (behind >= cfg.stale_minors_behind) level = 'stale';
  else if (reproduced || rows.some((r) => r.verification_level === 'reproduced'))
    level = 'reproduced';
  else level = 'single';

  const keyMetric = pickKeyMetric(rows, cfg.key_metrics);
  const best =
    keyMetric === null
      ? (rows[0] ?? null)
      : (rows.reduce<CompiledIndexRow | null>((acc, row) => {
          const v = metricOf(row, keyMetric);
          if (v === null) return acc;
          if (acc === null) return row;
          return v > (metricOf(acc, keyMetric) ?? -Infinity) ? row : acc;
        }, null) ?? rows[0]!);

  const cell: CoverageCell = {
    ...facts,
    cell_id,
    runs: rows.length,
    logins,
    workloads,
    configs,
    level,
    best,
  };
  if (disputes.length > 0) cell.disputes = disputes;
  if (behind > 0) cell.minors_behind = behind;
  return cell;
}
