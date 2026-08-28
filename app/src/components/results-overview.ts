import { html, nothing, svg, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { IndexRow } from '../data/types.js';
import { fmtInt } from '../util/format.js';
import { AtlasElement } from './base.js';

interface Bucket {
  label: string;
  value: number;
}

export function countBy(rows: IndexRow[], value: (row: IndexRow) => string, limit = 5): Bucket[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = value(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([label, count]) => ({ label, value: count }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function activityBuckets(rows: IndexRow[], count = 12): Bucket[] {
  const dated = rows
    .map((row) => row.provenance.submitted_at ?? row.provenance.started_at)
    .filter((value): value is string => !!value)
    .map((value) => new Date(value))
    .filter((value) => Number.isFinite(value.getTime()));
  if (!dated.length) return [];

  const latest = new Date(Math.max(...dated.map((date) => date.getTime())));
  latest.setUTCHours(0, 0, 0, 0);
  const first = new Date(Math.min(...dated.map((date) => date.getTime())));
  const spanDays = Math.max(1, Math.ceil((latest.getTime() - first.getTime()) / 86_400_000));
  const stepDays = spanDays > 365 ? 30 : spanDays > 90 ? 14 : spanDays > 24 ? 7 : 1;
  const bins = Math.min(count, Math.ceil(spanDays / stepDays) + 1);
  const start = new Date(latest);
  start.setUTCDate(start.getUTCDate() - (bins - 1) * stepDays);

  const values = Array.from({ length: bins }, () => 0);
  for (const date of dated) {
    const index = Math.floor((date.getTime() - start.getTime()) / (stepDays * 86_400_000));
    if (index >= 0 && index < bins) values[index]!++;
  }
  const fmt = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: stepDays < 30 ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
  return values.map((value, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index * stepDays);
    return { label: fmt.format(date), value };
  });
}

function bars(items: Bucket[], title: string): TemplateResult {
  const max = Math.max(1, ...items.map((item) => item.value));
  return html`<div class="overview-panel">
    <div class="overview-label">${title}</div>
    <div class="overview-bars">
      ${items.map(
        (item) =>
          html`<div class="overview-bar">
            <span class="overview-name" title=${item.label}>${item.label}</span>
            <i class="overview-track"
              ><i style=${`width:${Math.max(3, (item.value / max) * 100)}%`}></i
            ></i>
            <span class="overview-value">${fmtInt(item.value)}</span>
          </div>`,
      )}
    </div>
  </div>`;
}

function activity(items: Bucket[]): TemplateResult {
  const max = Math.max(1, ...items.map((item) => item.value));
  const width = 480;
  const height = 112;
  const gap = 5;
  const barWidth = Math.max(6, (width - gap * (items.length - 1)) / Math.max(1, items.length));
  return html`<div class="overview-panel activity-panel">
    <div class="overview-label">Run activity</div>
    <svg
      class="activity-chart"
      viewBox=${`0 0 ${width} ${height}`}
      role="img"
      aria-label="Runs over time"
      preserveAspectRatio="none"
    >
      ${items.map((item, index) => {
        const barHeight = item.value ? Math.max(3, (item.value / max) * 78) : 1;
        const x = index * (barWidth + gap);
        return svg`<g>
          <rect class="activity-bar" x=${x} y=${82 - barHeight} width=${barWidth} height=${barHeight} rx="2">
            <title>${item.label}: ${item.value} run${item.value === 1 ? '' : 's'}</title>
          </rect>
          ${
            index === 0 || index === items.length - 1
              ? svg`<text class="activity-tick" x=${index === 0 ? x : x + barWidth} y="105" text-anchor=${index === 0 ? 'start' : 'end'}>${item.label}</text>`
              : nothing
          }
        </g>`;
      })}
    </svg>
  </div>`;
}

@customElement('atlas-results-overview')
export class AtlasResultsOverview extends AtlasElement {
  @property({ attribute: false }) rows: IndexRow[] = [];
  @property() group: 'kind' | 'engine' | 'model' | 'hardware' | 'workload' = 'kind';
  @property() heading = 'Results overview';

  override render() {
    if (!this.rows.length) return nothing;
    const accessors = {
      kind: (row: IndexRow) => row.kind,
      engine: (row: IndexRow) => row.engine.id,
      model: (row: IndexRow) => row.model.id,
      hardware: (row: IndexRow) => row.hardware.id,
      workload: (row: IndexRow) => row.workload_id,
    };
    const labels = {
      kind: 'Run types',
      engine: 'Top engines',
      model: 'Top models',
      hardware: 'Top hardware',
      workload: 'Top workloads',
    };
    const groups = countBy(this.rows, accessors[this.group]);
    const timeline = activityBuckets(this.rows);
    const cells = new Set(this.rows.map((row) => row.cell_id)).size;
    const contributors = new Set(this.rows.map((row) => row.provenance.login)).size;

    return html`<section class="results-overview" aria-label=${this.heading}>
      <div class="overview-head">
        <div>
          <div class="eyebrow plain">${this.heading}</div>
          <p class="xs muted">A visual summary of the runs currently in view.</p>
        </div>
        <div class="overview-facts" aria-label="Summary totals">
          <span><b>${fmtInt(this.rows.length)}</b> runs</span>
          <span><b>${fmtInt(cells)}</b> cells</span>
          <span><b>${fmtInt(contributors)}</b> contributors</span>
        </div>
      </div>
      <div class="overview-grid">
        ${timeline.length ? activity(timeline) : nothing} ${bars(groups, labels[this.group])}
      </div>
    </section>`;
  }
}
