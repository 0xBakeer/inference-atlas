/**
 * The coverage heatmap — the primary view of the atlas. Colour = evidence level, inner square
 * size = share of the square's possible cells that have been measured, number = runs.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import type { HeatCell, HeatMatrix } from '../data/derive.js';
import { heatKey } from '../data/derive.js';
import { fmtInt, fmtPct } from '../util/format.js';
import { METRIC_BY_KEY } from '../util/metrics.js';
import { AtlasElement } from './base.js';
import { hideTip, showTip } from './ui.js';

export type HeatCellSelect = CustomEvent<{ cell: HeatCell }>;

@customElement('atlas-heatmap')
export class AtlasHeatmap extends AtlasElement {
  @property({ attribute: false }) matrix: HeatMatrix | null = null;
  @property({ attribute: false }) rows: string[] = [];
  @property({ attribute: false }) cols: string[] = [];
  @property({ attribute: false }) rowLabel: (id: string) => string = (s) => s;
  @property({ attribute: false }) colLabel: (id: string) => string = (s) => s;
  @property({ attribute: false }) rowSub: ((id: string) => string | null) | null = null;
  @property({ attribute: false }) colSub: ((id: string) => string | null) | null = null;
  /** Optional marker under each column header, e.g. the vendor dot for hardware. */
  @property({ attribute: false }) colDot: ((id: string) => TemplateResult | typeof nothing) | null =
    null;
  @property({ attribute: false }) selectedKey: string | null = null;
  @property({ type: Boolean }) compact = false;
  @state() private width = 0;
  private ro: ResizeObserver | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        const w = this.clientWidth;
        if (w && Math.abs(w - this.width) > 4) this.width = w;
      });
      this.ro.observe(this);
    }
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.ro?.disconnect();
  }

  private select(cell: HeatCell): void {
    this.dispatchEvent(
      new CustomEvent('cell-select', { detail: { cell }, bubbles: true }) as HeatCellSelect,
    );
  }

  private tip(e: MouseEvent, cell: HeatCell): void {
    const best = cell.best && cell.bestMetric ? METRIC_BY_KEY[cell.bestMetric] : null;
    showTip(
      e.clientX,
      e.clientY,
      html`<div class="t-title">
          ${this.rowLabel(cell.row)} <span style="opacity:.6">×</span> ${this.colLabel(cell.col)}
        </div>
        <div class="t-row"><span>evidence</span><span>${cell.level}</span></div>
        <div class="t-row"><span>runs</span><span>${fmtInt(cell.runs)}</span></div>
        <div class="t-row">
          <span>cells measured</span><span>${cell.covered} / ${cell.possible}</span>
        </div>
        ${
          best && cell.bestValue !== null
            ? html`<div class="t-row">
                <span>best ${best.short}</span><span>${best.fmt(cell.bestValue)} ${best.unit}</span>
              </div>`
            : nothing
        }
        ${cell.logins.size ? html`<div class="t-row"><span>by</span><span>${[...cell.logins].slice(0, 3).join(', ')}</span></div>` : nothing}
        ${cell.runs === 0 ? html`<div class="t-row" style="margin-top:3px;opacity:.8"><span>nobody has measured this — click to add</span></div>` : nothing}`,
    );
  }

  private cellTemplate(row: string, col: string): TemplateResult {
    const m = this.matrix!;
    const cell = m.cells.get(heatKey(row, col));
    if (!cell)
      return html`<div class="hm-cell impossible" title="Not a possible combination"></div>`;
    const frac = cell.possible > 0 ? cell.covered / cell.possible : 0;
    const selected = this.selectedKey === heatKey(row, col);
    return html`<button
      type="button"
      class="hm-cell level-${cell.level} ${selected ? 'selected' : ''} ${cell.runs ? 'has-runs' : ''}"
      style=${styleMap({ '--f': String(Math.max(0.3, Math.sqrt(frac))) })}
      aria-label=${`${this.rowLabel(row)} × ${this.colLabel(col)}: ${cell.runs} runs, ${cell.level}`}
      @click=${() => this.select(cell)}
      @mouseenter=${(e: MouseEvent) => this.tip(e, cell)}
      @mousemove=${(e: MouseEvent) => this.tip(e, cell)}
      @mouseleave=${hideTip}
      @focus=${(e: FocusEvent) => {
        const r = (e.target as HTMLElement).getBoundingClientRect();
        this.tip({ clientX: r.right, clientY: r.top } as MouseEvent, cell);
      }}
      @blur=${hideTip}
    >
      <i class="fill"></i>
      ${cell.runs ? html`<span class="n">${cell.runs}</span>` : nothing}
    </button>`;
  }

  override render() {
    const m = this.matrix;
    if (!m) return nothing;
    const rows = this.rows.length ? this.rows : m.rows;
    const cols = this.cols.length ? this.cols : m.cols;
    // fill the available width, but keep squares between 20 and 40 px
    const narrow = (this.width || 900) < 720;
    const labelW = narrow ? 124 : this.compact ? 140 : 190;
    const covW = narrow ? 44 : this.compact ? 52 : 64;
    const avail = Math.max(0, (this.width || 900) - labelW - covW - 26 - cols.length * 2);
    const cellSize = Math.max(
      narrow ? 24 : this.compact ? 18 : 20,
      Math.min(this.compact ? 28 : 40, Math.floor(avail / Math.max(1, cols.length))),
    );
    return html`<div
      class="hm ${this.compact ? 'compact' : ''}"
      style=${styleMap({ '--hm-cell': `${cellSize}px` })}
    >
      <div class="hm-scroll">
        <div
          class="hm-grid"
          style=${styleMap({
            gridTemplateColumns: `var(--hm-label-w) repeat(${cols.length}, var(--hm-cell)) var(--hm-cov-w)`,
            gridTemplateRows: `var(--hm-head-h) repeat(${rows.length}, var(--hm-cell)) 48px`,
          })}
        >
          <div class="hm-corner"></div>
          ${cols.map(
            (c) =>
              html`<div class="hm-colhead" title=${this.colLabel(c)}>
                <span class="t">${this.colLabel(c)}</span>
                ${this.colDot ? this.colDot(c) : nothing}
              </div>`,
          )}
          <div class="hm-corner"></div>
          ${rows.map((r) => {
            const cov = m.rowCoverage.get(r) ?? { covered: 0, possible: 0 };
            const pct = cov.possible ? cov.covered / cov.possible : 0;
            const sub = this.rowSub?.(r);
            return html`<div class="hm-rowhead" title=${this.rowLabel(r)}>
                <span class="t ellipsis">${this.rowLabel(r)}</span>
                ${sub ? html`<span class="s ellipsis">${sub}</span>` : nothing}
              </div>
              ${cols.map((c) => this.cellTemplate(r, c))}
              <div
                class="hm-rowcov"
                title=${`${cov.covered} of ${cov.possible} possible cells measured`}
              >
                <span class="pct">${fmtPct(pct, 0)}</span>
                <i class="bar"><i style="width:${pct * 100}%"></i></i>
              </div>`;
          })}
          <div class="hm-corner hm-foot-label"><span>covered</span></div>
          ${cols.map((c) => {
            const cov = m.colCoverage.get(c) ?? { covered: 0, possible: 0 };
            const pct = cov.possible ? cov.covered / cov.possible : 0;
            return html`<div
              class="hm-colcov"
              title=${`${cov.covered} of ${cov.possible} possible cells measured`}
            >
              <i class="bar"><i style="height:${pct * 100}%"></i></i>
              <span class="pct">${pct === 0 ? '·' : fmtPct(pct, 0)}</span>
            </div>`;
          })}
          <div class="hm-corner"></div>
        </div>
      </div>
    </div>`;
  }
}
