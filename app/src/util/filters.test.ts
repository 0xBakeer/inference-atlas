import { describe, expect, it } from 'vitest';
import {
  fuzzyScore,
  inDateRange,
  matchesQuery,
  parseSort,
  serializeSort,
  sortRows,
  toggleSort,
  uniqueSorted,
} from './filters.js';

describe('filters', () => {
  it('parses and serialises sort specs', () => {
    expect(parseSort('-x', { key: 'a', dir: 'asc' })).toEqual({ key: 'x', dir: 'desc' });
    expect(parseSort('x', { key: 'a', dir: 'asc' })).toEqual({ key: 'x', dir: 'asc' });
    expect(parseSort(null, { key: 'a', dir: 'desc' })).toEqual({ key: 'a', dir: 'desc' });
    expect(serializeSort({ key: 'x', dir: 'desc' })).toBe('-x');
    expect(toggleSort({ key: 'x', dir: 'asc' }, 'x')).toEqual({ key: 'x', dir: 'desc' });
    expect(toggleSort({ key: 'x', dir: 'asc' }, 'y', 'desc')).toEqual({ key: 'y', dir: 'desc' });
  });
  it('sorts stably with nulls last', () => {
    const rows = [{ v: 3 }, { v: null }, { v: 1 }, { v: 2 }, { v: undefined }];
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual([1, 2, 3, null, undefined]);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.v)).toEqual([3, 2, 1, null, undefined]);
    const strs = [{ v: 'b10' }, { v: 'b2' }, { v: 'a' }];
    expect(sortRows(strs, (r) => r.v, 'asc').map((r) => r.v)).toEqual(['a', 'b2', 'b10']);
  });
  it('matches multi-token queries', () => {
    expect(matchesQuery('vllm 0.27.1 qwen3.8-27b', 'qwen vllm')).toBe(true);
    expect(matchesQuery('vllm 0.27.1 qwen3.8-27b', 'sglang')).toBe(false);
    expect(matchesQuery('anything', '  ')).toBe(true);
  });
  it('scores fuzzy matches by quality', () => {
    expect(fuzzyScore('nvidia-rtx-4090', 'nvidia-rtx-4090')).toBeGreaterThan(
      fuzzyScore('nvidia-rtx-4090', 'nvidia'),
    );
    expect(fuzzyScore('nvidia-rtx-4090', 'rtx')).toBeGreaterThan(
      fuzzyScore('nvidia-rtx-4090', 'tx-4'),
    );
    expect(fuzzyScore('nvidia-rtx-4090', 'zzz')).toBe(0);
    expect(fuzzyScore('nvidia-rtx-4090', 'nr40')).toBeGreaterThan(0);
  });
  it('filters date ranges and uniques', () => {
    expect(inDateRange('2026-08-23T12:00:00Z', '2026-08-01', '2026-08-31')).toBe(true);
    expect(inDateRange('2026-09-01T00:00:00Z', null, '2026-08-31')).toBe(false);
    expect(inDateRange(null, '2026-08-01', null)).toBe(false);
    expect(uniqueSorted(['b', 'a', 'b', 'a10', 'a2'])).toEqual(['a', 'a2', 'a10', 'b']);
  });
});
