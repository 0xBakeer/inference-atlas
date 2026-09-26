import { describe, expect, it } from 'vitest';
import type { IndexRow } from '../data/types.js';
import { firstAppearances, periodStats, weeklyCounts } from './community.js';

function row(p: {
  id: string;
  date: string;
  login: string;
  model?: string;
  hw?: string;
  engine?: string;
  cell?: string;
}): IndexRow {
  return {
    run_id: p.id,
    cell_id: p.cell ?? `cell-${p.model ?? 'm'}-${p.hw ?? 'h'}`,
    config_id: 'c',
    workload_id: 'w',
    kind: 'serving',
    engine: { id: p.engine ?? 'vllm', version: '1', minor: '1' },
    model: { id: p.model ?? 'a/b', quant_id: 'q' },
    hardware: { id: p.hw ?? 'gpu', count: 1 },
    metrics: {},
    provenance: { login: p.login, submitted_at: `${p.date}T10:00:00Z` },
    verification_level: 'self-reported',
    path: '',
  } as IndexRow;
}

const rows = [
  row({ id: '1', date: '2026-09-01', login: 'ana', model: 'a/b', hw: 'gpu' }),
  row({ id: '2', date: '2026-09-03', login: 'ana', model: 'a/b', hw: 'gpu' }),
  row({ id: '3', date: '2026-09-10', login: 'bo', model: 'c/d', hw: 'gpu' }),
  row({ id: '4', date: '2026-09-20', login: 'bo', model: 'c/d', hw: 'mac', engine: 'mlx' }),
];

describe('community', () => {
  it('reports first appearances newest first, once each', () => {
    const news = firstAppearances(rows);
    expect(news.map((n) => `${n.kind}:${n.id}@${n.date}`)).toEqual([
      'engine:mlx@2026-09-20',
      'hardware:mac@2026-09-20',
      'model:c/d@2026-09-10',
      'contributor:bo@2026-09-10',
      'engine:vllm@2026-09-01',
      'hardware:gpu@2026-09-01',
      'model:a/b@2026-09-01',
      'contributor:ana@2026-09-01',
    ]);
    expect(news.find((n) => n.kind === 'model' && n.id === 'c/d')?.by).toBe('bo');
  });

  it('counts a period', () => {
    const s = periodStats(rows, 14, new Date('2026-09-22T00:00:00Z'));
    expect(s).toEqual({ runs: 2, contributors: 1, cells: 2, models: 1, hardware: 1 });
  });

  it('buckets runs per week', () => {
    expect(weeklyCounts(rows, 4, new Date('2026-09-22T00:00:00Z'))).toEqual([1, 1, 1, 1]);
  });
});
