import { describe, expect, it } from 'vitest';
import { latencyBars, throughputBars } from './run-metric-chart.js';

describe('run metric chart data', () => {
  it('uses measured throughput values only', () => {
    expect(
      throughputBars({
        output_tok_s: 120,
        total_tok_s: null,
        decode_tok_s_per_request: { p50: 42 },
      }).map((item) => [item.label, item.value]),
    ).toEqual([
      ['Output', 120],
      ['Decode / request', 42],
    ]);
  });

  it('prefers distribution percentiles and falls back to means', () => {
    expect(
      latencyBars({
        ttft_ms: { mean: 20, p50: 18, p95: 35 },
        tpot_ms: { mean: 7 },
      }).map((item) => [item.label, item.value]),
    ).toEqual([
      ['TTFT p50', 18],
      ['TTFT p95', 35],
      ['TPOT p50', 7],
    ]);
  });
});
