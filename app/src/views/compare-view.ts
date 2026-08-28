import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ResultRecord } from '@atlas/core';
import '../components/chart.js';
import '../components/run-picker.js';
import { icon } from '../components/icons.js';
import {
  sweepAxisOf,
  sweepChartBuild,
  sweepHasMetric,
  type SweepMetric,
} from '../components/sweep-chart.js';
import {
  deltaTag,
  emptyState,
  hbar,
  kindTag,
  skeletonLines,
  verifBadge,
  when,
  who,
} from '../components/ui.js';
import { href, qlist, setQuery } from '../router.js';
import { store } from '../store.js';
import { copyText } from '../util/clipboard.js';
import { seriesColor } from '../util/colors.js';
import { argsDiff, metricDelta } from '../util/diff.js';
import { fmtPct } from '../util/format.js';
import { blockCards, type MetricCardData } from '../util/metrics.js';
import { ViewElement } from './view-base.js';

@customElement('atlas-compare-view')
export class AtlasCompareView extends ViewElement {
  @state() private recs = new Map<string, ResultRecord | null>();
  @state() private showAll = false;
  @state() private sweepMetric: SweepMetric = 'throughput';

  private ids(): string[] {
    return qlist(this.q, 'runs').slice(0, 6);
  }

  protected override willUpdate(_c: PropertyValues): void {
    if (!store.registry.value) return;
    for (const id of this.ids()) {
      if (!this.recs.has(id)) {
        this.recs = new Map(this.recs).set(id, null);
        void store.run(store.rowById(id) ?? { run_id: id }).then((rec) => {
          this.recs = new Map(this.recs).set(id, rec);
        });
      }
    }
  }

  private add(id: string): void {
    const ids = this.ids();
    if (!ids.includes(id)) setQuery({ runs: [...ids, id].join(',') }, { push: true });
  }
  private removeRun(id: string): void {
    setQuery(
      {
        runs:
          this.ids()
            .filter((x) => x !== id)
            .join(',') || null,
      },
      { push: true },
    );
  }

  override render() {
    if (!store.registry.value) return html`<div class="page">${skeletonLines(6)}</div>`;
    const ids = this.ids();
    const recs = ids.map((id) => this.recs.get(id)).filter((r): r is ResultRecord => !!r);
    const loading = ids.some((id) => this.recs.get(id) === null);
    const missing = ids.filter(
      (id) =>
        this.recs.get(id) === undefined ||
        (this.recs.has(id) && this.recs.get(id) === null && !loading),
    );

    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Compare</div>
        <div class="row-wrap" style="justify-content:space-between">
          <h1>
            ${recs.length ? `${recs.length} run${recs.length === 1 ? '' : 's'} side by side` : 'Compare runs'}
          </h1>
          <div class="head-actions">
            <button class="btn btn-sm" @click=${() => copyText(location.href, 'Permalink copied')}>
              ${icon('link')} Permalink
            </button>
          </div>
        </div>
        <p class="lede">
          Only flags that differ are highlighted. Metric deltas are direction-aware: lower TTFT is
          better, higher tok/s is better.
        </p>
      </div>

      <div class="card mb-4">
        <div class="row-wrap mb-2">
          ${ids.map((id, i) => {
            const rec = this.recs.get(id);
            return html`<span class="run-chip">
              <i class="sw" style="background:${seriesColor(i)}"></i>
              <a class="mono" href=${href('run', id)}
                >${rec ? `${rec.engine.id} ${rec.engine.version} · ${rec.model.id}/${rec.model.quant_id} · ${rec.hardware.id}` : id.slice(0, 16)}</a
              >
              <button class="x" aria-label="Remove" @click=${() => this.removeRun(id)}>
                ${icon('x')}
              </button>
            </span>`;
          })}
        </div>
        ${ids.length < 6 ? html`<atlas-run-picker .exclude=${ids} placeholder="Add a run to the comparison…" @pick=${(e: CustomEvent<string>) => this.add(e.detail)}></atlas-run-picker>` : html`<span class="xs muted">Six runs is the limit for a readable comparison.</span>`}
      </div>

      ${
        ids.length === 0
          ? emptyState({
              title: 'Pick two or more runs',
              text: 'Search above, or open any run and use “Compare with…”. Runs from the same cell give the cleanest diff.',
              action: html`<a class="btn" href="#/results">${icon('table')} Browse results</a>`,
            })
          : loading
            ? skeletonLines(6)
            : html`${missing.length ? html`<div class="callout warn mb-3">${missing.length} run id${missing.length === 1 ? '' : 's'} could not be loaded: ${missing.join(', ')}</div>` : nothing}
              ${recs.length ? this.table(recs) : nothing}
              ${recs.length ? this.metrics(recs) : nothing}
              ${recs.some((r) => r.sweep?.length) ? this.sweeps(recs) : nothing}
              ${recs.some((r) => r.scores) ? this.evals(recs) : nothing}`
      }
    </div>`;
  }

  private table(recs: ResultRecord[]): TemplateResult {
    const rows = argsDiff(recs.map((r) => r.args));
    const shown = this.showAll ? rows : rows.filter((r) => r.differs);
    const same = rows.length - rows.filter((r) => r.differs).length;
    return html`<section class="mb-5">
      <div class="section-title">
        <h2>Configuration</h2>
        <span class="meta"
          >${rows.filter((r) => r.differs).length} differing
          flag${rows.filter((r) => r.differs).length === 1 ? '' : 's'}, ${same} identical</span
        >
        <span class="spacer"></span>
        <label class="checkbox"
          ><input
            type="checkbox"
            .checked=${this.showAll}
            @change=${(e: Event) => (this.showAll = (e.target as HTMLInputElement).checked)}
          />
          show identical flags</label
        >
      </div>
      <div class="table-wrap">
        <table class="table cmp-table">
          <thead>
            <tr>
              <th></th>
              ${recs.map(
                (r, i) =>
                  html`<th class="col-run">
                    <span class="row" style="gap:6px"
                      ><i
                        class="sw"
                        style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${seriesColor(i)}"
                      ></i
                      ><a href=${href('run', r.run_id)} class="mono"
                        >${r.run_id.slice(0, 12)}</a
                      ></span
                    >
                  </th>`,
              )}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="muted xs">engine</td>
              ${recs.map((r) => html`<td class="mono xs">${r.engine.id} ${r.engine.version}</td>`)}
            </tr>
            <tr>
              <td class="muted xs">model / quant</td>
              ${recs.map((r) => html`<td class="mono xs">${r.model.id}/${r.model.quant_id}</td>`)}
            </tr>
            <tr>
              <td class="muted xs">hardware</td>
              ${recs.map((r) => html`<td class="mono xs">${r.hardware.id}${r.hardware.count > 1 ? ` ×${r.hardware.count}` : ''}</td>`)}
            </tr>
            <tr>
              <td class="muted xs">workload</td>
              ${recs.map((r) => html`<td class="mono xs">${r.workload_id} ${kindTag(r.kind)}</td>`)}
            </tr>
            <tr>
              <td class="muted xs">by</td>
              ${recs.map((r) => html`<td>${who(r.provenance.github_login, { userId: r.provenance.github_user_id })} <span class="xs muted">${when(r.provenance.submitted_at ?? r.provenance.started_at)}</span></td>`)}
            </tr>
            <tr>
              <td class="muted xs">verification</td>
              ${recs.map((r) => html`<td>${verifBadge(r.verification.level)}</td>`)}
            </tr>
            <tr>
              <td class="muted xs">config_id</td>
              ${recs.map((r) => html`<td class="mono xs">${r.config_id}</td>`)}
            </tr>
            ${shown.map(
              (row) =>
                html`<tr>
                  <td class="mono xs" style=${row.differs ? 'font-weight:600' : ''}>${row.name}</td>
                  ${row.values.map((v) => html`<td class="mono xs ${row.differs ? 'diff' : 'same-val'}">${v === null ? html`<span class="faint">unset</span>` : v}</td>`)}
                </tr>`,
            )}
            ${
              shown.length === 0
                ? html`<tr>
                    <td colspan=${recs.length + 1} class="muted small">
                      Identical flags on every run.
                    </td>
                  </tr>`
                : nothing
            }
          </tbody>
        </table>
      </div>
    </section>`;
  }

  private metrics(recs: ResultRecord[]): TemplateResult {
    const cardsPer = recs.map((r) => blockCards(r.metrics));
    const keys = [...new Set(cardsPer.flatMap((c) => c.map((x) => x.key)))];
    const base = cardsPer[0] ?? [];
    const betterOf = (key: string): 'higher' | 'lower' =>
      [
        'ttft',
        'tpot',
        'itl',
        'e2e',
        'vram',
        'ram',
        'power',
        'power_peak',
        'energy',
        'temp',
      ].includes(key)
        ? 'lower'
        : 'higher';
    if (keys.length === 0) return html``;
    return html`<section class="mb-5">
      <div class="section-title">
        <h2>Metrics</h2>
        <span class="meta">deltas relative to the first run</span>
      </div>
      <div class="table-wrap">
        <table class="table cmp-table">
          <thead>
            <tr>
              <th>metric</th>
              ${recs.map((r, i) => html`<th class="num"><i class="sw" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${seriesColor(i)};margin-right:6px"></i>${r.run_id.slice(0, 8)}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${keys.map((key) => {
              const label = cardsPer.flatMap((c) => c).find((c) => c.key === key)!;
              const b = base.find((c) => c.key === key) as MetricCardData | undefined;
              return html`<tr>
                <td class="xs">
                  ${label.label}${label.unit ? html` <span class="unit">${label.unit}</span>` : nothing}
                </td>
                ${cardsPer.map((cards, i) => {
                  const c = cards.find((x) => x.key === key);
                  if (!c || c.value === null)
                    return html`<td class="num"><span class="null">–</span></td>`;
                  const d = i === 0 || !b ? null : metricDelta(b.value, c.value, betterOf(key));
                  return html`<td class="num">${c.text} ${i > 0 ? deltaTag(d) : nothing}</td>`;
                })}
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
    </section>`;
  }

  private sweeps(recs: ResultRecord[]): TemplateResult {
    const withSweep = recs.map((r, i) => ({ r, i })).filter((x) => x.r.sweep?.length);
    const axis = sweepAxisOf(withSweep[0]!.r.sweep!);
    const metrics = (['throughput', 'ttft', 'tpot'] as SweepMetric[]).filter((m) =>
      withSweep.some((x) => sweepHasMetric(x.r.sweep!, m)),
    );
    const metric = metrics.includes(this.sweepMetric)
      ? this.sweepMetric
      : (metrics[0] ?? 'throughput');
    const series = withSweep.map((x) => ({
      label: `${x.r.engine.id} ${x.r.engine.version} ${x.r.model.quant_id}`,
      color: seriesColor(x.i),
      points: x.r.sweep!,
    }));
    return html`<section class="mb-5">
      <div class="section-title">
        <h2>Sweep overlay</h2>
        <span class="meta">${axis.replace('_', ' ')} on the x axis</span
        ><span class="spacer"></span>
        <div class="seg sm">
          ${metrics.map((m) => html`<button aria-pressed=${m === metric} @click=${() => (this.sweepMetric = m)}>${m === 'throughput' ? 'tok/s' : m === 'ttft' ? 'TTFT' : 'TPOT'}</button>`)}
        </div>
      </div>
      <div class="card">
        <atlas-chart
          .build=${sweepChartBuild(series, metric, axis)}
          .height=${280}
          .key=${metric + series.length}
        ></atlas-chart>
      </div>
    </section>`;
  }

  private evals(recs: ResultRecord[]): TemplateResult {
    const withScores = recs.map((r, i) => ({ r, i })).filter((x) => x.r.scores);
    const cats = [
      ...new Set(withScores.flatMap((x) => Object.keys(x.r.scores!.by_category ?? {}))),
    ];
    return html`<section class="mb-5">
      <div class="section-title"><h2>Eval overlay</h2></div>
      <div class="split">
        <div class="card tight">
          <div class="eyebrow plain mb-2">Accuracy</div>
          ${withScores.map((x) => hbar(`${x.r.model.id}/${x.r.model.quant_id}`, x.r.scores!.accuracy, fmtPct(x.r.scores!.accuracy), undefined))}
        </div>
        ${
          cats.length
            ? html`<div class="card tight">
                <div class="eyebrow plain mb-2">By category</div>
                ${cats.map(
                  (c) =>
                    html`<div class="mb-2">
                      <div class="xs muted">${c}</div>
                      ${withScores.map((x) => {
                        const v = x.r.scores!.by_category?.[c];
                        return hbar(
                          x.r.run_id.slice(0, 8),
                          v && v.total ? v.correct / v.total : null,
                          v ? `${v.correct}/${v.total}` : '–',
                        );
                      })}
                    </div>`,
                )}
              </div>`
            : nothing
        }
      </div>
    </section>`;
  }
}
