/**
 * Shared statistical chart builders used across list, registry and community pages.
 *
 * Two families:
 *  - `barList` — an HTML horizontal bar chart. Long entity labels (model repo ids,
 *    device names) read far better horizontally, and plain markup reflows on any
 *    viewport without canvas resize logic.
 *  - uPlot builders (`activityBuild`, `histogramBuild`) for time series and
 *    distributions, matching the existing sweep/timeline chart styling.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';
import type uPlot from 'uplot';
import type { IndexRow } from '../data/types.js';
import { fmtInt, isNum } from '../util/format.js';
import { METRIC_BY_KEY, type MetricDef } from '../util/metrics.js';
import { axisDefaults, tooltipPlugin, type ChartBuild } from './chart.js';

/* ------------------------------------------------------------------ bar list */

export interface BarItem {
  label: string | TemplateResult;
  /** Plain-text title for the row (tooltips + a11y); required when label is a template. */
  title?: string;
  value: number | null;
  /** Formatted value shown at the end of the row. */
  text: string;
  /** CSS colour (a `var(--…)` reference or resolved colour). Defaults to chart-1. */
  color?: string;
  href?: string;
  /** Optional 0..1 fraction override (e.g. measured ÷ ceiling); defaults to value ÷ max. */
  frac?: number | null;
  /** Small annotation after the value (e.g. "82% of ceiling"). */
  note?: string;
}

/**
 * Horizontal bar chart. Bars scale to the max value (or an explicit `max`).
 * Rows with `href` navigate; every row carries its full text as a title.
 */
export function barList(items: BarItem[], opts: { max?: number; ariaLabel?: string } = {}) {
  const nums = items.map((i) => i.value).filter(isNum);
  if (!items.length || !nums.length) return nothing;
  const max = opts.max ?? Math.max(...nums, 1e-9);
  const row = (it: BarItem) => {
    const frac = it.frac ?? (isNum(it.value) ? it.value / max : 0);
    const w = Math.max(0, Math.min(1, frac)) * 100;
    const body = html`<span class="bl-label ellipsis"
        title=${it.title ?? (typeof it.label === 'string' ? it.label : '')}
        >${it.label}</span
      >
      <span class="bl-track"
        ><span
          class="bl-fill"
          style=${styleMap({ width: `${w}%`, background: it.color ?? 'var(--chart-1)' })}
        ></span
      ></span>
      <span class="bl-val mono"
        >${it.text}${it.note ? html` <span class="bl-note">${it.note}</span>` : nothing}</span
      >`;
    return it.href
      ? html`<a class="bl-row" href=${it.href}>${body}</a>`
      : html`<div class="bl-row">${body}</div>`;
  };
  return html`<div class="bar-chart" role="img" aria-label=${opts.ariaLabel ?? 'bar chart'}>
    ${items.map(row)}
  </div>`;
}

/* ------------------------------------------------------------------ activity over time */

export interface ActivityOpts {
  /** Series label on the y axis. */
  label?: string;
  /** Also draw the running total on a second scale. */
  cumulative?: boolean;
}

interface Bucket {
  t: number;
  count: number;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;
const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** Bucket ISO dates per week (per month when the span exceeds ~9 months). */
function bucketDates(dates: Array<string | null | undefined>): {
  buckets: Bucket[];
  monthly: boolean;
} {
  const ts = dates
    .map((d) => (d ? Date.parse(d) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (!ts.length) return { buckets: [], monthly: false };
  const span = ts[ts.length - 1]! - ts[0]!;
  const monthly = span > 270 * 24 * 3600 * 1000;
  const keyOf = (t: number) => {
    const d = new Date(t);
    if (monthly) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    // snap to the Monday of that week
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = (day.getUTCDay() + 6) % 7;
    return day.getTime() - dow * 24 * 3600 * 1000;
  };
  const map = new Map<number, number>();
  for (const t of ts) map.set(keyOf(t), (map.get(keyOf(t)) ?? 0) + 1);
  // fill empty buckets so the line does not lie about continuity
  const keys = [...map.keys()].sort((a, b) => a - b);
  const buckets: Bucket[] = [];
  let k = keys[0]!;
  const last = keys[keys.length - 1]!;
  let guard = 0;
  while (k <= last && guard++ < 2000) {
    buckets.push({ t: k, count: map.get(k) ?? 0 });
    if (monthly) {
      const d = new Date(k);
      k = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    } else {
      k += WEEK_MS;
    }
  }
  return { buckets, monthly };
}

/**
 * Submissions over time: bars per week/month, with an optional cumulative line.
 * Returns null when there are fewer than two buckets to draw.
 */
export function activityBuild(
  dates: Array<string | null | undefined>,
  opts: ActivityOpts = {},
): ChartBuild | null {
  const { buckets, monthly } = bucketDates(dates);
  if (buckets.length < 2) return null;
  const label = opts.label ?? 'runs';
  return (_w, _theme, p) => {
    const xs = buckets.map((b) => b.t / 1000);
    const counts = buckets.map((b) => b.count);
    let total = 0;
    const cum = counts.map((c) => (total += c));
    const data: uPlot.AlignedData = [
      xs,
      counts,
      ...(opts.cumulative ? [cum] : []),
    ] as uPlot.AlignedData;
    const fmtDate = (t: number) => (monthly ? monthFmt : dayFmt).format(new Date(t * 1000));
    const uopts: uPlot.Options = {
      width: 600,
      height: 200,
      legend: { show: false },
      cursor: { points: { size: 7 } },
      scales: {
        x: { time: false },
        y: { range: (_u, _min, max) => [0, Math.max(1, max) * 1.15] },
        ...(opts.cumulative ? { c: { range: (_u, _min, max) => [0, Math.max(1, max) * 1.1] } } : {}),
      },
      axes: [
        { ...axisDefaults(p), values: (_u, vals) => vals.map((v) => fmtDate(v)) },
        {
          ...axisDefaults(p, label),
          size: 40,
          incrs: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
          values: (_u, vals) => vals.map((v) => fmtInt(v)),
        },
        ...(opts.cumulative
          ? [
              {
                ...axisDefaults(p, 'total'),
                scale: 'c',
                side: 1 as const,
                size: 44,
                grid: { show: false },
                values: (_u: uPlot, vals: number[]) => vals.map((v) => fmtInt(v)),
              },
            ]
          : []),
      ],
      series: [
        {},
        {
          label,
          stroke: p.chart1,
          fill: p.chart1Soft,
          width: 0,
          paths: barsPath(0.6),
          points: { show: false },
        },
        ...(opts.cumulative
          ? [
              {
                label: 'total',
                scale: 'c',
                stroke: p.chart2,
                width: 2,
                points: { show: false },
                spanGaps: true,
              },
            ]
          : []),
      ],
      plugins: [
        tooltipPlugin((u, idx) => {
          const t = u.data[0][idx]!;
          const c = u.data[1]?.[idx];
          const tot = opts.cumulative ? u.data[2]?.[idx] : null;
          if (c == null) return null;
          return `<div style="opacity:.7;margin-bottom:2px">${monthly ? '' : 'week of '}${fmtDate(t)}</div><div>${fmtInt(c)} ${label}${tot != null ? ` · ${fmtInt(tot)} total` : ''}</div>`;
        }),
      ],
    };
    return { opts: uopts, data };
  };
}

/* ------------------------------------------------------------------ histogram */

export interface HistogramOpts {
  label?: string;
  fmt?: (v: number) => string;
  bins?: number;
}

/** Distribution of a metric across runs. Returns null when < 3 finite values. */
export function histogramBuild(values: number[], opts: HistogramOpts = {}): ChartBuild | null {
  const vals = values.filter(isNum);
  if (vals.length < 3) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const nBins = Math.max(4, Math.min(opts.bins ?? Math.ceil(Math.sqrt(vals.length) * 1.5), 24));
  const span = max - min || 1;
  const step = span / nBins;
  const counts = new Array<number>(nBins).fill(0);
  for (const v of vals) counts[Math.min(nBins - 1, Math.floor((v - min) / step))]!++;
  const centers = counts.map((_c, i) => min + step * (i + 0.5));
  const fmt = opts.fmt ?? ((v: number) => String(Math.round(v)));
  return (_w, _theme, p) => {
    const uopts: uPlot.Options = {
      width: 600,
      height: 200,
      legend: { show: false },
      cursor: { points: { size: 7 } },
      scales: {
        x: { time: false, range: [min - step / 2, max + step / 2] },
        y: { range: (_u, _min, m) => [0, Math.max(1, m) * 1.15] },
      },
      axes: [
        { ...axisDefaults(p, opts.label), values: (_u, vs) => vs.map((v) => fmt(v)) },
        {
          ...axisDefaults(p, 'runs'),
          size: 40,
          incrs: [1, 2, 5, 10, 20, 50, 100, 200],
          values: (_u, vs) => vs.map((v) => fmtInt(v)),
        },
      ],
      series: [
        {},
        {
          label: 'runs',
          stroke: p.chart1,
          fill: p.chart1Soft,
          width: 0,
          paths: barsPath(0.85),
          points: { show: false },
        },
      ],
      plugins: [
        tooltipPlugin((u, idx) => {
          const c = u.data[1]?.[idx];
          const x = u.data[0][idx]!;
          if (c == null) return null;
          return `<div style="opacity:.7;margin-bottom:2px">≈ ${fmt(x)}</div><div>${fmtInt(c)} run${c === 1 ? '' : 's'}</div>`;
        }),
      ],
    };
    return { opts: uopts, data: [centers, counts] as uPlot.AlignedData };
  };
}

/* ------------------------------------------------------------------ aggregation */

const PREFERRED_METRICS = [
  'decode_tok_s_per_request',
  'output_tok_s',
  'ttft_p50',
  'accuracy',
  'vram_peak_gb',
];

/** First metric (in preference order) that at least one of the rows actually measured. */
export function firstMetricWithData(
  rows: IndexRow[],
  preferred: string[] = PREFERRED_METRICS,
): MetricDef | null {
  for (const key of preferred) {
    const def = METRIC_BY_KEY[key];
    if (def && rows.some((r) => def.fromRow(r) !== null)) return def;
  }
  return null;
}

export interface GroupBest {
  id: string;
  row: IndexRow;
  value: number;
  count: number;
}

/** Best value of `metric` per group, sorted best-first along the metric's direction. */
export function bestPerGroup(
  rows: IndexRow[],
  key: (r: IndexRow) => string,
  metric: MetricDef,
): GroupBest[] {
  const map = new Map<string, GroupBest>();
  for (const r of rows) {
    const v = metric.fromRow(r);
    if (v === null) continue;
    const id = key(r);
    const cur = map.get(id);
    if (!cur) map.set(id, { id, row: r, value: v, count: 1 });
    else {
      cur.count++;
      const better = metric.better === 'higher' ? v > cur.value : v < cur.value;
      if (better) {
        cur.value = v;
        cur.row = r;
      }
    }
  }
  return [...map.values()].sort((a, b) =>
    metric.better === 'higher' ? b.value - a.value : a.value - b.value,
  );
}

/** Row count per group, sorted descending. */
export function countPerGroup(
  rows: IndexRow[],
  key: (r: IndexRow) => string,
): Array<{ id: string; count: number }> {
  const map = new Map<string, number>();
  for (const r of rows) map.set(key(r), (map.get(key(r)) ?? 0) + 1);
  return [...map.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ shared bits */

/** uPlot bar renderer; loaded lazily because `uPlot.paths.bars` lives on the constructor. */
function barsPath(size: number): uPlot.Series.PathBuilder {
  return (u, seriesIdx, idx0, idx1) => {
    const ctor = u.constructor as unknown as {
      paths: { bars: (o?: { size?: [number, number] }) => uPlot.Series.PathBuilder };
    };
    return ctor.paths.bars({ size: [size, 100] })(u, seriesIdx, idx0, idx1);
  };
}

/** A titled chart section used by list/detail pages. */
export function chartCard(
  title: string,
  meta: string | TemplateResult,
  body: unknown,
): TemplateResult {
  return html`<section class="card chart-card">
    <div class="card-head">
      <h3>${title}</h3>
      <span class="muted small">${meta}</span>
    </div>
    ${body}
  </section>`;
}
