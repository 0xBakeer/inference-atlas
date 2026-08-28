import { html, nothing, type PropertyValues } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ResultRecord } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import { resolveSelection, type CellChangeEvent } from '../components/cell-picker.js';
import '../components/cell-picker.js';
import '../components/chart.js';
import { icon } from '../components/icons.js';
import {
  ordinalLinesBuild,
  scalingEfficiency,
  sweepChartBuild,
  sweepHasMetric,
  type SweepMetric,
} from '../components/sweep-chart.js';
import { emptyState, skeletonLines, who } from '../components/ui.js';
import { href, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { seriesColor } from '../util/colors.js';
import { fmtInt, fmtPct, fmtTokS } from '../util/format.js';
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
        <h1>Throughput against concurrency</h1>
        <p class="lede">
          Sweeps run the same workload at 1, 2, 4 … 32 concurrent streams. Perfect scaling doubles
          tok/s with every doubling; the efficiency column says how far each device and engine fall
          short.
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
            : html`<div class="card">
                  <div class="row mb-2">
                    <span class="spacer"></span>
                    <div class="seg sm">
                      ${metrics.map((m) => html`<button aria-pressed=${m === metric} @click=${() => (this.metric = m)}>${m === 'throughput' ? 'tok/s' : m === 'ttft' ? 'TTFT' : 'TPOT'}</button>`)}
                    </div>
                  </div>
                  <atlas-chart
                    .build=${sweepChartBuild(series, metric, 'concurrency')}
                    .height=${320}
                    .key=${`${metric}${recs.length}`}
                  ></atlas-chart>
                </div>
                ${this.efficiencyChart(recs)}
                <section class="mt-4">
                  <div class="section-title">
                    <h2>Scaling efficiency</h2>
                    <span class="meta">tok/s at c ÷ (tok/s at c₀ × c/c₀)</span>
                  </div>
                  <div class="table-wrap">
                    <table class="table cards">
                      <thead>
                        <tr>
                          <th>run</th>
                          <th>by</th>
                          ${[1, 2, 4, 8, 16, 32, 64].map((c) => html`<th class="num">c=${c}</th>`)}
                          <th class="num">eff @max</th>
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
                                ><a class="mono xs" href=${href('run', r.run_id)}
                                  >${r.engine.id} ${r.engine.version} ·
                                  ${r.model.id}/${r.model.quant_id} · ${r.hardware.id}</a
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

  private efficiencyChart(recs: ResultRecord[]) {
    const levels = [1, 2, 4, 8, 16, 32, 64];
    const series = recs.map((r, i) => {
      const eff = scalingEfficiency(r.sweep!);
      return {
        label: `${r.engine.id} ${r.model.quant_id} · ${r.hardware.id}`,
        color: seriesColor(i),
        values: levels.map((c) => {
          const e = eff.find((x) => x.x === c);
          return e?.eff ?? null;
        }),
      };
    });
    if (!series.some((s) => s.values.some((v) => v != null))) return nothing;
    return html`<div class="card mt-4">
      <div class="card-head">
        <h3>Scaling efficiency</h3>
        <span class="muted small">1.0 is perfect linear scaling</span>
      </div>
      <atlas-chart
        .build=${ordinalLinesBuild(levels.map(String), series, 'efficiency', (v) => fmtPct(v, 0))}
        .height=${240}
        .key=${`eff${recs.length}`}
      ></atlas-chart>
    </div>`;
  }
}
