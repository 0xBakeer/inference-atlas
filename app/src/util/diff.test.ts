import { describe, expect, it } from 'vitest';
import type { EngineParam } from '@atlas/core';
import { argsDiff, canonicalDistance, metricDelta, parseCanonical, versionDiff } from './diff.js';

describe('argsDiff', () => {
  it('marks only differing flags', () => {
    const rows = argsDiff([
      { 'max-model-len': 262144, 'gpu-memory-utilization': 0.44, 'enable-prefix-caching': true },
      { 'max-model-len': 262144, 'gpu-memory-utilization': 0.9 },
    ]);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName['max-model-len']!.differs).toBe(false);
    expect(byName['gpu-memory-utilization']!.differs).toBe(true);
    expect(byName['gpu-memory-utilization']!.values).toEqual(['0.44', '0.9']);
    expect(byName['enable-prefix-caching']!.values).toEqual(['true', null]);
    expect(rows.map((r) => r.name)).toEqual([
      'enable-prefix-caching',
      'gpu-memory-utilization',
      'max-model-len',
    ]);
  });
  it('normalises numeric values so 0.90 equals 0.9', () => {
    const rows = argsDiff([{ a: 0.9 }, { a: 0.9 }, { a: 0.9 }]);
    expect(rows[0]!.differs).toBe(false);
    expect(rows[0]!.values).toEqual(['0.9', '0.9', '0.9']);
  });
});

describe('canonical distance', () => {
  it('counts differing resolved params', () => {
    const a = parseCanonical('@dtype=auto;@quant=fp8;max-model-len=262144');
    const b = parseCanonical(
      '@dtype=auto;@quant=fp8;max-model-len=262144;enable-prefix-caching=true',
    );
    expect(canonicalDistance(a, b)).toBe(1);
    expect(canonicalDistance(a, a)).toBe(0);
    expect(parseCanonical('')).toEqual({});
  });
});

describe('versionDiff', () => {
  const older: EngineParam[] = [
    { name: 'a', type: 'int', default: 1 },
    { name: 'b', type: 'bool', default: false },
    { name: 'gone', type: 'str', default: null },
  ];
  const newer: EngineParam[] = [
    { name: 'a', type: 'int', default: 2 },
    { name: 'b', type: 'bool', default: false },
    { name: 'added', type: 'float', default: 0.5 },
  ];
  it('reports added, removed, default changes', () => {
    const d = versionDiff(older, newer);
    expect(d.added.map((p) => p.name)).toEqual(['added']);
    expect(d.removed.map((p) => p.name)).toEqual(['gone']);
    expect(d.defaultChanged).toEqual([{ name: 'a', from: 1, to: 2 }]);
    expect(d.typeChanged).toEqual([]);
  });
});

describe('metricDelta', () => {
  it('is direction aware', () => {
    expect(metricDelta(100, 80, 'lower')).toMatchObject({ better: true });
    expect(metricDelta(100, 80, 'higher')).toMatchObject({ better: false });
    expect(metricDelta(100, 100, 'higher')).toMatchObject({ same: true });
    expect(metricDelta(null, 80, 'higher')).toBeNull();
    expect(metricDelta(100, 150, 'higher')?.pct).toBeCloseTo(0.5);
  });
});
