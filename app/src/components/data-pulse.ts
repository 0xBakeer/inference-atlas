import { html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { watch } from '../signal.js';
import { store } from '../store.js';
import { fmtInt } from '../util/format.js';
import { AtlasElement } from './base.js';

/** A small site-wide chart that keeps the data footprint visible on every route. */
@customElement('atlas-data-pulse')
export class AtlasDataPulse extends AtlasElement {
  constructor() {
    super();
    watch(this, store.index);
  }

  override render() {
    const groups = [...store.index.value.reduce((counts, row) => {
      counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
    if (!groups.length) return html``;
    const max = Math.max(...groups.map(([, count]) => count));
    return html`<section class="data-pulse" aria-label="Measured runs by workload type">
      <div class="data-pulse-head">
        <span class="eyebrow plain">Atlas pulse</span>
        <span>${fmtInt(store.index.value.length)} measured runs</span>
      </div>
      <div class="data-pulse-bars">
        ${groups.map(
          ([kind, count]) => html`<div class="data-pulse-bar" title=${`${kind}: ${count} runs`}>
            <span class="label">${kind}</span>
            <span class="track"><i style=${`width:${(count / max) * 100}%`}></i></span>
            <span class="count">${fmtInt(count)}</span>
          </div>`,
        )}
      </div>
    </section>`;
  }
}
