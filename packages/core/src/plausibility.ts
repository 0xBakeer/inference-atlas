import { normalizeKey } from './canonical.js';
import type {
  ArgValue,
  Args,
  Hardware,
  MetricBlock,
  Model,
  Quant,
  ResultRecord,
  SiteConfig,
} from './types.js';

/**
 * Plausibility checks — SPEC §5 item 5.
 *
 * These are the cheap physical sanity bounds that catch a fabricated or mis-transcribed
 * number without needing to re-run anything: you cannot decode faster than memory bandwidth
 * allows, you cannot use more VRAM than the device has, requests cannot fail negatively.
 *
 * Pure functions: everything they need is passed in, so the app runs them client-side on a
 * pasted result and CI runs them on a PR with the same code.
 */

export interface PlausibilityIssue {
  level: 'error' | 'warn';
  code: string;
  message: string;
  /** Dotted path into the result, e.g. `sweep[2].metrics.output_tok_s`. */
  path?: string;
}

export interface PlausibilityInput {
  result: ResultRecord;
  hardware: Hardware | null;
  model: Model | null;
  quant: Quant | null;
  /** Only `site.plausibility` is read; omit it to use the defaults below. */
  site?: Pick<SiteConfig, 'plausibility'> | null;
}

const DEFAULTS = {
  bandwidth_tolerance: 1.5,
  vram_tolerance: 1.02,
  warn_bandwidth_fraction: 0.15,
  min_weight_gb: 0.05,
};

/** Bytes per weight for a quant, used only when `quant.size_gb` is missing. */
function bitsToGb(paramsB: number, bits: number): number {
  return (paramsB * 1e9 * (bits / 8)) / 1e9;
}

/**
 * The weight bytes that must be read for one decoded token.
 *
 * Dense models read everything; MoE models read roughly the active fraction, which is why a
 * 30B-A3B model decodes an order of magnitude faster than its total size suggests.
 */
export function activeWeightGb(model: Model | null, quant: Quant | null): number | null {
  if (!model) return null;
  const total = quant?.size_gb ?? (quant ? bitsToGb(model.params_b, quant.bits) : null);
  if (total === null || total <= 0) return null;
  const active = model.active_params_b ?? model.params_b;
  if (!model.params_b) return total;
  const fraction = Math.min(1, Math.max(0, active / model.params_b));
  return total * (fraction || 1);
}

/**
 * How many tokens come out of one forward pass.
 *
 * Speculative decoding is the one legitimate way to beat the naive bandwidth bound: the
 * draft tokens are verified in a single pass over the weights, so tok/s scales with the
 * accepted draft length. We prefer the measured `accepted_tokens_per_step`, fall back to
 * the configured draft length + 1, and fall back again to a generous 4 when a speculative
 * method is configured but the draft length is not in `args` — this only ever loosens an
 * error bound, so being generous is the safe direction.
 */
export function tokensPerForwardPass(args: Args, metrics?: MetricBlock | null): number {
  const measured = metrics?.accepted_tokens_per_step;
  if (typeof measured === 'number' && measured > 0) return measured;

  let configured = false;
  let drafts: number | null = null;
  for (const [rawKey, rawValue] of Object.entries(args ?? {})) {
    const key = normalizeKey(rawKey);
    // `dspark` is SparkInfer's speculative route and `eagle` is how several engines spell
    // theirs; neither contains the word "speculative", so matching on that alone missed
    // them entirely and bounded a speculating engine as though it decoded one token per
    // pass. That is the one bound a measurement is allowed to beat, and reporting it as a
    // violation blames the engine for doing the thing it was configured to do.
    if (
      !key.includes('speculative') &&
      !key.includes('dspark') &&
      !key.includes('eagle') &&
      !key.startsWith('draft') &&
      key !== 'model-draft'
    )
      continue;
    configured = true;
    const n = draftTokensFrom(key, rawValue);
    if (n !== null) drafts = Math.max(drafts ?? 0, n);
  }
  if (drafts !== null) return drafts + 1;
  return configured ? 4 : 1;
}

function draftTokensFrom(key: string, value: ArgValue): number | null {
  if (
    key === 'num-speculative-tokens' ||
    key === 'speculative-num-steps' ||
    key === 'speculative-num-draft-tokens' ||
    key === 'draft-max' ||
    key === 'draft' ||
    key === 'dspark-tokens'
  ) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  let obj: unknown = value;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      obj = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    for (const k of [
      'num_speculative_tokens',
      'num-speculative-tokens',
      'num_steps',
      'draft_max',
    ]) {
      const n = Number(rec[k]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/** Upper bound on single-stream decode tok/s: bandwidth ÷ active weights, times a tolerance. */
export function bandwidthCeiling(
  hardware: Hardware | null,
  model: Model | null,
  quant: Quant | null,
  tolerance = DEFAULTS.bandwidth_tolerance,
  hwCount = 1,
  tokensPerPass = 1,
): number | null {
  const bw = hardware?.memory_bandwidth_gbs;
  const weight = activeWeightGb(model, quant);
  if (!bw || !weight || weight < DEFAULTS.min_weight_gb) return null;
  return ((bw * hwCount) / weight) * tolerance * Math.max(1, tokensPerPass);
}

function perRequestDecodeRate(metrics: MetricBlock, concurrency: number | null): number | null {
  const d = metrics.decode_tok_s_per_request;
  if (d && typeof d.mean === 'number') return d.mean;
  if (typeof metrics.output_tok_s === 'number') {
    const c = concurrency && concurrency > 0 ? concurrency : 1;
    return metrics.output_tok_s / c;
  }
  return null;
}

const NON_NEGATIVE: Array<keyof MetricBlock> = [
  'duration_s',
  'output_tok_s',
  'total_tok_s',
  'req_s',
  'prefill_tok_s',
  'vram_peak_gb',
  'ram_peak_gb',
  'kv_cache_tokens',
  'power_avg_w',
  'power_peak_w',
  'energy_wh',
  'requests_total',
  'requests_ok',
  'requests_failed',
];

const DISTRIBUTIONS: Array<keyof MetricBlock> = [
  'ttft_ms',
  'tpot_ms',
  'itl_ms',
  'e2e_ms',
  'decode_tok_s_per_request',
];

function checkMetricBlock(
  metrics: MetricBlock,
  path: string,
  ctx: {
    hardware: Hardware | null;
    ceiling: number | null;
    /** The same bound without the speculative-decoding multiplier — what "efficient" means. */
    plainCeiling: number | null;
    vramTolerance: number;
    warnFraction: number;
    concurrency: number | null;
    hwCount: number;
  },
): PlausibilityIssue[] {
  const issues: PlausibilityIssue[] = [];

  for (const key of NON_NEGATIVE) {
    const v = metrics[key];
    if (typeof v === 'number' && v < 0) {
      issues.push({
        level: 'error',
        code: 'negative-metric',
        message: `${key} is ${v}; it cannot be negative.`,
        path: `${path}.${key}`,
      });
    }
  }

  for (const key of DISTRIBUTIONS) {
    const d = metrics[key];
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    const ordered: Array<[string, number | null | undefined]> = [
      ['min', d.min],
      ['p50', d.p50],
      ['p90', d.p90],
      ['p95', d.p95],
      ['p99', d.p99],
      ['max', d.max],
    ];
    const present = ordered.filter(([, v]) => typeof v === 'number') as Array<[string, number]>;
    // mean and stddev are checked for sign but not for order: a mean can legitimately sit
    // anywhere between the percentiles.
    const signed = [...present, ['mean', d.mean], ['stddev', d.stddev]].filter(
      ([, v]) => typeof v === 'number',
    ) as Array<[string, number]>;
    for (const [name, v] of signed) {
      if (v < 0) {
        issues.push({
          level: 'error',
          code: 'negative-metric',
          message: `${key}.${name} is ${v}; latencies cannot be negative.`,
          path: `${path}.${key}.${name}`,
        });
      }
    }
    for (let i = 1; i < present.length; i++) {
      const [prevName, prevValue] = present[i - 1]!;
      const [name, value] = present[i]!;
      if (value < prevValue) {
        issues.push({
          level: 'error',
          code: 'distribution-out-of-order',
          message: `${key}.${name} (${value}) is below ${key}.${prevName} (${prevValue}).`,
          path: `${path}.${key}.${name}`,
        });
      }
    }
  }

  const { requests_total: total, requests_ok: ok, requests_failed: failed } = metrics;
  if (typeof total === 'number' && typeof ok === 'number' && typeof failed === 'number') {
    if (ok + failed !== total) {
      issues.push({
        level: 'error',
        code: 'request-counts-mismatch',
        message: `requests_ok (${ok}) + requests_failed (${failed}) is ${ok + failed}, not requests_total (${total}).`,
        path: `${path}.requests_total`,
      });
    }
  }

  const rate = metrics.success_rate;
  if (typeof rate === 'number') {
    if (rate < 0 || rate > 1) {
      issues.push({
        level: 'error',
        code: 'success-rate-out-of-range',
        message: `success_rate is ${rate}; it is a fraction in [0, 1].`,
        path: `${path}.success_rate`,
      });
    } else if (typeof total === 'number' && total > 0 && typeof ok === 'number') {
      const expected = ok / total;
      if (Math.abs(expected - rate) > 0.01) {
        issues.push({
          level: 'warn',
          code: 'success-rate-inconsistent',
          message: `success_rate is ${rate} but requests_ok/requests_total is ${expected.toFixed(4)}.`,
          path: `${path}.success_rate`,
        });
      }
    }
  }

  const vram = metrics.vram_peak_gb;
  const memory = ctx.hardware?.memory_gb ?? null;
  if (typeof vram === 'number' && typeof memory === 'number' && memory > 0) {
    const limit = memory * ctx.hwCount * ctx.vramTolerance;
    if (vram > limit) {
      issues.push({
        level: 'error',
        code: 'vram-exceeds-device-memory',
        message: `vram_peak_gb is ${vram} but ${ctx.hardware?.id} has ${memory} GB${
          ctx.hwCount > 1 ? ` x${ctx.hwCount}` : ''
        }.`,
        path: `${path}.vram_peak_gb`,
      });
    }
  }

  if (ctx.ceiling !== null) {
    const perRequest = perRequestDecodeRate(metrics, ctx.concurrency);
    if (perRequest !== null && perRequest > ctx.ceiling) {
      issues.push({
        level: 'error',
        code: 'bandwidth-ceiling-exceeded',
        message:
          `per-request decode is ${perRequest.toFixed(1)} tok/s but memory bandwidth allows at most ` +
          `${ctx.ceiling.toFixed(1)} tok/s for these weights. Either the weights, the hardware or the number is wrong ` +
          `(speculative decoding does not lift this bound — it lowers the bytes read per accepted token, so record the ` +
          `draft configuration in args).`,
        path: `${path}.output_tok_s`,
      });
    } else if (
      perRequest !== null &&
      ctx.plainCeiling !== null &&
      perRequest < ctx.plainCeiling * ctx.warnFraction
    ) {
      // Measured against the plain bound on purpose: speculative decoding lifts what is
      // possible, it does not change what "leaving bandwidth on the table" means.
      issues.push({
        level: 'warn',
        code: 'bandwidth-efficiency-low',
        message: `per-request decode is ${perRequest.toFixed(1)} tok/s, under ${(ctx.warnFraction * 100).toFixed(0)}% of the ${ctx.plainCeiling.toFixed(1)} tok/s bandwidth ceiling — worth a note about why.`,
        path: `${path}.output_tok_s`,
      });
    }
  }

  const tdp = ctx.hardware?.tdp_w ?? null;
  if (typeof metrics.power_avg_w === 'number' && typeof tdp === 'number' && tdp > 0) {
    if (metrics.power_avg_w > tdp * ctx.hwCount * 1.25) {
      issues.push({
        level: 'warn',
        code: 'power-above-tdp',
        message: `power_avg_w is ${metrics.power_avg_w} against a ${tdp} W TDP; check what the sampler measured (whole wall socket vs device).`,
        path: `${path}.power_avg_w`,
      });
    }
  }

  if (metrics.thermal_throttle_detected === true) {
    issues.push({
      level: 'warn',
      code: 'thermal-throttle',
      message:
        'thermal throttling was detected during the run; the numbers describe a throttled machine.',
      path: `${path}.thermal_throttle_detected`,
    });
  }

  return issues;
}

/** Run every plausibility check against one result. Empty array = nothing suspicious. */
export function checkPlausibility(input: PlausibilityInput): PlausibilityIssue[] {
  const { result, hardware, model, quant } = input;
  const cfg = { ...DEFAULTS, ...(input.site?.plausibility ?? {}) };
  const hwCount = result.hardware?.count ?? 1;
  const concurrencyRaw = result.workload?.resolved_params?.['concurrency'];
  const concurrency = typeof concurrencyRaw === 'number' ? concurrencyRaw : null;

  const tokensPerPass = tokensPerForwardPass(result.args ?? {}, result.metrics);
  const ceiling = bandwidthCeiling(
    hardware,
    model,
    quant,
    cfg.bandwidth_tolerance,
    hwCount,
    tokensPerPass,
  );
  const plainCeiling = bandwidthCeiling(
    hardware,
    model,
    quant,
    cfg.bandwidth_tolerance,
    hwCount,
    1,
  );
  const ctx = {
    hardware,
    ceiling,
    plainCeiling,
    vramTolerance: cfg.vram_tolerance,
    warnFraction: cfg.warn_bandwidth_fraction,
    concurrency,
    hwCount,
  };

  const issues: PlausibilityIssue[] = [];

  if (result.metrics) {
    issues.push(...checkMetricBlock(result.metrics, 'metrics', ctx));
  }

  if (result.sweep) {
    result.sweep.forEach((point, i) => {
      const pointConcurrency = point.concurrency ?? concurrency;
      issues.push(
        ...checkMetricBlock(point.metrics, `sweep[${i}].metrics`, {
          ...ctx,
          concurrency: pointConcurrency,
        }),
      );
    });
  }

  if (!result.metrics && !result.sweep && !result.scores) {
    issues.push({
      level: 'warn',
      code: 'no-metrics',
      message:
        'the result carries no metrics, no sweep and no scores — there is nothing to record.',
    });
  }

  if (result.scores) {
    const s = result.scores;
    if (s.correct > s.total) {
      issues.push({
        level: 'error',
        code: 'score-counts-mismatch',
        message: `scores.correct (${s.correct}) is greater than scores.total (${s.total}).`,
        path: 'scores.correct',
      });
    } else if (s.total > 0 && Math.abs(s.correct / s.total - s.accuracy) > 0.005) {
      issues.push({
        level: 'error',
        code: 'accuracy-mismatch',
        message: `scores.accuracy is ${s.accuracy} but correct/total is ${(s.correct / s.total).toFixed(4)}.`,
        path: 'scores.accuracy',
      });
    }
  }

  const failedCount = result.metrics?.requests_failed;
  if (typeof failedCount === 'number' && failedCount > 0 && (result.failures ?? []).length === 0) {
    issues.push({
      level: 'warn',
      code: 'failures-not-described',
      message: `${failedCount} requests failed but failures[] is empty. Failures are data — say what broke.`,
      path: 'failures',
    });
  }

  if (hardware && quant && model) {
    const weight = activeWeightGb(model, quant);
    const memory = hardware.memory_gb;
    if (weight && typeof memory === 'number' && memory > 0) {
      const total = quant.size_gb ?? bitsToGb(model.params_b, quant.bits);
      if (total > memory * hwCount) {
        issues.push({
          level: 'warn',
          code: 'weights-exceed-memory',
          message: `${quant.model_id}/${quant.id} is ~${total.toFixed(1)} GB but ${hardware.id} has ${memory} GB${
            hwCount > 1 ? ` x${hwCount}` : ''
          } — this only works with offloading, which belongs in args and notes.`,
        });
      }
    }
  }

  return issues;
}
