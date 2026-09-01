import { describe, expect, it } from 'vitest';
import {
  fmtCompact,
  fmtGB,
  fmtInt,
  fmtMs,
  fmtNum,
  fmtParams,
  fmtPct,
  fmtSignedPct,
  fmtTokS,
  fmtTokens,
  plural,
  shortSha,
} from './format.js';

describe('format', () => {
  it('formats tok/s with one decimal, integers above 1000', () => {
    expect(fmtTokS(18.94)).toBe('18.9');
    expect(fmtTokS(4.5)).toBe('4.5');
    expect(fmtTokS(2841.6)).toBe('2,842');
    expect(fmtTokS(null)).toBe('–');
  });
  it('formats ms with 0 decimals above 10, 1 below', () => {
    expect(fmtMs(161.04)).toBe('161');
    expect(fmtMs(9.96)).toBe('10.0');
    expect(fmtMs(493000)).toBe('493,000');
  });
  it('formats percentages and GB', () => {
    expect(fmtPct(0.87)).toBe('87.0%');
    expect(fmtPct(1, 0)).toBe('100%');
    expect(fmtGB(54.1)).toBe('54.1');
    expect(fmtGB(128)).toBe('128');
  });
  it('formats integers, compact and tokens', () => {
    expect(fmtInt(2585)).toBe('2,585');
    expect(fmtCompact(1234)).toBe('1.2k');
    expect(fmtCompact(2_500_000)).toBe('2.5M');
    expect(fmtTokens(262144)).toBe('256K');
    expect(fmtTokens(1048576)).toBe('1M');
    expect(fmtTokens(163840)).toBe('160K');
  });
  it('formats params, signed pct, sha, plural', () => {
    expect(fmtParams(27)).toBe('27B');
    expect(fmtParams(0.5)).toBe('500M');
    expect(fmtSignedPct(0.123)).toBe('+12.3%');
    expect(fmtSignedPct(-0.5, 0)).toBe('-50%');
    expect(shortSha('abcdef1234567890')).toBe('abcdef1');
    expect(plural(1, 'run')).toBe('1 run');
    expect(plural(2, 'run')).toBe('2 runs');
    expect(fmtNum(0.9999, 2)).toBe('1.00');
  });
});
