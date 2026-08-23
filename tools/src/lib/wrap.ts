/**
 * Engine-native benchmark JSON → a SPEC metric block.
 *
 * A TypeScript port of `bench/atlas_bench/wrap.py`, kept deliberately in step with it: the
 * issue form accepts whatever `vllm bench serve --save-result` or SGLang's
 * `bench_serving.py --output-file` produced, because asking somebody to re-run their
 * benchmark through our harness to submit a number they already have is how contributions
 * die. Anything the native harness does not report stays null — a wrapped result is honest
 * about being second-hand and says so in `raw.payload.source`.
 */
import type { Distribution, MetricBlock } from '@atlas/core';

export type NativeSource = 'vllm-bench-serve' | 'sglang-bench-serving' | 'unknown';

type Raw = Record<string, unknown>;

/** Native distribution prefixes → the SPEC distribution key they belong to. */
const DISTRIBUTIONS: Array<[keyof MetricBlock, string[]]> = [
  ['ttft_ms', ['ttft']],
  ['tpot_ms', ['tpot']],
  ['itl_ms', ['itl']],
  ['e2e_ms', ['e2el', 'e2e_latency', 'e2e']],
];

const STAT_KEYS: Array<[string, keyof Distribution]> = [
  ['mean', 'mean'],
  ['median', 'p50'],
  ['p50', 'p50'],
  ['p90', 'p90'],
  ['p95', 'p95'],
  ['p99', 'p99'],
  ['min', 'min'],
  ['max', 'max'],
];

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function detectSource(raw: Raw): NativeSource {
  const backend = typeof raw.backend === 'string' ? raw.backend : '';
  if ('mean_e2e_latency_ms' in raw || backend === 'sglang' || backend === 'sglang-oai') {
    return 'sglang-bench-serving';
  }
  if ('mean_e2el_ms' in raw || 'total_token_throughput' in raw) return 'vllm-bench-serve';
  return 'unknown';
}

function distribution(raw: Raw, names: string[]): Distribution | null {
  const block: Distribution = {};
  for (const name of names) {
    for (const [prefix, target] of STAT_KEYS) {
      if (block[target] != null) continue;
      const value = num(raw[`${prefix}_${name}_ms`]);
      if (value !== null) block[target] = round(value);
    }
  }
  return Object.keys(block).length > 0 ? block : null;
}

export interface WrappedNative {
  metrics: MetricBlock;
  resolved_params: Record<string, unknown>;
  source: NativeSource;
}

export function wrapNative(raw: Raw): WrappedNative {
  const source = detectSource(raw);
  const metrics: MetricBlock = {};

  const completed = num(raw.completed);
  const total = num(raw.num_prompts) ?? num(raw.num_requests) ?? completed;
  if (total !== null) metrics.requests_total = total;
  if (completed !== null) {
    metrics.requests_ok = completed;
    metrics.requests_failed = Math.max((total ?? completed) - completed, 0);
    const denominator = total ?? completed;
    metrics.success_rate = denominator ? round(completed / denominator, 6) : 0;
  }

  const duration = num(raw.duration) ?? num(raw.benchmark_duration) ?? num(raw.duration_s);
  if (duration !== null) metrics.duration_s = round(duration);

  for (const [key, target] of [
    ['output_throughput', 'output_tok_s'],
    ['total_token_throughput', 'total_tok_s'],
    ['request_throughput', 'req_s'],
  ] as Array<[string, keyof MetricBlock]>) {
    const value = num(raw[key]);
    if (value !== null) (metrics as Record<string, unknown>)[target] = round(value);
  }
  if (metrics.total_tok_s == null && metrics.duration_s) {
    const tokens = (num(raw.total_input_tokens) ?? 0) + (num(raw.total_output_tokens) ?? 0);
    if (tokens > 0) metrics.total_tok_s = round(tokens / metrics.duration_s);
  }

  const concurrency = num(raw.max_concurrency) ?? num(raw.concurrency) ?? 1;
  const ttftMean = num(raw.mean_ttft_ms);
  const inputTokens = num(raw.total_input_tokens);
  if (ttftMean !== null && inputTokens && completed) {
    const prefillWindowS = ((ttftMean / 1000) * completed) / Math.max(concurrency, 1);
    if (prefillWindowS > 0) metrics.prefill_tok_s = round(inputTokens / prefillWindowS);
  }

  for (const [target, names] of DISTRIBUTIONS) {
    (metrics as Record<string, unknown>)[target] = distribution(raw, names);
  }

  return {
    metrics,
    resolved_params: {
      concurrency,
      num_requests: total,
      request_rate: raw.request_rate ?? null,
      input_tokens: raw.total_input_tokens ?? null,
      output_tokens: raw.total_output_tokens ?? null,
      source,
      source_model: raw.model_id ?? raw.model ?? null,
      source_backend: raw.backend ?? null,
      source_date: raw.date ?? null,
    },
    source,
  };
}

/** `20260823-101500` / `2026-08-23 10:15:00` → `2026-08-23T10:15:00Z`. */
export function nativeStartedAt(raw: Raw): string | null {
  const value = String(raw.date ?? '').trim();
  if (!value) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  }
  const spaced = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(value);
  if (spaced) return `${spaced[1]}T${spaced[2]}Z`;
  return null;
}

/** SPEC metric keys, used to tell a hand-written metric block from a native dump. */
const SPEC_KEYS = new Set([
  'output_tok_s',
  'total_tok_s',
  'req_s',
  'prefill_tok_s',
  'ttft_ms',
  'tpot_ms',
  'itl_ms',
  'e2e_ms',
  'decode_tok_s_per_request',
  'requests_total',
  'success_rate',
  'vram_peak_gb',
  'duration_s',
]);

export function looksLikeMetricBlock(value: Raw): boolean {
  return Object.keys(value).some((key) => SPEC_KEYS.has(key));
}
