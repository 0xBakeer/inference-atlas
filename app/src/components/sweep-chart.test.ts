import { describe, expect, it } from 'vitest';
import type { SweepPoint } from '@atlas/core';
import type { ChartPalette } from './chart.js';
import { sweepChartBuild, sweepYTail, type SweepSeries } from './sweep-chart.js';

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

function pt(concurrency: number, ttft50: number, ttft95: number, tok: number): SweepPoint {
  return {
    concurrency,
    metrics: { output_tok_s: tok, ttft_ms: { p50: ttft50, p95: ttft95 } },
  };
}

const points = [
  pt(1, 1600, 1900, 24),
  pt(4, 2100, 2600, 58),
  pt(16, 2700, 3400, 90),
  pt(64, 70000, 112000, 105),
];
const one: SweepSeries[] = [{ label: 'this run', color: '#1b4fd6', points }];
const two: SweepSeries[] = [...one, { label: 'max-num-seqs=2', color: '#c25e00', points }];

describe('sweepChartBuild', () => {
  it('adds a p50–p95 band column for a single latency series', () => {
    const { opts, data } = sweepChartBuild(one, 'ttft', 'concurrency')(600, 'light', palette);
    expect(data).toHaveLength(3); // x, p50, p95
    expect(data[2]).toEqual([1900, 2600, 3400, 112000]);
    expect(opts.bands).toHaveLength(1);
    expect(opts.series).toHaveLength(3);
    expect(opts.series[2]!.dash).toEqual([4, 4]);
  });

  it('keeps multi-series latency charts band-free — a band per arm would be unreadable', () => {
    const { opts, data } = sweepChartBuild(two, 'ttft', 'concurrency')(600, 'light', palette);
    expect(data).toHaveLength(3); // x + two arms, no tail column
    expect(opts.bands).toBeUndefined();
    expect(opts.legend?.show).toBe(true);
  });

  it('ribbon-fills throughput curves but not beyond two series', () => {
    const single = sweepChartBuild(one, 'throughput', 'concurrency')(600, 'dark', palette);
    expect(single.opts.series[1]!.fill).toBeTypeOf('function');
    const many = sweepChartBuild(
      [...two, { label: 'c', color: '#6aa300', points }],
      'throughput',
      'concurrency',
    )(600, 'dark', palette);
    expect(many.opts.series[1]!.fill).toBeUndefined();
  });

  it('ticks the measured levels exactly on a log concurrency axis', () => {
    const { opts } = sweepChartBuild(one, 'throughput', 'concurrency')(600, 'light', palette);
    const splits = opts.axes?.[0]?.splits;
    expect(splits).toBeTypeOf('function');
    expect((splits as () => number[])()).toEqual([1, 4, 16, 64]);
  });

  it('joins a cursor sync group when asked so paired panels share the crosshair', () => {
    const { opts } = sweepChartBuild(one, 'ttft', 'concurrency', { sync: 'pair' })(
      600,
      'light',
      palette,
    );
    expect(opts.cursor?.sync?.key).toBe('pair');
  });
});

describe('sweepYTail', () => {
  it('reads the p95 tail only for latency metrics', () => {
    expect(sweepYTail(points[0]!, 'ttft')).toBe(1900);
    expect(sweepYTail(points[0]!, 'throughput')).toBeNull();
    expect(sweepYTail({ metrics: {} }, 'ttft')).toBeNull();
  });
});
