import { describe, expect, it } from 'vitest';
import { conditionsComparability, resolveConditions } from './conditions.js';
import type { ResolvedConditions } from './conditions.js';
import type { RunConditions } from './types.js';

const rec = (notes: string | null, conditions?: RunConditions | null) => ({
  conditions,
  provenance: { notes },
});

describe('resolveConditions — structured field', () => {
  it('is authoritative when present, even over canonical prose', () => {
    const r = resolveConditions(
      rec('Box was NOT dedicated: prose says shared.', {
        dedicated: true,
        detail: 'SSH tunnel stopped for the duration',
        isolation_check: 'GPU compute-app list sampled before each workload',
      }),
    );
    expect(r).toEqual({
      dedicated: true,
      detail: 'SSH tunnel stopped for the duration',
      isolationCheck: 'GPU compute-app list sampled before each workload',
      source: 'structured',
    });
  });

  it('keeps asserted and measured distinct: a check may be absent', () => {
    const r = resolveConditions(rec(null, { dedicated: false }));
    expect(r.dedicated).toBe(false);
    expect(r.detail).toBeNull();
    expect(r.isolationCheck).toBeNull();
    expect(r.source).toBe('structured');
  });
});

describe('resolveConditions — canonical prose vocabulary', () => {
  it('parses a dedicated opener', () => {
    const r = resolveConditions(
      rec(
        'Box WAS dedicated: nothing else on the machine, reverse-proxy tunnel stopped. Ambient ~22C.',
      ),
    );
    expect(r.dedicated).toBe(true);
    expect(r.detail).toBe('nothing else on the machine, reverse-proxy tunnel stopped');
    expect(r.isolationCheck).toBeNull();
    expect(r.source).toBe('notes');
  });

  it('parses a not-dedicated opener with an isolation check sentence', () => {
    const r = resolveConditions(
      rec(
        'Box was NOT dedicated: idle Chrome, a Claude Code session, and a shared LM Studio endpoint reachable by other services. Isolation check: resident-model set sampled before and after every workload; contaminated runs discarded. Ambient ~22C.',
      ),
    );
    expect(r.dedicated).toBe(false);
    expect(r.detail).toBe(
      'idle Chrome, a Claude Code session, and a shared LM Studio endpoint reachable by other services',
    );
    expect(r.isolationCheck).toBe(
      'resident-model set sampled before and after every workload; contaminated runs discarded',
    );
    expect(r.source).toBe('notes');
  });

  it('parses an isolation check that follows immediately, before any other sentence', () => {
    const r = resolveConditions(
      rec(
        'Box WAS dedicated: nothing else ran. Isolation check: nvidia-smi compute-apps empty before each workload.',
      ),
    );
    expect(r.detail).toBe('nothing else ran');
    expect(r.isolationCheck).toBe('nvidia-smi compute-apps empty before each workload');
  });

  it('requires the opener at the start of the notes', () => {
    const r = resolveConditions(
      rec('Ambient ~22C. Box WAS dedicated: this is not the opening sentence.'),
    );
    expect(r.dedicated).toBeNull();
    expect(r.source).toBe('none');
  });

  it('an isolation check without an opener still surfaces the measurement', () => {
    const r = resolveConditions(
      rec('Isolation check: resident-model set compared before/after; clean pair.'),
    );
    expect(r.dedicated).toBeNull();
    expect(r.isolationCheck).toBe('resident-model set compared before/after; clean pair');
    expect(r.source).toBe('notes');
  });
});

describe('resolveConditions — everything older is honestly unknown', () => {
  it('never guesses from free prose', () => {
    const r = resolveConditions(
      rec(
        'Mac Studio M2 Max 32GB, desktop session active (browser + dev tools running, not a clean idle box). The machine was fully isolated for the run.',
      ),
    );
    expect(r).toEqual({ dedicated: null, detail: null, isolationCheck: null, source: 'none' });
  });

  it('handles null and empty notes', () => {
    expect(resolveConditions(rec(null)).source).toBe('none');
    expect(resolveConditions(rec('')).source).toBe('none');
  });
});

describe('conditionsComparability', () => {
  const c = (dedicated: boolean | null): ResolvedConditions => ({
    dedicated,
    detail: null,
    isolationCheck: null,
    source: dedicated === null ? 'none' : 'structured',
  });

  it('classifies a known difference as mixed', () => {
    expect(conditionsComparability([c(true), c(false)])).toBe('mixed');
  });
  it('classifies agreement as uniform', () => {
    expect(conditionsComparability([c(true), c(true)])).toBe('uniform');
    expect(conditionsComparability([c(false), c(false)])).toBe('uniform');
  });
  it('classifies known-vs-unknown as partial', () => {
    expect(conditionsComparability([c(true), c(null)])).toBe('partial');
  });
  it('classifies all-unknown as unrecorded', () => {
    expect(conditionsComparability([c(null), c(null)])).toBe('unrecorded');
    expect(conditionsComparability([])).toBe('unrecorded');
  });
});
