import { html, nothing, type PropertyValues } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ResultRecord } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import { resolveSelection, type CellChangeEvent } from '../components/cell-picker.js';
import '../components/cell-picker.js';
import '../components/chart.js';
import { icon } from '../components/icons.js';
import {
  scalingEfficiency,
  sweepChartBuild,
  sweepHasMetric,
  type SweepMetric,
} from '../components/sweep-chart.js';
import { emptyState, skeletonLines, who } from '../components/ui.js';
import { href, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { seriesColor } from '../util/colors.js';
import { fmtInt, fmtPct, fmtTokS } from '@atlas/core';
import { ViewElement } from './view-base.js';

@customElement('atlas-parallelism-view')
export class AtlasParallelismView extends ViewElement {
  @state() private recs = new Map<string, ResultRecord | null>();
  @state() private metric: SweepMetric = 'throughput';

  private rows() {
    const q = this.q;
    const hw = qget(q, 'hardware');
    const eng = qget(q, 'engine');
    const model = qget(q, 'model');
    return store.index.value.filter(
      (r) =>
        r.kind === 'sweep' &&
        (!hw || r.hardware.id === hw) &&
        (!eng || r.engine.id === eng) &&
        (!model || r.model.id === model),
    );
  }

  protected override willUpdate(_c: PropertyValues): void {
    if (!store.registry.value) return;
    for (const r of this.rows().slice(0, 12)) {
      if (!this.recs.has(r.run_id)) {
        this.recs = new Map(this.recs).set(r.run_id, null);
        void store.run(r).then((rec) => (this.recs = new Map(this.recs).set(r.run_id, rec)));
      }
    }
  }

  /** The two numbers a reader wants before the curves: the biggest peak, and the best scaler. */
  private summary(recs: ResultRecord[]) {
    if (!recs.length) return nothing;
    let peak: { r: ResultRecord; y: number; c: number } | null = null;
    let eff: { r: ResultRecord; e: number; c: number } | null = null;
    for (const r of recs) {
      for (const p of scalingEfficiency(r.sweep!)) {
        if (p.y !== null && (!peak || p.y > peak.y)) peak = { r, y: p.y, c: p.x };
      }
      const last = scalingEfficiency(r.sweep!)
        .filter((p) => p.eff !== null)
        .at(-1);
      if (last && last.eff !== null && (!eff || last.eff > eff.e))
        eff = { r, e: last.eff, c: last.x };
    }
    const name = (r: ResultRecord) =>
      `${store.lookups.models.get(r.model.id)?.model.name ?? r.model.id} on ${store.lookups.hardware.get(r.hardware.id)?.name ?? r.hardware.id}`;
    return html`<div class="stats-strip mb-4">
      <div class="stat">
        <div class="v">${recs.length}</div>
        <div class="k">sweeps compared</div>
      </div>
      ${
        peak
          ? html`<div class="stat">
              <div class="v">${fmtTokS(peak.y)}<small>tok/s</small></div>
              <div class="k">
                highest total · ${peak.c} users ·
                <a href=${href('run', peak.r.run_id)}>${name(peak.r)}</a>
              </div>
            </div>`
          : nothing
      }
      ${
        eff
          ? html`<div class="stat">
              <div class="v">${fmtPct(eff.e, 0)}</div>
              <div class="k">
                best scaling kept at ${eff.c} users ·
                <a href=${href('run', eff.r.run_id)}>${name(eff.r)}</a>
              </div>
            </div>`
          : nothing
      }
    </div>`;
  }

  override render() {
    const reg = store.registry.value;
    if (!reg) return html`<div class="page">${skeletonLines(6)}</div>`;
    const q = this.q;
    const sel = {
      engine: qget(q, 'engine'),
      model: qget(q, 'model'),
      hardware: qget(q, 'hardware'),
      quant: null,
      version: null,
    };
    const rows = this.rows().slice(0, 12);
    const recs = rows
      .map((r) => this.recs.get(r.run_id))
      .filter((r): r is ResultRecord => !!r && !!r.sweep?.length);
    const loading = rows.some((r) => this.recs.get(r.run_id) === null);
    const sweepWorkloads = reg.workloads.filter((w) => w.kind === 'sweep');
    const metrics = (['throughput', 'ttft', 'tpot'] as SweepMetric[]).filter((m) =>
      recs.some((r) => sweepHasMetric(r.sweep!, m)),
    );
    const metric = metrics.includes(this.metric) ? this.metric : 'throughput';
    const series = recs.map((r, i) => ({
      label: `${r.engine.id} ${r.engine.version} · ${r.model.id}/${r.model.quant_id} · ${r.hardware.id}`,
      color: seriesColor(i),
      points: r.sweep!,
    }));
    const addSel = resolveSelection(sel, { requireAll: true });

    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Parallelism</div>
        <h1>How many users can one box serve?</h1>
        <p class="lede">
          A sweep runs the same request shape with 1, 2, 4 … 64 people at once. Perfect scaling
          would double the total tok/s with every doubling; the curve shows where each setup stops
          climbing, and the efficiency column says how much of that ideal it keeps.
        </p>
      </div>
      <div class="card mb-4">
        <atlas-cell-picker
          .value=${sel}
          .fields=${['hardware', 'engine', 'model']}
          .required=${false}
          compact
          @cell-change=${(e: CellChangeEvent) => setQuery({ engine: e.detail.engine, model: e.detail.model, hardware: e.detail.hardware })}
        ></atlas-cell-picker>
      </div>
      ${
        rows.length === 0
          ? emptyState({
              title: 'No parallelism sweeps measured here yet',
              text: sweepWorkloads.length
                ? `The registry has ${sweepWorkloads.length} sweep workload${sweepWorkloads.length === 1 ? '' : 's'}. Pick a cell and add the first one.`
                : 'No sweep workloads are registered.',
              action:
                sweepWorkloads.length && addSel.engine && addSel.model && addSel.hardware
                  ? addButton(
                      {
                        engine_id: addSel.engine,
                        engine_version: addSel.version,
                        model_id: addSel.model,
                        quant_id: addSel.quant,
                        hardware_id: addSel.hardware,
                        workload_ids: sweepWorkloads.map((w) => w.id),
                      },
                      { primary: true, label: `Add a sweep on ${addSel.hardware}` },
                    )
                  : undefined,
            })
          : loading && recs.length === 0
            ? skeletonLines(6)
            : html`${this.summary(recs)}
                <div class="card hide-legend">
                  <div class="row mb-2">
                    <span class="xs muted">Colours match the table below</span>
                    <span class="spacer"></span>
                    <div class="seg sm">
                      ${metrics.map((m) => html`<button aria-pressed=${m === metric} @click=${() => (this.metric = m)}>${m === 'throughput' ? 'Total tok/s' : m === 'ttft' ? 'Wait for first token' : 'Time per token'}</button>`)}
                    </div>
                  </div>
                  <atlas-chart
                    .build=${sweepChartBuild(series, metric, 'concurrency')}
                    .height=${320}
                    .key=${`${metric}${recs.length}`}
                    .chartTitle=${'Parallelism sweep'}
                  ></atlas-chart>
                </div>
                <section class="mt-4">
                  <div class="section-title">
                    <h2>Scaling efficiency</h2>
                    <span class="meta"
                      >total tok/s at each concurrency, and below it the share of perfect scaling
                      kept (100% = doubled with every doubling)</span
                    >
                  </div>
                  <div class="table-wrap">
                    <table class="table cards">
                      <thead>
                        <tr>
                          <th>Setup</th>
                          <th>By</th>
                          ${[1, 2, 4, 8, 16, 32, 64].map((c) => html`<th class="num">${c} user${c === 1 ? '' : 's'}</th>`)}
                          <th class="num">Kept at max</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${recs.map((r, i) => {
                          const eff = scalingEfficiency(r.sweep!);
                          const at = (c: number) => eff.find((e) => e.x === c);
                          const last = eff.filter((e) => e.eff !== null).at(-1);
                          return html`<tr>
                            <td class="primary">
                              <span class="row" style="gap:6px"
                                ><i
                                  class="sw"
                                  style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${seriesColor(i)}"
                                ></i
                                ><a
                                  class="xs"
                                  href=${href('run', r.run_id)}
                                  title=${`${r.engine.id} ${r.engine.version} · ${r.model.id}/${r.model.quant_id} · ${r.hardware.id}`}
                                  >${store.lookups.models.get(r.model.id)?.model.name ?? r.model.id}<span
                                    class="mono muted"
                                    >/${r.model.quant_id}</span
                                  >
                                  ·
                                  ${store.lookups.hardware.get(r.hardware.id)?.name ?? r.hardware.id}
                                  ·
                                  ${store.lookups.engines.get(r.engine.id)?.meta.name ?? r.engine.id}
                                  <span class="mono muted">${r.engine.version}</span></a
                                ></span
                              >
                            </td>
                            <td data-label="by">
                              ${who(r.provenance.github_login, { userId: r.provenance.github_user_id, size: 'sm' })}
                            </td>
                            ${[1, 2, 4, 8, 16, 32, 64].map((c) => {
                              const e = at(c);
                              return html`<td class="num" data-label=${`c=${c}`}>
                                ${e && e.y !== null ? html`${fmtTokS(e.y)}<br /><span class="xs muted">${e.eff === null ? '' : fmtPct(e.eff, 0)}</span>` : html`<span class="null">–</span>`}
                              </td>`;
                            })}
                            <td class="num" data-label="eff">
                              ${last?.eff == null ? '–' : fmtPct(last.eff, 0)}
                            </td>
                          </tr>`;
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p class="xs muted mt-2">
                    ${fmtInt(rows.length)} sweep
                    run${rows.length === 1 ? '' : 's'}${rows.length > 12 ? ' (showing the first 12)' : ''}.
                    ${icon('flag')}
                    ${addSel.engine && addSel.hardware && addSel.model ? addButton({ engine_id: addSel.engine, engine_version: addSel.version, model_id: addSel.model, quant_id: addSel.quant, hardware_id: addSel.hardware, workload_ids: sweepWorkloads.map((w) => w.id) }, { label: 'Add another sweep', size: 'xs' }) : nothing}
                  </p>
                </section>`
      }
    </div>`;
  }
}
