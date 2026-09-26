import { describe, expect, it } from 'vitest';
import { paretoFrontier } from './pareto.js';

describe('paretoFrontier', () => {
  const pts = [
    { x: 100, y: 50 }, // a: dominated by c (lower x, higher y)
    { x: 400, y: 90 }, // b: frontier (highest y)
    { x: 80, y: 60 }, // c: frontier
    { x: 200, y: 55 }, // d: dominated by c
    { x: 150, y: 80 }, // e: frontier
  ];
  it('finds lower-x / higher-y frontier ordered by x', () => {
    expect(paretoFrontier(pts, 'lower', 'higher')).toEqual([2, 4, 1]);
  });
  it('respects direction flags', () => {
    // higher x is better, higher y better: b dominates everything
    expect(paretoFrontier(pts, 'higher', 'higher')).toEqual([1]);
    // lower x better, lower y better: c (80,60) and a? a=(100,50): lower y than c → frontier: c, a
    expect(paretoFrontier(pts, 'lower', 'lower')).toEqual([2, 0]);
  });
  it('ignores non-finite points and handles ties', () => {
    expect(
      paretoFrontier(
        [
          { x: NaN, y: 1 },
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        'lower',
        'higher',
      ),
    ).toEqual([1]);
    expect(paretoFrontier([], 'lower', 'higher')).toEqual([]);
  });
});
