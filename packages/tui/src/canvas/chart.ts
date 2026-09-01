/**
 * Chart compositor over the braille canvas.
 *
 * Two things make a terminal line chart read as a chart rather than as scattered dots: an
 * **area fill** under the curve, which turns a shallow slope from a dotted line into a solid
 * shape, and a **drawn axis** with ticks the reader can line values up against. Both are
 * here, along with a right-hand axis so a throughput curve and a latency curve can share one
 * plot instead of being stacked as two thin ones.
 *
 * Everything returns plain strings — Ink just prints them — and mono renders deterministically
 * so the tests can assert on shape.
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
  /** Fill the area between the curve and the bottom — what makes a sparse curve read. */
  fill?: boolean;
  /** Which y scale this series belongs to. Default 'left'. */
  axis?: 'left' | 'right';
}

export interface ChartOptions {
  /** Total width in terminal cells, axis gutters included. */
  width: number;
  /** Plot height in terminal cells, x-axis row excluded. */
  height: number;
  series: ChartSeries[];
  xFmt?: (v: number) => string;
  yFmt?: (v: number) => string;
  /** Formatter for the right-hand axis; falls back to `yFmt`. */
  yFmtRight?: (v: number) => string;
  level: ColorLevel;
  /** Index into `series[highlight.series].points` to mark with ◉. */
  highlight?: { series: number; point: number } | null;
  /** Use a log2 x-axis (context-length sweeps: 1k → 256k). */
  logX?: boolean;
  /**
   * Label these exact x values instead of computing round numbers. Sweep axes are the
   * levels that were actually run (1, 2, 4, 8 …); inventing 17 and 34 between them, or
   * padding the domain out to −1, describes a measurement nobody made.
   */
  xTicks?: number[];
  /** Skip domain padding — for axes whose ends are meaningful (a sweep's first/last level). */
  tightX?: boolean;
}

const fmtDefault = (v: number): string => {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${Math.round(v / 100_000) / 10}M`;
  if (abs >= 10_000) return `${Math.round(v / 1000)}k`;
  if (abs >= 1000) return `${Math.round(v / 100) / 10}k`;
  if (abs >= 10) return String(Math.round(v));
  return String(Math.round(v * 10) / 10);
};

interface AxisPlan {
  ticks: number[];
  labels: string[];
  domain: [number, number];
  width: number;
}

/** Ticks whose labels are distinct — three rows all reading "20k" tell you nothing. */
function planAxis(values: number[], height: number, fmt: (v: number) => string): AxisPlan | null {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const ticks: number[] = [];
  const labels: string[] = [];
  for (const t of niceTicks(min, max, Math.max(2, Math.floor(height / 2)))) {
    const label = fmt(t);
    if (labels.includes(label)) continue;
    ticks.push(t);
    labels.push(label);
  }
  if (ticks.length === 0) {
    ticks.push(min);
    labels.push(fmt(min));
  }
  const domain = padDomain(Math.min(min, ...ticks), Math.max(max, ...ticks));
  return { ticks, labels, domain, width: Math.max(...labels.map((l) => l.length)) };
}

export function renderChart(opts: ChartOptions): string[] {
  const xFmt = opts.xFmt ?? fmtDefault;
  const yFmt = opts.yFmt ?? fmtDefault;
  const yFmtRight = opts.yFmtRight ?? yFmt;
  const toX = (v: number) => (opts.logX ? Math.log2(Math.max(1, v)) : v);

  const usable = opts.series.filter((s) =>
    s.points.some((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
  );
  if (usable.length === 0) return ['(no data)'];

  const xs: number[] = [];
  const leftYs: number[] = [];
  const rightYs: number[] = [];
  for (const s of usable) {
    for (const p of s.points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      xs.push(toX(p.x));
      (s.axis === 'right' ? rightYs : leftYs).push(p.y);
    }
  }

  const left = planAxis(leftYs, opts.height, yFmt);
  const right = planAxis(rightYs, opts.height, yFmtRight);
  const leftGutter = (left?.width ?? 0) + 1;
  const rightGutter = right ? right.width + 1 : 0;
  const plotCols = Math.max(6, opts.width - leftGutter - rightGutter - 1);

  const xDomain: [number, number] = opts.tightX
    ? [Math.min(...xs), Math.max(...xs)]
    : padDomain(Math.min(...xs), Math.max(...xs));
  const grid = new BrailleGrid(plotCols, opts.height);
  const sx = linearScale(xDomain, [0, grid.width - 1]);
  const syFor = (axis: 'left' | 'right') => {
    const plan = axis === 'right' ? right : left;
    return linearScale(plan?.domain ?? [0, 1], [grid.height - 1, 0]);
  };

  usable.forEach((s, si) => {
    const sy = syFor(s.axis ?? 'left');
    const pts = s.points
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ x: sx(toX(p.x)), y: sy(p.y) }))
      .sort((a, b) => a.x - b.x);
    if (pts.length === 0) return;

    if (s.connect !== false && pts.length > 1) {
      for (let i = 1; i < pts.length; i++) {
        grid.line(pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y, si);
      }
      if (s.fill) {
        // Rasterise the curve to one y per dot column, then drop a column of dots to the
        // floor: a filled body reads as a magnitude, a bare polyline reads as noise.
        for (let x = Math.ceil(pts[0]!.x); x <= Math.floor(pts[pts.length - 1]!.x); x++) {
          let j = 1;
          while (j < pts.length && pts[j]!.x < x) j++;
          const a = pts[Math.max(0, j - 1)]!;
          const b = pts[Math.min(pts.length - 1, j)]!;
          const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
          const y = a.y + (b.y - a.y) * t;
          for (let yy = Math.ceil(y); yy < grid.height; yy++) grid.set(x, yy, si);
        }
      }
    }
    // Always mark the measured points themselves — they are the data, the line is a reading aid.
    for (const p of pts) grid.set(p.x, p.y, si);
  });

  if (opts.highlight) {
    const s = usable[opts.highlight.series];
    const p = s?.points[opts.highlight.point];
    if (s && p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      grid.mark(sx(toX(p.x)), syFor(s.axis ?? 'left')(p.y), '◉', opts.highlight.series);
    }
  }

  const colorOf = (si: number) => (text: string) =>
    paint(text, { fg: usable[si]?.color ?? null }, opts.level);
  const dim = (text: string) => paint(text, { fg: '#5a6480' }, opts.level);
  const body = grid.render(colorOf);

  // Label rows: a tick's label sits on the character row its value falls into.
  const rowsFor = (plan: AxisPlan | null, axis: 'left' | 'right') => {
    const map = new Map<number, string>();
    if (!plan) return map;
    const sy = syFor(axis);
    plan.ticks.forEach((t, i) => {
      const row = Math.round(sy(t) / 4);
      if (row >= 0 && row < opts.height && !map.has(row)) map.set(row, plan.labels[i]!);
    });
    return map;
  };
  const leftRows = rowsFor(left, 'left');
  const rightRows = rowsFor(right, 'right');
  const leftColor = usable.find((s) => (s.axis ?? 'left') === 'left')?.color ?? null;
  const rightColor = usable.find((s) => s.axis === 'right')?.color ?? null;

  const lines = body.map((row, r) => {
    const l = leftRows.get(r) ?? '';
    const gutterText = l.padStart(leftGutter);
    const axisChar = l ? '┤' : '│';
    const rightLabel = rightRows.get(r) ?? '';
    const rightText = rightGutter
      ? rightLabel
        ? dim('├') + paint(rightLabel.padEnd(rightGutter - 1), { fg: rightColor }, opts.level)
        : dim('│') + ' '.repeat(rightGutter - 1)
      : '';
    return (
      (l ? paint(gutterText, { fg: leftColor }, opts.level) : dim(gutterText)) +
      dim(axisChar) +
      row +
      rightText
    );
  });

  // Bottom axis with a tick mark under every labelled x.
  const tickXs = (
    opts.xTicks && opts.xTicks.length > 0
      ? opts.xTicks
      : [xDomain[0], (xDomain[0] + xDomain[1]) / 2, xDomain[1]].map((v) => (opts.logX ? 2 ** v : v))
  ).filter((v) => {
    const dot = sx(toX(v));
    return dot >= -0.5 && dot <= grid.width - 0.5;
  });
  const axisCells = Array.from({ length: plotCols }, () => '─');
  const labelRow = Array.from({ length: plotCols + 12 }, () => ' ');
  for (const v of tickXs) {
    const col = Math.max(0, Math.min(plotCols - 1, Math.round(sx(toX(v)) / 2)));
    axisCells[col] = '┬';
    const label = xFmt(v);
    // Centre the label, then nudge it inside the plot so nothing is clipped at the edges.
    let start = Math.max(0, col - Math.floor(label.length / 2));
    if (start + label.length > plotCols) start = Math.max(0, plotCols - label.length);
    if (labelRow.slice(start, start + label.length + 1).some((c) => c !== ' ')) continue;
    for (let i = 0; i < label.length; i++) labelRow[start + i] = label[i]!;
  }
  lines.push(dim(`${' '.repeat(leftGutter)}└${axisCells.join('')}`));
  lines.push(dim(`${' '.repeat(leftGutter + 1)}${labelRow.join('').trimEnd()}`));
  return lines;
}

/** Legend chips for a chart, to sit in a panel title rather than steal a row. */
export function legendChips(series: ChartSeries[], level: ColorLevel): string {
  return series
    .filter((s) => s.label)
    .map((s) => paint(`━━ ${s.label}`, { fg: s.color }, level))
    .join('  ');
}
