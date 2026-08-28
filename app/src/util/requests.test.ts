import { describe, expect, it } from 'vitest';
import type { ResultRecord } from '@atlas/core';
import { levelFromId, quantile, requestSamples, samplesByLevel } from './requests.js';

function recWith(payload: unknown): ResultRecord {
  return { raw: { payload } } as unknown as ResultRecord;
}

const req = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: 'ok',
  warmup: false,
  ttft_ms: 100,
  e2e_ms: 1000,
  completion_tokens: 256,
  ...over,
});

describe('levelFromId', () => {
  it('parses the level regardless of the axis name the harness used', () => {
    expect(levelFromId('concurrency16-r00042')).toBe(16);
    expect(levelFromId('concurrency1-w00000')).toBe(1);
    expect(levelFromId('input8192-r3')).toBe(8192);
  });

  it('returns null when the id does not encode a level', () => {
    expect(levelFromId('mix-0319')).toBeNull();
    expect(levelFromId('r00042')).toBeNull();
  });
});

describe('requestSamples', () => {
  it('extracts typed samples and tolerates missing numeric fields', () => {
    const rec = recWith({
      requests: [req('concurrency2-r00000'), req('concurrency2-r00001', { ttft_ms: 'nope' })],
    });
    const s = requestSamples(rec);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ level: 2, ttft_ms: 100, e2e_ms: 1000, ok: true, warmup: false });
    expect(s[1]!.ttft_ms).toBeNull();
  });

  it('yields nothing for absent, foreign or malformed payloads', () => {
    expect(requestSamples(recWith(undefined))).toEqual([]);
    expect(requestSamples(recWith({ engine_endpoint: {} }))).toEqual([]);
    expect(requestSamples(recWith({ requests: 'not-a-list' }))).toEqual([]);
    expect(requestSamples(recWith({ requests: [{ no_id: true }, 42] }))).toEqual([]);
  });
});

describe('samplesByLevel', () => {
  it('groups measured samples by ascending level and drops warmups', () => {
    const rec = recWith({
      requests: [
        req('concurrency8-r00000'),
        req('concurrency1-w00000', { warmup: true }),
        req('concurrency1-r00000'),
        req('concurrency8-r00001'),
        req('mix-0001'), // no level encoded — cannot be placed on the x axis
      ],
    });
    const by = samplesByLevel(requestSamples(rec));
    expect([...by.keys()]).toEqual([1, 8]);
    expect(by.get(8)).toHaveLength(2);
    expect(by.get(1)).toHaveLength(1);
  });
});

describe('quantile', () => {
  it('interpolates and clamps', () => {
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.95)).toBe(5);
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 9], 2)).toBe(9);
  });
});
