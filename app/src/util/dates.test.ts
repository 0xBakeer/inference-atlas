import { describe, expect, it } from 'vitest';
import { absDate, absDateTime, relTime } from './dates.js';

describe('dates', () => {
  const now = new Date('2026-08-23T12:00:00Z');
  it('renders relative time', () => {
    expect(relTime('2026-08-23T11:59:50Z', now)).toBe('just now');
    expect(relTime('2026-08-23T10:00:00Z', now)).toBe('2 h ago');
    expect(relTime('2026-08-20T12:00:00Z', now)).toBe('3 d ago');
    expect(relTime('2026-08-24T12:00:00Z', now)).toBe('in 1 d');
    expect(relTime(null, now)).toBe('–');
  });
  it('renders absolute dates', () => {
    expect(absDate('2026-08-23T12:00:00Z')).toBe('2026-08-23');
    expect(absDateTime('2026-08-23T12:34:00Z')).toBe('2026-08-23 12:34 UTC');
    expect(absDate('garbage')).toBe('–');
  });
});
