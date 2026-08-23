/** Drill-down for one heatmap square: its runs by workload, and Add buttons for what is missing. */
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { HeatCell, PossibleCell } from '../data/derive.js';
import type { IndexRow } from '../data/types.js';
import { href } from '../router.js';
import { store } from '../store.js';
import { fmtInt } from '../util/format.js';
import { headlineMetric } from '../util/metrics.js';
import { addButton } from './add-modal.js';
import { AtlasElement } from './base.js';
import { icon } from './icons.js';
import { avatar, evBadge, kindTag, verifBadge, when } from './ui.js';

@customElement('atlas-cell-drawer')
export class AtlasCellDrawer extends AtlasElement {
  @property({ attribute: false }) cell: HeatCell | null = null;
  @property({ attribute: false }) rowLabel: (id: string) => string = (s) => s;
  @property({ attribute: false }) colLabel: (id: string) => string = (s) => s;
  @state() private showAllMissing = false;

  private close(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true }));
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.close();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKey);
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKey);
  }

  private runRow(r: IndexRow): TemplateResult {
    const hl = headlineMetric(r, store.site.coverage.key_metrics);
    return html`<a class="cell-run" href=${href('run', r.run_id)}>
      <span class="row" style="gap:6px;min-width:0">
        <span class="mono xs ellipsis">${r.workload_id}</span>
        ${kindTag(r.kind)}
      </span>
      <span class="hl"
        >${hl ? html`${hl.def.fmt(hl.value)}<span class="unit">${hl.def.unit}</span>` : html`<span class="faint">–</span>`}</span
      >
      <span class="meta">
        ${avatar(r.provenance.login, { userId: r.provenance.user_id, avatarUrl: r.provenance.avatar_url, size: 'sm' })}
        ${r.provenance.login} · ${when(r.provenance.submitted_at ?? r.provenance.started_at)} ·
        ${verifBadge(r.verification_level)} ${hl ? html`· ${hl.def.label}` : nothing}
      </span>
    </a>`;
  }

  private specFor(pc: PossibleCell, workloadIds?: string[]) {
    return {
      engine_id: pc.engine_id,
      engine_version: pc.engine_version,
      model_id: pc.model_id,
      quant_id: pc.quant_id,
      hardware_id: pc.hardware_id,
      hw_count: pc.hw_count,
      workload_ids: workloadIds ?? [],
    };
  }

  private pcLabel(pc: PossibleCell): TemplateResult {
    return html`<span class="mono xs">${pc.engine_id} ${pc.engine_minor}</span>
      <span class="faint">·</span> <span class="mono xs">${pc.model_id}/${pc.quant_id}</span>
      <span class="faint">·</span> <span class="mono xs">${pc.hardware_id}</span>`;
  }

  override render() {
    const cell = this.cell;
    if (!cell) return nothing;
    const reg = store.registry.value;
    if (!reg) return nothing;
    const index = store.index.value;
    const covered = cell.possibleCells.filter((pc) =>
      cell.cells.some((c) => c.cell_id === pc.cell_id),
    );
    const missing = cell.possibleCells.filter(
      (pc) => !cell.cells.some((c) => c.cell_id === pc.cell_id),
    );
    const shownMissing = this.showAllMissing ? missing : missing.slice(0, 8);
    const allWorkloads = reg.workloads;

    return html`<div class="backdrop" @click=${() => this.close()}></div>
      <aside class="drawer cell-drawer" role="dialog" aria-label="Cell details">
        <div class="drawer-head">
          <div class="grow">
            <div class="eyebrow plain">
              ${evBadge(cell.level)} · ${fmtInt(cell.runs)} run${cell.runs === 1 ? '' : 's'} ·
              ${cell.covered}/${cell.possible} cells
            </div>
            <h2 class="mt-1">
              ${this.rowLabel(cell.row)} <span class="muted">×</span> ${this.colLabel(cell.col)}
            </h2>
          </div>
          <button
            class="btn btn-ghost btn-icon"
            type="button"
            aria-label="Close"
            @click=${() => this.close()}
          >
            ${icon('x')}
          </button>
        </div>
        <div class="drawer-body stack">
          ${
            covered.length
              ? html`<section>
                  <div class="section-title">
                    <h2>Measured</h2>
                    <span class="meta"
                      >${covered.length} cell${covered.length === 1 ? '' : 's'}</span
                    >
                  </div>
                  <div class="col" style="gap:14px">
                    ${covered.map((pc) => {
                      const cov = cell.cells.find((c) => c.cell_id === pc.cell_id)!;
                      const runs = index.filter((r) => r.cell_id === pc.cell_id);
                      const have = new Set(cov.workloads);
                      const missingW = allWorkloads.filter((w) => !have.has(w.id));
                      return html`<div class="col" style="gap:6px">
                        <div class="row-wrap" style="justify-content:space-between">
                          <span class="row" style="gap:6px"
                            >${evBadge(cov.level, '')} ${this.pcLabel(pc)}</span
                          >
                          <a
                            class="btn btn-xs"
                            href=${`#/explore?engine=${pc.engine_id}&version=${pc.engine_version}&model=${pc.model_id}&quant=${pc.quant_id}&hardware=${pc.hardware_id}`}
                            >Explore ${icon('arrowRight')}</a
                          >
                        </div>
                        ${runs.map((r) => this.runRow(r))}
                        ${
                        missingW.length
                          ? html`<div class="row-wrap" style="gap:4px">
                              <span class="xs muted">Missing:</span>
                              ${missingW.slice(0, 6).map((w) =>
                                addButton(this.specFor(pc, [w.id]), {
                                  label: w.id,
                                  size: 'xs',
                                  title: `Add ${w.name}`,
                                }),
                              )}
                              ${
                                missingW.length > 6
                                  ? addButton(
                                      this.specFor(
                                        pc,
                                        missingW.map((w) => w.id),
                                      ),
                                      { label: `all ${missingW.length}`, size: 'xs' },
                                    )
                                  : nothing
                              }
                            </div>`
                          : nothing
                      }
                      </div>`;
                    })}
                  </div>
                </section>`
              : nothing
          }
          ${
            missing.length
              ? html`<section>
                  <div class="section-title">
                    <h2>${covered.length ? 'Not yet measured' : 'Nobody has measured this yet'}</h2>
                    <span class="meta"
                      >${missing.length} cell${missing.length === 1 ? '' : 's'}</span
                    >
                  </div>
                  ${covered.length ? nothing : html`<p class="small muted mb-3">Every row below is a twenty-minute job for somebody with the hardware. Pick one and the packet tells an agent exactly what to run.</p>`}
                  <div class="missing-list">
                    ${shownMissing.map(
                      (pc) =>
                        html`<div class="missing-row">
                          <span class="grow ellipsis">${this.pcLabel(pc)}</span>
                          ${addButton(this.specFor(pc), { label: 'Add', size: 'sm' })}
                        </div>`,
                    )}
                  </div>
                  ${
                    missing.length > shownMissing.length
                      ? html`<button
                          class="btn btn-ghost btn-sm mt-2"
                          @click=${() => (this.showAllMissing = true)}
                        >
                          Show all ${missing.length}
                        </button>`
                      : nothing
                  }
                </section>`
              : nothing
          }
        </div>
      </aside>`;
  }
}
