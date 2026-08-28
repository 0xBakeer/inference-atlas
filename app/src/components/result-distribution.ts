import { html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { IndexRow } from '../data/types.js';
import { METRIC_BY_KEY, METRICS } from '../util/metrics.js';
import { AtlasElement } from './base.js';

const BINS = 12;

interface Bin {
  count: number;
  start: number;
  end: number;
}

/** Compact, honest distribution chart for a metric across a set of measured runs. */
@customElement('atlas-result-distribution')
export class AtlasResultDistribution extends AtlasElement {
  @property({ attribute: false }) rows: IndexRow[] = [];
  @property() metric = 'output_tok_s';

  override render() {
    const def = METRIC_BY_KEY[this.metric] ?? METRICS[0]!;
    const values = this.rows
      .map((row) => def.fromRow(row))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    if (!values.length) {
      return html`<p class="chart-empty">No measured ${def.label.toLowerCase()} values in this selection.</p>`;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const bins: Bin[] = Array.from({ length: BINS }, (_, index) => ({
      count: 0,
      start: min + (span * index) / BINS,
      end: min + (span * (index + 1)) / BINS,
    }));
    for (const value of values) {
      const index = Math.min(BINS - 1, Math.floor(((value - min) / span) * BINS));
      bins[index]!.count++;
    }
    const peak = Math.max(...bins.map((bin) => bin.count), 1);
    const format = (value: number) => `${def.fmt(value)}${def.unit ? ` ${def.unit}` : ''}`;

    return html`<div class="distribution" role="img" aria-label=${`${values.length} measured ${def.label} values, from ${format(min)} to ${format(max)}`}>
      <div class="distribution-scale" aria-hidden="true">
        <span>${format(min)}</span><span>${format(max)}</span>
      </div>
      <div class="distribution-bars">
        ${bins.map(
          (bin) => html`<span
            class="distribution-bar"
            style=${`height:${Math.max(4, (bin.count / peak) * 100)}%`}
            title=${`${format(bin.start)}–${format(bin.end)}: ${bin.count} run${bin.count === 1 ? '' : 's'}`}
          ><i></i></span>`,
        )}
      </div>
      <div class="distribution-caption">
        <span>${values.length} measured runs</span>
        <span>distribution, not a performance ranking</span>
      </div>
    </div>`;
  }
}
