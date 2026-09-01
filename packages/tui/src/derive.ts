/**
 * View models: pure derivations from AtlasData that the views render. Chart math is
 * `@atlas/core` (paretoFrontier, requestSamples, ...) — this file only shapes it.
 */

import type { IndexRow, ResultRecord } from '@atlas/core';
import {
  headlineMetric,
  paretoFrontier,
  quantile,
  requestSamples,
  samplesByLevel,
} from '@atlas/core';
import type { AtlasData } from './data/load.js';
import type { FitLevel } from './hw/fit.js';

/** Case-insensitive substring filter over the identity columns. */
export function filterRows(rows: IndexRow[], query: string): IndexRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const terms = q.split(/\s+/);
  return rows.filter((r) => {
    const hay =
      `${r.model.id} ${r.model.quant_id} ${r.engine.id} ${r.engine.version} ${r.hardware.id} ${r.workload_id} ${r.kind}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export interface ParetoPointRow {
  row: IndexRow;
  x: number;
  y: number;
}

/** Serving runs with both axes present: x = TTFT p50 (lower better), y = tok/s (higher). */
export function paretoData(rows: IndexRow[]): { points: ParetoPointRow[]; frontier: Set<number> } {
  const points: ParetoPointRow[] = [];
  for (const row of rows) {
    if (row.kind !== 'serving') continue;
    const x = row.metrics.ttft_p50;
    const y = row.metrics.output_tok_s;
    if (typeof x === 'number' && typeof y === 'number') points.push({ row, x, y });
  }
  const frontier = new Set(
    paretoFrontier(
      points.map((p) => ({ x: p.x, y: p.y })),
      'lower',
      'higher',
    ),
  );
  return { points, frontier };
}

export interface CoverageGrid {
  rowLabels: string[];
  colLabels: string[];
  /** Run counts per [row][col]; 0 = never measured. */
  counts: number[][];
}

/** Model × hardware run counts — the "where has anyone been" map. */
export function coverageGrid(data: AtlasData): CoverageGrid {
  const models = [...new Set(data.index.map((r) => r.model.id))].sort();
  const hardware = [...new Set(data.index.map((r) => r.hardware.id))].sort();
  const counts = models.map(() => hardware.map(() => 0));
  const mi = new Map(models.map((m, i) => [m, i]));
  const hi = new Map(hardware.map((h, i) => [h, i]));
  for (const r of data.index) {
    counts[mi.get(r.model.id)!]![hi.get(r.hardware.id)!]! += 1;
  }
  return { rowLabels: models, colLabels: hardware, counts };
}

export interface SweepSeriesPoint {
  x: number;
  y: number;
}

export interface SweepChartData {
  xLabel: string;
  logX: boolean;
  throughput: SweepSeriesPoint[];
  latencyP95: SweepSeriesPoint[];
}

/**
 * Chart data out of one run: sweep runs group their request samples by level; longctx-style
 * runs read the payload points array; anything else has nothing to sweep.
 */
export function sweepChartData(record: ResultRecord): SweepChartData | null {
  // Payload points (longctx / context sweeps) carry x and rates directly.
  const payload = record.raw?.payload as Record<string, unknown> | undefined;
  const points = payload?.['points'];
  if (Array.isArray(points) && points.length > 0) {
    const throughput: SweepSeriesPoint[] = [];
    const latencyP95: SweepSeriesPoint[] = [];
    for (const p of points) {
      const o = p as Record<string, unknown>;
      const x = typeof o['input_tokens'] === 'number' ? o['input_tokens'] : null;
      if (x === null) continue;
      const rate = o['decode_tok_s'] ?? o['output_tok_s'];
      if (typeof rate === 'number') throughput.push({ x, y: rate });
      if (typeof o['ttft_ms'] === 'number') latencyP95.push({ x, y: o['ttft_ms'] as number });
    }
    if (throughput.length > 0 || latencyP95.length > 0) {
      return { xLabel: 'input tokens', logX: true, throughput, latencyP95 };
    }
  }
  // Request samples with sweep levels in their ids (sweep-parallel-*).
  const byLevel = samplesByLevel(requestSamples(record));
  if (byLevel.size > 1) {
    const throughput: SweepSeriesPoint[] = [];
    const latencyP95: SweepSeriesPoint[] = [];
    for (const [level, samples] of byLevel) {
      const ok = samples.filter((s) => s.ok);
      const toks = ok.reduce((sum, s) => sum + (s.completion_tokens ?? 0), 0);
      // The arm's wall time is roughly its slowest request — requests within a level run together.
      const spanMs = Math.max(...ok.map((s) => s.e2e_ms ?? 0));
      if (toks > 0 && spanMs > 0) throughput.push({ x: level, y: toks / (spanMs / 1000) });
      const p95 = quantile(
        ok.map((s) => s.ttft_ms).filter((v): v is number => v !== null),
        0.95,
      );
      if (p95 !== null) latencyP95.push({ x: level, y: p95 });
    }
    if (throughput.length > 1 || latencyP95.length > 1) {
      return { xLabel: 'concurrency', logX: false, throughput, latencyP95 };
    }
  }
  return null;
}

export const FIT_ORDER: Record<FitLevel, number> = {
  recommended: 0,
  'should-fit': 1,
  tight: 2,
  unknown: 3,
  'no-fit': 4,
  'wrong-platform': 5,
};

/** Best runs for the home screen: fit first, then the site's headline metric. */
export function rankForHome<T extends { row: IndexRow; fitLevel: FitLevel }>(
  rows: T[],
  keyMetrics: string[],
): T[] {
  return [...rows].sort((a, b) => {
    const byFit = FIT_ORDER[a.fitLevel] - FIT_ORDER[b.fitLevel];
    if (byFit !== 0) return byFit;
    const am = headlineMetric(a.row, keyMetrics);
    const bm = headlineMetric(b.row, keyMetrics);
    if (!am && !bm) return 0;
    if (!am) return 1;
    if (!bm) return -1;
    const dir = (m: NonNullable<typeof am>) => (m.def.better === 'higher' ? -m.value : m.value);
    return dir(am) - dir(bm);
  });
}
