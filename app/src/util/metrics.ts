import type {
  CompiledIndexRow,
  Distribution,
  MetricBlock,
  ResultRecord,
  SiteConfig,
  WorkloadKind,
} from '@atlas/core';
import { fmtGB, fmtMs, fmtNum, fmtPct, fmtTokS, fmtW, isNum } from './format.js';

export type Better = 'higher' | 'lower';

export interface MetricDef {
  key: string;
  label: string;
  short: string;
  unit: string;
  better: Better;
  fmt: (v: number | null | undefined) => string;
  /** Read the value from an index row. */
  fromRow: (r: CompiledIndexRow) => number | null;
  /** Read the value from a full metric block (run detail / sweep points). */
  fromBlock?: (m: MetricBlock) => number | null;
}

const n = (v: unknown): number | null => (isNum(v) ? v : null);
const pctFmt = (v: number | null | undefined) => fmtPct(v, 1);

export const METRICS: MetricDef[] = [
  {
    key: 'decode_tok_s_per_request',
    label: 'Decode tok/s per request',
    short: 'Decode',
    unit: 'tok/s',
    better: 'higher',
    fmt: fmtTokS,
    fromRow: (r) => n(r.metrics.decode_tok_s_per_request),
    fromBlock: (m) => n(m.decode_tok_s_per_request?.mean ?? m.decode_tok_s_per_request?.p50),
  },
  {
    key: 'output_tok_s',
    label: 'Output tok/s',
    short: 'Output',
    unit: 'tok/s',
    better: 'higher',
    fmt: fmtTokS,
    fromRow: (r) => n(r.metrics.output_tok_s),
    fromBlock: (m) => n(m.output_tok_s),
  },
  {
    key: 'ttft_p50',
    label: 'TTFT p50',
    short: 'TTFT p50',
    unit: 'ms',
    better: 'lower',
    fmt: fmtMs,
    fromRow: (r) => n(r.metrics.ttft_p50),
    fromBlock: (m) => n(m.ttft_ms?.p50),
  },
  {
    key: 'ttft_p95',
    label: 'TTFT p95',
    short: 'TTFT p95',
    unit: 'ms',
    better: 'lower',
    fmt: fmtMs,
    fromRow: (r) => n(r.metrics.ttft_p95),
    fromBlock: (m) => n(m.ttft_ms?.p95),
  },
  {
    key: 'tpot_p50',
    label: 'TPOT p50',
    short: 'TPOT',
    unit: 'ms',
    better: 'lower',
    fmt: fmtMs,
    fromRow: (r) => n(r.metrics.tpot_p50),
    fromBlock: (m) => n(m.tpot_ms?.p50),
  },
  {
    key: 'success_rate',
    label: 'Success rate',
    short: 'Success',
    unit: '',
    better: 'higher',
    fmt: pctFmt,
    fromRow: (r) => n(r.metrics.success_rate),
    fromBlock: (m) => n(m.success_rate),
  },
  {
    key: 'accuracy',
    label: 'Eval accuracy',
    short: 'Accuracy',
    unit: '',
    better: 'higher',
    fmt: pctFmt,
    fromRow: (r) => n(r.metrics.accuracy),
  },
  {
    key: 'vram_peak_gb',
    label: 'Peak VRAM',
    short: 'VRAM',
    unit: 'GB',
    better: 'lower',
    fmt: fmtGB,
    fromRow: (r) => n(r.metrics.vram_peak_gb),
    fromBlock: (m) => n(m.vram_peak_gb),
  },
  {
    key: 'power_avg_w',
    label: 'Average power',
    short: 'Power',
    unit: 'W',
    better: 'lower',
    fmt: fmtW,
    fromRow: (r) => n(r.metrics.power_avg_w),
    fromBlock: (m) => n(m.power_avg_w),
  },
  {
    key: 'tok_per_w',
    label: 'Tokens per watt',
    short: 'tok/W',
    unit: 'tok/W',
    better: 'higher',
    fmt: (v) => fmtNum(v, 2),
    fromRow: (r) => {
      const t = n(r.metrics.output_tok_s) ?? n(r.metrics.decode_tok_s_per_request);
      const w = n(r.metrics.power_avg_w);
      return t !== null && w !== null && w > 0 ? t / w : null;
    },
    fromBlock: (m) => {
      const t = n(m.output_tok_s) ?? n(m.decode_tok_s_per_request?.mean);
      const w = n(m.power_avg_w);
      return t !== null && w !== null && w > 0 ? t / w : null;
    },
  },
];

export const METRIC_BY_KEY: Record<string, MetricDef> = Object.fromEntries(
  METRICS.map((m) => [m.key, m]),
);

export function metricDef(key: string): MetricDef | undefined {
  return METRIC_BY_KEY[key];
}

/** Site config metric labels win over the built-in ones when present. */
export function metricLabel(site: SiteConfig, key: string): string {
  return site.atlas.metrics?.find((m) => m.key === key)?.label ?? METRIC_BY_KEY[key]?.label ?? key;
}

/**
 * Key-metric order for workload kinds where the site-wide order surfaces a misleading number.
 *
 * On `longctx` the model answers a needle question, and the answer is a handful of tokens:
 * Atlas replies in 6 at every depth where SGLang replies in 83–113. `output_tok_s` is
 * completion tokens over wall clock, so with the whole answer in one delta it collapses to
 * roughly answer-length / TTFT — it ranks engines by how chatty they are. That reads as a
 * 20x gap where the prefill gap is 1.7–2.4x. TTFT is the honest headline for a
 * prefill-dominated workload, and `longctx-needle-*` already leaves `output_tok_s` out of
 * its `metrics_required` entirely.
 */
const KEY_METRICS_BY_KIND: Partial<Record<WorkloadKind, string[]>> = {
  longctx: ['ttft_p50', 'decode_tok_s_per_request', 'output_tok_s'],
};

/** Headline number for an index row: first key metric present, in site preference order. */
export function headlineMetric(
  r: CompiledIndexRow,
  keyMetrics: string[],
): { def: MetricDef; value: number } | null {
  for (const k of KEY_METRICS_BY_KIND[r.kind] ?? keyMetrics) {
    const def = METRIC_BY_KEY[k];
    if (!def) continue;
    const v = def.fromRow(r);
    if (v !== null) return { def, value: v };
  }
  for (const def of METRICS) {
    const v = def.fromRow(r);
    if (v !== null) return { def, value: v };
  }
  return null;
}

/** Distribution summary for inline range bars. */
export function distSummary(d: Distribution | null | undefined): {
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
} | null {
  if (!d) return null;
  const s = { min: n(d.min), p50: n(d.p50), p95: n(d.p95), max: n(d.max), mean: n(d.mean) };
  if (Object.values(s).every((v) => v === null)) return null;
  return s;
}

/** Metrics worth showing from a full record's metric block, with the formatted value. */
export interface MetricCardData {
  key: string;
  label: string;
  unit: string;
  value: number | null;
  text: string;
  dist?: Distribution | null;
}

export function blockCards(m: MetricBlock | null | undefined): MetricCardData[] {
  if (!m) return [];
  const cards: MetricCardData[] = [];
  const push = (
    key: string,
    label: string,
    unit: string,
    value: number | null,
    fmt: (v: number | null) => string,
    dist?: Distribution | null,
  ) => {
    if (value === null && !dist) return;
    cards.push({ key, label, unit, value, text: fmt(value), dist });
  };
  push(
    'decode',
    'Decode tok/s / request',
    'tok/s',
    n(m.decode_tok_s_per_request?.mean ?? m.decode_tok_s_per_request?.p50),
    fmtTokS,
    m.decode_tok_s_per_request,
  );
  push('output', 'Output tok/s', 'tok/s', n(m.output_tok_s), fmtTokS);
  push('total', 'Total tok/s', 'tok/s', n(m.total_tok_s), fmtTokS);
  push('prefill', 'Prefill tok/s', 'tok/s', n(m.prefill_tok_s), fmtTokS);
  push('ttft', 'TTFT p50', 'ms', n(m.ttft_ms?.p50 ?? m.ttft_ms?.mean), fmtMs, m.ttft_ms);
  push('tpot', 'TPOT p50', 'ms', n(m.tpot_ms?.p50 ?? m.tpot_ms?.mean), fmtMs, m.tpot_ms);
  push('itl', 'ITL mean', 'ms', n(m.itl_ms?.mean ?? m.itl_ms?.p50), fmtMs, m.itl_ms);
  push('e2e', 'E2E p50', 'ms', n(m.e2e_ms?.p50 ?? m.e2e_ms?.mean), fmtMs, m.e2e_ms);
  push('req_s', 'Requests/s', 'req/s', n(m.req_s), (v) => fmtNum(v, 2));
  push('success', 'Success rate', '', n(m.success_rate), pctFmt);
  push('vram', 'Peak VRAM', 'GB', n(m.vram_peak_gb), fmtGB);
  push('ram', 'Peak RAM', 'GB', n(m.ram_peak_gb), fmtGB);
  push('kv', 'KV cache', 'tokens', n(m.kv_cache_tokens), (v) =>
    v === null ? '–' : v.toLocaleString('en-US'),
  );
  push('power', 'Average power', 'W', n(m.power_avg_w), fmtW);
  push('power_peak', 'Peak power', 'W', n(m.power_peak_w), fmtW);
  push('energy', 'Energy', 'Wh', n(m.energy_wh), (v) => fmtNum(v, 2));
  push('gpu_util', 'GPU util', '%', n(m.gpu_util_avg_pct), (v) => fmtNum(v, 0));
  push('temp', 'Max temp', '°C', n(m.temp_max_c), (v) => fmtNum(v, 0));
  push('accept', 'Spec. acceptance', '', n(m.acceptance_rate), pctFmt);
  push('tps', 'Tokens / step', '', n(m.accepted_tokens_per_step), (v) => fmtNum(v, 2));
  return cards;
}

/** Key metric of a full record for timeline / sweep charts. */
export function recordKeyValue(rec: ResultRecord, key: string): number | null {
  const def = METRIC_BY_KEY[key];
  if (!def) return null;
  if (key === 'accuracy') return n(rec.scores?.accuracy);
  if (def.fromBlock && rec.metrics) return def.fromBlock(rec.metrics);
  return null;
}
