/**
 * Categorical charts used on every page: counts, histograms, grouped metric bars.
 * Line/sweep charts stay in sweep-chart.ts; this file is bars only, drawn by hand so
 * each bar can carry its own colour (uPlot series colours are per-series, not per-point).
 */
import { html, nothing, type TemplateResult } from 'lit';
import type uPlot from 'uplot';
import { fmtCompact, fmtInt } from '../util/format.js';
import { axisDefaults, tooltipPlugin, type ChartBuild, type ChartPalette } from './chart.js';
import './chart.js';

export interface BarItem {
  label: string;
  value: number;
  color?: string;
}

export interface ChartCardOpts {
  meta?: string;
  height?: number;
  key?: unknown;
  note?: string;
  yLabel?: string;
  fmt?: (v: number) => string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function clipLabel(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

function maxBarsFor(width: number): number {
  if (width < 420) return 6;
  if (width < 640) return 8;
  if (width < 900) return 10;
  return 12;
}

function labelMaxFor(width: number): number {
  if (width < 420) return 8;
  if (width < 640) return 12;
  return 18;
}

function roundBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, Math.abs(h)));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, [rr, rr, 0, 0]);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fill();
}

/** One coloured bar per item. Tallest first; extras are dropped, never squeezed. */
export function barChartBuild(
  items: BarItem[],
  yLabel: string,
  fmtY: (v: number) => string = fmtInt,
): ChartBuild {
  return (width, _theme, p: ChartPalette) => {
    const cap = maxBarsFor(width);
    const shown = [...items]
      .filter((d) => Number.isFinite(d.value))
      .sort((a, b) => b.value - a.value)
      .slice(0, cap);
    const xs = shown.map((_, i) => i);
    const ys = shown.map((d) => d.value);
    const maxLabel = labelMaxFor(width);
    const labels = shown.map((d) => clipLabel(d.label, maxLabel));
    const compact = width < 560;
    const opts: uPlot.Options = {
      width: 600,
      height: 220,
      legend: { show: false },
      cursor: { points: { show: false }, y: false, drag: { x: false, y: false } },
      scales: {
        x: { time: false, range: [-0.6, Math.max(0.6, shown.length - 0.4)] },
        y: { range: (_u, _min, max) => [0, (max || 1) * 1.12] },
      },
      axes: [
        {
          ...axisDefaults(p),
          size: compact ? 40 : 48,
          labelSize: 0,
          splits: () => xs,
          values: () => labels,
          grid: { show: false },
        },
        {
          ...axisDefaults(p, compact ? undefined : yLabel),
          size: compact ? 36 : 44,
          values: (_u, vals) => vals.map((v) => fmtY(v)),
        },
      ],
      series: [{}, { label: yLabel, paths: () => null, points: { show: false }, stroke: p.chart1 }],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            const dpr = devicePixelRatio || 1;
            ctx.save();
            ctx.beginPath();
            ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
            ctx.clip();
            shown.forEach((item, i) => {
              const x0 = u.valToPos(i - 0.36, 'x', true);
              const x1 = u.valToPos(i + 0.36, 'x', true);
              const y0 = u.valToPos(0, 'y', true);
              const y1 = u.valToPos(item.value, 'y', true);
              const w = Math.max(1, x1 - x0);
              const h = y0 - y1;
              if (h <= 0) return;
              ctx.fillStyle = item.color ?? p.chart1;
              roundBar(ctx, x0, y1, w, h, 3 * dpr);
            });
            ctx.restore();
          },
        ],
      },
      plugins: [
        tooltipPlugin((_u, idx) => {
          const item = shown[idx];
          if (!item) return null;
          return `<div style="opacity:.7;margin-bottom:2px">${escapeHtml(item.label)}</div><div><b>${fmtY(item.value)}</b> ${escapeHtml(yLabel)}</div>`;
        }),
      ],
    };
    return { opts, data: [xs, ys] as uPlot.AlignedData };
  };
}

/** Side-by-side bars per group (e.g. p50 vs p95, or several runs on one metric). */
export function groupedBarChartBuild(
  groups: string[],
  series: Array<{ label: string; color: string; values: Array<number | null> }>,
  yLabel: string,
  fmtY: (v: number) => string = fmtInt,
): ChartBuild {
  return (width, _theme, p: ChartPalette) => {
    const n = groups.length;
    const sN = Math.max(1, series.length);
    const xs = groups.map((_, i) => i);
    const compact = width < 560;
    const maxLabel = labelMaxFor(width);
    const labels = groups.map((g) => clipLabel(g, maxLabel));
    const opts: uPlot.Options = {
      width: 600,
      height: 220,
      legend: { show: series.length > 1, live: false },
      cursor: { points: { show: false }, y: false, drag: { x: false, y: false } },
      scales: {
        x: { time: false, range: [-0.6, Math.max(0.6, n - 0.4)] },
        y: { range: (_u, _min, max) => [0, (max || 1) * 1.12] },
      },
      axes: [
        {
          ...axisDefaults(p),
          size: compact ? 40 : 48,
          labelSize: 0,
          splits: () => xs,
          values: () => labels,
          grid: { show: false },
        },
        {
          ...axisDefaults(p, compact ? undefined : yLabel),
          size: compact ? 36 : 44,
          values: (_u, vals) => vals.map((v) => fmtY(v)),
        },
      ],
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          paths: () => null,
          points: { show: false },
        })),
      ],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            const dpr = devicePixelRatio || 1;
            ctx.save();
            ctx.beginPath();
            ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
            ctx.clip();
            const groupW = 0.78;
            const barW = groupW / sN;
            groups.forEach((_, i) => {
              series.forEach((s, j) => {
                const v = s.values[i];
                if (v == null || !Number.isFinite(v)) return;
                const cx = i - groupW / 2 + (j + 0.5) * barW;
                const x0 = u.valToPos(cx - barW * 0.42, 'x', true);
                const x1 = u.valToPos(cx + barW * 0.42, 'x', true);
                const y0 = u.valToPos(0, 'y', true);
                const y1 = u.valToPos(v, 'y', true);
                const w = Math.max(1, x1 - x0);
                const h = y0 - y1;
                if (h <= 0) return;
                ctx.fillStyle = s.color || p.chart1;
                roundBar(ctx, x0, y1, w, h, 2.5 * dpr);
              });
            });
            ctx.restore();
          },
        ],
      },
      plugins: [
        tooltipPlugin((u, idx) => {
          const lines = series.map((s, i) => {
            const v = u.data[i + 1]?.[idx];
            if (v == null) return null;
            return `<div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:6px"></span>${escapeHtml(s.label)}: <b>${fmtY(v)}</b></div>`;
          });
          if (lines.every((l) => l === null)) return null;
          return `<div style="opacity:.7;margin-bottom:2px">${escapeHtml(groups[idx] ?? '')}</div>${lines.filter(Boolean).join('')}`;
        }),
      ],
    };
    const data: uPlot.AlignedData = [xs, ...series.map((s) => s.values.map((v) => v ?? null))];
    return { opts, data };
  };
}

/** Equal-width histogram. Bin count follows plot width so labels stay readable. */
export function histogramChartBuild(
  values: number[],
  yLabel = 'runs',
  fmtX: (v: number) => string = fmtCompact,
): ChartBuild {
  return (width, theme, p) => {
    const nums = values.filter((v) => Number.isFinite(v));
    const bins = width < 520 ? 6 : 8;
    const items = histogramItems(nums, bins, fmtX);
    return barChartBuild(items, yLabel, fmtInt)(width, theme, p);
  };
}

export function histogramItems(
  values: number[],
  bins = 8,
  fmtX: (v: number) => string = fmtCompact,
): BarItem[] {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return [];
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min === max) return [{ label: fmtX(min), value: nums.length }];
  const n = Math.max(2, Math.min(bins, nums.length));
  const width = (max - min) / n;
  const counts = Array.from({ length: n }, () => 0);
  for (const v of nums) {
    const i = Math.min(n - 1, Math.floor((v - min) / width));
    counts[i]! += 1;
  }
  return counts.map((value, i) => ({
    label: fmtX(min + i * width),
    value,
  }));
}

export function countBy<T>(
  rows: T[],
  key: (r: T) => string,
  color?: (label: string) => string,
): BarItem[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([label, value]) => ({
      label,
      value,
      color: color?.(label),
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

export function chartCard(
  title: string,
  build: ChartBuild | null | undefined,
  opts: ChartCardOpts = {},
): TemplateResult | typeof nothing {
  if (!build) return nothing;
  return html`<section class="card chart-card">
    <div class="card-head">
      <h3>${title}</h3>
      ${opts.meta ? html`<span class="muted small">${opts.meta}</span>` : nothing}
    </div>
    <atlas-chart
      .build=${build}
      .height=${opts.height ?? 220}
      .key=${opts.key ?? title}
    ></atlas-chart>
    ${opts.note ? html`<p class="chart-note">${opts.note}</p>` : nothing}
  </section>`;
}

/** Hide a zero-only series so empty registries do not draw a blank axis. */
export function countsChart(
  title: string,
  items: BarItem[],
  opts: ChartCardOpts = {},
): TemplateResult | typeof nothing {
  const usable = items.filter((d) => Number.isFinite(d.value) && d.value > 0);
  if (usable.length === 0) return nothing;
  const fmt = opts.fmt ?? fmtInt;
  const yLabel = opts.yLabel ?? 'count';
  const dropped = items.length - Math.min(items.length, 12);
  return chartCard(title, barChartBuild(usable, yLabel, fmt), {
    ...opts,
    key: opts.key ?? `${title}:${usable.length}:${usable[0]?.value}`,
    note:
      opts.note ??
      (dropped > 0
        ? `Showing the ${Math.min(items.length, 12)} largest. ${dropped} more not plotted.`
        : undefined),
  });
}
