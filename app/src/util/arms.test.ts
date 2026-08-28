import { describe, expect, it } from 'vitest';
import type { ResultRecord } from '@atlas/core';
import type { IndexRow } from '../data/types.js';
import { armDiff, armLabel, cellArms, prefillPoints } from './arms.js';

function row(over: Partial<IndexRow>): IndexRow {
  return {
    run_id: 'r',
    cell_id: 'cell-a',
    config_id: 'cfg-1',
    ...over,
  } as IndexRow;
}

const rec = { cell_id: 'cell-a', config_id: 'cfg-1' } as ResultRecord;

describe('cellArms', () => {
  it('groups the cell by config with the current arm first', () => {
    const index = [
      row({ run_id: 'x1', config_id: 'cfg-2' }),
      row({ run_id: 'x2', config_id: 'cfg-2' }),
      row({ run_id: 'x3', config_id: 'cfg-1' }),
      row({ run_id: 'other-cell', cell_id: 'cell-b', config_id: 'cfg-9' }),
    ];
    const arms = cellArms(index, rec);
    expect(arms.map((a) => a.configId)).toEqual(['cfg-1', 'cfg-2']);
    expect(arms[1]!.rows).toHaveLength(2);
  });
});

describe('armDiff / armLabel', () => {
  it('names an arm by exactly the flags that differ', () => {
    const base = { 'max-num-seqs': 2, 'gpu-memory-utilization': 0.85 };
    const arm = { 'max-num-seqs': 64, 'gpu-memory-utilization': 0.85 };
    expect(armDiff(base, arm)).toEqual(['max-num-seqs=64']);
    expect(armLabel(base, arm, 'fallback')).toBe('max-num-seqs=64');
  });

  it('marks flags the arm does not set at all', () => {
    expect(armDiff({ 'enable-prefix-caching': true }, {})).toEqual(['enable-prefix-caching=unset']);
  });

  it('falls back for identical configs and truncates long diffs', () => {
    expect(armLabel({ a: 1 }, { a: 1 }, 'by somebody')).toBe('by somebody');
    const label = armLabel({}, { a: 1, b: 2, c: 3 }, 'x');
    expect(label).toBe('a=1 b=2 +1');
  });
});

describe('prefillPoints', () => {
  const prefill = (len: number, tok: number, started = '2026-08-28T00:00:00Z'): ResultRecord =>
    ({
      kind: 'prefill',
      workload: { id: `prefill-${len}`, resolved_params: { input_tokens: len } },
      metrics: { prefill_tok_s: tok },
      provenance: { started_at: started },
    }) as unknown as ResultRecord;

  it('orders by context length and keeps the newest run per length', () => {
    const pts = prefillPoints([
      prefill(32768, 2230),
      prefill(8192, 3100),
      prefill(8192, 2900, '2026-08-29T00:00:00Z'),
      { kind: 'serving' } as ResultRecord,
    ]);
    expect(pts.map((p) => p.input_tokens)).toEqual([8192, 32768]);
    expect(pts[0]!.metrics.prefill_tok_s).toBe(2900);
  });
});
