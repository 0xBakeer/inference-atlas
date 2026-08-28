/**
 * Two cells can both be honestly recorded and still not be comparable — the compare view
 * must say so. These tests pin the three surfaces: the conditions row, the comparability
 * note, and the canonical-prose fallback for results that predate the structured field.
 * They also pin what the view must NOT do: rank, hide, or warn-shame either run.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ResultRecord } from '@atlas/core';
import { fixtureRegistry } from '../data/fixture.js';
import { parseHash, route } from '../router.js';
import { store } from '../store.js';

import './compare-view.js';

function makeRun(
  runId: string,
  extra: Partial<ResultRecord> & { notes?: string | null } = {},
): ResultRecord {
  const { notes = null, ...rest } = extra;
  return {
    schema_version: 1,
    run_id: runId,
    config_id: runId.slice(0, 16),
    cell_id: runId.slice(0, 12),
    workload_id: 'serve-test-c2-v1',
    kind: 'serving',
    engine: { id: 'vllm', version: '0.27.1' },
    model: { id: 'acme/test-model-1b', quant_id: 'fp8' },
    hardware: { id: 'test-gpu-24gb', count: 1 },
    args: { 'max-model-len': 32768 },
    args_canonical: '@dtype=auto;max-model-len=32768',
    metrics: null,
    provenance: {
      github_login: 'tester',
      started_at: '2026-08-27T10:00:00Z',
      method: 'atlas-bench',
      notes,
    },
    verification: { level: 'self-reported' },
    ...rest,
  } as ResultRecord;
}

const runs = new Map<string, ResultRecord>();

beforeAll(() => {
  store.registry.value = fixtureRegistry();
  store.index.value = [];
  store.run = (row: { run_id: string }) => Promise.resolve(runs.get(row.run_id) ?? null);
});

async function mountCompare(ids: string[]): Promise<HTMLElement> {
  route.value = parseHash(`#/compare?runs=${ids.join(',')}`);
  const el = document.createElement('atlas-compare-view') as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

function textOf(el: HTMLElement): string {
  const text = el.textContent ?? '';
  el.remove();
  return text;
}

describe('compare view — run conditions', () => {
  it('says so when two honestly-recorded runs were measured under different conditions', async () => {
    runs.set(
      'aaaaaaaaaaaaaaaa--serve-test-c2-v1--000001',
      makeRun('aaaaaaaaaaaaaaaa--serve-test-c2-v1--000001', {
        conditions: {
          dedicated: true,
          detail: 'SSH tunnel stopped for the duration',
          isolation_check: 'GPU compute-app list sampled before each workload',
        },
      }),
    );
    runs.set(
      'bbbbbbbbbbbbbbbb--serve-test-c2-v1--000002',
      makeRun('bbbbbbbbbbbbbbbb--serve-test-c2-v1--000002', {
        conditions: {
          dedicated: false,
          detail: 'shared LM Studio endpoint reachable by other services',
          isolation_check: null,
        },
      }),
    );
    const text = textOf(
      await mountCompare([
        'aaaaaaaaaaaaaaaa--serve-test-c2-v1--000001',
        'bbbbbbbbbbbbbbbb--serve-test-c2-v1--000002',
      ]),
    );
    expect(text).toContain('measured under different conditions');
    expect(text).toContain('dedicated box');
    expect(text).toContain('shared box');
    // asserted vs measured stays distinct
    expect(text).toContain('isolation measured');
    expect(text).toContain('asserted, not measured');
    // never a verdict on which run to trust: the note explains, it does not disqualify
    expect(text.toLowerCase()).not.toContain('invalid');
    expect(text.toLowerCase()).not.toContain('do not compare');
  });

  it('reads the canonical prose vocabulary for runs that predate the structured field', async () => {
    runs.set(
      'cccccccccccccccc--serve-test-c2-v1--000003',
      makeRun('cccccccccccccccc--serve-test-c2-v1--000003', {
        notes:
          'Box was NOT dedicated: idle Chrome and an agent session. Isolation check: resident-model set sampled before and after every workload.',
      }),
    );
    runs.set(
      'dddddddddddddddd--serve-test-c2-v1--000004',
      makeRun('dddddddddddddddd--serve-test-c2-v1--000004', {
        notes: 'Box WAS dedicated: nothing else on the machine.',
      }),
    );
    const text = textOf(
      await mountCompare([
        'cccccccccccccccc--serve-test-c2-v1--000003',
        'dddddddddddddddd--serve-test-c2-v1--000004',
      ]),
    );
    expect(text).toContain('measured under different conditions');
    expect(text).toContain('shared box');
    expect(text).toContain('dedicated box');
  });

  it('is honest about legacy results: unrecorded, not guessed', async () => {
    runs.set(
      'eeeeeeeeeeeeeeee--serve-test-c2-v1--000005',
      makeRun('eeeeeeeeeeeeeeee--serve-test-c2-v1--000005', {
        notes: 'Mac Studio M2 Max 32GB, desktop session active (not a clean idle box).',
      }),
    );
    runs.set(
      'ffffffffffffffff--serve-test-c2-v1--000006',
      makeRun('ffffffffffffffff--serve-test-c2-v1--000006', {
        notes: 'The machine was fully isolated for the run.',
      }),
    );
    const text = textOf(
      await mountCompare([
        'eeeeeeeeeeeeeeee--serve-test-c2-v1--000005',
        'ffffffffffffffff--serve-test-c2-v1--000006',
      ]),
    );
    expect(text).toContain('conditions not recorded');
    expect(text).toContain('None of these runs recorded machine-readable conditions');
    // free prose is never classified
    expect(text).not.toContain('shared box');
    expect(text).not.toContain('dedicated box');
  });

  it('stays quiet when conditions are known and agree', async () => {
    for (const id of [
      '1111111111111111--serve-test-c2-v1--000007',
      '2222222222222222--serve-test-c2-v1--000008',
    ]) {
      runs.set(
        id,
        makeRun(id, { conditions: { dedicated: true, detail: null, isolation_check: null } }),
      );
    }
    const text = textOf(
      await mountCompare([
        '1111111111111111--serve-test-c2-v1--000007',
        '2222222222222222--serve-test-c2-v1--000008',
      ]),
    );
    expect(text).toContain('dedicated box');
    expect(text).not.toContain('measured under different conditions');
    expect(text).not.toContain('machine-readable');
  });
});
