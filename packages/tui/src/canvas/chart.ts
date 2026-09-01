/**
 * Chart compositors over the braille canvas: a line chart (sweeps, prefill curves) and a
 * scatter (Pareto). Both return plain strings — Ink just prints them — and both render a
 * deterministic mono form for tests.
 */

import { BrailleGrid } from './braille.js';
import type { ColorLevel } from './color.js';
import { paint } from './color.js';
import { linearScale, niceTicks, padDomain } from './scale.js';

export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartSeries {
  label: string;
  color: string;
  points: ChartPoint[];
  /** Connect points with line segments (line chart) or plot dots only (scatter). */
  connect?: boolean;
}

export interface ChartOptions {
  /** Total width in terminal cells, axis gutter included. */
  width: number;
  /** Plot height in terminal cells, x-axis line excluded. */
  height: number;
  series: ChartSeries[];
  xFmt?: (v: number) => string;
  yFmt?: (v: number) => string;
  level: ColorLevel;
  /** Index into the flattened points of series[highlightSeries] to mark with ◉. */
  highlight?: { series: number; point: number } | null;
  /** Use a log2 x-axis (context-length sweeps: 1k → 256k). */
  logX?: boolean;
}

const fmtDefault = (v: number): string =>
  Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v * 10) / 10}`;

/** Render a chart to lines: plot area with y gutter, x-axis row, tick row, legend row. */
export function renderChart(opts: ChartOptions): string[] {
  const xFmt = opts.xFmt ?? fmtDefault;
  const yFmt = opts.yFmt ?? fmtDefault;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of opts.series)
    for (const p of s.points) {
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        xs.push(opts.logX ? Math.log2(Math.max(1, p.x)) : p.x);
        ys.push(p.y);
      }
    }
  if (xs.length === 0) return ['(no data)'];

  const yTicks = niceTicks(Math.min(...ys), Math.max(...ys), Math.max(2, opts.height / 2));
  const gutter = Math.max(...yTicks.map((t) => yFmt(t).length), 1) + 1;
  const plotCols = Math.max(4, opts.width - gutter - 1);

  const xDomain = padDomain(Math.min(...xs), Math.max(...xs));
  const yDomain = padDomain(
    Math.min(...ys, yTicks[0] ?? Infinity),
    Math.max(...ys, yTicks[yTicks.length - 1] ?? -Infinity),
  );
  const grid = new BrailleGrid(plotCols, opts.height);
  const sx = linearScale(xDomain, [0, grid.width - 1]);
  const sy = linearScale(yDomain, [grid.height - 1, 0]);

  opts.series.forEach((s, si) => {
    const pts = s.points
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ x: opts.logX ? Math.log2(Math.max(1, p.x)) : p.x, y: p.y }))
      .sort((a, b) => a.x - b.x);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      if (s.connect !== false && i > 0) {
        const q = pts[i - 1]!;
        grid.line(sx(q.x), sy(q.y), sx(p.x), sy(p.y), si);
      } else {
        grid.set(sx(p.x), sy(p.y), si);
      }
    }
  });

  if (opts.highlight) {
    const s = opts.series[opts.highlight.series];
    const p = s?.points[opts.highlight.point];
    if (s && p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const hx = opts.logX ? Math.log2(Math.max(1, p.x)) : p.x;
      grid.mark(sx(hx), sy(p.y), '◉', opts.highlight.series);
    }
  }

  const colorOf = (si: number) => (text: string) =>
    paint(text, { fg: opts.series[si]?.color ?? null }, opts.level);
  const plot = grid.render(colorOf);

  // y gutter: tick labels on the rows their value falls into.
  const labelAt = new Map<number, string>();
  for (const t of yTicks) {
    const row = Math.round(sy(t) / 4);
    if (row >= 0 && row < opts.height && !labelAt.has(row)) labelAt.set(row, yFmt(t));
  }
  const lines = plot.map((body, r) => {
    const label = labelAt.get(r) ?? '';
    return `${label.padStart(gutter)}│${body}`;
  });
  lines.push(`${' '.repeat(gutter)}└${'─'.repeat(plotCols)}`);

  // x tick row: min, middle and max of the domain.
  const unlog = (v: number) => (opts.logX ? 2 ** v : v);
  const lo = xFmt(unlog(xDomain[0]));
  const hi = xFmt(unlog(xDomain[1]));
  const mid = xFmt(unlog((xDomain[0] + xDomain[1]) / 2));
  const pad = Math.max(1, plotCols - lo.length - mid.length - hi.length);
  lines.push(
    `${' '.repeat(gutter + 1)}${lo}${' '.repeat(Math.ceil(pad / 2))}${mid}${' '.repeat(Math.floor(pad / 2))}${hi}`,
  );

  if (opts.series.length > 1 || opts.series[0]?.label) {
    lines.push(
      opts.series
        .map((s, si) => `${colorOf(si)('──')} ${s.label}`)
        .join('   ')
        .trimEnd(),
    );
  }
  return lines;
}
