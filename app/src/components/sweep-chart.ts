/** Shared uPlot builders: sweep lines (x = concurrency | input_tokens), timeline lines, scatter. */
import type uPlot from 'uplot';
import type { SweepAxis, SweepPoint } from '@atlas/core';
import { fmtCompact, fmtMs, fmtTokS, fmtTokens } from '../util/format.js';
import { withAlpha } from '../util/colors.js';
import {
  axisDefaults,
  ribbonFill,
  tooltipPlugin,
  type ChartBuild,
  type ChartPalette,
} from './chart.js';

export interface SweepSeries {
  label: string;
  color: string;
  points: SweepPoint[];
}

export type SweepMetric = 'throughput' | 'ttft' | 'tpot' | 'prefill';

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
  if (metric === 'prefill') {
    const v = m.prefill_tok_s ?? null;
    return typeof v === 'number' ? v : null;
  }
  if (metric === 'ttft') {
    const v = m.ttft_ms?.p50 ?? m.ttft_ms?.mean ?? null;
    return typeof v === 'number' ? v : null;
  }
  const v = m.tpot_ms?.p50 ?? m.tpot_ms?.mean ?? null;
  return typeof v === 'number' ? v : null;
}

/** Tail of the same distribution, for the p50–p95 band. Throughput-style metrics have none. */
export function sweepYTail(p: SweepPoint, metric: SweepMetric): number | null {
  const d = metric === 'ttft' ? p.metrics.ttft_ms : metric === 'tpot' ? p.metrics.tpot_ms : null;
  const v = d?.p95 ?? d?.p90 ?? null;
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

const METRIC_LABEL: Record<SweepMetric, string> = {
  throughput: 'tok/s',
  prefill: 'prefill tok/s',
  ttft: 'TTFT p50 (ms)',
  tpot: 'TPOT p50 (ms)',
};

export interface SweepChartOpts {
  logX?: boolean;
  /** uPlot cursor-sync group; paired panels over the same x share one so the crosshair travels. */
  sync?: string;
  /** p50–p95 band on single-series latency charts (default on when the data has the tail). */
  band?: boolean;
}

/** One metric across one or more sweeps, aligned on the union of x values. */
export function sweepChartBuild(
  series: SweepSeries[],
  metric: SweepMetric,
  axis: SweepAxis,
  opts: SweepChartOpts = {},
): ChartBuild {
  return (_width, theme, p: ChartPalette) => {
    const xs = [
      ...new Set(
        series.flatMap((s) =>
          s.points.map((pt) => sweepX(pt, axis)).filter((v): v is number => v !== null),
        ),
      ),
    ].sort((a, b) => a - b);
    const at = (s: SweepSeries, x: number): SweepPoint =>
      s.points.find((pt) => sweepX(pt, axis) === x) ?? { metrics: {} };
    const band =
      (opts.band ?? true) &&
      series.length === 1 &&
      (metric === 'ttft' || metric === 'tpot') &&
      series[0]!.points.some((pt) => sweepYTail(pt, metric) !== null);
    const data: uPlot.AlignedData = [
      xs,
      ...series.map((s) => xs.map((x) => sweepY(at(s, x), metric))),
      ...(band ? [xs.map((x) => sweepYTail(at(series[0]!, x), metric))] : []),
    ];
    const yLabel = METRIC_LABEL[metric];
    const fmtY = metric === 'throughput' || metric === 'prefill' ? fmtTokS : fmtMs;
    const logX =
      opts.logX ??
      (axis === 'concurrency' && xs.length > 3 && xs[xs.length - 1]! / Math.max(1, xs[0]!) >= 16);
    // Ribbon fills read well up to two curves; beyond that they stack into mud. A band chart
    // keeps only the p50–p95 haze — ribbon plus band would double-fill the same area.
    const fillAlpha = band || series.length > 2 ? 0 : theme === 'dark' ? 0.2 : 0.12;
    const uopts: uPlot.Options = {
      width: 600,
      height: 240,
      legend: { show: series.length > 1, live: false },
      cursor: {
        points: { size: 8 },
        ...(opts.sync ? { sync: { key: opts.sync } } : {}),
      },
      scales: {
        x: { time: false, distr: logX ? 3 : 1 },
        y: { range: (_u, min, max) => [Math.min(0, min), max * 1.08 || 1] },
      },
      ...(band ? { bands: [{ series: [2, 1], fill: withAlpha(series[0]!.color, 0.14) }] } : {}),
      axes: [
        {
          ...axisDefaults(p, AXIS_LABEL[axis]),
          // Sweeps are run at a handful of exact levels (1, 2, 4 … 64): tick every one of
          // them. The filter must pass them all through — uPlot's log-scale default keeps
          // only decades and would blank most of the measured levels.
          ...(logX && xs.length <= 12 ? { splits: () => xs, filter: (_u, splits) => splits } : {}),
          // token counts read as powers of two (8K, 32K, 128K), not decimal compacts
          values: (_u, vals) =>
            vals.map((v) =>
              axis === 'input_tokens' || axis === 'output_tokens' ? fmtTokens(v) : fmtCompact(v),
            ),
        },
        {
          ...axisDefaults(p, yLabel),
          // ms values reach six digits (a 100 s TTFT) — give the tick text room.
          size: metric === 'ttft' || metric === 'tpot' ? 54 : 44,
          values: (_u, vals) => vals.map((v) => fmtY(v)),
        },
      ],
      series: [
        { label: AXIS_LABEL[axis] },
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 2,
          ...(fillAlpha > 0 ? { fill: ribbonFill(withAlpha(s.color, fillAlpha)) } : {}),
          points: { show: true, size: 7, fill: s.color, stroke: p.surface, width: 1.5 },
          spanGaps: true,
        })),
        ...(band
          ? [
              {
                label: 'p95',
                stroke: withAlpha(series[0]!.color, 0.55),
                width: 1,
                dash: [4, 4],
                points: { show: false },
                spanGaps: true,
              },
            ]
          : []),
      ],
      plugins: [
        tooltipPlugin((u, idx) => {
          const x = u.data[0][idx];
          const lines = series.map((s, i) => {
            const v = u.data[i + 1]?.[idx];
            if (v == null) return null;
            const tail = band ? u.data[series.length + 1]?.[idx] : null;
            const val = band && tail != null ? `p50 ${fmtY(v)} · p95 ${fmtY(tail)}` : fmtY(v);
            return `<div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:6px"></span>${escapeHtml(s.label)}: <b>${val}</b></div>`;
          });
          if (lines.every((l) => l === null)) return null;
          const fmtX = axis === 'input_tokens' || axis === 'output_tokens' ? fmtTokens : fmtCompact;
          return `<div style="opacity:.7;margin-bottom:2px">${AXIS_LABEL[axis]} ${fmtX(x)}</div>${lines.filter(Boolean).join('')}`;
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
  return (_w, theme, p) => {
    const xs = labels.map((_, i) => i);
    const data: uPlot.AlignedData = [xs, ...series.map((s) => s.values)];
    const fillAlpha = series.length <= 2 ? (theme === 'dark' ? 0.2 : 0.12) : 0;
    const uopts: uPlot.Options = {
      width: 600,
      height: 240,
      legend: { show: series.length > 1, live: false },
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
          ...(fillAlpha > 0 ? { fill: ribbonFill(withAlpha(s.color, fillAlpha)) } : {}),
          points: { show: true, size: 8, fill: s.color, stroke: p.surface, width: 1.5 },
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
