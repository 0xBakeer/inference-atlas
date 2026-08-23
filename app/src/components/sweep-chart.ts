/** Shared uPlot builders: sweep lines (x = concurrency | input_tokens), timeline lines, scatter. */
import type uPlot from 'uplot';
import type { SweepAxis, SweepPoint } from '@atlas/core';
import { fmtCompact, fmtMs, fmtTokS } from '../util/format.js';
import { axisDefaults, tooltipPlugin, type ChartBuild, type ChartPalette } from './chart.js';

export interface SweepSeries {
  label: string;
  color: string;
  points: SweepPoint[];
}

export type SweepMetric = 'throughput' | 'ttft' | 'tpot';

export function sweepAxisOf(points: SweepPoint[]): SweepAxis {
  if (
    points.some((p) => typeof p.input_tokens === 'number') &&
    !points.some((p) => typeof p.concurrency === 'number' && p.concurrency !== 1)
  )
    return 'input_tokens';
  if (points.some((p) => typeof p.concurrency === 'number')) return 'concurrency';
  if (points.some((p) => typeof p.input_tokens === 'number')) return 'input_tokens';
  if (points.some((p) => typeof p.output_tokens === 'number')) return 'output_tokens';
  return 'num_requests';
}

export function sweepX(p: SweepPoint, axis: SweepAxis): number | null {
  const v = p[axis];
  return typeof v === 'number' ? v : null;
}

export function sweepY(p: SweepPoint, metric: SweepMetric): number | null {
  const m = p.metrics;
  if (metric === 'throughput') {
    const v =
      m.output_tok_s ?? m.decode_tok_s_per_request?.mean ?? m.decode_tok_s_per_request?.p50 ?? null;
    return typeof v === 'number' ? v : null;
  }
  if (metric === 'ttft') {
    const v = m.ttft_ms?.p50 ?? m.ttft_ms?.mean ?? null;
    return typeof v === 'number' ? v : null;
  }
  const v = m.tpot_ms?.p50 ?? m.tpot_ms?.mean ?? null;
  return typeof v === 'number' ? v : null;
}

export function sweepHasMetric(points: SweepPoint[], metric: SweepMetric): boolean {
  return points.some((p) => sweepY(p, metric) !== null);
}

const AXIS_LABEL: Record<SweepAxis, string> = {
  concurrency: 'concurrency',
  input_tokens: 'input tokens',
  output_tokens: 'output tokens',
  num_requests: 'requests',
};

/** One metric across one or more sweeps, aligned on the union of x values. */
export function sweepChartBuild(
  series: SweepSeries[],
  metric: SweepMetric,
  axis: SweepAxis,
  opts: { logX?: boolean } = {},
): ChartBuild {
  return (_width, _theme, p: ChartPalette) => {
    const xs = [
      ...new Set(
        series.flatMap((s) =>
          s.points.map((pt) => sweepX(pt, axis)).filter((v): v is number => v !== null),
        ),
      ),
    ].sort((a, b) => a - b);
    const data: uPlot.AlignedData = [
      xs,
      ...series.map((s) =>
        xs.map((x) =>
          sweepY(s.points.find((pt) => sweepX(pt, axis) === x) ?? { metrics: {} }, metric),
        ),
      ),
    ];
    const yLabel =
      metric === 'throughput' ? 'tok/s' : metric === 'ttft' ? 'TTFT p50 (ms)' : 'TPOT p50 (ms)';
    const fmtY = metric === 'throughput' ? fmtTokS : fmtMs;
    const logX =
      opts.logX ??
      (axis === 'concurrency' && xs.length > 3 && xs[xs.length - 1]! / Math.max(1, xs[0]!) >= 16);
    const uopts: uPlot.Options = {
      width: 600,
      height: 240,
      legend: { show: series.length > 1 },
      cursor: { points: { size: 8 } },
      scales: {
        x: { time: false, distr: logX ? 3 : 1 },
        y: { range: (_u, min, max) => [Math.min(0, min), max * 1.08 || 1] },
      },
      axes: [
        {
          ...axisDefaults(p, AXIS_LABEL[axis]),
          values: (_u, vals) => vals.map((v) => fmtCompact(v)),
        },
        { ...axisDefaults(p, yLabel), values: (_u, vals) => vals.map((v) => fmtY(v)) },
      ],
      series: [
        { label: AXIS_LABEL[axis] },
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 2,
          points: { show: true, size: 7, fill: p.surface, stroke: s.color, width: 2 },
          spanGaps: true,
        })),
      ],
      plugins: [
        tooltipPlugin((u, idx) => {
          const x = u.data[0][idx];
          const lines = series.map((s, i) => {
            const v = u.data[i + 1]?.[idx];
            return v == null
              ? null
              : `<div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:6px"></span>${escapeHtml(s.label)}: <b>${fmtY(v)}</b></div>`;
          });
          if (lines.every((l) => l === null)) return null;
          return `<div style="opacity:.7;margin-bottom:2px">${AXIS_LABEL[axis]} ${fmtCompact(x)}</div>${lines.filter(Boolean).join('')}`;
        }),
      ],
    };
    return { opts: uopts, data };
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** Scaling efficiency: throughput(x) / (throughput(x0) * x / x0). */
export function scalingEfficiency(
  points: SweepPoint[],
  axis: SweepAxis = 'concurrency',
): Array<{ x: number; y: number | null; eff: number | null }> {
  const pts = points
    .map((p) => ({ x: sweepX(p, axis), y: sweepY(p, 'throughput') }))
    .filter((p): p is { x: number; y: number | null } => p.x !== null)
    .sort((a, b) => a.x - b.x);
  const base = pts.find((p) => p.y !== null);
  return pts.map((p) => ({
    x: p.x,
    y: p.y,
    eff: base && p.y !== null && base.y ? p.y / (base.y * (p.x / base.x)) : null,
  }));
}

/** Generic multi-series line chart over ordinal x (e.g. engine versions). */
export function ordinalLinesBuild(
  labels: string[],
  series: Array<{ label: string; color: string; values: Array<number | null> }>,
  yLabel: string,
  fmtY: (v: number) => string,
  flagged?: Set<string>,
): ChartBuild {
  return (_w, _t, p) => {
    const xs = labels.map((_, i) => i);
    const data: uPlot.AlignedData = [xs, ...series.map((s) => s.values)];
    const uopts: uPlot.Options = {
      width: 600,
      height: 240,
      legend: { show: series.length > 1 },
      cursor: { points: { size: 8 } },
      scales: {
        x: { time: false, range: [-0.4, Math.max(0.4, labels.length - 0.6)] },
        y: { range: (_u, min, max) => [Math.min(0, min), max * 1.1 || 1] },
      },
      axes: [
        {
          ...axisDefaults(p),
          splits: () => xs,
          values: () => labels.map((l) => (flagged?.has(l) ? `${l} !` : l)),
        },
        { ...axisDefaults(p, yLabel), values: (_u, vals) => vals.map((v) => fmtY(v)) },
      ],
      series: [
        { label: 'version' },
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 2,
          points: { show: true, size: 8, fill: p.surface, stroke: s.color, width: 2 },
          spanGaps: true,
        })),
      ],
      plugins: [
        tooltipPlugin((u, idx) => {
          const lines = series.map((s, i) => {
            const v = u.data[i + 1]?.[idx];
            return v == null
              ? null
              : `<div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:6px"></span>${escapeHtml(s.label)}: <b>${fmtY(v)}</b></div>`;
          });
          if (lines.every((l) => l === null)) return null;
          return `<div style="opacity:.7;margin-bottom:2px">${escapeHtml(labels[idx] ?? '')}</div>${lines.filter(Boolean).join('')}`;
        }),
      ],
    };
    return { opts: uopts, data };
  };
}
