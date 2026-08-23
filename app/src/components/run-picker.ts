/** Searchable run picker (compare page, "Compare with…" on run detail). Emits `pick` with the run_id. */
import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { IndexRow } from '../data/types.js';
import { store } from '../store.js';
import { fuzzyScore } from '../util/filters.js';
import { headlineMetric } from '../util/metrics.js';
import { AtlasElement } from './base.js';
import { icon } from './icons.js';
import { kindTag } from './ui.js';

@customElement('atlas-run-picker')
export class AtlasRunPicker extends AtlasElement {
  @property({ attribute: false }) exclude: string[] = [];
  @property() placeholder = 'Search runs by engine, model, hardware, workload, contributor…';
  /** Optional: restrict to these run ids (e.g. same cell). */
  @property({ attribute: false }) only: string[] | null = null;
  @state() private q = '';
  @state() private open = false;
  @state() private sel = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('click', this.onDoc);
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('click', this.onDoc);
  }
  private onDoc = (e: Event) => {
    if (!this.contains(e.target as Node)) this.open = false;
  };

  private candidates(): IndexRow[] {
    const ex = new Set(this.exclude);
    const only = this.only ? new Set(this.only) : null;
    let rows = store.index.value.filter((r) => !ex.has(r.run_id) && (!only || only.has(r.run_id)));
    const q = this.q.trim();
    if (q) {
      rows = rows
        .map((r) => ({
          r,
          s: fuzzyScore(
            `${r.engine.id} ${r.engine.version} ${r.model.id} ${r.model.quant_id} ${r.hardware.id} ${r.workload_id} ${r.provenance.login} ${r.run_id}`,
            q,
          ),
        }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.r);
    }
    return rows.slice(0, 30);
  }

  private pick(r: IndexRow): void {
    this.open = false;
    this.q = '';
    this.dispatchEvent(new CustomEvent('pick', { detail: r.run_id, bubbles: true }));
  }

  override render() {
    const rows = this.open ? this.candidates() : [];
    const keyMetrics = store.site.coverage.key_metrics;
    return html`<div class="run-picker">
      <div class="search-input">
        ${icon('search')}
        <input
          class="input"
          type="search"
          placeholder=${this.placeholder}
          .value=${this.q}
          @focus=${() => (this.open = true)}
          @input=${(e: Event) => {
            this.q = (e.target as HTMLInputElement).value;
            this.open = true;
            this.sel = 0;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              this.sel = Math.min(rows.length - 1, this.sel + 1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              this.sel = Math.max(0, this.sel - 1);
            } else if (e.key === 'Enter' && rows[this.sel]) {
              e.preventDefault();
              this.pick(rows[this.sel]!);
            } else if (e.key === 'Escape') this.open = false;
          }}
        />
      </div>
      ${
        this.open
          ? html`<div class="results" role="listbox">
              ${rows.length === 0 ? html`<div class="opt muted">No runs match</div>` : nothing}
              ${rows.map((r, i) => {
                const hl = headlineMetric(r, keyMetrics);
                return html`<div
                  class="opt"
                  role="option"
                  aria-selected=${i === this.sel}
                  @mouseenter=${() => (this.sel = i)}
                  @click=${() => this.pick(r)}
                >
                  <span class="ellipsis"
                    >${r.engine.id} ${r.engine.version} · ${r.model.id}/${r.model.quant_id} ·
                    ${r.hardware.id}</span
                  >
                  <span>${hl ? `${hl.def.fmt(hl.value)} ${hl.def.unit}` : ''}</span>
                  <span class="sub row" style="gap:6px"
                    >${kindTag(r.kind)} ${r.workload_id} · ${r.provenance.login}</span
                  >
                </div>`;
              })}
            </div>`
          : nothing
      }
    </div>`;
  }
}
