/**
 * Result file → slim index row (SPEC §6, `index.json`).
 *
 * The row is what the heatmap, the tables and the coverage computation all read, so it has
 * to answer "how fast was this" for every workload kind with one flat set of keys. Two
 * decisions live here:
 *
 * 1. **Distributions collapse to the percentile the site ranks on** — `ttft_ms.p50` becomes
 *    `ttft_p50`. The full distribution stays in the run file, one fetch away.
 * 2. **A sweep result falls back to its best point.** Long-context and parallelism sweeps
 *    legitimately leave the top-level `metrics` block empty because there is no single
 *    number: the measurement *is* the curve. Showing such a run as "no data" on the atlas
 *    would be wrong, so the row carries the best point of the curve and says so in
 *    `metrics_source`, and the app links through to the sweep for the shape.
 */
import { engineMinor } from '@atlas/core';
import type { CompiledIndexRow, Distribution, MetricBlock, ResultRecord } from '@atlas/core';

/** An index row plus the two build-time fields the app needs but the shared type does not carry. */
export interface BuiltIndexRow extends CompiledIndexRow {
  /** `metrics` when the numbers come from the top-level block, `sweep-best` when from the curve. */
  metrics_source: 'metrics' | 'sweep-best' | 'none';
}

type MetricKey = keyof CompiledIndexRow['metrics'];

/** Which direction counts as "best" when a sweep has to be collapsed to one number. */
const BETTER: Record<MetricKey, 'higher' | 'lower'> = {
  output_tok_s: 'higher',
  ttft_p50: 'lower',
  ttft_p95: 'lower',
  tpot_p50: 'lower',
  success_rate: 'higher',
  accuracy: 'higher',
  vram_peak_gb: 'higher',
  power_avg_w: 'higher',
  decode_tok_s_per_request: 'higher',
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fromDistribution(
  dist: Distribution | null | undefined,
  key: keyof Distribution,
): number | null {
  if (!dist) return null;
  return num(dist[key]);
}

/** Every ranking key present, so lookups do not have to deal with `undefined`. */
type RowMetrics = Record<MetricKey, number | null>;

/** The nine ranking numbers, pulled out of one metric block. */
function pick(block: MetricBlock | null | undefined): RowMetrics {
  return {
    output_tok_s: num(block?.output_tok_s),
    ttft_p50: fromDistribution(block?.ttft_ms, 'p50'),
    ttft_p95: fromDistribution(block?.ttft_ms, 'p95'),
    tpot_p50: fromDistribution(block?.tpot_ms, 'p50'),
    success_rate: num(block?.success_rate),
    accuracy: null,
    vram_peak_gb: num(block?.vram_peak_gb),
    power_avg_w: num(block?.power_avg_w),
    decode_tok_s_per_request:
      fromDistribution(block?.decode_tok_s_per_request, 'mean') ??
      fromDistribution(block?.decode_tok_s_per_request, 'p50'),
  };
}

function isEmpty(metrics: RowMetrics): boolean {
  return Object.values(metrics).every((v) => v === null);
}

export function indexMetrics(result: ResultRecord): {
  metrics: RowMetrics;
  source: BuiltIndexRow['metrics_source'];
} {
  const top = pick(result.metrics);
  top.accuracy = num(result.scores?.accuracy);

  const points = result.sweep ?? [];
  if (points.length === 0) {
    return { metrics: top, source: isEmpty(top) ? 'none' : 'metrics' };
  }

  const merged = { ...top };
  let usedSweep = false;
  for (const key of Object.keys(BETTER) as MetricKey[]) {
    if (merged[key] !== null) continue;
    let best: number | null = null;
    for (const point of points) {
      const value = pick(point.metrics)[key];
      if (value === null) continue;
      if (best === null) best = value;
      else if (BETTER[key] === 'higher') best = Math.max(best, value);
      else best = Math.min(best, value);
    }
    if (best !== null) {
      merged[key] = best;
      usedSweep = true;
    }
  }

  const source = usedSweep ? 'sweep-best' : isEmpty(merged) ? 'none' : 'metrics';
  return { metrics: merged, source };
}

export function buildIndexRow(result: ResultRecord, path: string): BuiltIndexRow {
  const { metrics, source } = indexMetrics(result);
  return {
    run_id: result.run_id,
    cell_id: result.cell_id,
    config_id: result.config_id,
    workload_id: result.workload_id,
    kind: result.kind,
    engine: {
      id: result.engine.id,
      version: result.engine.version,
      minor: engineMinor(result.engine.version),
    },
    model: { id: result.model.id, quant_id: result.model.quant_id },
    hardware: { id: result.hardware.id, count: result.hardware.count },
    metrics,
    metrics_source: source,
    provenance: {
      login: result.provenance.github_login,
      user_id: result.provenance.github_user_id ?? null,
      commit: result.provenance.commit ?? null,
      pr: result.provenance.pr ?? null,
      submitted_at: result.provenance.submitted_at ?? null,
      started_at: result.provenance.started_at ?? null,
    },
    verification_level: result.verification.level,
    gotchas: result.gotchas?.length ?? 0,
    sweep_points: result.sweep?.length ?? 0,
    path,
  };
}
