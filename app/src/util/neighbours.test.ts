import { describe, expect, it } from 'vitest';
import { nearestNeighbours } from './neighbours.js';

describe('nearestNeighbours', () => {
  const runs = [
    { id: 'far', c: '@dtype=auto;@quant=fp8;a=1;b=2;c=3' },
    { id: 'near', c: '@dtype=auto;@quant=fp8;a=1' },
    { id: 'same', c: '@dtype=auto;@quant=fp8' },
  ];
  it('sorts by number of differing params', () => {
    const n = nearestNeighbours('@dtype=auto;@quant=fp8', runs, (r) => r.c);
    expect(n.map((x) => x.item.id)).toEqual(['same', 'near', 'far']);
    expect(n[0]!.distance).toBe(0);
    expect(n[1]!.differing).toEqual(['a']);
    expect(n[2]!.differing).toEqual(['a', 'b', 'c']);
  });
  it('respects the limit', () => {
    expect(nearestNeighbours('x=1', runs, (r) => r.c, 2)).toHaveLength(2);
  });
});
