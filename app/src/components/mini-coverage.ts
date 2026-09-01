/** A compact coverage heatmap for registry detail pages, with the same drill-down drawer. */
import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  buildHeatMatrix,
  heatKey,
  type AxisKey,
  type HeatCell,
  type HeatFilters,
} from '../data/derive.js';
import { watch } from '../signal.js';
import { store } from '../store.js';
import { fmtPct } from '@atlas/core';
import { AtlasElement } from './base.js';
import './cell-drawer.js';
import './heatmap.js';
import type { HeatCellSelect } from './heatmap.js';
import { emptyState, vendorDot } from './ui.js';

@customElement('atlas-mini-coverage')
export class AtlasMiniCoverage extends AtlasElement {
  @property({ attribute: false }) rowKey: AxisKey = 'model';
  @property({ attribute: false }) colKey: AxisKey = 'hardware';
  @property({ attribute: false }) filters: HeatFilters = {};
  @state() private selected: HeatCell | null = null;

  constructor() {
    super();
    watch(this, store.registry, store.index, store.coverage);
  }

  private label(key: AxisKey): (id: string) => string {
    const lk = store.lookups;
    if (key === 'hardware')
      return (id) => {
        const h = lk.hardware.get(id);
        return h ? h.name.replace(new RegExp(`^${h.vendor}\\s+`, 'i'), '') : id;
      };
    if (key === 'model') return (id) => lk.models.get(id)?.model.name ?? id;
    if (key === 'engine') return (id) => lk.engines.get(id)?.meta.name ?? id;
    return (id) => id;
  }

  override render() {
    const reg = store.registry.value;
    if (!reg) return nothing;
    const m = buildHeatMatrix(
      reg,
      store.lookups,
      store.possible,
      store.coverage.value,
      store.index.value,
      this.rowKey,
      this.colKey,
      this.filters,
      store.site.coverage.key_metrics,
    );
    if (!m.rows.length)
      return emptyState({
        compact: true,
        title: 'No possible cells',
        text: 'No engine in the registry can run this combination.',
      });
    const rowLabel = this.label(this.rowKey);
    const colLabel = this.label(this.colKey);
    const sortBy = (ids: string[], cov: Map<string, { covered: number; possible: number }>) =>
      [...ids].sort(
        (a, b) =>
          (cov.get(b)?.covered ?? 0) / Math.max(1, cov.get(b)?.possible ?? 1) -
            (cov.get(a)?.covered ?? 0) / Math.max(1, cov.get(a)?.possible ?? 1) ||
          a.localeCompare(b),
      );
    const colDot =
      this.colKey === 'hardware'
        ? (id: string) => vendorDot(store.lookups.hardware.get(id)?.vendor)
        : null;
    return html`<atlas-heatmap
        compact
        .matrix=${m}
        .rows=${sortBy(m.rows, m.rowCoverage)}
        .cols=${sortBy(m.cols, m.colCoverage)}
        .rowLabel=${rowLabel}
        .colLabel=${colLabel}
        .colDot=${colDot}
        .selectedKey=${this.selected ? heatKey(this.selected.row, this.selected.col) : null}
        @cell-select=${(e: HeatCellSelect) => (this.selected = e.detail.cell)}
      ></atlas-heatmap>
      <div class="xs muted mt-2">
        ${m.totalCovered} of ${m.totalPossible} possible cells measured
        (${fmtPct(m.totalCovered / Math.max(1, m.totalPossible), 1)}) — click a square to see runs
        or add one.
      </div>
      ${this.selected ? html`<atlas-cell-drawer .cell=${this.selected} .rowLabel=${rowLabel} .colLabel=${colLabel} @close=${() => (this.selected = null)}></atlas-cell-drawer>` : nothing}`;
  }
}
