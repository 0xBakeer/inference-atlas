/** The hardware key under the coverage grid: it has to pack, or it eats the screen. */

import { describe, expect, it } from 'vitest';
import { legendLines } from './coverage.js';

describe('legendLines', () => {
  const hw = Array.from({ length: 20 }, (_, i) => `vendor-device-${i + 1}`);

  it('packs the hardware key into columns instead of one line each', () => {
    const lines = legendLines(hw, 100);
    expect(lines.length).toBeLessThan(8);
    expect(lines.join('\n')).toContain('1 = vendor-device-1');
    expect(lines.join('\n')).toContain('20 = vendor-device-20');
  });

  it('never lets a line run past the width it was given', () => {
    for (const width of [40, 80, 100, 200]) {
      for (const line of legendLines(hw, width)) {
        expect(line.length).toBeLessThanOrEqual(Math.max(width, 22));
      }
    }
  });

  it('falls back to one entry per line when the terminal is too narrow', () => {
    expect(legendLines(hw, 10)).toHaveLength(20);
  });

  it('has nothing to draw for an empty grid', () => {
    expect(legendLines([], 100)).toEqual([]);
  });
});
