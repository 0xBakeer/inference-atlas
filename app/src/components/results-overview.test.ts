import { describe, expect, it } from 'vitest';
import type { IndexRow } from '../data/types.js';
import { activityBuckets, countBy } from './results-overview.js';

function row(kind: IndexRow['kind'], date: string, cell = kind): IndexRow {
  return {
    run_id: `${kind}-${date}`,
    cell_id: cell,
    config_id: 'cfg',
    workload_id: 'workload',
    kind,
    engine: { id: 'engine', version: '1.0.0', minor: '1.0' },
    model: { id: 'owner/model', quant_id: 'bf16' },
    hardware: { id: 'device', count: 1 },
    metrics: {},
    provenance: { login: 'user', submitted_at: date },
    verification_level: 'self-reported',
    path: 'results/file.json',
  };
}

describe('results overview data', () => {
  it('groups, orders, and limits categories', () => {
    const rows = [
      row('eval', '2026-01-01'),
      row('serving', '2026-01-02'),
      row('serving', '2026-01-03'),
      row('sweep', '2026-01-04'),
    ];
    expect(countBy(rows, (item) => item.kind, 2)).toEqual([
      { label: 'serving', value: 2 },
      { label: 'eval', value: 1 },
    ]);
  });

  it('creates chronological activity buckets without future dates', () => {
    const buckets = activityBuckets([
      row('serving', '2026-01-01T12:00:00Z'),
      row('serving', '2026-01-03T12:00:00Z'),
    ]);
    expect(buckets.reduce((sum, bucket) => sum + bucket.value, 0)).toBe(2);
    expect(buckets.at(-1)?.value).toBe(1);
  });

  it('ignores rows without valid dates', () => {
    const invalid = row('eval', 'not-a-date');
    invalid.provenance.submitted_at = null;
    invalid.provenance.started_at = null;
    expect(activityBuckets([invalid])).toEqual([]);
  });
});
