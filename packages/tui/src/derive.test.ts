import { describe, expect, it } from 'vitest';
import type { IndexRow, ResultRecord } from '@atlas/core';
import { fixtureRow } from '@atlas/core';
import { coverageGrid, filterRows, paretoData, rankForHome, sweepChartData } from './derive.js';
import type { AtlasData } from './data/load.js';

const row = (over: Parameters<typeof fixtureRow>[0]): IndexRow => fixtureRow(over) as IndexRow;

describe('filterRows', () => {
  const rows = [
    row({ model: { id: 'Qwen/Qwen3-8B', quant_id: 'fp8' } }),
    row({ model: { id: 'google/gemma-4-E2B-it', quant_id: 'bf16' } }),
  ];
  it('matches case-insensitively across identity columns', () => {
    expect(filterRows(rows, 'GEMMA')).toHaveLength(1);
    expect(filterRows(rows, 'qwen fp8')).toHaveLength(1);
  });
  it('requires every term', () => {
    expect(filterRows(rows, 'qwen bf16')).toHaveLength(0);
  });
  it('empty query returns everything', () => {
    expect(filterRows(rows, '  ')).toHaveLength(2);
  });
});

describe('paretoData', () => {
  it('keeps serving runs with both axes and finds the frontier', () => {
    const rows = [
      row({ run_id: 'a', metrics: { output_tok_s: 100, ttft_p50: 50 } }),
      row({ run_id: 'b', metrics: { output_tok_s: 50, ttft_p50: 100 } }), // dominated
      row({ run_id: 'c', metrics: { output_tok_s: 120, ttft_p50: 200 } }),
      row({ run_id: 'd', kind: 'eval', metrics: { output_tok_s: 999, ttft_p50: 1 } }),
      row({ run_id: 'e', metrics: { output_tok_s: null, ttft_p50: 10 } }),
    ];
    const { points, frontier } = paretoData(rows);
    expect(points).toHaveLength(3);
    const ids = [...frontier].map((i) => points[i]!.row.run_id).sort();
    expect(ids).toEqual(['a', 'c']);
  });
});

describe('coverageGrid', () => {
  it('counts runs per model × hardware', () => {
    const index = [
      row({ model: { id: 'a/m1', quant_id: 'q' }, hardware: { id: 'hw1', count: 1 } }),
      row({ model: { id: 'a/m1', quant_id: 'q' }, hardware: { id: 'hw1', count: 1 } }),
      row({ model: { id: 'b/m2', quant_id: 'q' }, hardware: { id: 'hw2', count: 1 } }),
    ];
    const grid = coverageGrid({ index } as AtlasData);
    expect(grid.rowLabels).toEqual(['a/m1', 'b/m2']);
    expect(grid.colLabels).toEqual(['hw1', 'hw2']);
    expect(grid.counts).toEqual([
      [2, 0],
      [0, 1],
    ]);
  });
});

describe('sweepChartData', () => {
  it('reads payload points for context sweeps on a log axis', () => {
    const rec = {
      raw: {
        payload: {
          points: [
            { input_tokens: 1024, decode_tok_s: 100, ttft_ms: 500 },
            { input_tokens: 4096, decode_tok_s: 80, ttft_ms: 900 },
          ],
        },
      },
    } as unknown as ResultRecord;
    const d = sweepChartData(rec)!;
    expect(d.logX).toBe(true);
    expect(d.throughput).toEqual([
      { x: 1024, y: 100 },
      { x: 4096, y: 80 },
    ]);
    expect(d.latencyP95).toHaveLength(2);
  });

  it('groups request samples by concurrency level', () => {
    const req = (level: number, i: number) => ({
      id: `concurrency${level}-r${i}`,
      status: 'ok',
      warmup: false,
      ttft_ms: 100 * level,
      e2e_ms: 1000,
      completion_tokens: 100,
    });
    const rec = {
      raw: { payload: { requests: [req(1, 0), req(1, 1), req(8, 0), req(8, 1)] } },
    } as unknown as ResultRecord;
    const d = sweepChartData(rec)!;
    expect(d.xLabel).toBe('concurrency');
    expect(d.throughput.map((p) => p.x)).toEqual([1, 8]);
  });

  it('returns null for a plain single run', () => {
    expect(sweepChartData({ raw: { payload: {} } } as unknown as ResultRecord)).toBeNull();
  });
});

describe('rankForHome', () => {
  it('sorts by fit first, then headline metric direction', () => {
    const rows = [
      {
        row: row({ run_id: 'slow-fit', metrics: { output_tok_s: 10 } }),
        fitLevel: 'recommended' as const,
      },
      {
        row: row({ run_id: 'fast-nofit', metrics: { output_tok_s: 500 } }),
        fitLevel: 'no-fit' as const,
      },
      {
        row: row({ run_id: 'fast-fit', metrics: { output_tok_s: 100 } }),
        fitLevel: 'recommended' as const,
      },
    ];
    const ranked = rankForHome(rows, ['output_tok_s']);
    expect(ranked.map((r) => r.row.run_id)).toEqual(['fast-fit', 'slow-fit', 'fast-nofit']);
  });
});
