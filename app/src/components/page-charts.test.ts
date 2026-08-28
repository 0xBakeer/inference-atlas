import { describe, expect, it } from 'vitest';
import type { ChartPalette } from './chart.js';
import { barChartBuild, countBy, groupedBarChartBuild, histogramItems } from './page-charts.js';

const palette: ChartPalette = {
  ink: '#111111',
  muted: '#666666',
  line: '#dddddd',
  surface: '#ffffff',
  accent: '#d1295e',
  chart1: '#1b4fd6',
  chart2: '#c25e00',
  chart1Soft: 'rgba(27, 79, 214, 0.14)',
  chart2Soft: 'rgba(194, 94, 0, 0.13)',
};

describe('barChartBuild', () => {
  it('sorts by value and keeps one y per bar', () => {
    const { data, opts } = barChartBuild(
      [
        { label: 'b', value: 2 },
        { label: 'a', value: 9 },
        { label: 'c', value: 4 },
      ],
      'runs',
    )(800, 'light', palette);
    expect(data[1]).toEqual([9, 4, 2]);
    expect(opts.series).toHaveLength(2);
    expect(opts.hooks?.draw).toHaveLength(1);
  });

  it('drops the long tail so labels stay readable on a phone', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ label: `e${i}`, value: 20 - i }));
    const { data } = barChartBuild(items, 'runs')(400, 'light', palette);
    expect((data[0] as number[]).length).toBeLessThanOrEqual(8);
  });
});

describe('groupedBarChartBuild', () => {
  it('aligns one column per series', () => {
    const { data, opts } = groupedBarChartBuild(
      ['TTFT', 'TPOT'],
      [
        { label: 'p50', color: '#c25e00', values: [12, 4] },
        { label: 'p95', color: '#1b4fd6', values: [30, 9] },
      ],
      'ms',
    )(700, 'light', palette);
    expect(data).toHaveLength(3);
    expect(data[1]).toEqual([12, 4]);
    expect(data[2]).toEqual([30, 9]);
    expect(opts.legend?.show).toBe(true);
  });
});

describe('histogramItems', () => {
  it('puts every sample in a bucket and sums to n', () => {
    const items = histogramItems([1, 2, 2, 3, 10], 4);
    expect(items.reduce((n, i) => n + i.value, 0)).toBe(5);
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it('collapses a single unique value to one bar', () => {
    expect(histogramItems([4, 4, 4], 8)).toEqual([{ label: '4', value: 3 }]);
  });
});

describe('countBy', () => {
  it('groups and sorts by count', () => {
    const items = countBy([{ k: 'vllm' }, { k: 'sglang' }, { k: 'vllm' }], (r) => r.k);
    expect(items).toEqual([
      { label: 'vllm', value: 2, color: undefined },
      { label: 'sglang', value: 1, color: undefined },
    ]);
  });
});
