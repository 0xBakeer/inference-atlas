/**
 * Derived views of the compiled data: lookups, the possible-cell cross product, per-axis
 * aggregation for the heatmap. Everything here is pure and memoised by the store.
 */
import { cellId, engineMinor } from '@atlas/core';
import type {
  CoverageCell,
  CoverageLevel,
  Hardware,
  Platform,
  Quant,
  Workload,
  WorkloadKind,
} from '@atlas/core';
import type { CoverageMap, IndexRow, Registry, RegistryEngine, RegistryModel } from './types.js';

export interface PossibleCell {
  cell_id: string;
  model_id: string;
  quant_id: string;
  hardware_id: string;
  hw_count: number;
  engine_id: string;
  engine_version: string;
  engine_minor: string;
}

export interface Lookups {
  hardware: Map<string, Hardware>;
  engines: Map<string, RegistryEngine>;
  models: Map<string, RegistryModel>;
  quants: Map<string, Quant>; // key `${model}/${quant}`
  workloads: Map<string, Workload>;
}

export function buildLookups(reg: Registry): Lookups {
  const hardware = new Map(reg.hardware.map((h) => [h.id, h]));
  const engines = new Map(reg.engines.map((e) => [e.meta.id, e]));
  const models = new Map(reg.models.map((m) => [m.model.id, m]));
  const quants = new Map<string, Quant>();
  for (const m of reg.models) for (const q of m.quants) quants.set(`${m.model.id}/${q.id}`, q);
  const workloads = new Map(reg.workloads.map((w) => [w.id, w]));
  return { hardware, engines, models, quants, workloads };
}

/**
 * Which engine platforms a device can host — the same mapping `tools/lib/compat.ts` uses, so
 * the app's denominator equals the build's `cells_possible`.
 */
export function hardwarePlatforms(hw: Hardware): Platform[] {
  const v = hw.vendor.toLowerCase();
  const cpu: Platform[] = ['linux-cpu', 'windows-cpu'];
  if (hw.kind === 'cpu') return v === 'apple' ? ['macos-cpu', ...cpu] : cpu;
  switch (v) {
    case 'nvidia':
      return ['linux-cuda', 'windows-cuda'];
    case 'amd':
      return ['linux-rocm'];
    case 'apple':
      return ['macos-metal', 'macos-cpu'];
    case 'intel':
      return ['linux-xpu'];
    default:
      return cpu;
  }
}

export function engineRunsOn(engine: RegistryEngine, hw: Hardware): boolean {
  const plats = new Set<string>(hardwarePlatforms(hw));
  return engine.meta.platforms.some((p) => plats.has(p));
}

export function quantRunsOn(quant: Quant, engine: RegistryEngine): boolean {
  return quant.engines.includes(engine.meta.id) && engine.meta.quant_formats.includes(quant.format);
}

/** Newest registered version of an engine (registry order is oldest to newest). */
export function latestVersion(engine: RegistryEngine): string | null {
  return engine.versions.at(-1) ?? engine.meta.versions_available?.at(-1) ?? null;
}

export function engineMinors(engine: RegistryEngine): Array<{ minor: string; version: string }> {
  const seen = new Map<string, string>();
  for (const v of engine.versions) seen.set(engineMinor(v), v); // keep newest patch per minor
  return [...seen.entries()].map(([minor, version]) => ({ minor, version }));
}

/**
 * Every cell that could exist given the registry: model x quant x hardware x engine-minor where
 * the quant lists the engine and the engine has a platform the device can run.
 */
export function possibleCells(reg: Registry): PossibleCell[] {
  const out: PossibleCell[] = [];
  for (const m of reg.models) {
    for (const q of m.quants) {
      for (const e of reg.engines) {
        if (!quantRunsOn(q, e)) continue;
        const minors = engineMinors(e);
        if (minors.length === 0) continue;
        for (const hw of reg.hardware) {
          if (!engineRunsOn(e, hw)) continue;
          for (const { minor, version } of minors) {
            out.push({
              cell_id: cellId({
                model_id: m.model.id,
                quant_id: q.id,
                hardware_id: hw.id,
                hw_count: 1,
                engine_id: e.meta.id,
                engine_minor: minor,
              }),
              model_id: m.model.id,
              quant_id: q.id,
              hardware_id: hw.id,
              hw_count: 1,
              engine_id: e.meta.id,
              engine_version: version,
              engine_minor: minor,
            });
          }
        }
      }
    }
  }
  return out;
}

/* --------------------------------------------------------------- heatmap aggregation */

export type AxisKey = 'model' | 'quant' | 'hardware' | 'engine' | 'engine_minor' | 'workload';

export const AXIS_LABEL: Record<AxisKey, string> = {
  model: 'Models',
  quant: 'Quantizations',
  hardware: 'Hardware',
  engine: 'Engines',
  engine_minor: 'Engine versions',
  workload: 'Workloads',
};

const LEVEL_RANK: Record<CoverageLevel, number> = {
  none: 0,
  single: 1,
  reproduced: 2,
  stale: 3,
  disputed: 4,
};

export function maxLevel(a: CoverageLevel, b: CoverageLevel): CoverageLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

export interface HeatCell {
  row: string;
  col: string;
  possible: number;
  covered: number; // cells with runs
  runs: number;
  level: CoverageLevel;
  cells: CoverageCell[]; // covered coverage cells in this square
  possibleCells: PossibleCell[];
  best: IndexRow | null;
  bestMetric: string | null;
  bestValue: number | null;
  workloads: Set<string>;
  logins: Set<string>;
}

export interface HeatMatrix {
  rows: string[];
  cols: string[];
  cells: Map<string, HeatCell>; // key row col
  rowCoverage: Map<string, { covered: number; possible: number }>;
  colCoverage: Map<string, { covered: number; possible: number }>;
  totalPossible: number;
  totalCovered: number;
}

export interface HeatFilters {
  engine?: string | null;
  model?: string | null;
  hardware?: string | null;
  vendor?: string | null;
  kind?: WorkloadKind | null;
  workload?: string | null;
  featuredOnly?: boolean;
}

function axisValue(
  key: AxisKey,
  cell: {
    model_id: string;
    quant_id: string;
    hardware_id: string;
    engine_id: string;
    engine_minor: string;
  },
  modelFixed: boolean,
): string {
  switch (key) {
    case 'model':
      return cell.model_id;
    case 'quant':
      return modelFixed ? cell.quant_id : `${cell.model_id}/${cell.quant_id}`;
    case 'hardware':
      return cell.hardware_id;
    case 'engine':
      return cell.engine_id;
    case 'engine_minor':
      return `${cell.engine_id} ${cell.engine_minor}`;
    case 'workload':
      return '';
  }
}

function lowerIsBetter(metric: string): boolean {
  return (
    metric.startsWith('ttft') ||
    metric.startsWith('tpot') ||
    metric === 'vram_peak_gb' ||
    metric === 'power_avg_w'
  );
}

export function buildHeatMatrix(
  reg: Registry,
  lookups: Lookups,
  possible: PossibleCell[],
  coverage: CoverageMap,
  index: IndexRow[],
  rowKey: AxisKey,
  colKey: AxisKey,
  filters: HeatFilters,
  keyMetrics: string[],
): HeatMatrix {
  const featured = reg.site.featured ?? {};
  const fModels = new Set(featured.models ?? []);
  const fHardware = new Set(featured.hardware ?? []);
  const fEngines = new Set(featured.engines ?? []);
  const modelFixed = !!filters.model;
  const workloadAxis = rowKey === 'workload' || colKey === 'workload';
  const rowsByCell = new Map<string, IndexRow[]>();
  for (const r of index) {
    const list = rowsByCell.get(r.cell_id);
    if (list) list.push(r);
    else rowsByCell.set(r.cell_id, [r]);
  }
  const workloadList = reg.workloads
    .filter((w) => !filters.kind || w.kind === filters.kind)
    .filter((w) => !filters.workload || w.id === filters.workload)
    .map((w) => w.id);

  const cells = new Map<string, HeatCell>();
  const rowSet = new Set<string>();
  const colSet = new Set<string>();

  const keep = (pc: PossibleCell): boolean => {
    if (filters.engine && pc.engine_id !== filters.engine) return false;
    if (filters.model && pc.model_id !== filters.model) return false;
    if (filters.hardware && pc.hardware_id !== filters.hardware) return false;
    if (filters.vendor) {
      const hw = lookups.hardware.get(pc.hardware_id);
      if (!hw || hw.vendor !== filters.vendor) return false;
    }
    if (filters.featuredOnly) {
      if (
        !fModels.has(pc.model_id) &&
        !fHardware.has(pc.hardware_id) &&
        !fEngines.has(pc.engine_id)
      )
        return false;
    }
    return true;
  };

  const put = (row: string, col: string, pc: PossibleCell, workloadId: string | null) => {
    const k = row + ' ' + col;
    let hc = cells.get(k);
    if (!hc) {
      hc = {
        row,
        col,
        possible: 0,
        covered: 0,
        runs: 0,
        level: 'none',
        cells: [],
        possibleCells: [],
        best: null,
        bestMetric: null,
        bestValue: null,
        workloads: new Set(),
        logins: new Set(),
      };
      cells.set(k, hc);
    }
    hc.possible += 1;
    hc.possibleCells.push(pc);
    rowSet.add(row);
    colSet.add(col);
    const cov = coverage[pc.cell_id];
    if (!cov) return;
    let runs = rowsByCell.get(pc.cell_id) ?? [];
    if (workloadId) runs = runs.filter((r) => r.workload_id === workloadId);
    else if (filters.kind) runs = runs.filter((r) => r.kind === filters.kind);
    else if (filters.workload) runs = runs.filter((r) => r.workload_id === filters.workload);
    if (runs.length === 0) return;
    hc.covered += 1;
    hc.runs += runs.length;
    hc.level = maxLevel(hc.level, cov.level);
    hc.cells.push(cov);
    for (const w of cov.workloads) hc.workloads.add(w);
    for (const l of cov.logins) hc.logins.add(l);
    // best = the strongest value of the first key metric (in preference order) any run has
    for (const r of runs) {
      for (const mk of keyMetrics) {
        const v = (r.metrics as Record<string, number | null | undefined>)[mk];
        if (typeof v !== 'number') continue;
        let better: boolean;
        if (hc.bestValue === null || hc.bestMetric === null) better = true;
        else if (hc.bestMetric !== mk)
          better = keyMetrics.indexOf(mk) < keyMetrics.indexOf(hc.bestMetric);
        else better = lowerIsBetter(mk) ? v < hc.bestValue : v > hc.bestValue;
        if (better) {
          hc.best = r;
          hc.bestMetric = mk;
          hc.bestValue = v;
        }
        break;
      }
    }
  };

  for (const pc of possible) {
    if (!keep(pc)) continue;
    if (workloadAxis) {
      const other = rowKey === 'workload' ? colKey : rowKey;
      const otherVal = axisValue(other, pc, modelFixed);
      for (const w of workloadList) {
        const row = rowKey === 'workload' ? w : otherVal;
        const col = colKey === 'workload' ? w : otherVal;
        put(row, col, pc, w);
      }
    } else {
      put(axisValue(rowKey, pc, modelFixed), axisValue(colKey, pc, modelFixed), pc, null);
    }
  }

  const rowCoverage = new Map<string, { covered: number; possible: number }>();
  const colCoverage = new Map<string, { covered: number; possible: number }>();
  let totalPossible = 0;
  let totalCovered = 0;
  for (const hc of cells.values()) {
    const r = rowCoverage.get(hc.row) ?? { covered: 0, possible: 0 };
    r.possible += hc.possible;
    r.covered += hc.covered;
    rowCoverage.set(hc.row, r);
    const c = colCoverage.get(hc.col) ?? { covered: 0, possible: 0 };
    c.possible += hc.possible;
    c.covered += hc.covered;
    colCoverage.set(hc.col, c);
    totalPossible += hc.possible;
    totalCovered += hc.covered;
  }
  return {
    rows: [...rowSet],
    cols: [...colSet],
    cells,
    rowCoverage,
    colCoverage,
    totalPossible,
    totalCovered,
  };
}

export function heatKey(row: string, col: string): string {
  return row + ' ' + col;
}

/** Per-cell "what is missing": workloads nobody has run in this coverage cell. */
export function missingWorkloads(reg: Registry, cov: CoverageCell | null): Workload[] {
  const have = new Set(cov?.workloads ?? []);
  return reg.workloads.filter((w) => !have.has(w.id));
}
