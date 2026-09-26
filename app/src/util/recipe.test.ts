import { describe, expect, it } from 'vitest';
import {
  fmtTokens,
  keyNumbers,
  recipeFacts,
  shapeLabel,
  speculative,
  workloadShape,
} from './recipe.js';

const serving = {
  kind: 'serving' as const,
  params: { concurrency: 16, input_tokens: 128, output_tokens: 128, num_requests: 320 },
  sweep: null,
};

describe('recipe', () => {
  it('formats token counts compactly', () => {
    expect(fmtTokens(128)).toBe('128');
    expect(fmtTokens(1024)).toBe('1k');
    expect(fmtTokens(262144)).toBe('256k');
    expect(fmtTokens(1500)).toBe('1.5k');
    expect(fmtTokens(null)).toBe('–');
  });

  it('reads a workload shape, sweeps included', () => {
    expect(shapeLabel(workloadShape(serving))).toBe('16 concurrent · 128 in / 128 out');
    const sweep = workloadShape({
      kind: 'sweep',
      params: { concurrency: 1, input_tokens: 1024, output_tokens: 256 },
      sweep: { concurrency: [1, 2, 4, 64] },
    });
    expect(sweep.concurrency).toEqual([1, 2, 4, 64]);
    expect(shapeLabel(sweep)).toBe('1→64 concurrent · 1k in / 256 out');
  });

  it('names speculative decoding across engine spellings', () => {
    expect(
      speculative({
        'speculative-algorithm': 'EAGLE',
        'speculative-num-steps': 3,
        'speculative-num-draft-tokens': 4,
      }),
    ).toBe('EAGLE (3 steps, 4 draft tokens)');
    expect(
      speculative({ 'speculative-config': '{"method":"mtp","num_speculative_tokens":2}' }),
    ).toBe('mtp (2 tokens)');
    expect(speculative({ 'spec-type': 'ngram' })).toBe('ngram');
    expect(speculative({ 'max-num-seqs': 8 })).toBeNull();
  });

  it('collects the recipe facts, and says when the KV pool was not recorded', () => {
    const facts = recipeFacts(
      {
        kind: 'serving',
        args: {
          'context-length': 262144,
          'max-running-requests': 16,
          'kv-cache-dtype': 'fp8_e4m3',
          'mem-fraction-static': 0.95,
        },
        metrics: { requests_total: 320, ram_peak_gb: 121.2 },
        hardware: { id: 'x', count: 1 },
      } as never,
      serving,
    );
    const by = Object.fromEntries(facts.map((f) => [f.key, f]));
    expect(by.concurrency?.value).toBe('16');
    expect(by.io?.value).toBe('128 / 128 tokens');
    expect(by.context?.value).toBe('262,144 tokens');
    expect(by.context?.source).toBe('--context-length');
    expect(by.kv?.missing).toBe(true);
    expect(by.kv?.value).toBe('size not recorded · fp8_e4m3');
    expect(by.seqs?.value).toBe('16');
    expect(by.mem?.value).toBe('95% of memory');
    expect(by.spec?.value).toBe('off');
    expect(by.peak?.value).toBe('121 GB');
  });

  it('separates total throughput from per-user speed', () => {
    const nums = keyNumbers(
      {
        kind: 'serving',
        metrics: {
          output_tok_s: 220.955,
          decode_tok_s_per_request: { p50: 15.02, mean: 14.9 },
          ttft_ms: { p50: 409.9 },
          success_rate: 1,
        },
      },
      workloadShape(serving),
    );
    expect(nums.map((n) => n.key)).toEqual(['output', 'per_user', 'ttft', 'success']);
    expect(nums[0]!.hint).toBe('all 16 concurrent requests combined');
    expect(nums[0]!.fmt(nums[0]!.value)).toBe('221');
  });

  it('headlines a sweep by its peak and where it peaked', () => {
    const nums = keyNumbers({
      kind: 'sweep',
      metrics: {},
      sweep: [
        { concurrency: 1, metrics: { output_tok_s: 20, decode_tok_s_per_request: { p50: 20 } } },
        { concurrency: 32, metrics: { output_tok_s: 180 } },
        { concurrency: 64, metrics: { output_tok_s: 170 } },
      ],
    });
    expect(nums[0]).toMatchObject({
      key: 'peak_output',
      value: 180,
      hint: 'reached at 32 concurrent',
    });
    expect(nums[1]).toMatchObject({ key: 'per_user', value: 20, hint: 'at 1 concurrent' });
  });
});
