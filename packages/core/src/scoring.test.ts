import { describe, expect, it } from 'vitest';
import { computeScores } from './scoring.js';
import type { CompiledIndexRow } from './types.js';

function row(
  login: string,
  cell: string,
  over: Partial<CompiledIndexRow> = {},
  submitted = '2026-08-01T00:00:00Z',
): CompiledIndexRow {
  return {
    run_id: `${cell}-${login}-${submitted}-${over.workload_id ?? 'serve-v1'}`,
    cell_id: cell,
    config_id: 'c'.repeat(16),
    workload_id: 'serve-v1',
    kind: 'serving',
    engine: { id: 'vllm', version: '0.27.1', minor: '0.27' },
    model: { id: 'qwen3-8b', quant_id: 'fp8' },
    hardware: { id: 'nvidia-rtx-4090', count: 1 },
    metrics: { output_tok_s: 100 },
    provenance: { login, submitted_at: submitted },
    verification_level: 'self-reported',
    path: 'results/x.json',
    ...over,
  };
}

const points = (rows: CompiledIndexRow[], login: string) =>
  computeScores({ rows }).contributors.find((c) => c.login === login)?.points ?? 0;

describe('contributor scoring', () => {
  it('pays most for filling an empty cell', () => {
    const filled = points([row('alice', 'cell-a')], 'alice');
    const reproduced = points(
      [row('bob', 'cell-a', {}, '2026-07-01T00:00:00Z'), row('alice', 'cell-a')],
      'alice',
    );
    expect(filled).toBeGreaterThan(reproduced);
    expect(reproduced).toBeGreaterThan(0);
  });

  it('pays more for reproducing somebody else than for repeating yourself', () => {
    const rows = [
      row('alice', 'cell-a', {}, '2026-08-01T00:00:00Z'),
      row('bob', 'cell-a', {}, '2026-08-02T00:00:00Z'),
      row('alice', 'cell-a', {}, '2026-08-03T00:00:00Z'),
    ];
    const scored = computeScores({ rows });
    const bobRun = scored.runs.find((r) => r.login === 'bob')!;
    const aliceSecond = scored.runs.filter((r) => r.login === 'alice')[1]!;
    expect(bobRun.role).toBe('reproduction');
    expect(aliceSecond.role).toBe('additional');
    expect(bobRun.points).toBeGreaterThan(aliceSecond.points);
  });

  it('halves each further run by the same person in the same cell', () => {
    const scored = computeScores({
      rows: [
        row('alice', 'cell-a', {}, '2026-08-01T00:00:00Z'),
        row('alice', 'cell-a', {}, '2026-08-02T00:00:00Z'),
        row('alice', 'cell-a', {}, '2026-08-03T00:00:00Z'),
      ],
    });
    const [first, second, third] = scored.runs;
    expect(second!.factor).toBeCloseTo(0.5, 5);
    expect(third!.factor).toBeCloseTo(0.25, 5);
    expect(first!.points).toBeGreaterThan(second!.points + third!.points);
  });

  it('does not diminish across different cells', () => {
    const scored = computeScores({
      rows: [row('alice', 'cell-a'), row('alice', 'cell-b'), row('alice', 'cell-c')],
    });
    expect(scored.runs.every((r) => r.factor === 1)).toBe(true);
    expect(scored.contributors[0]?.cells_filled).toBe(3);
  });

  it('is monotonic: adding a run never lowers anybody', () => {
    const base = [row('alice', 'cell-a'), row('bob', 'cell-b')];
    const before = computeScores({ rows: base }).contributors;
    const after = computeScores({
      rows: [...base, row('alice', 'cell-c', {}, '2026-08-09T00:00:00Z')],
    }).contributors;
    for (const person of before) {
      const later = after.find((c) => c.login === person.login)!;
      expect(later.points).toBeGreaterThanOrEqual(person.points);
    }
  });

  it('does not depend on the order rows are passed in', () => {
    const rows = [
      row('alice', 'cell-a', {}, '2026-08-01T00:00:00Z'),
      row('bob', 'cell-a', {}, '2026-08-02T00:00:00Z'),
      row('carol', 'cell-b', {}, '2026-08-03T00:00:00Z'),
    ];
    const forwards = computeScores({ rows }).contributors;
    const backwards = computeScores({ rows: [...rows].reverse() }).contributors;
    expect(backwards).toEqual(forwards);
  });

  it('credits registry work above any single measurement', () => {
    const scored = computeScores({
      rows: [row('alice', 'cell-a')],
      registryCredits: { hardware: { 'nvidia-rtx-5090': 'dave' }, engines: { sglang: 'erin' } },
    });
    const dave = scored.contributors.find((c) => c.login === 'dave')!;
    const erin = scored.contributors.find((c) => c.login === 'erin')!;
    const alice = scored.contributors.find((c) => c.login === 'alice')!;
    expect(dave.points).toBeGreaterThan(alice.points);
    expect(erin.points).toBeGreaterThan(dave.points);
    expect(dave.runs).toBe(0);
    expect(dave.breakdown.registry_hardware).toBe(1);
  });

  it('reads its weights from the site config', () => {
    const rows = [row('alice', 'cell-a')];
    const site = {
      scoring: {
        weights: {
          fill_empty_cell: 1000,
          reproduction: 6,
          new_hardware: 25,
          new_model: 15,
          new_engine: 40,
        },
        diminishing: { per_cell_factor: 0.5 },
      },
    } as const;
    expect(computeScores({ rows, site }).contributors[0]?.points).toBe(1000);
  });

  it('pays extra for sweep points, evals and gotchas', () => {
    const plain = points([row('alice', 'cell-a')], 'alice');
    const rich = points(
      [row('alice', 'cell-a', { sweep_points: 6, gotchas: 3, kind: 'eval' })],
      'alice',
    );
    expect(rich).toBeGreaterThan(plain);
  });

  it('tracks who has which hardware and when they were last seen', () => {
    const scored = computeScores({
      rows: [
        row('alice', 'cell-a', {}, '2026-08-01T00:00:00Z'),
        row(
          'alice',
          'cell-b',
          { hardware: { id: 'apple-m2-max-32gb', count: 1 } },
          '2026-08-05T00:00:00Z',
        ),
      ],
    });
    const alice = scored.contributors[0]!;
    expect(alice.hardware_ids).toEqual(['apple-m2-max-32gb', 'nvidia-rtx-4090']);
    expect(alice.first_seen).toBe('2026-08-01T00:00:00Z');
    expect(alice.last_seen).toBe('2026-08-05T00:00:00Z');
  });
});
