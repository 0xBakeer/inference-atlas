import { describe, expect, it } from 'vitest';
import {
  activeWeightGb,
  bandwidthCeiling,
  checkPlausibility,
  tokensPerForwardPass,
} from './plausibility.js';
import type { Hardware, MetricBlock, Model, Quant, ResultRecord } from './types.js';

const spark: Hardware = {
  schema_version: 1,
  id: 'nvidia-gb10-dgx-spark',
  name: 'NVIDIA DGX Spark (GB10)',
  vendor: 'nvidia',
  kind: 'soc',
  memory_gb: 128,
  memory_bandwidth_gbs: 273,
  tdp_w: 140,
};

const dense: Model = {
  schema_version: 1,
  id: 'Qwen/Qwen3.8-27B',
  name: 'Qwen3.8-27B',
  hf_id: 'Qwen/Qwen3.8-27B',
  vendor: 'alibaba',
  params_b: 27,
  active_params_b: 27,
  context_length: 262144,
};

const moe: Model = {
  ...dense,
  id: 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16',
  hf_id: 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16',
  name: 'Nemotron',
  params_b: 30,
  active_params_b: 3,
  moe: true,
};

const fp8: Quant = {
  schema_version: 1,
  id: 'fp8',
  model_id: 'Qwen/Qwen3.8-27B',
  format: 'fp8',
  bits: 8,
  size_gb: 28.5,
  engines: ['vllm'],
  source: 'official',
};

const nvfp4: Quant = {
  ...fp8,
  id: 'nvfp4',
  model_id: 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16',
  format: 'nvfp4',
  bits: 4,
  size_gb: 17,
};

function result(metrics: MetricBlock, over: Partial<ResultRecord> = {}): ResultRecord {
  return {
    schema_version: 1,
    run_id: 'a'.repeat(16) + '--serve-v1--abcdef',
    config_id: 'a'.repeat(16),
    cell_id: 'b'.repeat(12),
    workload_id: 'serve-v1',
    kind: 'serving',
    engine: { id: 'vllm', version: '0.27.1' },
    model: { id: 'Qwen/Qwen3.8-27B', quant_id: 'fp8' },
    hardware: { id: 'nvidia-gb10-dgx-spark', count: 1 },
    args: {},
    args_canonical: '@dtype=auto;@quant=fp8',
    metrics,
    provenance: { github_login: 'someone', started_at: '2026-08-16T00:00:00Z', method: 'manual' },
    verification: { level: 'self-reported' },
    ...over,
  };
}

const codes = (issues: ReturnType<typeof checkPlausibility>) => issues.map((i) => i.code);

describe('speculative decoding raises the bound', () => {
  it('recognises the dspark and eagle spellings, not just "speculative"', () => {
    // SparkInfer speaks dspark and several engines speak eagle. Matching only on the word
    // "speculative" bounded them at one token per pass and turned a legitimate measurement
    // into a physics violation.
    expect(tokensPerForwardPass({ 'dspark-tokens': 5 })).toBe(6);
    expect(tokensPerForwardPass({ 'speculative-eagle-topk': 1 })).toBeGreaterThan(1);
    expect(tokensPerForwardPass({ 'speculative-num-draft-tokens': 4 })).toBe(5);
  });

  it('leaves a non-speculative configuration at one token per pass', () => {
    expect(tokensPerForwardPass({ 'max-num-seqs': 4, 'gpu-memory-utilization': 0.95 })).toBe(1);
  });

  it('prefers a measured acceptance rate over the configured draft length', () => {
    expect(
      tokensPerForwardPass({ 'dspark-tokens': 5 }, { accepted_tokens_per_step: 2.4 } as never),
    ).toBe(2.4);
  });
});

describe('weights and the bandwidth ceiling', () => {
  it('uses active weights for MoE models', () => {
    expect(activeWeightGb(dense, fp8)).toBeCloseTo(28.5, 5);
    expect(activeWeightGb(moe, nvfp4)).toBeCloseTo(1.7, 5);
  });

  it('derives the ceiling from bandwidth over active weights', () => {
    // 273 GB/s over 28.5 GB is 9.58 tok/s; the 1.5 tolerance makes the bound 14.4.
    expect(bandwidthCeiling(spark, dense, fp8)).toBeCloseTo(14.37, 1);
  });

  it('lifts the ceiling by the accepted tokens per forward pass', () => {
    expect(tokensPerForwardPass({}, null)).toBe(1);
    expect(
      tokensPerForwardPass({ 'speculative-config': { num_speculative_tokens: 3 } }, null),
    ).toBe(4);
    expect(tokensPerForwardPass({ 'speculative-config': '{"method":"mtp"}' }, null)).toBe(4);
    expect(tokensPerForwardPass({}, { accepted_tokens_per_step: 2.96 })).toBe(2.96);
  });
});

describe('checkPlausibility', () => {
  it('accepts a measurement that obeys physics', () => {
    const issues = checkPlausibility({
      result: result({ decode_tok_s_per_request: { mean: 7.88 }, vram_peak_gb: 54 }),
      hardware: spark,
      model: dense,
      quant: fp8,
    });
    expect(codes(issues)).toEqual([]);
  });

  it('rejects decode faster than memory bandwidth allows', () => {
    const issues = checkPlausibility({
      result: result({ decode_tok_s_per_request: { mean: 60 } }),
      hardware: spark,
      model: dense,
      quant: fp8,
    });
    expect(codes(issues)).toContain('bandwidth-ceiling-exceeded');
    expect(issues[0]?.level).toBe('error');
  });

  it('accepts the same number once speculative decoding explains it', () => {
    const issues = checkPlausibility({
      result: result(
        { decode_tok_s_per_request: { mean: 16.5 }, accepted_tokens_per_step: 2.96 },
        { args: { 'speculative-config': { method: 'mtp', num_speculative_tokens: 3 } } },
      ),
      hardware: spark,
      model: dense,
      quant: fp8,
    });
    expect(codes(issues)).not.toContain('bandwidth-ceiling-exceeded');
  });

  it('rejects using more memory than the device has', () => {
    const issues = checkPlausibility({
      result: result({ vram_peak_gb: 200 }),
      hardware: spark,
      model: dense,
      quant: fp8,
    });
    expect(codes(issues)).toContain('vram-exceeds-device-memory');
  });

  it('rejects request counts that do not add up', () => {
    const issues = checkPlausibility({
      result: result({
        requests_total: 200,
        requests_ok: 190,
        requests_failed: 5,
        success_rate: 0.95,
      }),
      hardware: spark,
      model: dense,
      quant: fp8,
    });
    expect(codes(issues)).toContain('request-counts-mismatch');
  });

  it('rejects a success rate outside [0, 1] and negative latencies', () => {
    const issues = checkPlausibility({
      result: result({ success_rate: 1.4, duration_s: -3, ttft_ms: { mean: -1 } }),
      hardware: spark,
      model: dense,
      quant: fp8,
    });
    expect(codes(issues)).toContain('success-rate-out-of-range');
    expect(codes(issues).filter((c) => c === 'negative-metric')).toHaveLength(2);
  });

  it('rejects a distribution whose percentiles run backwards', () => {
    const issues = checkPlausibility({
      result: result({ ttft_ms: { p50: 400, p95: 120 } }),
      hardware: spark,
      model: dense,
      quant: fp8,
    });
    expect(codes(issues)).toContain('distribution-out-of-order');
  });

  it('warns when failures happened but nobody said what broke', () => {
    const issues = checkPlausibility({
      result: result({
        requests_total: 100,
        requests_ok: 97,
        requests_failed: 3,
        success_rate: 0.97,
      }),
      hardware: spark,
      model: dense,
      quant: fp8,
    });
    const failure = issues.find((i) => i.code === 'failures-not-described');
    expect(failure?.level).toBe('warn');
  });

  it('checks every point of a sweep', () => {
    const issues = checkPlausibility({
      result: result(
        {},
        {
          kind: 'longctx',
          sweep: [
            { input_tokens: 8, metrics: { decode_tok_s_per_request: { mean: 7 } } },
            { input_tokens: 32768, metrics: { decode_tok_s_per_request: { mean: 900 } } },
          ],
        },
      ),
      hardware: spark,
      model: dense,
      quant: fp8,
    });
    const bad = issues.find((i) => i.code === 'bandwidth-ceiling-exceeded');
    expect(bad?.path).toBe('sweep[1].metrics.output_tok_s');
  });

  it('says so when there is nothing to record at all', () => {
    const issues = checkPlausibility({
      result: result({}, { metrics: null }),
      hardware: spark,
      model: dense,
      quant: fp8,
    });
    expect(codes(issues)).toContain('no-metrics');
  });

  it('checks eval scores against their own arithmetic', () => {
    const issues = checkPlausibility({
      result: result(
        {},
        {
          kind: 'eval',
          metrics: null,
          scores: { suite: 'math', total: 100, correct: 87, accuracy: 0.5 },
        },
      ),
      hardware: spark,
      model: dense,
      quant: fp8,
    });
    expect(codes(issues)).toContain('accuracy-mismatch');
  });

  it('degrades quietly when the registry entry is missing', () => {
    const issues = checkPlausibility({
      result: result({ decode_tok_s_per_request: { mean: 9000 } }),
      hardware: null,
      model: null,
      quant: null,
    });
    expect(codes(issues)).not.toContain('bandwidth-ceiling-exceeded');
  });
});
